import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import {
  recordYouTubeKeyCapRefusal,
  recordYouTubeKeyCapRefusalSafe,
  readYouTubeKeyCapRefusalKeyCounts,
  readYouTubeKeyCapRefusalSummary,
} from './quotaKeyCapRefusals';

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
      // Re-applying must be a no-op; the migration is part of the deploy path.
      await pool.query(migration158);
    })();
  }
  return schemaReady;
}

after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM youtube_key_cap_refusal_events WHERE key_fingerprint LIKE $1', [keyPattern]);
  await pool.query('DELETE FROM youtube_key_cap_refusal_counters WHERE key_fingerprint LIKE $1', [keyPattern]);
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
