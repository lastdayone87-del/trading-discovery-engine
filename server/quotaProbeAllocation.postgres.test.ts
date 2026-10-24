import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import {
  ProbeQuotaExceededError,
  YouTubeKeyCapExceededError,
  getProbeQuotaStatus,
  releaseProbeQuotaReservation,
  reserveEnforcedKeyCap,
  reserveProbeQuota,
  resetKeyCapEnforcementCacheForTests,
  resetProbeQuotaConfigCacheForTests,
  resetProbeQuotaExhaustionCacheForTests,
  settleProbeQuotaReservation,
  type ProbeQuotaReservation,
  type ShadowPoolPort,
} from './quotaKeyCapShadow';
import { getYouTubeQuotaDay } from './youtubeQuotaDay';

// The probe allocation is derived from the effective YouTube budget. Establish
// a deterministic one-key budget so the 100-unit cap below is valid even when
// the CI process has no provider keys configured (which correctly fails
// closed with a zero 10% share).
process.env.YOUTUBE_API_KEY = 'probe-allocation-postgres-test-key';
process.env.YOUTUBE_DAILY_QUOTA_PER_KEY = '10000';

/**
 * Dedicated-database tests for the independent probe-origin official quota
 * allocation. They never run without QUOTA_SHADOW_TEST_DATABASE_URL and never
 * touch a shared/production database:
 *
 *   QUOTA_SHADOW_TEST_DATABASE_URL=postgresql://... \
 *     npx tsx --test server/quotaProbeAllocation.postgres.test.ts
 */
const dedicatedUrl = process.env.QUOTA_SHADOW_TEST_DATABASE_URL;

test('probe allocation PostgreSQL tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicatedUrl) {
    console.log(
      'SKIP: set QUOTA_SHADOW_TEST_DATABASE_URL to a dedicated test database to run the probe allocation PostgreSQL tests.'
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
const migration155 = readFileSync(
  fileURLToPath(new URL('./db/migrations/155_probe_quota_allocation.sql', import.meta.url)),
  'utf8'
);

const runTag = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
// Pacific noon, so day boundaries cannot move during a test.
const fixedNow = new Date('2026-10-20T19:00:00.000Z');
const quotaDay = getYouTubeQuotaDay(fixedNow);
const keyFor = (name: string): string => `probe-fp-${name}-${runTag}`;
const keyPattern = `probe-fp-%-${runTag}`;
const PROBE_CAP = 100;

const probeReader = async (key: string, fallback: string): Promise<string> => {
  if (key === 'youtube_probe_official_quota_enabled') return 'true';
  if (key === 'youtube_probe_daily_cap_units') return String(PROBE_CAP);
  if (key === 'youtube_key_daily_cap_enforced') return 'false';
  return fallback;
};

const keyCapReader = async (key: string, fallback: string): Promise<string> => {
  if (key === 'youtube_probe_official_quota_enabled') return 'true';
  if (key === 'youtube_probe_daily_cap_units') return String(PROBE_CAP);
  if (key === 'youtube_key_daily_cap_enforced') return 'true';
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
      pool = new pg.Pool({ connectionString: dedicatedUrl, max: 30 });
      await pool.query(migration115);
      await pool.query(migration148);
      await pool.query(migration151);
      await pool.query(migration155);
    })();
  }
  return schemaReady;
}

async function leaseCount(operationPrefix: string): Promise<number> {
  const result = await requirePool().query(
    `SELECT count(*)::int AS count FROM youtube_key_cap_shadow_leases
      WHERE quota_day=$1 AND operation_id LIKE $2 AND allocation='PROBE'`,
    [quotaDay, `${operationPrefix}%`]
  );
  return Number(result.rows[0].count);
}

async function probeUsage(): Promise<number> {
  const result = await requirePool().query(
    `SELECT COALESCE((SELECT units_used FROM youtube_probe_quota_usage WHERE quota_day=$1),0)::int AS units`,
    [quotaDay]
  );
  return Number(result.rows[0].units);
}

async function clearProbeState(): Promise<void> {
  await requirePool().query(
    `DELETE FROM youtube_key_cap_shadow_leases WHERE quota_day=$1 AND allocation='PROBE'`,
    [quotaDay]
  );
  await requirePool().query(
    `DELETE FROM youtube_probe_quota_usage WHERE quota_day=$1`,
    [quotaDay]
  );
}

function resetCaches(): void {
  resetProbeQuotaConfigCacheForTests();
  resetProbeQuotaExhaustionCacheForTests();
  resetKeyCapEnforcementCacheForTests();
}

