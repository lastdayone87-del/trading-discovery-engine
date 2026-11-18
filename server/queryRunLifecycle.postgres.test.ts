import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { completeQueryRun, coolQueryForProviderQuarantine, failJob, failQueryRun, getDb, startQueryRun } from './db';

const databaseUrl = process.env.PHASE4_POSTGRES_URL;

after(async () => {
  if (!databaseUrl) return;
  const db = await getDb().catch(() => null);
  if (db) await db.end().catch(() => undefined);
});
const metrics = {
  rawResults: 1, distinctResults: 1, duplicateResults: 0, knownChannels: 0,
  newChannels: 1, countryRejected: 0, nonTrading: 0, uncertain: 0, needsReview: 0,
  tradingConfirmed: 0, uniqueChannels: 1, qualityChannels: 0, communitiesDiscovered: 0,
  quotaUsed: 100
};

test('Stage 4 PostgreSQL: provider-linked completion is success-gated and terminal states are monotonic', { skip: databaseUrl ? false : 'PHASE4_POSTGRES_URL is required' }, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `stage4-${Date.now()}-${process.pid}`;
  let queryId: number | undefined;
  const runIds: string[] = [];
  try {
    queryId = (await db.query(
      `INSERT INTO query_library(query,country,collection,intent,normalized_query)
       VALUES($1,'BR','EXPERIMENTAL','GENERAL',$1) RETURNING id`, [suffix]
    )).rows[0].id;

    const providerSnapshot = JSON.stringify({
      providerKey: 'youtube-search', retrievalSurface: 'YOUTUBE_NATIVE',
      capability: 'SEARCH_YOUTUBE', costDomain: 'YOUTUBE_DATA_API', continuationOwner: 'PHASE_9',
    });
    const run = (await db.query(
      `INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,retrieval_lane,search_ordering,provider_key,retrieval_surface,provider_capability,cost_domain,provider_allocation_snapshot)
       VALUES($1,'BR','automated_query','RUNNING','BASELINE','stage4','VIDEO','RELEVANCE','youtube-search','YOUTUBE_NATIVE','SEARCH_YOUTUBE','YOUTUBE_DATA_API',$2::jsonb) RETURNING id`, [queryId, providerSnapshot]
    )).rows[0];
    runIds.push(run.id);

    await assert.rejects(
      completeQueryRun(run.id, metrics),
      /provider|SUCCESS|completion/i,
      'a YouTube run without a successful provider event must not complete'
    );
    assert.equal((await db.query('SELECT status FROM query_runs WHERE id=$1', [run.id])).rows[0].status, 'RUNNING');

    await db.query(
      `INSERT INTO provider_call_events(id,provider,operation,request_id,run_id,job_id,attempt,status,latency_ms,reserved_cost,actual_cost,policy_version)
       VALUES($1,'youtube','search',$2,$3,$4,1,'SUCCESS',10,100,100,'stage4-test')`,
      [randomUUID(), `${run.id}:attempt:1`, run.id, `job-${suffix}`]
    );
    await completeQueryRun(run.id, metrics);
    assert.equal((await db.query('SELECT status FROM query_runs WHERE id=$1', [run.id])).rows[0].status, 'COMPLETED');

    await failQueryRun(run.id, new Error('late provider failure'), true);
    const afterLateFailure = (await db.query('SELECT status FROM query_runs WHERE id=$1', [run.id])).rows[0];
    assert.equal(afterLateFailure.status, 'COMPLETED', 'a late failure must not overwrite COMPLETED');

    const retryRun = (await db.query(
      `INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,retrieval_lane,search_ordering,provider_key,retrieval_surface,provider_capability,cost_domain,provider_allocation_snapshot)
       VALUES($1,'BR','automated_query','RUNNING','BASELINE','stage4 retry','VIDEO','RELEVANCE','youtube-search','YOUTUBE_NATIVE','SEARCH_YOUTUBE','YOUTUBE_DATA_API',$2::jsonb) RETURNING id`, [queryId, providerSnapshot]
    )).rows[0];
    runIds.push(retryRun.id);
    await failQueryRun(retryRun.id, Object.assign(new Error('temporary provider outage'), { code: 'ETIMEDOUT' }), false);
    assert.equal((await db.query('SELECT status FROM query_runs WHERE id=$1', [retryRun.id])).rows[0].status, 'RETRYING');
    assert.equal(await startQueryRun(retryRun.id), true);
    assert.equal((await db.query('SELECT status FROM query_runs WHERE id=$1', [retryRun.id])).rows[0].status, 'RUNNING');
    await failQueryRun(retryRun.id, new Error('terminal provider failure'), true);
    assert.equal((await db.query('SELECT status FROM query_runs WHERE id=$1', [retryRun.id])).rows[0].status, 'FAILED');
    assert.equal(await startQueryRun(retryRun.id), false);
  } finally {
    await db.query('DELETE FROM discovery_evaluation_run_observations WHERE query_run_id=ANY($1::uuid[])', [runIds]).catch(() => undefined);
    await db.query('DELETE FROM provider_call_events WHERE run_id=ANY($1::text[])', [runIds]).catch(() => undefined);
    await db.query('DELETE FROM query_runs WHERE id=ANY($1::uuid[])', [runIds]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
  }
});


