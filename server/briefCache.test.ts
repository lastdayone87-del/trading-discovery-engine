import test from 'node:test';
import assert from 'node:assert/strict';
import { createBriefCache } from './briefCache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('a successful snapshot is reused until its TTL expires', async () => {
  let now = 1_000;
  let loads = 0;
  const cache = createBriefCache(async () => ++loads, 1_000, () => now);

  assert.equal(await cache.get(), 1);
  now = 1_999;
  assert.equal(await cache.get(), 1, 'inside the TTL the snapshot is reused');
  assert.equal(loads, 1);

  now = 2_000;
  assert.equal(await cache.get(), 2, 'at the TTL boundary a fresh snapshot is loaded');
  assert.equal(loads, 2);
});

test('concurrent reads share one in-flight load', async () => {
  let loads = 0;
  const gate = deferred<string>();
  const cache = createBriefCache(() => {
    loads += 1;
    return gate.promise;
  }, 1_000, () => 1_000);

  const first = cache.get();
  const second = cache.get();
  assert.equal(loads, 1, 'the second read joins the in-flight load');

  gate.resolve('snapshot');
  assert.equal(await first, 'snapshot');
  assert.equal(await second, 'snapshot');
  assert.equal(loads, 1);
});

test('a failed load is not cached and the next read retries immediately', async () => {
  let attempts = 0;
  const cache = createBriefCache(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('database unavailable');
    return 'recovered';
  }, 1_000, () => 1_000);

  await assert.rejects(cache.get(), /database unavailable/);
  assert.equal(await cache.get(), 'recovered', 'a failure must not poison the cache');
  assert.equal(attempts, 2);
});

test('invalidation discards the snapshot and ignores a load that started before the mutation', async () => {
  let now = 1_000;
  let loads = 0;
  const first = deferred<string>();
  const second = deferred<string>();
  const pending = [first.promise, second.promise];
  const cache = createBriefCache(() => {
    const index = loads;
    loads += 1;
    return pending[index];
  }, 1_000, () => now);

  const oldRead = cache.get();
  cache.invalidate();
  const newRead = cache.get();
  assert.equal(loads, 2, 'invalidation starts a fresh load instead of joining the old one');

  first.resolve('pre-mutation');
  assert.equal(await oldRead, 'pre-mutation');
  second.resolve('post-mutation');
  assert.equal(await newRead, 'post-mutation');

  // The stale load must not have repopulated the cache.
  assert.equal(await cache.get(), 'post-mutation');
  assert.equal(loads, 2);
});

test('a non-positive TTL is rejected', () => {
  assert.throws(() => createBriefCache(async () => 1, 0), /positive finite/);
  assert.throws(() => createBriefCache(async () => 1, Number.NaN), /positive finite/);
});
