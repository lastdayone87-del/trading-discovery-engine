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
 * otherwise. All fixtures use unique tags with pre-cleanup (interrupted runs
 * cannot pollute later ones) and every control mutation is restored in
 * finally blocks; claimed jobs are deleted (attempts cascade).
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

async function db() {
  const { getDb } = await import('./dbCore');
  return getDb();
}

async function assertIsolatedTestDb(database: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }) {
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
    `SELECT count(*)::int AS n FROM jobs WHERE type IN ('TERM_HARVEST','SCORE_CANDIDATES') AND status IN ('PENDING','PROCESSING')`
  );
  assert.equal(
    Number(live.rows[0]?.n || 0),
    0,
    'refusing to run while harvest/scoring jobs are live: a worker may be active on this database'
  );
  // Deterministic budgets: today's ledgers must be empty so exact headroom
  // assertions (budget 1, groups 5 vs 3) cannot be skewed by other activity.
  const runsToday = await database.query(
    `SELECT count(*)::int AS n FROM corpus_extraction_runs WHERE completed_at>=date_trunc('day',now())`
  );
  assert.equal(Number(runsToday.rows[0]?.n || 0), 0, 'refusing to run with pre-existing daily extraction usage');
  const snapshotsToday = await database.query(
    `SELECT count(*)::int AS n FROM candidate_feature_snapshots WHERE computed_at>=date_trunc('day',now())`
  );
  assert.equal(Number(snapshotsToday.rows[0]?.n || 0), 0, 'refusing to run with pre-existing daily scoring usage');
}

async function cleanupProbeJobs(
  database: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> },
  like: string
) {
  await database.query(`DELETE FROM jobs WHERE idempotency_key LIKE $1`, [like]).catch(() => undefined);
}

maybe('concurrent budget-guarded claims admit at most remaining headroom', async t => {
  const { enqueueJob, claimNextJob } = await import('./dbCore');
  const { TERM_HARVEST_BUDGET_GUARD } = await import('./queueManager');
  const database = await db();
  await assertIsolatedTestDb(database);
  const tag = `budget-race:${Date.now()}:${process.pid}`;
  await cleanupProbeJobs(database, 'test-budget-race:%');
  const prev = (
    await database.query('SELECT paused, daily_compute_documents FROM corpus_controls WHERE singleton=true')
  ).rows[0];
  assert.ok(prev, 'corpus_controls singleton must exist');
  const jobIds: string[] = [];
  try {
    await database.query(`UPDATE corpus_controls SET paused=false, daily_compute_documents=1 WHERE singleton=true`);
    for (let index = 0; index < 3; index++) {
      const text = `budget race probe ${tag} ${index}`;
      const job = await enqueueJob(
        'TERM_HARVEST',
        {
          payloadSchemaVersion: 1,
          channelId: 'UCbudgetrace00000000000000',
          text,
          contentHash: createHash('sha256').update(text.normalize('NFC')).digest('hex'),
          lineage: 'AUTONOMOUS',
          entityClusterKey: `budget-race-${tag}`,
          observedAt: new Date().toISOString(),
          extractorVersion: 'deterministic-ngram-v1',
        },
        { priority: 5, maxAttempts: 3, idempotencyKey: `test-budget-race:${tag}:${index}` }
      );
      jobIds.push(job.id);
    }
    // Three concurrent guarded claims against a budget of 1: exactly one may
    // be admitted (control-row lock serializes check-then-claim; in-flight
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
      await database.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]).catch(() => undefined);
    }
    await database
      .query('UPDATE corpus_controls SET paused=$1, daily_compute_documents=$2 WHERE singleton=true', [
        prev.paused,
        prev.daily_compute_documents,
      ])
      .catch(() => undefined);
  }
});

