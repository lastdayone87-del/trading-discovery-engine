import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import pg from 'pg';
import type { Pool } from 'pg';
import {
  getSemanticCapacityStatus,
  recordProviderCapacityExhausted,
  recordProviderCapacitySuccess,
  resetProviderCapacityCacheForTests,
} from './providerCapacityState';

const dedicatedUrl = process.env.PROVIDER_CAPACITY_TEST_DATABASE_URL;

test('provider capacity tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicatedUrl) console.log('SKIP: set PROVIDER_CAPACITY_TEST_DATABASE_URL to run provider capacity tests.');
  assert.ok(true);
});

const maybe = dedicatedUrl ? test : test.skip;
let pool: Pool | null = null;

function requirePool(): Pool {
  assert.ok(pool, 'pool must be initialized by the schema test');
  return pool;
}

maybe('capacity state parks until reset, allows exactly one probe, and closes on success', async () => {
  pool = new pg.Pool({ connectionString: dedicatedUrl, max: 4 });
  const db = requirePool();
  await db.query(`DROP TABLE IF EXISTS provider_capacity_state`);
  await db.query(readFileSync(new URL('./db/migrations/210_provider_capacity_state.sql', import.meta.url), 'utf8'));
  resetProviderCapacityCacheForTests();

  const future = Date.now() + 60 * 60_000;
  await recordProviderCapacityExhausted({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: '*',
    state: 'EXHAUSTED',
    reasonCode: 'PROVIDER_QUOTA_DAILY',
    resumeAt: future,
    sourceEventId: 'event-1',
  }, db);
  resetProviderCapacityCacheForTests();
  const parked = await getSemanticCapacityStatus(Date.now(), db);
  assert.equal(parked.available, false);
  assert.equal(parked.probe, false);
  assert.ok((parked.resumeAt || 0) > Date.now());

  await db.query(`UPDATE provider_capacity_state SET resume_at=now()-interval '1 second' WHERE provider='gemini' AND scope_key='gemini-project-1'`);
  resetProviderCapacityCacheForTests();
  const probe = await getSemanticCapacityStatus(Date.now(), db);
  assert.deepEqual(probe, { available: true, probe: true, resumeAt: null, reason: 'PROBE' });
  const noSecondProbe = await getSemanticCapacityStatus(Date.now(), db);
  assert.equal(noSecondProbe.available, false, 'only one worker may hold the probe lease');

  await recordProviderCapacitySuccess({ provider: 'gemini', scopeKey: 'gemini-project-1', operation: 'multilingual-semantic-classification' }, db);
  resetProviderCapacityCacheForTests();
  const healthy = await getSemanticCapacityStatus(Date.now(), db);
  assert.equal(healthy.available, true);
  assert.equal(healthy.probe, false);
});

maybe('a blocked credential route remains unavailable until success or operator action', async () => {
  const db = requirePool();
  await db.query(`DELETE FROM provider_capacity_state`);
  resetProviderCapacityCacheForTests();
  await recordProviderCapacityExhausted({
    provider: 'groq',
    scopeKey: 'groq-org-1',
    operation: '*',
    state: 'BLOCKED',
    reasonCode: 'PROVIDER_CREDENTIALS_EXHAUSTED',
    resumeAt: Date.now() + 24 * 60 * 60_000,
    sourceEventId: 'event-2',
  }, db);
  resetProviderCapacityCacheForTests();
  const blocked = await getSemanticCapacityStatus(Date.now(), db);
  assert.equal(blocked.available, false);
  await recordProviderCapacitySuccess({ provider: 'groq', scopeKey: 'groq-org-1', operation: '*' }, db);
  resetProviderCapacityCacheForTests();
  assert.equal((await getSemanticCapacityStatus(Date.now(), db)).available, true);
});

after(async () => {
  if (!pool) return;
  try { await pool.query(`DROP TABLE IF EXISTS provider_capacity_state`); } finally { await pool.end(); }
});
