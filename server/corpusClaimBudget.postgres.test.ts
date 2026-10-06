import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/**
 * Live-database claim-boundary tests for atomic budget admission. These run
 * ONLY against an explicitly provided dedicated test database and refuse any
 * shared/production database:
 *
 *   CORPUS_BUDGET_TEST_DATABASE_URL=postgresql://... npx tsx --test ...
 *
 * Without that variable every test below skips (a visible skip note is
 * logged by the first test). When enabled, the suite first proves isolation
 * (empty query_library, no pending/processing harvest/scoring jobs, all
 * required tables present) and fails loudly before mutating anything
 * otherwise.
 *
 * Corpus tables are append-only by design (reject_immutable_event_mutation),
 * so fixtures there are NEVER deleted. Instead every fixture uses a unique
 * per-run tag and every budget assertion is delta-scoped (budgets are set
 * relative to measured usage), keeping each run deterministic no matter what
 * prior runs left behind. The only cleanup is jobs-table rows (allowed) and
 * control-row restoration — and cleanup failures propagate loudly rather
 * than being swallowed.
 */
const dedicated = process.env.CORPUS_BUDGET_TEST_DATABASE_URL;

test('corpus budget claim tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicated) {
    console.log(
      'SKIP: set CORPUS_BUDGET_TEST_DATABASE_URL to a dedicated empty test database to run live claim-boundary tests.'
    );
  }
  assert.ok(true);
});

if (dedicated) process.env.DATABASE_URL = dedicated;
const maybe = dedicated ? test : test.skip;

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

async function db(): Promise<Db> {
  const { getDb } = await import('./dbCore');
  return getDb();
}

async function assertIsolatedTestDb(database: Db) {
  for (const table of [
    'corpus_controls',
    'candidate_scoring_controls',
    'corpus_documents',
    'corpus_candidate_occurrences',
    'corpus_extraction_runs',
    'candidate_feature_snapshots',
    'jobs',
    'job_attempts',
    'query_library',
  ]) {
    const exists = await database.query(`SELECT to_regclass($1) AS oid`, [table]);
    assert.ok(exists.rows[0]?.oid, `required table missing: ${table} (is the test DB migrated?)`);
  }
  const library = await database.query('SELECT count(*)::int AS n FROM query_library');
  assert.equal(
    Number(library.rows[0]?.n || 0),
    0,
    'refusing to run against a non-empty (shared/production?) database: query_library must be empty'
  );
  const live = await database.query(
    `SELECT count(*)::int AS n FROM jobs WHERE type IN ('TERM_HARVEST','SCORE_CANDIDATES','PROPOSE_CONCEPT_RESOLUTION') AND status IN ('PENDING','PROCESSING')`
  );
  assert.equal(
    Number(live.rows[0]?.n || 0),
    0,
    'refusing to run while harvest/scoring/resolution jobs are live: a worker may be active on this database'
  );
}

async function spentToday(database: Db) {
  const runs = (
    await database.query(
      `SELECT count(*)::int AS n FROM corpus_extraction_runs WHERE completed_at>=date_trunc('day',now())`
    )
  ).rows[0];
  const snapshots = (
    await database.query(
      `SELECT count(*)::int AS n FROM candidate_feature_snapshots WHERE computed_at>=date_trunc('day',now())`
    )
  ).rows[0];
  return { runs: Number(runs?.n || 0), snapshots: Number(snapshots?.n || 0) };
}

function harvestPayload(tag: string, index: number) {
  const text = `budget race probe ${tag} ${index}`;
  return {
    payloadSchemaVersion: 1,
    channelId: 'UCbudgetrace00000000000000',
    text,
    contentHash: createHash('sha256').update(text.normalize('NFC')).digest('hex'),
    lineage: 'AUTONOMOUS',
    entityClusterKey: `budget-race-${tag}`,
    observedAt: new Date().toISOString(),
    extractorVersion: 'deterministic-ngram-v1',
  };
}

