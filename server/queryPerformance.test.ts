import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateQueryFunnel, isSeverelyContaminatedQuery, selectQueryCollection, type QueryObservation } from './queryPerformance';

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
