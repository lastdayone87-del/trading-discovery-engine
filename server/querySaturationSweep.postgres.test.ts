import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runQuerySaturationSweep } from './querySaturationSweep';

const databaseUrl = process.env.QUERY_SATURATION_TEST_DATABASE_URL;
const maybe = databaseUrl ? test : test.skip;

/**
 * Executes the production saturation SQL against a real PostgreSQL fixture.
 * Stored completion snapshots deliberately disagree with current sightings so
 * a stale implementation cannot pass these assertions.
 */
maybe('saturation sweep reads current sightings, excludes degraded runs, and writes reversible dormancy', async t => {
  const pool = new Pool({ connectionString: databaseUrl! });
  const client = await pool.connect();
  t.after(async () => {
    client.release();
    await pool.end();
  });
  await client.query(`
    CREATE TEMP TABLE query_library (
      id int primary key, status text, collection text,
      next_eligible_at timestamptz, generation_metadata jsonb
    );
    CREATE TEMP TABLE query_runs (
      id int primary key, query_id int, country text, status text,
      completed_at timestamptz, distinct_results int, known_channels int,
      duplicate_results int, quota_used int, raw_results int, performance_details jsonb
    );
    CREATE TEMP TABLE channel_sightings (
      query_run_id int, channel_id text, persisted boolean, was_known boolean,
      funnel_outcome text, country_outcome text
    );
    CREATE TEMP TABLE channels (channel_id text primary key, quality_score int);
  `);

  const insertLibrary = `INSERT INTO query_library(id,status,collection,next_eligible_at,generation_metadata)
    VALUES($1,'ACTIVE','EXPERIMENTAL',NULL,'{}'::jsonb)`;
  const insertRun = `INSERT INTO query_runs(
    id,query_id,country,status,completed_at,distinct_results,known_channels,
    duplicate_results,quota_used,raw_results,performance_details
  ) VALUES($1,$2,'Canada','COMPLETED',now()-interval '3 days',30,$3,$4,100,30,$5::jsonb)`;

  // Query 101: eight clean, exhausted runs. Stored snapshot claims zero
  // pending, but current sightings contain 60 unresolved classifications.
  await client.query(insertLibrary, [101]);
  for (let i = 0; i < 8; i++) {
    await client.query(insertRun, [1010 + i, 101, 29, 10, { providerRequestsFailed: 0, providerRateLimited: 0, classificationPending: 0 }]);
  }
  for (let i = 0; i < 60; i++) {
    await client.query(`INSERT INTO channel_sightings VALUES(1010,$1,true,true,'CLASSIFICATION_PENDING',NULL)`, [`pending-${i}`]);
  }

  // Query 102: six clean runs plus one provider-degraded run. If the degraded
  // run is counted, the query reaches the seven-run maturity threshold.
  await client.query(insertLibrary, [102]);
  for (let i = 0; i < 6; i++) {
    await client.query(insertRun, [1020 + i, 102, 29, 10, { providerRequestsFailed: 0, providerRateLimited: 0 }]);
  }
  await client.query(insertRun, [1029, 102, 29, 10, { providerRequestsFailed: 1, providerRateLimited: 0 }]);

  // Query 103: eight clean runs with fresh, quality-confirmed creators.
  await client.query(insertLibrary, [103]);
  for (let i = 0; i < 8; i++) {
    await client.query(insertRun, [1030 + i, 103, 20, 2, { providerRequestsFailed: 0, providerRateLimited: 0 }]);
    await client.query(`INSERT INTO channels VALUES($1,80)`, [`fresh-${i}`]);
    await client.query(`INSERT INTO channel_sightings VALUES($1,$2,true,false,'TRADING_CONFIRMED','CONFIRMED')`, [1030 + i, `fresh-${i}`]);
  }

  // Query 104: eight clean, exhausted runs with no pending sightings. This is
  // the positive dormancy path.
  await client.query(insertLibrary, [104]);
  for (let i = 0; i < 8; i++) {
    await client.query(insertRun, [1040 + i, 104, 29, 10, { providerRequestsFailed: 0, providerRateLimited: 0 }]);
  }

  const readSetting = async (_key: string, fallback: string) => fallback;
  const result = await runQuerySaturationSweep({
    db: client,
    readSetting,
    now: new Date('2026-11-16T00:00:00.000Z'),
    dormancyDays: 14,
  });

  assert.equal(result.insufficient, 2, 'pending-current and degraded-only queries are insufficient');
  assert.equal(result.active, 1, 'fresh creators keep their query active');
  assert.equal(result.dormant, 1, 'only the clean exhausted query becomes dormant');

  const dormant = (await client.query(`SELECT next_eligible_at, generation_metadata FROM query_library WHERE id=104`)).rows[0];
  assert.ok(dormant.next_eligible_at);
  assert.equal(dormant.generation_metadata.saturation.state, 'DORMANT');

  for (const id of [101, 102, 103]) {
    const row = (await client.query(`SELECT next_eligible_at FROM query_library WHERE id=$1`, [id])).rows[0];
    assert.equal(row.next_eligible_at, null);
  }
});