/** Fixture document with exactly `spans` distinct normalized spans (append-only; unique tag). */
async function fixtureScoringDocument(database: Db, tag: string, spans: number): Promise<string> {
  const artifact = await database.query(
    `INSERT INTO corpus_source_artifacts(source_type,source_key,creator_channel_id,discovery_lineage,entity_cluster_key,observed_at,policy_version)
     VALUES('CHANNEL_METADATA',$1,NULL,'AUTONOMOUS',$2,now(),'corpus-policy-v1') RETURNING id`,
    [`test-scoring-units:${tag}`, `scoring-units-${tag}`]
  );
  const document = await database.query(
    `INSERT INTO corpus_documents(artifact_id,document_kind,language,content_hash,retained_excerpt,retention_class,extractor_eligible,retention_expires_at)
     VALUES($1,'CHANNEL_METADATA','und',$2,'excerpt','MINIMAL_EXCERPT',true,now()+interval '90 days') RETURNING id`,
    [artifact.rows[0].id, `scoring-units-hash-${tag}`]
  );
  const documentId = String(document.rows[0].id);
  const run = await database.query(
    `INSERT INTO corpus_extraction_runs(document_id,extractor_version,status,token_count,candidate_count)
     VALUES($1,'deterministic-ngram-v1','COMPLETED',1,$2) RETURNING id`,
    [documentId, spans]
  );
  for (let span = 0; span < spans; span++) {
    await database.query(
      `INSERT INTO corpus_candidate_occurrences(extraction_run_id,document_id,literal_span,normalized_span,start_offset,end_offset,ngram_size,occurrence_key)
       VALUES($1,$2,$3,$3,$4,$5,1,$6) ON CONFLICT(occurrence_key) DO NOTHING`,
      [run.rows[0].id, documentId, `scoring span ${tag} ${span}`, span * 10, span * 10 + 5, `test-scoring-units:${tag}:${span}`]
    );
  }
  return documentId;
}

maybe('concurrent budget-guarded claims admit at most remaining headroom', async t => {
  const { enqueueJob, claimNextJob } = await import('./dbCore');
  const { TERM_HARVEST_BUDGET_GUARD } = await import('./queueManager');
  const database = await db();
  await assertIsolatedTestDb(database);
  const tag = `budget-race:${Date.now()}:${process.pid}`;
  await database.query(`DELETE FROM jobs WHERE idempotency_key LIKE 'test-budget-race:%'`);
  const prev = (
    await database.query('SELECT paused, daily_compute_documents FROM corpus_controls WHERE singleton=true')
  ).rows[0];
  const before = await spentToday(database);
  const jobIds: string[] = [];
  try {
    // Delta-scoped budget: exactly one unit of headroom over current usage.
    await database.query(`UPDATE corpus_controls SET paused=false, daily_compute_documents=$1 WHERE singleton=true`, [
      before.runs + 1,
    ]);
    for (let index = 0; index < 3; index++) {
      const job = await enqueueJob('TERM_HARVEST', harvestPayload(tag, index), {
        priority: 5,
        maxAttempts: 3,
        idempotencyKey: `test-budget-race:${tag}:${index}`,
      });
      jobIds.push(job.id);
    }
    // Three concurrent guarded claims with one unit of headroom: exactly one
    // is admitted (control-row lock serializes check-then-claim; in-flight
    // counting closes the claim/completion gap). The rest return null with
    // their jobs still PENDING and attempts untouched.
    const results = await Promise.all(
      [0, 1, 2].map(n =>
        claimNextJob(`test-budget-race-${n}`, ['TERM_HARVEST'], undefined, undefined, [
          TERM_HARVEST_BUDGET_GUARD,
        ])
      )
    );
    const claimed = results.filter(Boolean);
    assert.equal(claimed.length, 1);
    const states = (
      await database.query('SELECT status, attempts FROM jobs WHERE id = ANY($1::uuid[])', [jobIds])
    ).rows as Array<{ status: string; attempts: number }>;
    assert.equal(states.filter(row => row.status === 'PROCESSING').length, 1);
    assert.equal(states.filter(row => row.status === 'PENDING').length, 2);
    assert.ok(states.every(row => row.status !== 'FAILED'));
    assert.ok(
      states.filter(row => row.status === 'PENDING').every(row => Number(row.attempts) === 0),
      'denied jobs must not consume attempts'
    );
  } finally {
    if (jobIds.length > 0) {
      await database.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    }
    await database.query('UPDATE corpus_controls SET paused=$1, daily_compute_documents=$2 WHERE singleton=true', [
      prev.paused,
      prev.daily_compute_documents,
    ]);
  }
});

