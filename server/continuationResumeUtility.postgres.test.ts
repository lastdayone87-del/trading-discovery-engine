import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { listPendingAutonomousRuns } from './autonomousPageStore';

const databaseUrl = process.env.CONTINUATION_RESUME_TEST_DATABASE_URL;
const maybe = databaseUrl ? test : test.skip;

/**
 * Exercises the real resume-ranking SQL with controlled rows. The utility is
 * recomputed from page-observation components, so legacy marginal_utility_v2
 * values cannot influence ordering and zero-creator pages cannot win the
 * NULL/LEAST edge case.
 */
maybe('resume ranking orders creator utility from controlled pending rows', async t => {
  const pool = new Pool({ connectionString: databaseUrl! });
  const client = await pool.connect();
  t.after(async () => {
    client.release();
    await pool.end();
  });
  await client.query(`
    CREATE TEMP TABLE query_library (id int primary key, query text);
    CREATE TEMP TABLE query_runs (
      id int primary key, query_id int, country text, source text, pages_completed int,
      next_page_token text, resume_mode text, continuation_status text, deferred_until timestamptz,
      continued_to_run_id text, last_page_at timestamptz, started_at timestamptz,
      scheduled_at timestamptz, exploration_pages_remaining int, retrieval_lane text,
      search_ordering text, retrieval_config_key text, retrieval_treatment_origin text,
      requested_page_depth int, metadata jsonb, provider_allocation_snapshot jsonb, status text
    );
    CREATE TEMP TABLE autonomous_query_page_observations (
      query_run_id int, page_number int, marginal_quality_creators int,
      marginal_confirmed_creators int, marginal_new_creators int,
      marginal_non_trading_creators int, distinct_creator_count int,
      country_precision numeric, duplicate_ratio numeric, marginal_utility_v2 numeric
    );
    CREATE TEMP TABLE jobs (id int, status text, idempotency_key text);
  `);
  await client.query(`INSERT INTO query_library(id, query) VALUES (1,'one'),(2,'two')`);
  const insertRun = `INSERT INTO query_runs(
    id, query_id, country, source, pages_completed, continuation_status, scheduled_at, status
  ) VALUES ($1,$2,'Canada','automated_query',0,'RUNNING',now(),'RUNNING')`;
  await client.query(insertRun, [11, 1]);
  await client.query(insertRun, [12, 2]);

  // Run 11 has no distinct creators. PostgreSQL LEAST ignores NULL, so without
  // COALESCE this page would rank as fully productive.
  await client.query(
    `INSERT INTO autonomous_query_page_observations(
       query_run_id,page_number,marginal_quality_creators,marginal_confirmed_creators,
       marginal_new_creators,marginal_non_trading_creators,distinct_creator_count,
       country_precision,duplicate_ratio,marginal_utility_v2
     ) VALUES (11,1,0,0,0,0,0,0,0,1)`,
  );
  // Run 12 has strong creator metrics but a zero legacy score, proving the
  // resume order is recomputed rather than read from marginal_utility_v2.
  await client.query(
    `INSERT INTO autonomous_query_page_observations(
       query_run_id,page_number,marginal_quality_creators,marginal_confirmed_creators,
       marginal_new_creators,marginal_non_trading_creators,distinct_creator_count,
       country_precision,duplicate_ratio,marginal_utility_v2
     ) VALUES (12,1,8,8,8,0,10,1,0,0)`,
  );

  const ranked = await listPendingAutonomousRuns(5, client);
  assert.deepEqual(ranked.map(run => run.runId), ['12', '11']);
  assert.ok(ranked[0].marginalUtility > ranked[1].marginalUtility);
  assert.equal(ranked[1].marginalUtility, 0);
});
