import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateQueryFunnel, countDeferredRawResults, isSeverelyContaminatedQuery, manualSearchContinuationMetrics, selectQueryCollection, type QueryObservation } from './queryPerformance';
import { countTrailingLowYieldPages, evaluateContinuation } from './continuationPolicy';
import { aggregatePageMetrics } from './autonomousPageStore';

test('query funnel keeps duplicates, known channels, exclusions, and classifications separate', () => {
  const observations: QueryObservation[] = [
    { channelId: 'confirmed-new', wasKnown: false, persisted: true, funnelOutcome: 'TRADING_CONFIRMED', qualityScore: 80, hasCommunity: true },
    { channelId: 'confirmed-new', wasKnown: false, persisted: true, funnelOutcome: 'TRADING_CONFIRMED', qualityScore: 80, hasCommunity: true },
    { channelId: 'known', wasKnown: true, persisted: true, funnelOutcome: 'NON_TRADING', qualityScore: 0, hasCommunity: false },
    { channelId: 'excluded', wasKnown: false, persisted: false, funnelOutcome: 'COUNTRY_REJECTED', qualityScore: 0, hasCommunity: false },
    { channelId: 'uncertain', wasKnown: false, persisted: true, funnelOutcome: 'UNCERTAIN', qualityScore: 40, hasCommunity: false },
    { channelId: 'review', wasKnown: false, persisted: true, funnelOutcome: 'NEEDS_REVIEW', qualityScore: 45, hasCommunity: false }
  ];
  const metrics = calculateQueryFunnel(6, observations);
  assert.deepEqual({
    distinct: metrics.distinctResults,
    duplicates: metrics.duplicateResults,
    known: metrics.knownChannels,
    fresh: metrics.newChannels,
    rejected: metrics.countryRejected,
    nonTrading: metrics.nonTrading,
    uncertain: metrics.uncertain,
    review: metrics.needsReview,
    confirmed: metrics.tradingConfirmed
  }, { distinct: 5, duplicates: 1, known: 1, fresh: 3, rejected: 1, nonTrading: 1, uncertain: 1, review: 1, confirmed: 1 });
  assert.equal(metrics.noveltyRatio, 3 / 5);
  assert.equal(metrics.countryPrecision, 4 / 5);
  assert.equal(metrics.tradingPrecision, 1 / 4);
});

test('excluded candidates never count as new database channels', () => {
  const metrics = calculateQueryFunnel(1, [
    { channelId: 'blocked', wasKnown: false, persisted: false, funnelOutcome: 'COUNTRY_REJECTED', qualityScore: 0, hasCommunity: false }
  ]);
  assert.equal(metrics.newChannels, 0);
  assert.equal(metrics.performanceScore, 0);
  assert.equal(selectQueryCollection('EXPERIMENTAL', 1, metrics), 'REJECTED');
});

test('severely contaminated retrieval is quarantined after its first run', () => {
  const observations: QueryObservation[] = Array.from({ length: 10 }, (_, index) => ({
    channelId: `junk-${index}`,
    wasKnown: false,
    persisted: true,
    funnelOutcome: index === 0 ? 'TRADING_CONFIRMED' as const : index < 6 ? 'UNCERTAIN' as const : 'NEEDS_REVIEW' as const,
    qualityScore: index === 0 ? 20 : 0,
    hasCommunity: false
  }));
  const metrics = calculateQueryFunnel(10, observations);
  assert.equal(isSeverelyContaminatedQuery(metrics), true);
  assert.equal(selectQueryCollection('EXPERIMENTAL', 0, metrics), 'REJECTED');
});

test('mixed but useful exploratory retrieval is not prematurely quarantined', () => {
  const observations: QueryObservation[] = Array.from({ length: 10 }, (_, index) => ({
    channelId: `candidate-${index}`,
    wasKnown: false,
    persisted: true,
    funnelOutcome: index < 3 ? 'TRADING_CONFIRMED' as const : 'UNCERTAIN' as const,
    qualityScore: index < 3 ? 70 : 35,
    hasCommunity: index === 0
  }));
  const metrics = calculateQueryFunnel(10, observations);
  assert.equal(isSeverelyContaminatedQuery(metrics), false);
  assert.notEqual(selectQueryCollection('EXPERIMENTAL', 0, metrics), 'REJECTED');
});