after(async () => {
  if (pool) {
    try {
      await pool.query(`DELETE FROM youtube_key_cap_shadow_leases WHERE key_fingerprint LIKE $1`, [keyPattern]);
      await pool.query(`DELETE FROM youtube_key_quota_usage WHERE key_fingerprint LIKE $1`, [keyPattern]);
      await pool.query(`DELETE FROM youtube_probe_quota_usage WHERE quota_day=$1`, [quotaDay]);
    } finally {
      await pool.end();
    }
  }
});

maybe('schema: migration 155 adds the probe allocation without changing normal leases', async () => {
  await ensureSchema();
  const schema = await requirePool().query(
    `SELECT to_regclass('youtube_probe_quota_usage') AS usage,
            (SELECT count(*)::int FROM information_schema.columns
              WHERE table_name='youtube_key_cap_shadow_leases' AND column_name='allocation') AS allocation_columns`
  );
  assert.ok(schema.rows[0].usage);
  assert.equal(Number(schema.rows[0].allocation_columns), 1);
});

maybe('20 concurrent probe jobs cannot overrun a 100-unit allocation', async () => {
  await ensureSchema();
  await clearProbeState();
  resetCaches();
  const key = keyFor('concurrent');
  const prefix = `${runTag}:concurrent:`;
  const deps = { readSetting: probeReader, pool: requirePool() as unknown as ShadowPoolPort };

  const outcomes = await Promise.allSettled(
    Array.from({ length: 20 }, (_, index) =>
      reserveProbeQuota(deps, {
        keyFingerprint: key,
        operationId: `${prefix}${index}`,
        units: 10,
        now: fixedNow,
      })
    )
  );
  const admitted = outcomes.filter(outcome => outcome.status === 'fulfilled');
  const rejected = outcomes.filter(outcome => outcome.status === 'rejected');
  assert.equal(admitted.length, 10, 'exactly 10 x 10 units fit');
  assert.equal(rejected.length, 10, 'the other 10 jobs are deferred, not over-admitted');
  for (const outcome of rejected) {
    assert.ok(outcome.status === 'rejected');
    assert.ok(outcome.reason instanceof ProbeQuotaExceededError);
  }
  assert.equal(await leaseCount(`${prefix}`), 10);
  const status = await getProbeQuotaStatus(requirePool() as unknown as ShadowPoolPort, fixedNow);
  assert.equal(status.usedUnits, 0);
  assert.equal(status.inFlightUnits, PROBE_CAP);
});

maybe('reservation retry is idempotent and settlement is exactly-once', async () => {
  await ensureSchema();
  await clearProbeState();
  resetCaches();
  const key = keyFor('retry');
  const prefix = `${runTag}:retry:`;
  const operationId = `${prefix}1`;
  const deps = { readSetting: probeReader, pool: requirePool() as unknown as ShadowPoolPort };

  const first = await reserveProbeQuota(deps, {
    keyFingerprint: key, operationId, units: 40, now: fixedNow,
  });
  const retry = await reserveProbeQuota(deps, {
    keyFingerprint: key, operationId, units: 40, now: fixedNow,
  });
  assert.equal(first.operationId, retry.operationId);
  assert.equal(await leaseCount(prefix), 1, 'a duplicate attempt reuses one lease');

  // Settlement uses a savepoint because production always calls it inside
  // incrementQuota's transaction. Mirror that contract here.
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    assert.equal(await settleProbeQuotaReservation(client, first), true);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  assert.equal(await probeUsage(), 40);
  assert.equal(await leaseCount(prefix), 0);

  const secondClient = await requirePool().connect();
  try {
    await secondClient.query('BEGIN');
    assert.equal(await settleProbeQuotaReservation(secondClient, first), false);
    await secondClient.query('COMMIT');
  } catch (error) {
    await secondClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    secondClient.release();
  }
  assert.equal(await probeUsage(), 40, 'a repeated settlement cannot double-charge');
});

