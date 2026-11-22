import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import pg from 'pg';
import type { Pool } from 'pg';
import { tryReserveQuota } from './dbCore';
import { getYouTubeQuotaDay } from './youtubeQuotaDay';

/**
 * Live-database regression coverage for the active quota-reservation index.
 * Runs only against an explicitly provided disposable database (the CI
 * postgres service); without it every test skips.
 *
 *   QUOTA_RESERVATION_TEST_DATABASE_URL=postgresql://... \
 *     npx tsx --test server/quotaReservationIndex.postgres.test.ts
 */
const dedicatedUrl = process.env.QUOTA_RESERVATION_TEST_DATABASE_URL;

test('quota reservation index tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicatedUrl) {
    console.log('SKIP: set QUOTA_RESERVATION_TEST_DATABASE_URL to run the quota reservation PostgreSQL tests.');
  }
  assert.ok(true);
});

const maybe = dedicatedUrl ? test : test.skip;
let pool: Pool | null = null;

function requirePool(): Pool {
  assert.ok(pool, 'pool must be initialized by the schema test');
  return pool;
}

function planNodes(value: unknown, nodes: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) planNodes(item, nodes);
  } else if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (typeof node['Node Type'] === 'string') nodes.push(node);
    for (const child of Object.values(node)) planNodes(child, nodes);
  }
  return nodes;
}

function assertUsesReservationIndex(plan: unknown, indexName = 'idx_quota_reservations_reserved_expiry'): void {
  const nodes = planNodes(plan);
  assert.ok(
    nodes.some(node => String(node['Index Name'] || '') === indexName),
    `plan must use ${indexName}`,
  );
  assert.equal(
    nodes.some(node => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'quota_reservations'),
    false,
    'plan must not sequentially scan the historical reservation table',
  );
}

async function resetSchema(): Promise<void> {
  const db = requirePool();
  await db.query(`DROP TABLE IF EXISTS quota_reservations`);
  await db.query(`DROP TABLE IF EXISTS quota_tracker`);
  await db.query(`DROP TABLE IF EXISTS youtube_key_quota_usage`);
  await db.query(`DROP TABLE IF EXISTS youtube_key_cap_shadow_leases`);
  await db.query(`
    CREATE TABLE quota_tracker (
      id text PRIMARY KEY,
      units_used integer NOT NULL DEFAULT 0,
      daily_limit integer NOT NULL DEFAULT 10000,
      last_reset text NOT NULL
    );
    CREATE TABLE quota_reservations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      operation_type text NOT NULL,
      operation_id text NOT NULL,
      allocation text NOT NULL,
      units integer NOT NULL CHECK (units > 0),
      status text NOT NULL DEFAULT 'RESERVED',
      reserved_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      UNIQUE(operation_type, operation_id)
    );
    CREATE INDEX idx_quota_reservations_active
      ON quota_reservations(allocation, expires_at) WHERE status = 'RESERVED';
    CREATE TABLE youtube_key_quota_usage (
      quota_day text NOT NULL,
      key_fingerprint text NOT NULL,
      key_index integer NOT NULL,
      units_used integer NOT NULL DEFAULT 0,
      daily_limit integer NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (quota_day, key_fingerprint)
    );
    CREATE TABLE youtube_key_cap_shadow_leases (
      id bigserial PRIMARY KEY,
      quota_day text NOT NULL,
      operation_id text NOT NULL,
      key_fingerprint text NOT NULL,
      reserved_units integer NOT NULL,
      reserved_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      allocation text NOT NULL
    );
    INSERT INTO quota_reservations(operation_type, operation_id, allocation, units, status, reserved_at, expires_at)
    SELECT 'HISTORICAL', 'h-' || g, 'AUTONOMOUS', 1, 'CONSUMED', now() - interval '30 days', now() - interval '30 days'
    FROM generate_series(1, 100000) g;
    INSERT INTO quota_reservations(operation_type, operation_id, allocation, units, status, reserved_at, expires_at)
    SELECT 'RECENT_CONSUMED', 'r-' || g, 'AUTONOMOUS', 3, 'CONSUMED', now() - interval '1 day', now() - interval '1 day'
    FROM generate_series(1, 5) g;
    INSERT INTO quota_reservations(operation_type, operation_id, allocation, units, status, reserved_at, expires_at)
    SELECT 'ACTIVE', 'a-' || g, 'AUTONOMOUS', 7, 'RESERVED', now(), now() + interval '20 minutes'
    FROM generate_series(1, 120) g;
    ANALYZE quota_reservations;
  `);
  await db.query(
    `INSERT INTO quota_tracker(id, units_used, daily_limit, last_reset) VALUES ('youtube', 1234, 10000, $1)`,
    [getYouTubeQuotaDay()],
  );
}