test('out-of-scope fresh channels earn no learning credit when scope is observed', () => {
  const base = (channelId: string, scopeEligibility?: 'IN_SCOPE' | 'OUT_OF_SCOPE' | 'UNRESOLVED'): QueryObservation => ({
    channelId, wasKnown: false, persisted: true, funnelOutcome: 'TRADING_CONFIRMED', qualityScore: 80, hasCommunity: false, scopeEligibility,
  });
  const metrics = calculateQueryFunnel(4, [base('a', 'IN_SCOPE'), base('b', 'OUT_OF_SCOPE'), base('c', 'UNRESOLVED'), base('d', undefined)]);
  assert.equal(metrics.newChannels, 4);
  // IN_SCOPE earns; legacy-missing stays neutral (backward compatible);
  // explicitly observed OUT_OF_SCOPE and UNRESOLVED do not.
  assert.equal(metrics.inScopeNewChannels, 2);
});

test('deferred probe results keep raw reporting but do not count as duplicates', () => {
  const observations: QueryObservation[] = [
    { channelId: 'a', wasKnown: false, persisted: true, funnelOutcome: 'TRADING_CONFIRMED', qualityScore: 80, hasCommunity: false },
    { channelId: 'b', wasKnown: false, persisted: true, funnelOutcome: 'UNCERTAIN', qualityScore: 40, hasCommunity: false },
  ];
  const metrics = calculateQueryFunnel(10, observations, 6);
  assert.equal(metrics.rawResults, 10, 'the provider result count is preserved for reporting');
  assert.equal(metrics.deferredResults, 6);
  assert.equal(metrics.evaluatedRawResults, 4);
  assert.equal(metrics.duplicateResults, 2, 'deferred results are not duplicates');
});

test('manual page metrics exclude deferred channels from novelty and precision', () => {
  const metrics = manualSearchContinuationMetrics({
    rawIds: ['a', 'a', 'b', 'c'],
    uniqueIds: ['a', 'b', 'c'],
    deferredIds: ['b'],
    previousIds: ['a'],
    countryAccepted: 1,
    confirmedCount: 0,
    communityCount: 0,
  });
  assert.deepEqual(metrics.evaluatedUniqueIds, ['a', 'c']);
  assert.deepEqual(metrics.novelIds, ['c']);
  assert.equal(metrics.deferredOnly, false);
  assert.equal(metrics.distinctCreators, 2);
  assert.equal(metrics.noveltyRatio, 0.5);
  assert.ok(Math.abs(metrics.duplicateRatio - 1 / 3) < 1e-12, 'one of three evaluated raw results is a duplicate');
  assert.equal(metrics.countryPrecision, 0.5);

  const allDeferred = manualSearchContinuationMetrics({
    rawIds: ['b'],
    uniqueIds: ['b'],
    deferredIds: ['b'],
    previousIds: [],
    countryAccepted: 0,
    confirmedCount: 0,
    communityCount: 0,
  });
  assert.equal(allDeferred.deferredOnly, true);
  assert.equal(allDeferred.duplicateRatio, 0);
  assert.equal(allDeferred.countryPrecision, 0);
});

test('manual duplicate ratio counts repeated occurrences, not previously seen creators', () => {
  const metrics = manualSearchContinuationMetrics({
    rawIds: ['known', 'known', 'new'],
    uniqueIds: ['known', 'new'],
    deferredIds: [],
    previousIds: ['known'],
    countryAccepted: 2,
    confirmedCount: 0,
    communityCount: 0,
  });
  assert.ok(Math.abs(metrics.duplicateRatio - 1 / 3) < 1e-12, 'only the repeated occurrence is a duplicate');
  assert.equal(metrics.noveltyRatio, 0.5, 'the previously seen creator is not novel, but is also not a duplicate');
});