maybe('oversized scoring job does not block a smaller admittable job', async t => {
  const { enqueueJob, claimNextJob } = await import('./dbCore');
  const { SCORE_CANDIDATES_BUDGET_GUARD } = await import('./queueManager');
  const { FEATURE_SET_VERSION } = await import('./candidateScoring');
  const database = await db();
  await assertIsolatedTestDb(database);
  const tag = `oversized:${Date.now()}:${process.pid}`;
  await database.query(`DELETE FROM jobs WHERE idempotency_key LIKE 'test-oversized:%'`);
  const prev = (
    await database.query(
      'SELECT scoring_paused, daily_scoring_candidates FROM candidate_scoring_controls WHERE singleton=true'
    )
  ).rows[0];
  const jobIds: string[] = [];
  try {
    const bigDoc = await fixtureScoringDocument(database, `${tag}:big`, 5);
    const smallDoc = await fixtureScoringDocument(database, `${tag}:small`, 1);
    const before = await spentToday(database);
    // Exactly one unit of headroom: the 5-group job cannot fit, the 1-group
    // job can. Higher priority first proves scanning continues past denial.
    await database.query(
      `UPDATE candidate_scoring_controls SET scoring_paused=false, daily_scoring_candidates=$1 WHERE singleton=true`,
      [before.snapshots + 1]
    );
    const big = await enqueueJob(
      'SCORE_CANDIDATES',
      { payloadSchemaVersion: 1, documentId: bigDoc, featureSetVersion: FEATURE_SET_VERSION },
      { priority: 9, maxAttempts: 3, idempotencyKey: `test-oversized:${tag}:big` }
    );
    const small = await enqueueJob(
      'SCORE_CANDIDATES',
      { payloadSchemaVersion: 1, documentId: smallDoc, featureSetVersion: FEATURE_SET_VERSION },
      { priority: 1, maxAttempts: 3, idempotencyKey: `test-oversized:${tag}:small` }
    );
    jobIds.push(big.id, small.id);
    const claimed = await claimNextJob(`test-oversized`, ['SCORE_CANDIDATES'], undefined, undefined, [
      SCORE_CANDIDATES_BUDGET_GUARD,
    ]);
    assert.ok(claimed, 'the smaller job must claim despite the oversized higher-priority job');
    assert.equal(claimed?.id, small.id);
    const bigState = (
      await database.query('SELECT status, attempts FROM jobs WHERE id=$1::uuid', [big.id])
    ).rows[0] as { status: string; attempts: number };
    assert.equal(bigState.status, 'PENDING');
    assert.equal(Number(bigState.attempts), 0);
  } finally {
    if (jobIds.length > 0) {
      await database.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    }
    await database.query(
      'UPDATE candidate_scoring_controls SET scoring_paused=$1, daily_scoring_candidates=$2 WHERE singleton=true',
      [prev.scoring_paused, prev.daily_scoring_candidates]
    );
  }
});

maybe('zero-span scoring job is denied under an exhausted budget', async t => {
  const { enqueueJob, claimNextJob } = await import('./dbCore');
  const { SCORE_CANDIDATES_BUDGET_GUARD } = await import('./queueManager');
  const { FEATURE_SET_VERSION } = await import('./candidateScoring');
  const database = await db();
  await assertIsolatedTestDb(database);
  const tag = `zerospan:${Date.now()}:${process.pid}`;
  await database.query(`DELETE FROM jobs WHERE idempotency_key LIKE 'test-zerospan:%'`);
  const prev = (
    await database.query(
      'SELECT scoring_paused, daily_scoring_candidates FROM candidate_scoring_controls WHERE singleton=true'
    )
  ).rows[0];
  const jobIds: string[] = [];
  try {
    // Document with no occurrences: zero normalized-span groups.
    const artifact = await database.query(
      `INSERT INTO corpus_source_artifacts(source_type,source_key,creator_channel_id,discovery_lineage,entity_cluster_key,observed_at,policy_version)
       VALUES('CHANNEL_METADATA',$1,NULL,'AUTONOMOUS',$2,now(),'corpus-policy-v1') RETURNING id`,
      [`test-zerospan:${tag}`, `zerospan-${tag}`]
    );
    const document = await database.query(
      `INSERT INTO corpus_documents(artifact_id,document_kind,language,content_hash,retained_excerpt,retention_class,extractor_eligible,retention_expires_at)
       VALUES($1,'CHANNEL_METADATA','und',$2,'excerpt','MINIMAL_EXCERPT',true,now()+interval '90 days') RETURNING id`,
      [artifact.rows[0].id, `zerospan-hash-${tag}`]
    );
    const documentId = String(document.rows[0].id);
    const before = await spentToday(database);
    // Budget exactly spent: remaining is zero, so even a zero-unit job is
    // denied rather than routed into the processor's budget throw.
    await database.query(
      `UPDATE candidate_scoring_controls SET scoring_paused=false, daily_scoring_candidates=$1 WHERE singleton=true`,
      [before.snapshots]
    );
    const job = await enqueueJob(
      'SCORE_CANDIDATES',
      { payloadSchemaVersion: 1, documentId, featureSetVersion: FEATURE_SET_VERSION },
      { priority: 5, maxAttempts: 3, idempotencyKey: `test-zerospan:${tag}` }
    );
    jobIds.push(job.id);
    const denied = await claimNextJob(`test-zerospan`, ['SCORE_CANDIDATES'], undefined, undefined, [
      SCORE_CANDIDATES_BUDGET_GUARD,
    ]);
    assert.equal(denied, null);
    const state = (
      await database.query('SELECT status, attempts FROM jobs WHERE id=$1::uuid', [job.id])
    ).rows[0] as { status: string; attempts: number };
    assert.equal(state.status, 'PENDING');
    assert.equal(Number(state.attempts), 0);
  } finally {
    if (jobIds.length > 0) {
      await database.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    }
    await database.query(
      'UPDATE candidate_scoring_controls SET scoring_paused=$1, daily_scoring_candidates=$2 WHERE singleton=true',
      [prev.scoring_paused, prev.daily_scoring_candidates]
    );
  }
});

