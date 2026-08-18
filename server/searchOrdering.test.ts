import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateSearchOrdering, youtubeOrder } from './searchOrdering';

test('RELEVANCE is the control and the fallback', () => {
  assert.equal(allocateSearchOrdering('VIDEO', 0, 0, 0), 'RELEVANCE');
  assert.equal(allocateSearchOrdering('VIDEO', 0, 0, Number.NaN), 'RELEVANCE');
  assert.equal(youtubeOrder('RELEVANCE'), 'relevance');
});

test('DATE allocation converges within VIDEO runs', () => {
  const orig = process.env.DISCOVERY_RECENCY_FLOOR_PERCENT;
  try {
    process.env.DISCOVERY_RECENCY_FLOOR_PERCENT = '0';
    let dates = 0;
    for (let total = 0; total < 20; total++) {
      if (allocateSearchOrdering('VIDEO', dates, total, 25) === 'DATE') dates++;
    }
    assert.equal(dates, 5);
    assert.equal(youtubeOrder('DATE'), 'date');
  } finally {
    process.env.DISCOVERY_RECENCY_FLOOR_PERCENT = orig;
  }
});

test('DATE is not assigned to the CHANNEL lane', () => {
  assert.equal(allocateSearchOrdering('CHANNEL', 0, 0, 100), 'RELEVANCE');
});
