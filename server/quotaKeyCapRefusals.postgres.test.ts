import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import {
  pruneYouTubeKeyCapRefusalEvents,
  recordYouTubeKeyCapRefusal,
  recordYouTubeKeyCapRefusalSafe,
  readYouTubeKeyCapRefusalKeyCounts,
  readYouTubeKeyCapRefusalSummary,
} from './quotaKeyCapRefusals';
import {
  readKeyCapMonitorStop,
  recordKeyCapMonitorStop,
} from './youtubeKeyCapMonitorStops';

/**
 * Live-database tests for the durable cap-refusal counter. They run ONLY
 * against an explicitly provided dedicated test database (the CI postgres
 * service container), never a shared or production database:
 *
 *   QUOTA_SHADOW_TEST_DATABASE_URL=postgresql://... \
 *     npx tsx --test server/quotaKeyCapRefusals.postgres.test.ts
 *
 * Without that variable every test below skips. Migration 158 is applied
 * idempotently here; unique key fingerprints isolate repeated runs.
 */
const dedicatedUrl = process.env.QUOTA_SHADOW_TEST_DATABASE_URL;

test('cap-refusal PostgreSQL tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicatedUrl) {
    console.log(
      'SKIP: set QUOTA_SHADOW_TEST_DATABASE_URL to a dedicated test database to run the cap-refusal PostgreSQL tests.'
    );
  }
  assert.ok(true);
});

const maybe = dedicatedUrl ? test : test.skip;

const migration158 = readFileSync(
  fileURLToPath(new URL('./db/migrations/158_youtube_key_cap_refusals.sql', import.meta.url)),
  'utf8'
);
const migration159 = readFileSync(
  fileURLToPath(new URL('./db/migrations/159_youtube_key_cap_monitor_stops.sql', import.meta.url)),
  'utf8'
);

const runTag = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const keyFor = (name: string): string => `fp-refusal-${name}-${runTag}`;
const keyPattern = `fp-refusal-%-${runTag}`;
const opFor = (name: string): string => `cap:test:${name}-${runTag}`;

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
      await pool.query(migration158);
      await pool.query(migration159);
      // Re-applying must be a no-op; the migration is part of the deploy path.
      await pool.query(migration158);
      await pool.query(migration159);
    })();
  }
  return schemaReady;
}

after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM youtube_key_cap_refusal_events WHERE key_fingerprint LIKE $1', [keyPattern]);
  await pool.query('DELETE FROM youtube_key_cap_refusal_counters WHERE key_fingerprint LIKE $1', [keyPattern]);
  await pool.query('DELETE FROM youtube_key_cap_monitor_stops WHERE quota_day = $1', ['2026-10-20']);
  await pool.end();
});

maybe('records one refusal and deduplicates the same operation id', async () => {
  await ensureSchema();
  const key = keyFor('dedupe');
  const operationId = opFor('dedupe');
  const input = {
    quotaDay: '2026-10-20',
    operationId,
    keyFingerprint: key,
    projectedUnits: 9000,
    requestUnits: 100,
    capUnits: 9000,
  };

  const first = await recordYouTubeKeyCapRefusal(requirePool(), input);
  assert.deepEqual(first, { inserted: true, refusals: 1 });

  const duplicate = await recordYouTubeKeyCapRefusal(requirePool(), input);
  assert.deepEqual(duplicate, { inserted: false, refusals: 1 });

  const summary = await readYouTubeKeyCapRefusalSummary(requirePool(), '2026-10-20');
  // Other tests in this file may share the day; assert this key's contribution
  // through the per-key read model instead of a global day total.
  const keys = await readYouTubeKeyCapRefusalKeyCounts(requirePool(), '2026-10-20');
  const row = keys.find(item => item.keyFingerprint === key);
  assert.ok(row);
  assert.equal(row!.refusals, 1);
  assert.equal(row!.projectedUnitsMax, 9000);
  assert.equal(row!.lastRequestUnits, 100);
  assert.ok(summary.keys >= 1);
});

maybe('concurrent duplicate deliveries increment the counter exactly once', async () => {
  await ensureSchema();
  const key = keyFor('concurrent');
  const operationId = opFor('concurrent');
  const input = {
    quotaDay: '2026-10-20',
    operationId,
    keyFingerprint: key,
    projectedUnits: 8999,
    requestUnits: 100,
    capUnits: 9000,
  };

  const results = await Promise.all(
    Array.from({ length: 10 }, () => recordYouTubeKeyCapRefusal(requirePool(), input))
  );
  assert.equal(results.filter(result => result.inserted).length, 1);
  assert.ok(results.every(result => result.refusals === 1));

  const keys = await readYouTubeKeyCapRefusalKeyCounts(requirePool(), '2026-10-20');
  assert.equal(keys.find(item => item.keyFingerprint === key)?.refusals, 1);
});

