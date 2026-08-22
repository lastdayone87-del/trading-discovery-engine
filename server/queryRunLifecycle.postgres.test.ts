import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { completeQueryRun, failQueryRun, getDb, startQueryRun } from './db';

const databaseUrl = process.env.PHASE4_POSTGRES_URL;
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

    const run = (await db.query(
      `INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,retrieval_lane,search_ordering,provider_key)
       VALUES($1,'BR','automated_query','RUNNING','BASELINE','stage4','VIDEO','RELEVANCE','youtube-search') RETURNING id`, [queryId]
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
      `INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,retrieval_lane,search_ordering)
       VALUES($1,'BR','automated_query','RUNNING','BASELINE','stage4 retry','VIDEO','RELEVANCE') RETURNING id`, [queryId]
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
    await db.end();
  }
});

test('Stage 4 lifecycle contract keeps provider events linked to existing run, job, and request fields', () => {
  const migration = readFileSync(new URL('./db/migrations/017_provider_resilience.sql', import.meta.url), 'utf8');
  assert.match(migration, /request_id TEXT/);
  assert.match(migration, /run_id TEXT/);
  assert.match(migration, /job_id TEXT/);
  assert.match(migration, /idx_provider_events_job/);
});
