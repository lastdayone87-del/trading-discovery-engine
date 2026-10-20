import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import {
  recordShadowDispatchSafe,
  resetShadowConfigCacheForTests,
  resetShadowSweepClockForTests,
  settleShadowLease,
  sweepShadowLeases,
  type ShadowPoolPort,
} from './quotaKeyCapShadow';
import { getYouTubeQuotaDay } from './youtubeQuotaDay';

/**
 * Live-database tests for the shadow-only per-key cap accounting. These run
 * ONLY against an explicitly provided dedicated test database (the CI
 * postgres:17 service container), never a shared or production database:
 *
 *   QUOTA_SHADOW_TEST_DATABASE_URL=postgresql://... npx tsx --test server/quotaKeyCapShadow.postgres.test.ts
 *
 * Without that variable every test below skips. The schema used here is the
 * production shape: migration 115 (youtube_key_quota_usage), migration 148
 * (shadow leases/events), and migration 151 (settlement fence), applied
 * idempotently by this suite. The quota day is the real America/Los_Angeles
 * day (same helper as the hooks) and every run uses unique key fingerprints,
 * so repeated runs never interfere.
 */
const dedicatedUrl = process.env.QUOTA_SHADOW_TEST_DATABASE_URL;

test('quota cap shadow PostgreSQL tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicatedUrl) {
    console.log(
      'SKIP: set QUOTA_SHADOW_TEST_DATABASE_URL to a dedicated test database to run the shadow cap PostgreSQL tests.'
    );
  }
  assert.ok(true);
});

const maybe = dedicatedUrl ? test : test.skip;

const migration115 = readFileSync(
  fileURLToPath(new URL('./db/migrations/115_youtube_key_quota_usage.sql', import.meta.url)),
  'utf8'
);
const migration148 = readFileSync(
  fileURLToPath(new URL('./db/migrations/148_youtube_key_cap_shadow.sql', import.meta.url)),
  'utf8'
);
const migration151 = readFileSync(
  fileURLToPath(new URL('./db/migrations/151_youtube_key_cap_shadow_settled.sql', import.meta.url)),
  'utf8'
);

const runTag = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const quotaDay = getYouTubeQuotaDay(new Date());
const keyFor = (name: string): string => `fp-${name}-${runTag}`;
const keyPattern = `fp-%-${runTag}`;
const enabledReader = async (key: string, fallback: string): Promise<string> => {
  if (key === 'youtube_key_cap_shadow_enabled') return 'true';
  if (key === 'youtube_key_cap_shadow_cap_units') return '9000';
  return fallback;
};

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

function requirePool(): Pool {
  assert.ok(pool, 'pool must be initialized by the schema test');
  return pool;
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      pool = new pg.Pool({ connectionString: dedicatedUrl, max: 25 });
      await pool.query(migration115);
      await pool.query(migration148);
      await pool.query(migration151);
    })();
  }
  return schemaReady;
}

async function seedSettledUnits(keyFingerprint: string, units: number): Promise<void> {
  await requirePool().query(
    `INSERT INTO youtube_key_quota_usage(quota_day, key_fingerprint, key_index, units_used, daily_limit)
     VALUES($1, $2, 1, $3, 10000)
     ON CONFLICT(quota_day, key_fingerprint)
     DO UPDATE SET units_used = $3, updated_at = now()`,
    [quotaDay, keyFingerprint, units]
  );
}

async function leaseCount(keyFingerprint: string): Promise<number> {
  const result = await requirePool().query(
    `SELECT count(*)::int AS count FROM youtube_key_cap_shadow_leases WHERE quota_day=$1 AND key_fingerprint=$2`,
    [quotaDay, keyFingerprint]
  );
  return Number(result.rows[0].count);
}

async function eventRows(keyFingerprint: string): Promise<Array<{ event: string; projected_units: number }>> {
  const result = await requirePool().query(
    `SELECT event, projected_units FROM youtube_key_cap_shadow_events WHERE quota_day=$1 AND key_fingerprint=$2 ORDER BY created_at ASC`,
    [quotaDay, keyFingerprint]
  );
  return result.rows;
}

after(async () => {
  if (pool) {
    try {
      await pool.query(`DELETE FROM youtube_key_cap_shadow_leases WHERE key_fingerprint LIKE $1`, [keyPattern]);
      await pool.query(`DELETE FROM youtube_key_cap_shadow_settled WHERE key_fingerprint LIKE $1`, [keyPattern]);
      await pool.query(`DELETE FROM youtube_key_cap_shadow_events WHERE key_fingerprint LIKE $1`, [keyPattern]);
      await pool.query(`DELETE FROM youtube_key_quota_usage WHERE key_fingerprint LIKE $1`, [keyPattern]);
    } finally {
      await pool.end();
    }
  }
});

