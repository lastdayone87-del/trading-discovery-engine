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

test('a complete ledger read is cached across polls inside the TTL', async () => {
  resetSemanticRouteHealthCacheForTests();
  try {
    let queries = 0;
    const ok = async () => {
      queries++;
      return [];
    };
    await getSemanticRouteHealth(Date.now(), { query: ok });
    await getSemanticRouteHealth(Date.now() + 5_000, { query: ok });
    assert.equal(queries, 2, 'the second poll inside the TTL must reuse the cache');
  } finally {
    resetSemanticRouteHealthCacheForTests();
  }
});