maybe('release before dispatch frees capacity; a failed/hung dispatch lease does not', async () => {
  await ensureSchema();
  await clearProbeState();
  resetCaches();
  const key = keyFor('release');
  const prefix = `${runTag}:release:`;
  const deps = { readSetting: probeReader, pool: requirePool() as unknown as ShadowPoolPort };

  const held = await reserveProbeQuota(deps, {
    keyFingerprint: key, operationId: `${prefix}held`, units: PROBE_CAP, now: fixedNow,
  });
  await assert.rejects(
    reserveProbeQuota(deps, {
      keyFingerprint: key, operationId: `${prefix}blocked`, units: 1, now: fixedNow,
    }),
    (error: unknown) => error instanceof ProbeQuotaExceededError
  );
  const client = await requirePool().connect();
  try {
    assert.equal(await releaseProbeQuotaReservation(client, held), true);
  } finally {
    client.release();
  }
  const admitted = await reserveProbeQuota(deps, {
    keyFingerprint: key, operationId: `${prefix}after-release`, units: 1, now: fixedNow,
  });
  assert.equal(admitted.units, 1);
  assert.equal(await probeUsage(), 0, 'release is not a charge');
});

maybe('when the #533 per-key cap is ON, the same probe lease is checked once against 9,000/key', async () => {
  await ensureSchema();
  await clearProbeState();
  resetCaches();
  const key = keyFor('keycap');
  await requirePool().query(
    `INSERT INTO youtube_key_quota_usage(quota_day, key_fingerprint, key_index, units_used, daily_limit)
     VALUES($1,$2,1,8995,10000)
     ON CONFLICT(quota_day, key_fingerprint)
     DO UPDATE SET units_used=$3, updated_at=now()`,
    [quotaDay, key, 8995]
  );
  const deps = { readSetting: keyCapReader, pool: requirePool() as unknown as ShadowPoolPort };
  await assert.rejects(
    reserveProbeQuota(deps, {
      keyFingerprint: key,
      operationId: `${runTag}:keycap:1`,
      units: 10,
      now: fixedNow,
    }),
    (error: unknown) => error instanceof YouTubeKeyCapExceededError && error.code === 'YOUTUBE_KEY_CAP_EXCEEDED'
  );
  // The probe bucket would have admitted 10 (it is empty), but the global
  // per-key projection is the tighter limit: 8995 + 10 > 9000.
  assert.equal(await leaseCount(`${runTag}:keycap:`), 0);
});

maybe('concurrent probe and enforced reservations for one key cannot jointly over-admit 9,000', async () => {
  await ensureSchema();
  await clearProbeState();
  resetCaches();
  const deps = { readSetting: keyCapReader, pool: requirePool() as unknown as ShadowPoolPort };
  for (let round = 0; round < 6; round++) {
    const key = keyFor(`mixed-${round}`);
    await requirePool().query(
      `INSERT INTO youtube_key_quota_usage(quota_day, key_fingerprint, key_index, units_used, daily_limit)
       VALUES($1,$2,1,8990,10000)
       ON CONFLICT(quota_day, key_fingerprint)
       DO UPDATE SET units_used=$3, updated_at=now()`,
      [quotaDay, key, 8990]
    );
    const prefix = `${runTag}:mixed:${round}:`;
    const outcomes = await Promise.allSettled([
      reserveProbeQuota(deps, {
        keyFingerprint: key, operationId: `${prefix}probe`, units: 10, now: fixedNow,
      }),
      reserveEnforcedKeyCap(deps, {
        keyFingerprint: key, operationId: `${prefix}cap`, units: 10, now: fixedNow,
      }),
    ]);
    const admitted = outcomes.filter(outcome => outcome.status === 'fulfilled');
    assert.equal(admitted.length, 1, `round ${round}: exactly one 10-unit writer fits 8,990 + 10 = 9,000`);
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    assert.ok(
      rejected?.status === 'rejected' && rejected.reason instanceof YouTubeKeyCapExceededError,
      `round ${round}: the loser is a typed per-key rejection`
    );
  }
});

maybe('probe allocation projects only probe-origin settled usage, not ordinary enrichment', async () => {
  await ensureSchema();
  await clearProbeState();
  resetCaches();
  const key = keyFor('ordinary');
  await requirePool().query(
    `INSERT INTO youtube_key_quota_usage(quota_day, key_fingerprint, key_index, units_used, daily_limit)
     VALUES($1,$2,1,8000,10000)
     ON CONFLICT(quota_day, key_fingerprint)
     DO UPDATE SET units_used=$3, updated_at=now()`,
    [quotaDay, key, 8000]
  );
  const deps = { readSetting: probeReader, pool: requirePool() as unknown as ShadowPoolPort };
  const reservation: ProbeQuotaReservation = await reserveProbeQuota(deps, {
    keyFingerprint: key, operationId: `${runTag}:ordinary:1`, units: PROBE_CAP, now: fixedNow,
  });
  assert.equal(reservation.projectedBefore, 0, 'ordinary settled units do not consume the probe bucket');
});