maybe('schema: migrations 115, 148, and 151 apply cleanly', async () => {
  await ensureSchema();
  const tables = await requirePool().query(
    `SELECT to_regclass('youtube_key_cap_shadow_leases') AS leases,
            to_regclass('youtube_key_cap_shadow_events') AS events,
            to_regclass('youtube_key_cap_shadow_settled') AS settled`
  );
  assert.ok(tables.rows[0].leases);
  assert.ok(tables.rows[0].events);
  assert.ok(tables.rows[0].settled);
});

maybe('boundary: 9000 admitted, the next unit is WOULD_REJECT, leases count as in-flight', async () => {
  await ensureSchema();
  resetShadowConfigCacheForTests();
  resetShadowSweepClockForTests();
  const key = keyFor('boundary');
  await seedSettledUnits(key, 8990);
  const shadowPool = requirePool() as unknown as ShadowPoolPort;

  const first = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool: shadowPool },
    { keyFingerprint: key, operationId: `${runTag}:boundary:1`, units: 10 }
  );
  assert.equal(first.projectedBefore, 8990);
  assert.equal(first.event, null, '8990 + 10 = 9000 is admitted');
  assert.equal(first.leaseInserted, true);

  // The lease above must now count as in-flight occupancy: without lease
  // accounting this request would still see 8990 and be admitted.
  const second = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool: shadowPool },
    { keyFingerprint: key, operationId: `${runTag}:boundary:2`, units: 1 }
  );
  assert.equal(second.projectedBefore, 9000, 'in-flight lease is included in the projection');
  assert.equal(second.event, 'WOULD_REJECT', '9000 + 1 = 9001 blocks');
  assert.equal(second.leaseInserted, true, 'observational: the real request still proceeds');

  assert.equal(await leaseCount(key), 2);
  const events = await eventRows(key);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'WOULD_REJECT');
  assert.equal(events[0].projected_units, 9000);
});

maybe('partial fit below the cap is WOULD_DEFER', async () => {
  await ensureSchema();
  resetShadowConfigCacheForTests();
  resetShadowSweepClockForTests();
  const key = keyFor('defer');
  await seedSettledUnits(key, 8995);
  const result = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool: requirePool() as unknown as ShadowPoolPort },
    { keyFingerprint: key, operationId: `${runTag}:defer:1`, units: 10 }
  );
  assert.equal(result.projectedBefore, 8995);
  assert.equal(result.event, 'WOULD_DEFER', '8995 + 10 = 9005 crosses the cap from below');
  const events = await eventRows(key);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'WOULD_DEFER');
});

maybe('duplicate accounting: one lease and one event per operation id', async () => {
  await ensureSchema();
  resetShadowConfigCacheForTests();
  resetShadowSweepClockForTests();
  const key = keyFor('duplicate');
  await seedSettledUnits(key, 9000);
  const shadowPool = requirePool() as unknown as ShadowPoolPort;
  const operationId = `${runTag}:duplicate:1`;

  const first = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool: shadowPool },
    { keyFingerprint: key, operationId, units: 1 }
  );
  const second = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool: shadowPool },
    { keyFingerprint: key, operationId, units: 1 }
  );
  assert.equal(first.event, 'WOULD_REJECT');
  assert.equal(second.event, 'WOULD_REJECT', 'classification is still reported on retry');
  assert.equal(first.leaseInserted, true);
  assert.equal(second.leaseInserted, false, 'duplicate lease insert is deduplicated');
  assert.equal(await leaseCount(key), 1);
  assert.equal((await eventRows(key)).length, 1, 'duplicate event insert is deduplicated');
});

maybe('settlement tombstone fences a late dispatch after the response settled', async () => {
  await ensureSchema();
  resetShadowConfigCacheForTests();
  resetShadowSweepClockForTests();
  const key = keyFor('tombstone');
  const operationId = `${runTag}:tombstone:1`;
  await seedSettledUnits(key, 100);
  const shadowPool = requirePool() as unknown as ShadowPoolPort;

  const dispatch = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool: shadowPool },
    { keyFingerprint: key, operationId, units: 1 }
  );
  assert.equal(dispatch.leaseInserted, true);
  await settleShadowLease(shadowPool, { quotaDay, keyFingerprint: key, units: 1, operationId });
  assert.equal(await leaseCount(key), 0, 'settlement removes the in-flight lease');
  const settled = await requirePool().query(
    `SELECT count(*)::int AS count FROM youtube_key_cap_shadow_settled
      WHERE quota_day=$1 AND operation_id=$2 AND expires_at > now()`,
    [quotaDay, operationId]
  );
  assert.equal(Number(settled.rows[0].count), 1, 'settlement tombstone remains to fence late inserts');

  // Simulate the observation completing after settlement and the official
  // counter now being above the cap: the exact operation must not recreate a
  // lease or write a false WOULD_REJECT event.
  await seedSettledUnits(key, 9000);
  const late = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool: shadowPool },
    { keyFingerprint: key, operationId, units: 1 }
  );
  assert.equal(late.leaseInserted, false);
  assert.equal((await eventRows(key)).length, 0, 'late observation is fenced by its tombstone');

  // The fence is operation-specific: a genuinely new observation still works.
  const other = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool: shadowPool },
    { keyFingerprint: key, operationId: `${runTag}:tombstone:2`, units: 1 }
  );
  assert.equal(other.leaseInserted, true);
  assert.equal(other.event, 'WOULD_REJECT');
  assert.equal((await eventRows(key)).length, 1);
});

