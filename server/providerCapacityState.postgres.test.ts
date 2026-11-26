import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import pg from 'pg';
import type { Pool } from 'pg';
import {
  getSemanticCapacityStatus,
  recordProviderCapacityExhausted,
  recordProviderCapacitySuccess,
  releaseProviderCapacityProbe,
  resetProviderCapacityCacheForTests,
  type ProviderCapacityAccount,
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

function gemini(scopeKey: string): ProviderCapacityAccount {
  return { provider: 'gemini', scopeKey };
}

function groq(scopeKey: string): ProviderCapacityAccount {
  return { provider: 'groq', scopeKey };
}

before(async () => {
  if (!dedicatedUrl) return;
  pool = new pg.Pool({ connectionString: dedicatedUrl, max: 4 });
  await pool.query(`DROP TABLE IF EXISTS provider_capacity_state`);
  await pool.query(readFileSync(new URL('./db/migrations/210_provider_capacity_state.sql', import.meta.url), 'utf8'));
});

maybe('capacity state parks until reset, allows exactly one probe, and closes on success', async () => {
  const db = requirePool();
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
  const parked = await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db);
  assert.equal(parked.available, false);
  assert.equal(parked.probe, false);
  assert.ok((parked.resumeAt || 0) > Date.now());

  await db.query(`UPDATE provider_capacity_state SET resume_at=now()-interval '1 second' WHERE provider='gemini' AND scope_key='gemini-project-1'`);
  resetProviderCapacityCacheForTests();
  const probe = await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db);
  assert.equal(probe.available, true);
  assert.equal(probe.probe, true);
  assert.equal(probe.reason, 'PROBE');
  assert.deepEqual(
    { provider: probe.probeAccount?.provider, scopeKey: probe.probeAccount?.scopeKey, operation: probe.probeAccount?.operation },
    { provider: 'gemini', scopeKey: 'gemini-project-1', operation: '*' },
  );
  assert.ok(probe.probeAccount?.leaseUntil, 'the probe must carry its exact lease token');
  const noSecondProbe = await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db);
  assert.equal(noSecondProbe.available, false, 'only one worker may hold the probe lease');
  await releaseProviderCapacityProbe(probe.probeAccount!, db);
  resetProviderCapacityCacheForTests();
  assert.equal(
    (await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db)).probe,
    true,
    'an unused probe lease must be released for the next worker',
  );

  await recordProviderCapacitySuccess({ provider: 'gemini', scopeKey: 'gemini-project-1', operation: 'multilingual-semantic-classification', observedAt: Date.now() }, db);
  resetProviderCapacityCacheForTests();
  const healthy = await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db);
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
  const blocked = await getSemanticCapacityStatus([groq('groq-org-1')], Date.now(), db);
  assert.equal(blocked.available, false);
  await db.query(`UPDATE provider_capacity_state SET observed_at=now()-interval '60 seconds'`);
  await recordProviderCapacitySuccess({ provider: 'groq', scopeKey: 'groq-org-1', operation: '*', observedAt: Date.now() }, db);
  resetProviderCapacityCacheForTests();
  assert.equal((await getSemanticCapacityStatus([groq('groq-org-1')], Date.now(), db)).available, true);
});

maybe('a configured account with no state row keeps the pool available', async () => {
  const db = requirePool();
  await db.query(`DELETE FROM provider_capacity_state`);
  resetProviderCapacityCacheForTests();
  await recordProviderCapacityExhausted({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: '*',
    state: 'EXHAUSTED',
    reasonCode: 'PROVIDER_QUOTA_DAILY',
    resumeAt: Date.now() + 60 * 60_000,
  }, db);
  resetProviderCapacityCacheForTests();
  assert.equal((await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db)).available, false);
  const withHealthySibling = await getSemanticCapacityStatus(
    [gemini('gemini-project-1'), gemini('gemini-project-2')],
    Date.now(),
    db,
  );
  assert.equal(withHealthySibling.available, true, 'a never-failed configured account must remain eligible');
  assert.equal(withHealthySibling.probe, false);
});

maybe("a daily '*' failure overrides a stale healthy operation row", async () => {
  const db = requirePool();
  await db.query(`DELETE FROM provider_capacity_state`);
  resetProviderCapacityCacheForTests();
  await db.query(`INSERT INTO provider_capacity_state(provider,scope_key,operation,state)
                  VALUES ('gemini','gemini-project-1','multilingual-semantic-classification','HEALTHY')`);
  await recordProviderCapacityExhausted({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: '*',
    state: 'EXHAUSTED',
    reasonCode: 'PROVIDER_QUOTA_DAILY',
    resumeAt: Date.now() + 60 * 60_000,
  }, db);
  resetProviderCapacityCacheForTests();
  const parked = await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db);
  assert.equal(parked.available, false, "the daily '*' row must hide the older healthy operation row");
  await db.query(`UPDATE provider_capacity_state SET observed_at=now()-interval '60 seconds' WHERE operation='*'`);
  await recordProviderCapacitySuccess({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: 'multilingual-semantic-classification',
    observedAt: Date.now(),
  }, db);
  resetProviderCapacityCacheForTests();
  assert.equal((await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db)).available, true);
});

maybe('concurrent callers receive at most one probe', async () => {
  const db = requirePool();
  await db.query(`DELETE FROM provider_capacity_state`);
  resetProviderCapacityCacheForTests();
  await recordProviderCapacityExhausted({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: '*',
    state: 'EXHAUSTED',
    reasonCode: 'PROVIDER_QUOTA_DAILY',
    resumeAt: Date.now() + 60 * 60_000,
  }, db);
  await db.query(`UPDATE provider_capacity_state SET resume_at=now()-interval '1 second'`);
  resetProviderCapacityCacheForTests();
  const results = await Promise.all([
    getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db),
    getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db),
  ]);
  assert.equal(results.filter(result => result.probe).length, 1, 'exactly one concurrent caller may win the probe');
  assert.equal(results.filter(result => !result.available).length, 1);
});

