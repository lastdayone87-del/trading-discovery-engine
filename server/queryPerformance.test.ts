import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateQueryFunnel, selectQueryCollection, type QueryObservation } from './queryPerformance';

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