maybe('quota-reset boundary scopes counters to the Pacific quota day', async () => {
  await ensureSchema();
  const key = keyFor('reset');
  const dayOne = '2026-10-20';
  const dayTwo = '2026-10-21';
  // Same operation identity on a different day is a different refusal: the
  // event uniqueness includes quota_day, and the counter starts at zero.
  const operationId = opFor('reset');

  await recordYouTubeKeyCapRefusal(requirePool(), {
    quotaDay: dayOne, operationId, keyFingerprint: key,
    projectedUnits: 9000, requestUnits: 100, capUnits: 9000,
  });
  await recordYouTubeKeyCapRefusal(requirePool(), {
    quotaDay: dayOne, operationId: opFor('reset-2'), keyFingerprint: key,
    projectedUnits: 9001, requestUnits: 100, capUnits: 9000,
  });
  const dayTwoResult = await recordYouTubeKeyCapRefusal(requirePool(), {
    quotaDay: dayTwo, operationId, keyFingerprint: key,
    projectedUnits: 9000, requestUnits: 100, capUnits: 9000,
  });
  assert.deepEqual(dayTwoResult, { inserted: true, refusals: 1 });

  const dayOneKeys = await readYouTubeKeyCapRefusalKeyCounts(requirePool(), dayOne);
  assert.equal(dayOneKeys.find(item => item.keyFingerprint === key)?.refusals, 2);
  const dayTwoKeys = await readYouTubeKeyCapRefusalKeyCounts(requirePool(), dayTwo);
  assert.equal(dayTwoKeys.find(item => item.keyFingerprint === key)?.refusals, 1);
});

maybe('counter survives a new pool (process restart) and is independent of logs', async () => {
  await ensureSchema();
  const key = keyFor('restart');
  await recordYouTubeKeyCapRefusal(requirePool(), {
    quotaDay: '2026-10-20',
    operationId: opFor('restart'),
    keyFingerprint: key,
    projectedUnits: 9000,
    requestUnits: 100,
    capUnits: 9000,
  });

  // A fresh pool has no in-memory monitor state. The durable row is the only
  // source, so a restart (or a rotated application log) cannot lose it.
  const restarted = new pg.Pool({ connectionString: dedicatedUrl, max: 2 });
  try {
    const keys = await readYouTubeKeyCapRefusalKeyCounts(restarted, '2026-10-20');
    assert.equal(keys.find(item => item.keyFingerprint === key)?.refusals, 1);
  } finally {
    await restarted.end();
  }
});

maybe('prune removes only expired event identities and leaves counters intact', async () => {
  await ensureSchema();
  const key = keyFor('prune');
  const recentOperation = opFor('prune-recent');
  const oldOperation = opFor('prune-old');
  await recordYouTubeKeyCapRefusal(requirePool(), {
    quotaDay: '2026-10-20',
    operationId: recentOperation,
    keyFingerprint: key,
    projectedUnits: 9000,
    requestUnits: 100,
    capUnits: 9000,
  });
  await requirePool().query(
    `INSERT INTO youtube_key_cap_refusal_events
       (quota_day, operation_id, key_fingerprint, projected_units, request_units, cap_units, created_at)
     VALUES ($1, $2, $3, 9000, 100, 9000, now() - interval '31 days')`,
    ['2026-10-20', oldOperation, key],
  );

  const deleted = await pruneYouTubeKeyCapRefusalEvents(requirePool(), 30, 10_000);
  assert.ok(deleted >= 1, 'the expired event is pruned');
  const old = await requirePool().query(
    'SELECT 1 FROM youtube_key_cap_refusal_events WHERE operation_id = $1',
    [oldOperation],
  );
  assert.equal(old.rowCount, 0);
  const recent = await requirePool().query(
    'SELECT 1 FROM youtube_key_cap_refusal_events WHERE operation_id = $1',
    [recentOperation],
  );
  assert.equal(recent.rowCount, 1);
  const keys = await readYouTubeKeyCapRefusalKeyCounts(requirePool(), '2026-10-20');
  assert.equal(keys.find(item => item.keyFingerprint === key)?.refusals, 1);
});

maybe('durable monitor stop survives a new pool and the first stop wins', async () => {
  await ensureSchema();
  const first = await recordKeyCapMonitorStop(requirePool(), {
    quotaDay: '2026-10-20',
    reason: 'CAP_UNAVAILABLE',
    detail: 'cap_unavailable=4',
    at: new Date('2026-10-20T08:00:00.000Z'),
  });
  assert.equal(first.reason, 'CAP_UNAVAILABLE');
  const second = await recordKeyCapMonitorStop(requirePool(), {
    quotaDay: '2026-10-20',
    reason: 'QUOTA_EXHAUSTED',
    detail: 'quota_exhausted=21',
    at: new Date('2026-10-20T09:00:00.000Z'),
  });
  assert.deepEqual(second, first, 'a later stop cannot replace the first durable stop');

  const restarted = new pg.Pool({ connectionString: dedicatedUrl, max: 2 });
  try {
    assert.deepEqual(await readKeyCapMonitorStop(restarted, '2026-10-20'), first);
    assert.equal(await readKeyCapMonitorStop(restarted, '2026-10-21'), null);
  } finally {
    await restarted.end();
  }
});

maybe('observability failure is fail-open and never masks the cap verdict', async () => {
  const validInput = {
    quotaDay: '2026-10-20',
    operationId: opFor('safe'),
    keyFingerprint: keyFor('safe'),
    projectedUnits: 9000,
    requestUnits: 100,
    capUnits: 9000,
  };
  const broken = {
    query: async () => { throw new Error('database unavailable'); },
  };
  assert.equal(await recordYouTubeKeyCapRefusalSafe(broken, validInput), false);
  assert.equal(
    await recordYouTubeKeyCapRefusalSafe(broken, { ...validInput, requestUnits: 0 }),
    false
  );
});