maybe('multi-span scoring job is denied when groups exceed remaining budget', async t => {
  const { getDb, enqueueJob, claimNextJob } = await import('./dbCore');
  const { SCORE_CANDIDATES_BUDGET_GUARD } = await import('./queueManager');
  const { FEATURE_SET_VERSION } = await import('./candidateScoring');
  const database = await getDb();
  await assertIsolatedTestDb(database);
  const tag = `scoring-units:${Date.now()}:${process.pid}`;
  const sourceKey = `test-scoring-units:${tag}`;
  await cleanupProbeJobs(database, 'test-scoring-units:%');
  const prev = (
    await database.query(
      'SELECT scoring_paused, daily_scoring_candidates FROM candidate_scoring_controls WHERE singleton=true'
    )
  ).rows[0];
  assert.ok(prev, 'candidate_scoring_controls singleton must exist');
  const jobIds: string[] = [];
  try {
    // Fixture document with 5 distinct normalized spans.
    const artifact = await database.query(
      `INSERT INTO corpus_source_artifacts(source_type,source_key,creator_channel_id,discovery_lineage,entity_cluster_key,observed_at,policy_version)
       VALUES('CHANNEL_METADATA',$1,'UCscoringunits00000000','AUTONOMOUS',$2,now(),'corpus-policy-v1') RETURNING id`,
      [sourceKey, `scoring-units-${tag}`]
    );
    const document = await database.query(
      `INSERT INTO corpus_documents(artifact_id,document_kind,content_hash,retained_excerpt,retention_class,extractor_eligible,retention_expires_at)
       VALUES($1,'CHANNEL_METADATA',$2,'excerpt','MINIMAL_EXCERPT',true,now()+interval '90 days') RETURNING id`,
      [artifact.rows[0].id, `scoring-units-hash-${tag}`]
    );
    const documentId = String(document.rows[0].id);
    const run = await database.query(
      `INSERT INTO corpus_extraction_runs(document_id,extractor_version,status,token_count,candidate_count)
       VALUES($1,'deterministic-ngram-v1','COMPLETED',1,5) RETURNING id`,
      [documentId]
    );
    for (let span = 0; span < 5; span++) {
      await database.query(
        `INSERT INTO corpus_candidate_occurrences(extraction_run_id,document_id,literal_span,normalized_span,start_offset,end_offset,ngram_size,occurrence_key)
         VALUES($1,$2,$3,$3,$4,$5,1,$6) ON CONFLICT(occurrence_key) DO NOTHING`,
        [run.rows[0].id, documentId, `scoring span ${tag} ${span}`, span * 10, span * 10 + 5, `test-scoring-units:${tag}:${span}`]
      );
    }
    await database.query(
      `UPDATE candidate_scoring_controls SET scoring_paused=false, daily_scoring_candidates=3 WHERE singleton=true`
    );
    const job = await enqueueJob(
      'SCORE_CANDIDATES',
      { payloadSchemaVersion: 1, documentId, featureSetVersion: FEATURE_SET_VERSION },
      { priority: 4, maxAttempts: 3, idempotencyKey: `test-scoring-units:${tag}` }
    );
    jobIds.push(job.id);
    // 5 groups > 3 remaining: denied, job stays PENDING with attempts untouched.
    const denied = await claimNextJob(`test-scoring-units`, ['SCORE_CANDIDATES'], undefined, undefined, [
      SCORE_CANDIDATES_BUDGET_GUARD,
    ]);
    assert.equal(denied, null);
    const deniedState = (
      await database.query('SELECT status, attempts FROM jobs WHERE id=$1::uuid', [job.id])
    ).rows[0] as { status: string; attempts: number };
    assert.equal(deniedState.status, 'PENDING');
    assert.equal(Number(deniedState.attempts), 0);
    // Raise the budget to exactly cover the groups: admitted.
    await database.query(
      `UPDATE candidate_scoring_controls SET daily_scoring_candidates=5 WHERE singleton=true`
    );
    const admitted = await claimNextJob(`test-scoring-units-2`, ['SCORE_CANDIDATES'], undefined, undefined, [
      SCORE_CANDIDATES_BUDGET_GUARD,
    ]);
    assert.ok(admitted);
    assert.equal(admitted?.id, job.id);
  } finally {
    if (jobIds.length > 0) {
      await database.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]).catch(() => undefined);
    }
    await database
      .query(
        `DELETE FROM corpus_candidate_occurrences WHERE occurrence_key LIKE 'test-scoring-units:%'`
      )
      .catch(() => undefined);
    await database
      .query(`DELETE FROM corpus_documents WHERE content_hash LIKE 'scoring-units-hash-%'`)
      .catch(() => undefined);
    await database
      .query(`DELETE FROM corpus_source_artifacts WHERE source_key LIKE 'test-scoring-units:%'`)
      .catch(() => undefined);
    await database
      .query('UPDATE candidate_scoring_controls SET scoring_paused=$1, daily_scoring_candidates=$2 WHERE singleton=true', [
        prev.scoring_paused,
        prev.daily_scoring_candidates,
      ])
      .catch(() => undefined);
  }
});

