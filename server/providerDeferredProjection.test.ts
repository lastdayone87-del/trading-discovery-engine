import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_DEFERRED_PROJECTION_INTERVAL_MS,
  projectProviderDeferredEnrichment
} from './operationalEnrichmentRecovery';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('provider-deferred projection is start-to-start throttled and single-flight', async () => {
  const startedAt = 20_000_000;
  let dbCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const db = {
    async query() {
      dbCalls += 1;
      await gate;
      return { rows: [], rowCount: 0 };
    }
  };
  const getDb = async () => db;
  const getChannelById = async () => null;
  const upsertChannel = async () => undefined;

  const first = projectProviderDeferredEnrichment(getDb, getChannelById, upsertChannel, 100, startedAt);
  await flush();
  assert.equal(dbCalls, 1, 'the first call starts the projection');

  const concurrent = await projectProviderDeferredEnrichment(
    getDb, getChannelById, upsertChannel, 100, startedAt + 1
  );
  assert.equal(concurrent, 0, 'a concurrent call is skipped');
  assert.equal(dbCalls, 1, 'a concurrent call must not touch the database');

  release();
  assert.equal(await first, 0);

  const throttled = await projectProviderDeferredEnrichment(
    getDb, getChannelById, upsertChannel, 100, startedAt + PROVIDER_DEFERRED_PROJECTION_INTERVAL_MS - 1
  );
  assert.equal(throttled, 0, 'a call inside the throttle window is skipped');
  assert.equal(dbCalls, 1, 'a throttled call must not touch the database');

  const next = await projectProviderDeferredEnrichment(
    getDb, getChannelById, upsertChannel, 100, startedAt + PROVIDER_DEFERRED_PROJECTION_INTERVAL_MS
  );
  assert.equal(next, 0);
  assert.equal(dbCalls, 2, 'the next projection runs at the interval boundary');
});

test('a failed projection releases the guard and retries after the throttle', async () => {
  const startedAt = 30_000_000;
  let attempts = 0;
  const db = {
    async query() {
      attempts += 1;
      if (attempts === 1) throw new Error('database unavailable');
      return { rows: [], rowCount: 0 };
    }
  };
  const getDb = async () => db;
  const getChannelById = async () => null;
  const upsertChannel = async () => undefined;

  await assert.rejects(
    projectProviderDeferredEnrichment(getDb, getChannelById, upsertChannel, 100, startedAt),
    /database unavailable/
  );

  const tooSoon = await projectProviderDeferredEnrichment(
    getDb, getChannelById, upsertChannel, 100, startedAt + PROVIDER_DEFERRED_PROJECTION_INTERVAL_MS - 1
  );
  assert.equal(tooSoon, 0);
  assert.equal(attempts, 1, 'the failed attempt still counts against the throttle window');

  const retried = await projectProviderDeferredEnrichment(
    getDb, getChannelById, upsertChannel, 100, startedAt + PROVIDER_DEFERRED_PROJECTION_INTERVAL_MS
  );
  assert.equal(retried, 0);
  assert.equal(attempts, 2, 'the guard was released, so the next window retries');
});
