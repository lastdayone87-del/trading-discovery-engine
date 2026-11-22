import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

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

function assertUsesReservationIndex(plan: unknown): void {
  const nodes = planNodes(plan);
  assert.ok(
    nodes.some(node => String(node['Index Name'] || '') === 'idx_quota_reservations_reserved_expiry'),
    'plan must use the partial active-reservation index',
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
  await db.query(`
    CREATE TABLE quota_tracker (
      id text PRIMARY KEY,
      units_used integer NOT NULL DEFAULT 0,
      daily_limit integer NOT NULL DEFAULT 10000,
      last_reset text NOT NULL
    );
    INSERT INTO quota_tracker(id, units_used, daily_limit, last_reset)
    VALUES ('youtube', 1234, 10000, '2026-11-22');
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
    INSERT INTO quota_reservations(operation_type, operation_id, allocation, units, status, expires_at)
    SELECT 'HISTORICAL', 'h-' || g, 'AUTONOMOUS', 1, 'CONSUMED', now() - interval '1 day'
    FROM generate_series(1, 100000) g;
    INSERT INTO quota_reservations(operation_type, operation_id, allocation, units, status, expires_at)
    SELECT 'ACTIVE', 'a-' || g, 'AUTONOMOUS', 7, 'RESERVED', now() + interval '20 minutes'
    FROM generate_series(1, 120) g;
    ANALYZE quota_reservations;
  `);
}

async function buildIndex(): Promise<void> {
  await requirePool().query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quota_reservations_reserved_expiry
      ON public.quota_reservations (expires_at)
      INCLUDE (units, operation_type, operation_id)
      WHERE status='RESERVED'
  `);
  await requirePool().query(`ANALYZE quota_reservations`);
}

maybe('migration 207 adopts the partial index and the hot aggregate stays off a sequential scan', async () => {
  pool = new pg.Pool({ connectionString: dedicatedUrl, max: 6 });
  await resetSchema();
  await buildIndex();

  // The migration must accept the concurrently-built index. If the definition
  // drifted, its DO block raises and this test fails.
  const migration207 = readFileSync(
    new URL('./db/migrations/207_quota_reservation_active_index.sql', import.meta.url),
    'utf8',
  );
  await requirePool().query(migration207);

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
});

maybe('a held per-key charge row cannot block a tracker-only reservation', async () => {
  const db = requirePool();
  const charge: PoolClient = await db.connect();
  const reservation: PoolClient = await db.connect();
  try {
    await charge.query(`BEGIN`);
    await charge.query(
      `INSERT INTO youtube_key_quota_usage(quota_day,key_fingerprint,key_index,units_used,daily_limit)
       VALUES('2026-11-22','fp-lock-test',1,100,10000)
       ON CONFLICT(quota_day,key_fingerprint) DO UPDATE SET units_used=youtube_key_quota_usage.units_used+excluded.units_used`,
    );

    await reservation.query(`BEGIN`);
    await reservation.query(`SET LOCAL lock_timeout='1500ms'`);
    await reservation.query(
      `INSERT INTO quota_tracker(id,units_used,daily_limit,last_reset)
       VALUES('youtube',100,10000,'2026-11-22')
       ON CONFLICT(id) DO UPDATE SET units_used=quota_tracker.units_used+excluded.units_used`,
    );
    await reservation.query(`COMMIT`);
  } finally {
    await charge.query(`ROLLBACK`).catch(() => undefined);
    charge.release();
    reservation.release();
  }
});

after(async () => {
  if (!pool) return;
  try {
    await pool.query(`DROP TABLE IF EXISTS quota_reservations`);
    await pool.query(`DROP TABLE IF EXISTS youtube_key_quota_usage`);
    await pool.query(`DROP TABLE IF EXISTS quota_tracker`);
  } finally {
    await pool.end();
  }
});