maybe('a quota failure during a probe reopens the circuit with a new reset', async () => {
  const db = requirePool();
  await db.query(`DELETE FROM provider_capacity_state`);
  resetProviderCapacityCacheForTests();
  await recordProviderCapacityExhausted({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: '*',
    state: 'EXHAUSTED',
    reasonCode: 'PROVIDER_QUOTA_DAILY',
    resumeAt: Date.now() + 60 * 60_000,
  }, db);
  await db.query(`UPDATE provider_capacity_state SET resume_at=now()-interval '1 second'`);
  resetProviderCapacityCacheForTests();
  assert.equal((await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db)).probe, true);
  const nextReset = Date.now() + 8 * 60 * 60_000;
  await recordProviderCapacityExhausted({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: '*',
    state: 'EXHAUSTED',
    reasonCode: 'PROVIDER_QUOTA_DAILY',
    resumeAt: nextReset,
  }, db);
  resetProviderCapacityCacheForTests();
  const parked = await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db);
  assert.equal(parked.available, false);
  assert.equal(parked.probe, false);
  assert.ok((parked.resumeAt || 0) >= nextReset - 1_000, 'the failed probe must persist the new reset time');
});

maybe('an older success cannot clear a newer failure', async () => {
  const db = requirePool();
  await db.query(`DELETE FROM provider_capacity_state`);
  resetProviderCapacityCacheForTests();
  await recordProviderCapacityExhausted({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: '*',
    state: 'EXHAUSTED',
    reasonCode: 'PROVIDER_QUOTA_DAILY',
    resumeAt: Date.now() + 60 * 60_000,
  }, db);
  await recordProviderCapacitySuccess({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: 'multilingual-semantic-classification',
    observedAt: Date.now() - 60_000,
  }, db);
  resetProviderCapacityCacheForTests();
  assert.equal(
    (await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db)).available,
    false,
    'a success that started before the failure must not close the circuit',
  );
  await db.query(`UPDATE provider_capacity_state SET observed_at=now()-interval '60 seconds'`);
  await recordProviderCapacitySuccess({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: 'multilingual-semantic-classification',
    observedAt: Date.now(),
  }, db);
  resetProviderCapacityCacheForTests();
  assert.equal((await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db)).available, true);
});

maybe('an expired operation row cannot probe past a future daily block', async () => {
  const db = requirePool();
  await db.query(`DELETE FROM provider_capacity_state`);
  resetProviderCapacityCacheForTests();
  await recordProviderCapacityExhausted({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: 'multilingual-semantic-classification',
    state: 'EXHAUSTED',
    reasonCode: 'PROVIDER_QUOTA_MINUTE',
    resumeAt: Date.now() - 60_000,
  }, db);
  await db.query(`UPDATE provider_capacity_state SET resume_at=now()-interval '1 second'
                  WHERE provider='gemini' AND scope_key='gemini-project-1' AND operation='multilingual-semantic-classification'`);
  await recordProviderCapacityExhausted({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: '*',
    state: 'EXHAUSTED',
    reasonCode: 'PROVIDER_QUOTA_DAILY',
    resumeAt: Date.now() + 6 * 60 * 60_000,
  }, db);
  resetProviderCapacityCacheForTests();
  const status = await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db);
  assert.equal(status.available, false);
  assert.equal(status.probe, false, 'the expired operation row must not bypass the daily block');
  const exact = await db.query(
    `SELECT state FROM provider_capacity_state WHERE provider='gemini' AND scope_key='gemini-project-1' AND operation='multilingual-semantic-classification'`,
  );
  assert.equal(exact.rows[0].state, 'EXHAUSTED');
});

maybe('an expired worker cannot release a newer probe lease', async () => {
  const db = requirePool();
  await db.query(`DELETE FROM provider_capacity_state`);
  resetProviderCapacityCacheForTests();
  await recordProviderCapacityExhausted({
    provider: 'gemini',
    scopeKey: 'gemini-project-1',
    operation: '*',
    state: 'EXHAUSTED',
    reasonCode: 'PROVIDER_QUOTA_DAILY',
    resumeAt: Date.now() + 60 * 60_000,
  }, db);
  await db.query(`UPDATE provider_capacity_state SET resume_at=now()-interval '1 second'`);
  resetProviderCapacityCacheForTests();
  const first = await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db);
  assert.equal(first.probe, true);
  // Simulate the first worker's lease expiring before it releases.
  await db.query(`UPDATE provider_capacity_state SET probe_lease_until=now()-interval '1 second'`);
  resetProviderCapacityCacheForTests();
  const second = await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db);
  assert.equal(second.probe, true);
  await releaseProviderCapacityProbe(first.probeAccount!, db);
  resetProviderCapacityCacheForTests();
  assert.equal(
    (await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db)).probe,
    false,
    'the stale release must not clear the replacement lease',
  );
  await releaseProviderCapacityProbe(second.probeAccount!, db);
  resetProviderCapacityCacheForTests();
  assert.equal((await getSemanticCapacityStatus([gemini('gemini-project-1')], Date.now(), db)).probe, true);
});

after(async () => {
  if (!pool) return;
  try { await pool.query(`DROP TABLE IF EXISTS provider_capacity_state`); } finally { await pool.end(); }
});