maybe('concurrency: 20 parallel dispatches serialize per key/day and cap exactly', async () => {
  await ensureSchema();
  resetShadowConfigCacheForTests();
  resetShadowSweepClockForTests();
  const key = keyFor('concurrent');
  await seedSettledUnits(key, 8990);
  const shadowPool = requirePool() as unknown as ShadowPoolPort;

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      recordShadowDispatchSafe(
        { readSetting: enabledReader, pool: shadowPool },
        {
          keyFingerprint: key,
          operationId: `${runTag}:concurrent:${index}`,
          units: 1,
          lockTimeoutMs: 3000,
        }
      )
    )
  );

  assert.equal(results.filter((result) => result.lockSkipped).length, 0, 'no observation skipped');
  assert.equal(results.filter((result) => result.event === null).length, 10, '10 requests fit: 8990 -> 9000');
  assert.equal(results.filter((result) => result.event === 'WOULD_REJECT').length, 10, 'the remaining 10 block');
  // Shadow mode never blocks: every observed request still executes, so every
  // request holds a lease (20 total). Only the 10 crossing the cap produce
  // WOULD_REJECT events.
  assert.equal(await leaseCount(key), 20);
  const events = await eventRows(key);
  assert.equal(events.length, 10);
  assert.ok(events.every((row) => row.event === 'WOULD_REJECT'));
  // Rejected calls still execute in shadow mode and still hold leases, so the
  // projection keeps rising above the cap after the first rejection (9000,
  // 9001, ...). Every blocking observation is therefore >= cap.
  assert.ok(events.every((row) => row.projected_units >= 9000));
});

maybe('stale leases expire, are excluded from projections and swept on restart', async () => {
  await ensureSchema();
  resetShadowConfigCacheForTests();
  resetShadowSweepClockForTests();
  const key = keyFor('stale');
  const staleOperationId = `${runTag}:stale:1`;
  await seedSettledUnits(key, 8990);
  await requirePool().query(
    `INSERT INTO youtube_key_cap_shadow_leases(quota_day, operation_id, key_fingerprint, reserved_units, reserved_at, expires_at)
     VALUES($1, $2, $3, 9000, now() - interval '10 minutes', now() - interval '5 minutes')`,
    [quotaDay, staleOperationId, key]
  );

  // Restart recovery: the first observation after a restart sweeps expired
  // leases before projecting, so abandoned in-flight reservations cannot
  // poison the projection.
  const result = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool: requirePool() as unknown as ShadowPoolPort },
    { keyFingerprint: key, operationId: `${runTag}:stale:2`, units: 10 }
  );
  assert.equal(result.projectedBefore, 8990, 'expired lease is not part of the projection');
  assert.equal(result.event, null, '8990 + 10 = 9000 admitted');
  const stale = await requirePool().query(
    `SELECT count(*)::int AS count FROM youtube_key_cap_shadow_leases WHERE quota_day=$1 AND operation_id=$2`,
    [quotaDay, staleOperationId]
  );
  assert.equal(Number(stale.rows[0].count), 0, 'expired lease removed by the restart sweep');

  const swept = await sweepShadowLeases(requirePool() as unknown as ShadowPoolPort, new Date());
  assert.ok(swept >= 0);
});

maybe('settlement releases the in-flight lease exactly once', async () => {
  await ensureSchema();
  resetShadowConfigCacheForTests();
  resetShadowSweepClockForTests();
  const key = keyFor('settle');
  const operationId = `${runTag}:settle:1`;
  await seedSettledUnits(key, 100);
  const shadowPool = requirePool() as unknown as ShadowPoolPort;

  const dispatch = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool: shadowPool },
    { keyFingerprint: key, operationId, units: 1 }
  );
  assert.equal(dispatch.leaseInserted, true);
  assert.equal(await leaseCount(key), 1);

  const first = await settleShadowLease(shadowPool, { quotaDay, keyFingerprint: key, units: 1 });
  const second = await settleShadowLease(shadowPool, { quotaDay, keyFingerprint: key, units: 1 });
  assert.equal(first, true, 'matching lease released');
  assert.equal(second, false, 'double settlement is a no-op');
  assert.equal(await leaseCount(key), 0);

  // After settlement the official counter carries the usage: the projection
  // is settled-only and no double counting remains.
  await seedSettledUnits(key, 101);
  const next = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool: shadowPool },
    { keyFingerprint: key, operationId: `${runTag}:settle:2`, units: 8899 }
  );
  assert.equal(next.projectedBefore, 101);
  assert.equal(next.event, null, '101 + 8899 = 9000 admitted');
});