async function buildIndexes(): Promise<void> {
  await requirePool().query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quota_reservations_reserved_expiry
      ON public.quota_reservations (expires_at)
      INCLUDE (units, operation_type, operation_id)
      WHERE status='RESERVED'
  `);
  await requirePool().query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quota_reservations_consumed_recent
      ON public.quota_reservations (reserved_at)
      INCLUDE (allocation, units)
      WHERE status='CONSUMED'
  `);
  await requirePool().query(`ANALYZE quota_reservations`);
}

maybe('migrations 207/208 adopt the partial indexes and the hot aggregates stay off a sequential scan', async () => {
  pool = new pg.Pool({ connectionString: dedicatedUrl, max: 6 });
  await resetSchema();
  await buildIndexes();

  // The migration must accept the concurrently-built index. If the definition
  // drifted, its DO block raises and this test fails.
  const migration207 = readFileSync(
    new URL('./db/migrations/207_quota_reservation_active_index.sql', import.meta.url),
    'utf8',
  );
  await requirePool().query(migration207);
  const migration208 = readFileSync(
    new URL('./db/migrations/208_quota_reservation_consumed_index.sql', import.meta.url),
    'utf8',
  );
  await requirePool().query(migration208);

  const totalsPlan = await requirePool().query(`
    EXPLAIN (FORMAT JSON)
    SELECT
      COALESCE((SELECT units_used FROM quota_tracker WHERE id='youtube'),0)::int AS actual_used,
      COALESCE((SELECT SUM(units) FROM quota_reservations
                 WHERE status='RESERVED'
                   AND NOT (operation_type='X' AND operation_id='Y')),0)::int AS reserved_total
  `);
  assertUsesReservationIndex(totalsPlan.rows[0]['QUERY PLAN']);

  const expiryPlan = await requirePool().query(`
    EXPLAIN (FORMAT JSON)
    UPDATE quota_reservations SET status='EXPIRED'
     WHERE status='RESERVED' AND expires_at<=now()
  `);
  assertUsesReservationIndex(expiryPlan.rows[0]['QUERY PLAN']);

  const consumedPlan = await requirePool().query(`
    EXPLAIN (FORMAT JSON)
    SELECT allocation,COALESCE(SUM(units),0)::int AS units
      FROM quota_reservations
     WHERE status='CONSUMED' AND reserved_at>=now()-interval '7 days'
     GROUP BY allocation
  `);
  assertUsesReservationIndex(consumedPlan.rows[0]['QUERY PLAN'], 'idx_quota_reservations_consumed_recent');
});

maybe('a held per-key charge row cannot block the production reservation path', async () => {
  const db = requirePool();
  const charge = await db.connect();
  try {
    await charge.query(`BEGIN`);
    await charge.query(
      `INSERT INTO youtube_key_quota_usage(quota_day,key_fingerprint,key_index,units_used,daily_limit)
       VALUES($1,'fp-lock-test',1,100,10000)
       ON CONFLICT(quota_day,key_fingerprint) DO UPDATE SET units_used=youtube_key_quota_usage.units_used+excluded.units_used`,
      [getYouTubeQuotaDay()],
    );

    const admitted = await Promise.race([
      tryReserveQuota({
        operationType: 'LOCK_TEST',
        operationId: 'lock-1',
        allocation: 'MANUAL',
        units: 100,
        dailyBudget: 10000,
        allocationPercent: 100,
      }, db),
      new Promise<boolean>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('reservation blocked behind a per-key row')), 1500);
        timer.unref?.();
      }),
    ]);
    assert.equal(admitted, true, 'the tracker-only admission must not wait for the held key row');
  } finally {
    await charge.query(`ROLLBACK`).catch(() => undefined);
    charge.release();
    await db.query(`DELETE FROM quota_reservations WHERE operation_type='LOCK_TEST'`).catch(() => undefined);
  }
});