maybe('shared corpus budget blocks both harvest claims and research writes', async t => {
  const { getDb, claimNextJob, enqueueJob } = await import('./dbCore');
  const { TERM_HARVEST_BUDGET_GUARD } = await import('./queueManager');
  const { persistResearchCorpusDocument } = await import('./persistentResearchPhase3');
  const database = await getDb();
  await assertIsolatedTestDb(database);
  const tag = `both-consumers:${Date.now()}:${process.pid}`;
  await cleanupProbeJobs(database, 'test-both-consumers:%');
  const prev = (
    await database.query('SELECT paused, daily_compute_documents FROM corpus_controls WHERE singleton=true')
  ).rows[0];
  assert.ok(prev, 'corpus_controls singleton must exist');
  const text = `both consumers probe ${tag} trading markets analysis`;
  const contentHash = createHash('sha256').update(text.normalize('NFC')).digest('hex');
  const researchDocumentIds: string[] = [];
  try {
    await database.query(`UPDATE corpus_controls SET paused=false, daily_compute_documents=1 WHERE singleton=true`);
    // Consume the single unit through the research path first. (This also
    // enqueues a scoring job for the new document; tracked for cleanup.)
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
    const job = await enqueueJob(
      'TERM_HARVEST',
      {
        payloadSchemaVersion: 1,
        channelId: 'UCbothconsumers0000000000',
        text: `both consumers harvest ${tag}`,
        contentHash: createHash('sha256').update(`both consumers harvest ${tag}`.normalize('NFC')).digest('hex'),
        lineage: 'AUTONOMOUS',
        entityClusterKey: `both-consumers-${tag}`,
        observedAt: new Date().toISOString(),
        extractorVersion: 'deterministic-ngram-v1',
      },
      { priority: 5, maxAttempts: 3, idempotencyKey: `test-both-consumers:${tag}` }
    );
    try {
      const denied = await claimNextJob(`test-both-consumers`, ['TERM_HARVEST'], undefined, undefined, [
        TERM_HARVEST_BUDGET_GUARD,
      ]);
      assert.equal(denied, null);
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
      await database.query('DELETE FROM jobs WHERE id=$1::uuid', [job.id]).catch(() => undefined);
    }
  } finally {
    if (researchDocumentIds.length > 0) {
      await database
        .query(`DELETE FROM jobs WHERE payload->>'documentId' = ANY($1::text[])`, [researchDocumentIds])
        .catch(() => undefined);
    }
    await database.query('DELETE FROM corpus_candidate_occurrences WHERE document_id IN (SELECT id FROM corpus_documents WHERE content_hash LIKE $1)', [`both consumers%${tag}%`]).catch(() => undefined);
    await database.query('DELETE FROM corpus_extraction_runs WHERE document_id IN (SELECT id FROM corpus_documents WHERE content_hash LIKE $1)', [`both consumers%${tag}%`]).catch(() => undefined);
    await database.query('DELETE FROM corpus_qualification_decisions WHERE document_id IN (SELECT id FROM corpus_documents WHERE content_hash LIKE $1)', [`both consumers%${tag}%`]).catch(() => undefined);
    await database.query('DELETE FROM corpus_documents WHERE content_hash LIKE $1', [`both consumers%${tag}%`]).catch(() => undefined);
    await database.query('DELETE FROM corpus_source_artifacts WHERE source_key LIKE $1', [`test-both-consumers:%`]).catch(() => undefined);
    await database
      .query('UPDATE corpus_controls SET paused=$1, daily_compute_documents=$2 WHERE singleton=true', [
        prev.paused,
        prev.daily_compute_documents,
      ])
      .catch(() => undefined);
  }
});