test('deferred raw counting uses provider occurrences, not distinct channels', () => {
  assert.equal(countDeferredRawResults(['a', 'b', 'b', 'c'], ['b']), 2);
  assert.equal(countDeferredRawResults(['a', 'a', 'b'], new Set(['a', 'b'])), 3);
  assert.equal(countDeferredRawResults(['a', 'b'], []), 0);
});

test('completed run metrics preserve deferred accounting', () => {
  const first = calculateQueryFunnel(4, [
    { channelId: 'a', wasKnown: false, persisted: true, funnelOutcome: 'TRADING_CONFIRMED', qualityScore: 80, hasCommunity: false },
  ], 2);
  const second = calculateQueryFunnel(3, [
    { channelId: 'b', wasKnown: false, persisted: true, funnelOutcome: 'UNCERTAIN', qualityScore: 40, hasCommunity: false },
  ], 1);
  const aggregate = aggregatePageMetrics([first, second]);
  assert.equal(aggregate.rawResults, 7);
  assert.equal(aggregate.deferredResults, 3);
  assert.equal(aggregate.evaluatedRawResults, 4);
  assert.equal(aggregate.duplicateResults, 2);
});

test('deferred-only pages do not stop normal pagination as low yield', () => {
  const metrics = calculateQueryFunnel(6, [], 6);
  const page = {
    pageNumber: 1, maxPages: 3, hasNextPage: true,
    distinctCreators: metrics.distinctResults,
    cumulativeDistinctCreators: metrics.distinctResults,
    newCreators: metrics.newChannels, confirmedCreators: metrics.tradingConfirmed,
    qualityConfirmedCreators: metrics.qualityChannels,
    countryPrecision: metrics.countryPrecision,
    communityDiversity: 0,
    duplicateRatio: metrics.evaluatedRawResults ? metrics.duplicateResults / metrics.evaluatedRawResults : 0,
    consecutiveLowYieldPages: 1, maxConsecutiveLowYieldPages: 2,
    deferredOnly: true,
  };
  const decision = evaluateContinuation(page);
  assert.equal(decision.shouldContinue, true);
  assert.equal(decision.lowYield, false);
  assert.equal(decision.primaryReason, 'CONTINUE_EXPLORATION');
  assert.ok(decision.reasonCodes.includes('DEFERRED_ONLY'));
  assert.equal(evaluateContinuation({ ...page, pageNumber: 3 }).shouldContinue, false);
  assert.equal(evaluateContinuation({ ...page, pageNumber: 3 }).primaryReason, 'PAGE_CEILING');
});

test('deferred-only pages are transparent when rebuilding the low-yield streak', () => {
  const rows = [
    { marginalUtility: 0, reasonCodes: ['DEFERRED_ONLY'] },
    { marginalUtility: 0.1, reasonCodes: ['ZERO_CONFIRMED_VALUE'] },
    { marginalUtility: 0, reasonCodes: ['DEFERRED_ONLY'] },
    { marginalUtility: 0.1, reasonCodes: ['DUPLICATE_HEAVY'] },
    { marginalUtility: 0.8, reasonCodes: ['CONTINUE_PRODUCTIVE'] },
  ];
  assert.equal(countTrailingLowYieldPages(rows), 2, 'deferred-only pages neither extend nor reset the streak');
  assert.equal(countTrailingLowYieldPages([
    { marginalUtility: 0.1, reasonCodes: ['WRONG_COUNTRY'] },
    { marginalUtility: 0, reasonCodes: ['DEFERRED_ONLY'] },
    { marginalUtility: 0.8, reasonCodes: ['CONTINUE_PRODUCTIVE'] },
  ]), 1);
});

test('scope weighting stays neutral when no observation carries scope', () => {
  const metrics = calculateQueryFunnel(2, [
    { channelId: 'a', wasKnown: false, persisted: true, funnelOutcome: 'TRADING_CONFIRMED', qualityScore: 80, hasCommunity: false },
    { channelId: 'b', wasKnown: false, persisted: true, funnelOutcome: 'UNCERTAIN', qualityScore: 40, hasCommunity: false },
  ]);
  assert.equal(metrics.newChannels, 2);
  assert.equal(metrics.inScopeNewChannels, 2);
});