test('Stage 4 PostgreSQL: a quarantined search input cools the query without shortening a later cooldown', { skip: databaseUrl ? false : 'PHASE4_POSTGRES_URL is required' }, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `quarantine-${Date.now()}-${process.pid}`;
  const value = `${suffix}-hash`;
  let queryId: number | undefined;
  try {
    queryId = (await db.query(
      `INSERT INTO query_library(query,country,collection,intent,normalized_query)
       VALUES($1,'LU','EXPERIMENTAL','GENERAL',$1) RETURNING id`, [suffix]
    )).rows[0].id;
    await db.query(
      `INSERT INTO youtube_invalid_input_quarantine(input_kind,input_value,operation,first_seen,last_seen,hits,expires_at)
       VALUES('searchQuery',$1,'search-test',now(),now(),1,now()+interval '2 days')
       ON CONFLICT(input_kind,input_value) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
      [value]
    );
    await coolQueryForProviderQuarantine(queryId, 'searchQuery', value, db);
    let row = (await db.query('SELECT next_eligible_at FROM query_library WHERE id=$1', [queryId])).rows[0];
    let days = (new Date(row.next_eligible_at).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 1.9 && days < 2.1, `expected the quarantine expiry, got ${days} days`);

    await db.query(`UPDATE query_library SET next_eligible_at=now()+interval '10 days' WHERE id=$1`, [queryId]);
    await coolQueryForProviderQuarantine(queryId, 'searchQuery', value, db);
    row = (await db.query('SELECT next_eligible_at FROM query_library WHERE id=$1', [queryId])).rows[0];
    days = (new Date(row.next_eligible_at).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 9.9, `expected the later cooldown to win, got ${days} days`);

    await db.query('DELETE FROM youtube_invalid_input_quarantine WHERE input_value=$1', [value]);
    await db.query('UPDATE query_library SET next_eligible_at=NULL WHERE id=$1', [queryId]);
    await coolQueryForProviderQuarantine(queryId, 'searchQuery', value, db);
    row = (await db.query('SELECT next_eligible_at FROM query_library WHERE id=$1', [queryId])).rows[0];
    const hours = (new Date(row.next_eligible_at).getTime() - Date.now()) / 3_600_000;
    assert.ok(hours > 0.9 && hours < 1.1, `expected the one-hour fallback, got ${hours} hours`);
  } finally {
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
    await db.query('DELETE FROM youtube_invalid_input_quarantine WHERE input_value=$1', [value]).catch(() => undefined);
  }
});

test('Stage 4 PostgreSQL: a quarantined search input is a terminal job failure', { skip: databaseUrl ? false : 'PHASE4_POSTGRES_URL is required' }, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const jobId = randomUUID();
  try {
    await db.query(
      `INSERT INTO jobs(id,type,payload,priority,max_attempts,status,attempts)
       VALUES($1,'SEARCH_YOUTUBE','{}'::jsonb,20,3,'PROCESSING',1)`,
      [jobId]
    );
    const disposition = await failJob(
      jobId,
      Object.assign(new Error('quarantined search input'), { code: 'YOUTUBE_INPUT_QUARANTINED', inputKind: 'searchQuery' }),
      { db, now: Date.now() },
    );
    assert.equal(disposition, 'FAILED');
    const row = (await db.query('SELECT status,terminal_failure_class FROM jobs WHERE id=$1', [jobId])).rows[0];
    assert.equal(row.status, 'FAILED');
    assert.equal(row.terminal_failure_class, 'PERMANENT_INPUT');
  } finally {
    await db.query('DELETE FROM jobs WHERE id=$1', [jobId]).catch(() => undefined);
  }
});

test('Stage 4 lifecycle contract keeps provider events linked to existing run, job, and request fields', () => {
  const migration = readFileSync(new URL('./db/migrations/017_provider_resilience.sql', import.meta.url), 'utf8');
  assert.match(migration, /request_id TEXT/);
  assert.match(migration, /run_id TEXT/);
  assert.match(migration, /job_id TEXT/);
  assert.match(migration, /idx_provider_events_job/);
});
