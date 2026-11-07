import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSemanticRouteHealth,
  resetSemanticRouteHealthCacheForTests,
} from './semanticRouteHealth';

test('a failed ledger read is not cached as an authoritative empty ledger', async () => {
  resetSemanticRouteHealthCacheForTests();
  try {
    let failedQueries = 0;
    const degraded = await getSemanticRouteHealth(Date.now(), {
      query: async () => {
        failedQueries++;
        throw new Error('ledger unavailable');
      },
    });
    assert.deepEqual(degraded.recentFailures, []);
    assert.equal(failedQueries, 2, 'both ledger aggregates are attempted');

    let recoveredQueries = 0;
    const recovered = await getSemanticRouteHealth(Date.now(), {
      query: async () => {
        recoveredQueries++;
        return [];
      },
    });
    assert.deepEqual(recovered.recentFailures, []);
    assert.equal(recoveredQueries, 2, 'the next poll must re-read after a degraded read');
  } finally {
    resetSemanticRouteHealthCacheForTests();
  }
});

test('a complete ledger read is cached inside the TTL and refreshed after it', async (t) => {
  resetSemanticRouteHealthCacheForTests();
  let clockMs = 1_000_000;
  t.mock.method(Date, 'now', () => clockMs);
  try {
    let queries = 0;
    const ok = async () => {
      queries++;
      return [];
    };
    await getSemanticRouteHealth(clockMs, { query: ok });
    assert.equal(queries, 2, 'the first poll reads both aggregates');

    clockMs += 5_000;
    await getSemanticRouteHealth(clockMs, { query: ok });
    assert.equal(queries, 2, 'a poll inside the TTL must reuse the cache');

    clockMs += 20_000;
    await getSemanticRouteHealth(clockMs, { query: ok });
    assert.equal(queries, 4, 'a poll after the TTL must re-read both aggregates');
  } finally {
    resetSemanticRouteHealthCacheForTests();
  }
});
