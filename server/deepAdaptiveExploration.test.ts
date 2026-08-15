import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateContinuation } from './continuationPolicy';

test('evaluateContinuation allows productive branch with novel candidates to continue when confirmation lags', () => {
  const decision = evaluateContinuation({
    pageNumber: 1,
    maxPages: 5,
    hasNextPage: true,
    distinctCreators: 10,
    cumulativeDistinctCreators: 10,
    newCreators: 8,
    confirmedCreators: 0, // enrichment pending
    qualityConfirmedCreators: 0,
    countryPrecision: 0.9,
    communityDiversity: 0.0,
    duplicateRatio: 0.1,
    consecutiveLowYieldPages: 0,
    maxConsecutiveLowYieldPages: 2
  });

  assert.equal(decision.shouldContinue, true);
  assert.equal(decision.lowYield, false);
});

test('evaluateContinuation terminates early for duplicate-heavy or zero-value pages', () => {
  const decision = evaluateContinuation({
    pageNumber: 1,
    maxPages: 5,
    hasNextPage: true,
    distinctCreators: 10,
    cumulativeDistinctCreators: 10,
    newCreators: 0,
    confirmedCreators: 0,
    qualityConfirmedCreators: 0,
    countryPrecision: 0.3,
    communityDiversity: 0.0,
    duplicateRatio: 0.9,
    consecutiveLowYieldPages: 1,
    maxConsecutiveLowYieldPages: 2
  });

  assert.equal(decision.shouldContinue, false);
  assert.ok(decision.reasonCodes.includes('DUPLICATE_HEAVY') || decision.reasonCodes.includes('ZERO_CONFIRMED_VALUE'));
});