maybe('an expired existing lease cannot authorize a new reservation', async () => {
  const db = requirePool();
  await db.query(
    `INSERT INTO quota_reservations(operation_type, operation_id, allocation, units, status, expires_at)
     VALUES('LOCK_TEST_EXPIRED','expired-1','MANUAL',100,'RESERVED',now()-interval '1 minute')`,
  );
  try {
    const admitted = await tryReserveQuota({
      operationType: 'LOCK_TEST_EXPIRED',
      operationId: 'expired-1',
      allocation: 'MANUAL',
      units: 100,
      // Actual + live reserved + the requested 100 already exceeds this
      // budget. Only the expired lease could make the request look funded.
      dailyBudget: 2100,
      allocationPercent: 100,
    }, db);
    assert.equal(admitted, false, 'an expired lease must not authorize provider work');
    const row = await db.query(
      `SELECT status FROM quota_reservations WHERE operation_type='LOCK_TEST_EXPIRED' AND operation_id='expired-1'`,
    );
    assert.equal(row.rows[0]?.status, 'EXPIRED');
  } finally {
    await db.query(`DELETE FROM quota_reservations WHERE operation_type='LOCK_TEST_EXPIRED'`).catch(() => undefined);
  }
});

maybe('live PROBE leases count as reserved capacity and prevent double admission', async () => {
  const db = requirePool();
  await db.query(`UPDATE quota_tracker SET units_used=1234`);
  await db.query(
    `INSERT INTO youtube_key_cap_shadow_leases
       (quota_day, operation_id, key_fingerprint, reserved_units, expires_at, allocation)
     VALUES($1,'probe-visible-1','fp-probe',1000,now()+interval '1 hour','PROBE')`,
    [getYouTubeQuotaDay()],
  );
  try {
    const denied = await tryReserveQuota({
      operationType: 'PROBE_VISIBILITY',
      operationId: 'probe-visible-1',
      allocation: 'MANUAL',
      units: 100,
      // 1234 actual + 840 live reservations + 1000 probe lease + 100 request
      // exceeds this budget only when the probe lease is counted.
      dailyBudget: 3000,
      allocationPercent: 100,
    }, db);
    assert.equal(denied, false, 'a live probe lease must not be invisible to admission');

    const admitted = await tryReserveQuota({
      operationType: 'PROBE_VISIBILITY',
      operationId: 'probe-visible-2',
      allocation: 'MANUAL',
      units: 100,
      dailyBudget: 4000,
      allocationPercent: 100,
    }, db);
    assert.equal(admitted, true, 'a larger budget remains admittable with the probe lease counted');
  } finally {
    await db.query(`DELETE FROM quota_reservations WHERE operation_type='PROBE_VISIBILITY'`).catch(() => undefined);
    await db.query(`DELETE FROM youtube_key_cap_shadow_leases WHERE operation_id LIKE 'probe-visible-%'`).catch(() => undefined);
  }
});

after(async () => {
  if (!pool) return;
  try {
    await pool.query(`DROP TABLE IF EXISTS quota_reservations`);
    await pool.query(`DROP TABLE IF EXISTS youtube_key_quota_usage`);
    await pool.query(`DROP TABLE IF EXISTS youtube_key_cap_shadow_leases`);
    await pool.query(`DROP TABLE IF EXISTS quota_tracker`);
  } finally {
    await pool.end();
  }
});
