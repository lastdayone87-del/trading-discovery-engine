import test from 'node:test';
import assert from 'node:assert/strict';
import { assessGeneratedSurface, surfaceSimilarity, surfaceTokens } from './generatedQuerySurface';

const history = [
  { queryId: 1, query: 'SMI Charttechnik Analyse', primaryTerm: 'SMI Charttechnik Analyse', timesExecuted: 2, distinctResults: 40, newChannels: 0 },
  { queryId: 2, query: 'unrelated market topic', primaryTerm: 'unrelated market topic', timesExecuted: 1, distinctResults: 0, newChannels: 0 },
];

test('near-duplicate generated surfaces are deferred when prior yield is zero or empty', () => {
  const near = assessGeneratedSurface('SMI Charttechnik Analyse für Anfänger', history);
  assert.equal(near.allowed, false);
  assert.equal(near.reason, 'NEAR_DUPLICATE_ZERO_YIELD');
  const empty = assessGeneratedSurface('unrelated market topic today', history);
  assert.equal(empty.allowed, false);
  assert.equal(empty.reason, 'NEAR_DUPLICATE_EMPTY');
});

test('unrelated surfaces and non-executed history remain allowed', () => {
  assert.equal(assessGeneratedSurface('nq futures strategy', history).allowed, true);
  assert.equal(assessGeneratedSurface('SMI Charttechnik Analyse', [
    { ...history[0], timesExecuted: 0 },
  ]).allowed, true);
  assert.equal(assessGeneratedSurface('SMI Charttechnik Analyse für Anfänger', [
    { ...history[0], newChannels: 4 },
  ]).allowed, true, 'a previously productive surface may be retried');
});

test('batch duplicate surfaces are deferred before materialization', () => {
  const first = assessGeneratedSurface('analyse technique bitcoin', history);
  assert.equal(first.allowed, true);
  const second = assessGeneratedSurface('analyse technique bitcoin 2026', history, ['analyse technique bitcoin']);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'BATCH_DUPLICATE');
  assert.ok(surfaceSimilarity('analyse technique bitcoin', 'analyse technique bitcoin 2026') >= 0.75);
  assert.deepEqual(surfaceTokens('a bb'), ['bb']);
});

test('tokenization preserves combining marks and single-character CJK words', () => {
  // A Tamil word with vowel signs must stay one token.
  assert.deepEqual(surfaceTokens('தமிழ் சந்தை'), ['தமிழ்', 'சந்தை']);
  // Distinct one-character CJK words must not collapse into the shared suffix.
  const japaneseA = surfaceTokens('株 おすすめ');
  const japaneseB = surfaceTokens('金 おすすめ');
  assert.ok(japaneseA.includes('株'));
  assert.ok(japaneseB.includes('金'));
  assert.ok(surfaceSimilarity('株 おすすめ', '金 おすすめ') < 1);
  // ASCII single characters remain excluded.
  assert.deepEqual(surfaceTokens('x bb'), ['bb']);
});
