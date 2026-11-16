import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCandidateDuplicate, dedupeCandidateBatch } from './queryDuplicateGuard';

test('exact and reordered queries are hard duplicates', () => {
  const exact = classifyCandidateDuplicate(
    { query: 'DAX heute trading', country: 'Germany', intent: 'market_analysis' },
    [{ query: 'dax  heute   trading', country: 'Germany', intent: 'market_analysis' }],
  );
  assert.equal(exact.duplicate, true);
  assert.equal(exact.class, 'EXACT');

  const reordered = classifyCandidateDuplicate(
    { query: 'DAX heute trading', country: 'Germany', intent: 'market_analysis' },
    [{ query: 'DAX trading heute', country: 'Germany', intent: 'market_analysis' }],
  );
  assert.equal(reordered.duplicate, true);
  assert.equal(reordered.class, 'SEMANTIC');
});

test('same anchor with different intent is not automatically a duplicate', () => {
  const live = classifyCandidateDuplicate(
    { query: 'DAX live trading', country: 'Germany', intent: 'live_trading' },
    [{ query: 'DAX heute trading', country: 'Germany', intent: 'market_analysis' }],
  );
  assert.equal(live.duplicate, false);
  assert.ok(live.similarity < 0.8);

  const beginner = classifyCandidateDuplicate(
    { query: 'DAX trading für Anfänger', country: 'Germany', intent: 'education' },
    [{ query: 'DAX trading für Einsteiger', country: 'Germany', intent: 'education' }],
  );
  assert.equal(beginner.duplicate, false);
  assert.equal(beginner.nearDuplicate, true);
});

test('batch dedupe keeps distinct intentions and drops exact repeats', () => {
  const result = dedupeCandidateBatch(
    [
      { query: 'DAX Analyse heute', country: 'Germany', intent: 'market_analysis' },
      { query: 'DAX Analyse heute', country: 'Germany', intent: 'market_analysis' },
      { query: 'DAX live trading', country: 'Germany', intent: 'live_trading' },
    ],
    [],
  );
  assert.deepEqual(result.accepted.map(item => item.query), ['DAX Analyse heute', 'DAX live trading']);
  assert.equal(result.rejected.length, 1);
});