maybe('guarded corpus job cannot jump ahead of higher-priority ordinary work', async t => {
  const { enqueueJob, claimNextJob } = await import('./dbCore');
  const { TERM_HARVEST_BUDGET_GUARD } = await import('./queueManager');
  const database = await db();
  await assertIsolatedTestDb(database);
  const tag = `mixedprio:${Date.now()}:${process.pid}`;
  await database.query(`DELETE FROM jobs WHERE idempotency_key LIKE 'test-mixedprio:%'`);
  const prev = (
    await database.query('SELECT paused, daily_compute_documents FROM corpus_controls WHERE singleton=true')
  ).rows[0];
  const jobIds: string[] = [];
  try {
    const before = await spentToday(database);
    // Exhaust the harvest budget so the high-priority harvest row is denied;
    // the lower-priority unguarded SEARCH row must still claim first.
    await database.query(`UPDATE corpus_controls SET paused=false, daily_compute_documents=$1 WHERE singleton=true`, [
      before.runs,
    ]);
    const harvest = await enqueueJob('TERM_HARVEST', harvestPayload(tag, 0), {
      priority: 20,
      maxAttempts: 3,
      idempotencyKey: `test-mixedprio:${tag}:harvest`,
    });
    const search = await enqueueJob(
      'SEARCH_YOUTUBE',
      { payloadSchemaVersion: 1, probe: tag },
      { priority: 5, maxAttempts: 3, idempotencyKey: `test-mixedprio:${tag}:search` }
    );
    jobIds.push(harvest.id, search.id);
    const claimed = await claimNextJob(
      `test-mixedprio`,
      ['SEARCH_YOUTUBE', 'TERM_HARVEST'],
      undefined,
      undefined,
      [TERM_HARVEST_BUDGET_GUARD]
    );
    assert.ok(claimed);
    assert.equal(claimed?.type, 'SEARCH_YOUTUBE');
    assert.equal(claimed?.id, search.id);
    const harvestState = (
      await database.query('SELECT status, attempts FROM jobs WHERE id=$1::uuid', [harvest.id])
    ).rows[0] as { status: string; attempts: number };
    assert.equal(harvestState.status, 'PENDING');
    assert.equal(Number(harvestState.attempts), 0);
  } finally {
    if (jobIds.length > 0) {
      await database.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    }
    await database.query('UPDATE corpus_controls SET paused=$1, daily_compute_documents=$2 WHERE singleton=true', [
      prev.paused,
      prev.daily_compute_documents,
    ]);
  }
});

