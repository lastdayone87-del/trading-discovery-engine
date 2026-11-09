import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_COOLDOWN_CACHE_TTL_MS,
  ProviderCooldownReadCache,
  providerCooldownReadCache,
} from './cooldownReadCache';

test('active cooldown is cached and reused inside the TTL', async () => {
  const cache = new ProviderCooldownReadCache(5_000);
  let loads = 0;
  const loader = async () => { loads += 1; return 10_000; };
  assert.equal(await cache.get('gemini:org:a', 1_000, loader), 10_000);
  assert.equal(await cache.get('gemini:org:a', 2_000, loader), 10_000);
  assert.equal(loads, 1);
});

test('an expired cooldown becomes available before the cache TTL without another read', async () => {
  const cache = new ProviderCooldownReadCache(5_000);
  let loads = 0;
  const loader = async () => { loads += 1; return 3_000; };
  assert.equal(await cache.get('groq:org:a', 1_000, loader), 3_000);
  assert.equal(await cache.get('groq:org:a', 3_000, loader), undefined, 'expiry instant is no longer active');
  assert.equal(loads, 1, 'the cached value is still authoritative inside the TTL');
});

test('newly available capacity is observed after the TTL', async () => {
  const cache = new ProviderCooldownReadCache(5_000);
  let loads = 0;
  let value: number | undefined;
  const loader = async () => { loads += 1; return value; };
  assert.equal(await cache.get('gemini:pool', 1_000, loader), undefined);
  value = 20_000;
  assert.equal(await cache.get('gemini:pool', 2_000, loader), undefined, 'no-cooldown result is cached for the TTL');
  assert.equal(loads, 1);
  assert.equal(await cache.get('gemini:pool', 1_000 + PROVIDER_COOLDOWN_CACHE_TTL_MS, loader), 20_000);
  assert.equal(loads, 2, 'a provider-state change is picked up at the TTL boundary');
});

test('a loader failure is never cached, so the next read retries', async () => {
  const cache = new ProviderCooldownReadCache(5_000);
  let loads = 0;
  const loader = async () => {
    loads += 1;
    if (loads === 1) throw new Error('database unavailable');
    return 12_000;
  };
  await assert.rejects(cache.get('gemini:org:b', 1_000, loader), /database unavailable/);
  assert.equal(await cache.get('gemini:org:b', 1_000, loader), 12_000);
  assert.equal(loads, 2);
});

test('invalidation makes a new rate-limit visible immediately', async () => {
  const cache = new ProviderCooldownReadCache(5_000);
  let loads = 0;
  let value: number | undefined;
  const loader = async () => { loads += 1; return value; };
  assert.equal(await cache.get('groq:pool', 1_000, loader), undefined);
  value = 15_000;
  assert.equal(await cache.get('groq:pool', 1_100, loader), undefined);
  cache.invalidate('groq:pool');
  assert.equal(await cache.get('groq:pool', 1_100, loader), 15_000);
  assert.equal(loads, 2);
});

test('shared production cache can be invalidated as a whole', () => {
  providerCooldownReadCache.invalidate();
  assert.equal(providerCooldownReadCache.size(), 0);
});

test('concurrent misses for the same key share one ledger read', async () => {
  const cache = new ProviderCooldownReadCache(5_000);
  let loads = 0;
  const loader = async () => { loads += 1; return 9_000; };
  const [a, b, c] = await Promise.all([
    cache.get('gemini:org:a', 1_000, loader),
    cache.get('gemini:org:a', 1_000, loader),
    cache.get('gemini:org:a', 1_000, loader),
  ]);
  assert.deepEqual([a, b, c], [9_000, 9_000, 9_000]);
  assert.equal(loads, 1);
});

test('an in-flight read cannot repopulate stale state after invalidation', async () => {
  const cache = new ProviderCooldownReadCache(5_000);
  let resolveOld!: (value: number | undefined) => void;
  let loads = 0;
  const values: Array<number | undefined> = [undefined, 20_000];
  const loader = () => {
    const value = values[loads];
    loads += 1;
    if (loads === 1) return new Promise<number | undefined>(resolve => { resolveOld = resolve; });
    return Promise.resolve(value);
  };
  const pending = cache.get('groq:org:a', 1_000, loader);
  cache.invalidateProvider('groq');
  resolveOld(undefined); // stale read completes after the new rate-limit landed
  assert.equal(await pending, 20_000, 'the retry must observe the post-invalidation state');
  assert.equal(loads, 2);
});

test('provider-scoped invalidation does not discard unrelated provider reads', async () => {
  const cache = new ProviderCooldownReadCache(5_000);
  let geminiLoads = 0;
  let groqLoads = 0;
  await cache.get('gemini:org:a', 1_000, async () => { geminiLoads += 1; return 8_000; });
  await cache.get('groq:org:a', 1_000, async () => { groqLoads += 1; return 9_000; });
  cache.invalidateProvider('gemini');
  assert.equal(await cache.get('groq:org:a', 1_100, async () => { groqLoads += 1; return 9_000; }), 9_000);
  assert.equal(groqLoads, 1);
  assert.equal(await cache.get('gemini:org:a', 1_100, async () => { geminiLoads += 1; return 8_000; }), 8_000);
  assert.equal(geminiLoads, 2);
});