maybe('shared corpus budget blocks both harvest claims and research writes', async t => {
  const { getDb, claimNextJob, enqueueJob } = await import('./dbCore');
  const { TERM_HARVEST_BUDGET_GUARD } = await import('./queueManager');
  const { persistResearchCorpusDocument } = await import('./persistentResearchPhase3');
  const database = await getDb();
  await assertIsolatedTestDb(database);
  const tag = `both-consumers:${Date.now()}:${process.pid}`;
  await database.query(`DELETE FROM jobs WHERE idempotency_key LIKE 'test-both-consumers:%'`);
  const prev = (
    await database.query('SELECT paused, daily_compute_documents FROM corpus_controls WHERE singleton=true')
  ).rows[0];
  assert.ok(prev, 'corpus_controls singleton must exist');
  const text = `both consumers probe ${tag} trading markets analysis`;
  const jobIds: string[] = [];
  const researchDocumentIds: string[] = [];
  try {
    const before = await spentToday(database);
    // Exactly one unit of headroom; the research path consumes it.
    await database.query(`UPDATE corpus_controls SET paused=false, daily_compute_documents=$1 WHERE singleton=true`, [
      before.runs + 1,
    ]);
    const first = await persistResearchCorpusDocument({
      sourceType: 'VIDEO_TAGS',
      sourceKey: `test-both-consumers:${tag}`,
      text,
      lineage: 'AUTONOMOUS',
      entityClusterKey: `both-consumers-${tag}`,
      observedAt: new Date().toISOString(),
    });
    researchDocumentIds.push(String(first.documentId));
    // A harvest claim must now be denied: the shared cap is spent, even
    // though this consumer never wrote anything itself.
    const job = await enqueueJob('TERM_HARVEST', harvestPayload(tag, 0), {
      priority: 5,
      maxAttempts: 3,
      idempotencyKey: `test-both-consumers:${tag}`,
    });
    jobIds.push(job.id);
    const denied = await claimNextJob(`test-both-consumers`, ['TERM_HARVEST'], undefined, undefined, [
      TERM_HARVEST_BUDGET_GUARD,
    ]);
    assert.equal(denied, null);
    const harvestState = (
      await database.query('SELECT status, attempts FROM jobs WHERE id=$1::uuid', [job.id])
    ).rows[0] as { status: string; attempts: number };
    assert.equal(harvestState.status, 'PENDING');
    assert.equal(Number(harvestState.attempts), 0);
    // And a second research write is likewise refused: one cap, both paths.
    await assert.rejects(
      persistResearchCorpusDocument({
        sourceType: 'VIDEO_TAGS',
        sourceKey: `test-both-consumers:${tag}:second`,
        text: `both consumers second ${tag} trading markets analysis`,
        lineage: 'AUTONOMOUS',
        entityClusterKey: `both-consumers-${tag}`,
        observedAt: new Date().toISOString(),
      }),
      /BUDGET_EXHAUSTED/
    );
  } finally {
    if (researchDocumentIds.length > 0) {
      await database.query(`DELETE FROM jobs WHERE payload->>'documentId' = ANY($1::text[])`, [
        researchDocumentIds,
      ]);
    }
    if (jobIds.length > 0) {
      await database.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    }
    // Corpus fixture rows are append-only (immutable trigger) and keyed by
    // unique per-run tags, so reruns stay deterministic without deleting
    // them; all budget assertions above are delta-scoped for the same reason.
    await database.query('UPDATE corpus_controls SET paused=$1, daily_compute_documents=$2 WHERE singleton=true', [
      prev.paused,
      prev.daily_compute_documents,
    ]);
  }
});

function resolutionPayload(tag: string, index: number) {
  return {
    payloadSchemaVersion: 1,
    candidateKey: `test-resolution:${tag}:${index}`,
    literal: `test resolution probe ${tag} ${index}`,
    language: 'und',
    script: 'Zyyy',
    locale: 'und',
    resolverVersion: 'concept-resolution-v1',
  };
}

maybe('resolution admission with headroom and denial when exhausted', async t => {
  const { enqueueJob, claimNextJob } = await import('./dbCore');
  const { RESOLUTION_BUDGET_GUARD } = await import('./queueManager');
  const database = await db();
  await assertIsolatedTestDb(database);
  const tag = `resolution:${Date.now()}:${process.pid}`;
  await database.query(`DELETE FROM jobs WHERE idempotency_key LIKE 'test-resolution:%'`);
  const prev = (
    await database.query(
      'SELECT resolution_paused, daily_resolution_documents FROM concept_graph_controls WHERE singleton=true'
    )
  ).rows[0];
  assert.ok(prev, 'concept_graph_controls singleton must exist');
  const done = (
    await database.query(
      `SELECT count(*)::int AS n FROM concept_resolution_proposals WHERE created_at>=date_trunc('day',now())`
    )
  ).rows[0];
  const jobIds: string[] = [];
  try {
    // Exactly one unit of headroom over current usage.
    await database.query(
      `UPDATE concept_graph_controls SET resolution_paused=false, daily_resolution_documents=$1 WHERE singleton=true`,
      [Number(done?.n || 0) + 1]
    );
    const first = await enqueueJob('PROPOSE_CONCEPT_RESOLUTION', resolutionPayload(tag, 0), {
      priority: 2,
      maxAttempts: 3,
      idempotencyKey: `test-resolution:${tag}:0`,
    });
    jobIds.push(first.id);
    const admitted = await claimNextJob(`test-resolution`, ['PROPOSE_CONCEPT_RESOLUTION'], undefined, undefined, [
      RESOLUTION_BUDGET_GUARD,
    ]);
    assert.ok(admitted);
    assert.equal(admitted?.id, first.id);
    // Budget now exhausted: a second job is denied, stays PENDING, attempts untouched.
    const second = await enqueueJob('PROPOSE_CONCEPT_RESOLUTION', resolutionPayload(tag, 1), {
      priority: 2,
      maxAttempts: 3,
      idempotencyKey: `test-resolution:${tag}:1`,
    });
    jobIds.push(second.id);
    const denied = await claimNextJob(`test-resolution-2`, ['PROPOSE_CONCEPT_RESOLUTION'], undefined, undefined, [
      RESOLUTION_BUDGET_GUARD,
    ]);
    assert.equal(denied, null);
    const state = (
      await database.query('SELECT status, attempts FROM jobs WHERE id=$1::uuid', [second.id])
    ).rows[0] as { status: string; attempts: number };
    assert.equal(state.status, 'PENDING');
    assert.equal(Number(state.attempts), 0);
  } finally {
    if (jobIds.length > 0) {
      await database.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    }
    await database.query(
      'UPDATE concept_graph_controls SET resolution_paused=$1, daily_resolution_documents=$2 WHERE singleton=true',
      [prev.resolution_paused, prev.daily_resolution_documents]
    );
  }
});

maybe('concurrent resolution claims admit at most remaining headroom', async t => {
  const { enqueueJob, claimNextJob } = await import('./dbCore');
  const { RESOLUTION_BUDGET_GUARD } = await import('./queueManager');
  const database = await db();
  await assertIsolatedTestDb(database);
  const tag = `resolution-race:${Date.now()}:${process.pid}`;
  await database.query(`DELETE FROM jobs WHERE idempotency_key LIKE 'test-resolution-race:%'`);
  const prev = (
    await database.query(
      'SELECT resolution_paused, daily_resolution_documents FROM concept_graph_controls WHERE singleton=true'
    )
  ).rows[0];
  const done = (
    await database.query(
      `SELECT count(*)::int AS n FROM concept_resolution_proposals WHERE created_at>=date_trunc('day',now())`
    )
  ).rows[0];
  const jobIds: string[] = [];
  try {
    await database.query(
      `UPDATE concept_graph_controls SET resolution_paused=false, daily_resolution_documents=$1 WHERE singleton=true`,
      [Number(done?.n || 0) + 1]
    );
    for (let index = 0; index < 3; index++) {
      const job = await enqueueJob('PROPOSE_CONCEPT_RESOLUTION', resolutionPayload(`${tag}`, index), {
        priority: 2,
        maxAttempts: 3,
        idempotencyKey: `test-resolution-race:${tag}:${index}`,
      });
      jobIds.push(job.id);
    }
    const results = await Promise.all(
      [0, 1, 2].map(n =>
        claimNextJob(`test-resolution-race-${n}`, ['PROPOSE_CONCEPT_RESOLUTION'], undefined, undefined, [
          RESOLUTION_BUDGET_GUARD,
        ])
      )
    );
    const claimed = results.filter(Boolean);
    assert.equal(claimed.length, 1);
    const states = (
      await database.query('SELECT status, attempts FROM jobs WHERE id = ANY($1::uuid[])', [jobIds])
    ).rows as Array<{ status: string; attempts: number }>;
    assert.equal(states.filter(row => row.status === 'PROCESSING').length, 1);
    assert.equal(states.filter(row => row.status === 'PENDING').length, 2);
    assert.ok(states.every(row => row.status !== 'FAILED'));
    assert.ok(
      states.filter(row => row.status === 'PENDING').every(row => Number(row.attempts) === 0),
      'denied jobs must not consume attempts'
    );
  } finally {
    if (jobIds.length > 0) {
      await database.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    }
    await database.query(
      'UPDATE concept_graph_controls SET resolution_paused=$1, daily_resolution_documents=$2 WHERE singleton=true',
      [prev.resolution_paused, prev.daily_resolution_documents]
    );
  }
});

maybe('paused resolution control denies claims without consuming attempts', async t => {
  const { enqueueJob, claimNextJob } = await import('./dbCore');
  const { RESOLUTION_BUDGET_GUARD } = await import('./queueManager');
  const database = await db();
  await assertIsolatedTestDb(database);
  const tag = `resolution-paused:${Date.now()}:${process.pid}`;
  await database.query(`DELETE FROM jobs WHERE idempotency_key LIKE 'test-resolution-paused:%'`);
  const prev = (
    await database.query(
      'SELECT resolution_paused, daily_resolution_documents FROM concept_graph_controls WHERE singleton=true'
    )
  ).rows[0];
  const jobIds: string[] = [];
  try {
    await database.query(
      `UPDATE concept_graph_controls SET resolution_paused=true, daily_resolution_documents=100 WHERE singleton=true`
    );
    const job = await enqueueJob('PROPOSE_CONCEPT_RESOLUTION', resolutionPayload(tag, 0), {
      priority: 2,
      maxAttempts: 3,
      idempotencyKey: `test-resolution-paused:${tag}`,
    });
    jobIds.push(job.id);
    const denied = await claimNextJob(`test-resolution-paused`, ['PROPOSE_CONCEPT_RESOLUTION'], undefined, undefined, [
      RESOLUTION_BUDGET_GUARD,
    ]);
    assert.equal(denied, null);
    const state = (
      await database.query('SELECT status, attempts FROM jobs WHERE id=$1::uuid', [job.id])
    ).rows[0] as { status: string; attempts: number };
    assert.equal(state.status, 'PENDING');
    assert.equal(Number(state.attempts), 0);
  } finally {
    if (jobIds.length > 0) {
      await database.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    }
    await database.query(
      'UPDATE concept_graph_controls SET resolution_paused=$1, daily_resolution_documents=$2 WHERE singleton=true',
      [prev.resolution_paused, prev.daily_resolution_documents]
    );
  }
});

maybe('processed resolution job transitions to COMPLETED, never stuck PROCESSING', async t => {
  const { enqueueJob, claimNextJob } = await import('./dbCore');
  const { RESOLUTION_BUDGET_GUARD } = await import('./queueManager');
  const { processConceptResolutionJob } = await import('./conceptGraph');
  const database = await db();
  await assertIsolatedTestDb(database);
  const tag = `resolution-complete:${Date.now()}:${process.pid}`;
  await database.query(`DELETE FROM jobs WHERE idempotency_key LIKE 'test-resolution-complete:%'`);
  const prev = (
    await database.query(
      'SELECT resolution_paused, daily_resolution_documents FROM concept_graph_controls WHERE singleton=true'
    )
  ).rows[0];
  assert.ok(prev, 'concept_graph_controls singleton must exist');
  const done = (
    await database.query(
      `SELECT count(*)::int AS n FROM concept_resolution_proposals WHERE created_at>=date_trunc('day',now())`
    )
  ).rows[0];
  const jobIds: string[] = [];
  // term_surfaces rows are append-only; resolutionPayload() generates a unique
  // per-run surface literal, keeping reruns deterministic without deleting them.
  try {
    await database.query(
      `UPDATE concept_graph_controls SET resolution_paused=false, daily_resolution_documents=$1 WHERE singleton=true`,
      [Number(done?.n || 0) + 1]
    );
    const job = await enqueueJob('PROPOSE_CONCEPT_RESOLUTION', resolutionPayload(tag, 0), {
      priority: 2,
      maxAttempts: 3,
      idempotencyKey: `test-resolution-complete:${tag}`,
    });
    jobIds.push(job.id);
    const claimed = await claimNextJob(`test-resolution-complete`, ['PROPOSE_CONCEPT_RESOLUTION'], undefined, undefined, [
      RESOLUTION_BUDGET_GUARD,
    ]);
    assert.ok(claimed);
    assert.equal(claimed?.id, job.id);
    // Successful processing transitions the job out of PROCESSING exactly
    // like every other queue processor: it must not remain PROCESSING.
    await processConceptResolutionJob({ id: job.id, payload: resolutionPayload(tag, 0) });
    const state = (
      await database.query('SELECT status FROM jobs WHERE id=$1::uuid', [job.id])
    ).rows[0] as { status: string };
    assert.equal(state.status, 'COMPLETED');
    // And the proposal is deterministically recorded exactly once.
    const proposals = (
      await database.query(
        `SELECT count(*)::int AS n FROM concept_resolution_proposals WHERE candidate_key=$1`,
        [`test-resolution:${tag}:0`]
      )
    ).rows[0];
    assert.equal(Number(proposals?.n || 0), 1);
  } finally {
    if (jobIds.length > 0) {
      await database.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    }
    await database.query(
      'UPDATE concept_graph_controls SET resolution_paused=$1, daily_resolution_documents=$2 WHERE singleton=true',
      [prev.resolution_paused, prev.daily_resolution_documents]
    );
  }
});

maybe('crashed-after-persist resolution recovers to terminal instead of stranding', async t => {
  const { enqueueJob, claimNextJob } = await import('./dbCore');
  const { RESOLUTION_BUDGET_GUARD } = await import('./queueManager');
  const { processConceptResolutionJob } = await import('./conceptGraph');
  const database = await db();
  await assertIsolatedTestDb(database);
  const tag = `resolution-recover:${Date.now()}:${process.pid}`;
  await database.query(`DELETE FROM jobs WHERE idempotency_key LIKE 'test-resolution-recover:%'`);
  const prev = (
    await database.query(
      'SELECT resolution_paused, daily_resolution_documents FROM concept_graph_controls WHERE singleton=true'
    )
  ).rows[0];
  assert.ok(prev, 'concept_graph_controls singleton must exist');
  const done = (
    await database.query(
      `SELECT count(*)::int AS n FROM concept_resolution_proposals WHERE created_at>=date_trunc('day',now())`
    )
  ).rows[0];
  const jobIds: string[] = [];
  try {
    // Zero headroom: the budget is exactly spent. A fresh job is denied…
    await database.query(
      `UPDATE concept_graph_controls SET resolution_paused=false, daily_resolution_documents=$1 WHERE singleton=true`,
      [Number(done?.n || 0)]
    );
    const fresh = await enqueueJob('PROPOSE_CONCEPT_RESOLUTION', resolutionPayload(tag, 0), {
      priority: 1,
      maxAttempts: 3,
      idempotencyKey: `test-resolution-recover:${tag}:fresh`,
    });
    jobIds.push(fresh.id);
    assert.equal(
      await claimNextJob(`test-resolution-recover-fresh`, ['PROPOSE_CONCEPT_RESOLUTION'], undefined, undefined, [
        RESOLUTION_BUDGET_GUARD,
      ]),
      null
    );
    // …but a job whose proposal was already persisted (crash between the
    // insert and completeJob) is re-admitted with zero new units: the retry
    // creates nothing new (proposal_key idempotent) and the run below
    // completes it instead of stranding it behind its own spent budget.
    // Reproduce the persisted state by processing once with headroom.
    await database.query(
      `UPDATE concept_graph_controls SET daily_resolution_documents=$1 WHERE singleton=true`,
      [Number(done?.n || 0) + 1]
    );
    const crashed = await enqueueJob('PROPOSE_CONCEPT_RESOLUTION', resolutionPayload(tag, 1), {
      priority: 5,
      maxAttempts: 3,
      idempotencyKey: `test-resolution-recover:${tag}:crashed`,
    });
    jobIds.push(crashed.id);
    const firstClaim = await claimNextJob(
      `test-resolution-recover-claim`,
      ['PROPOSE_CONCEPT_RESOLUTION'],
      undefined,
      undefined,
      [RESOLUTION_BUDGET_GUARD]
    );
    assert.ok(firstClaim);
    assert.equal(firstClaim?.id, crashed.id);
    // Simulate the crash: proposal persisted by processing, but completion
    // lost — put the job back to PENDING as stale recovery would, then close
    // the budget exactly (its own proposal now consumes the single unit).
    await processConceptResolutionJob({ id: crashed.id, payload: resolutionPayload(tag, 1) });
    await database.query(
      `UPDATE jobs SET status='PENDING', locked_by=NULL, locked_at=NULL, updated_at=now() WHERE id=$1::uuid`,
      [crashed.id]
    );
    const retry = await claimNextJob(
      `test-resolution-recover-retry`,
      ['PROPOSE_CONCEPT_RESOLUTION'],
      undefined,
      undefined,
      [RESOLUTION_BUDGET_GUARD]
    );
    assert.ok(retry, 'idempotent retry must be admitted despite the exhausted budget');
    assert.equal(retry?.id, crashed.id);
    await processConceptResolutionJob({ id: crashed.id, payload: resolutionPayload(tag, 1) });
    const terminal = (
      await database.query('SELECT status FROM jobs WHERE id=$1::uuid', [crashed.id])
    ).rows[0] as { status: string };
    assert.equal(terminal.status, 'COMPLETED');
    // Still exactly one proposal: no duplicate creation, no double counting.
    const proposals = (
      await database.query(`SELECT count(*)::int AS n FROM concept_resolution_proposals WHERE candidate_key=$1`, [
        `test-resolution:${tag}:1`,
      ])
    ).rows[0];
    assert.equal(Number(proposals?.n || 0), 1);
  } finally {
    if (jobIds.length > 0) {
      await database.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    }
    await database.query(
      'UPDATE concept_graph_controls SET resolution_paused=$1, daily_resolution_documents=$2 WHERE singleton=true',
      [prev.resolution_paused, prev.daily_resolution_documents]
    );
  }
});
