import test from 'node:test';
import assert from 'node:assert/strict';
import { reformulatePollutedQuery } from './queryPlanner';
import { isSeverelyContaminatedQuery, selectQueryCollection } from './queryPerformance';

test('reformulatePollutedQuery generates governed trading-specific reformulation', () => {
  const result = reformulatePollutedQuery({
    pollutedQuery: 'DAX',
    country: 'Germany',
    intent: 'strategy'
  });

  assert.ok(result);
  assert.match(result.query, /DAX/i);
  assert.equal(result.generationMode, 'EXPLORATION');
  assert.ok(result.metadata.reformulatedFrom);
});

test('isSeverelyContaminatedQuery quarantines heavily contaminated query cohorts', () => {
  const metrics = {
    rawResults: 10,
    distinctResults: 10,
    duplicateResults: 0,
    knownChannels: 0,
    newChannels: 10,
    countryRejected: 0,
    nonTrading: 9,
    uncertain: 1,
    needsReview: 0,
    tradingConfirmed: 0,
    qualityChannels: 0,
    communitiesDiscovered: 0,
    averageQualityScore: 10,
    noveltyRatio: 1.0,
    countryPrecision: 1.0,
    tradingPrecision: 0.0,
    performanceScore: 20
  };

  assert.equal(isSeverelyContaminatedQuery(metrics), true);
  assert.equal(selectQueryCollection('EXPERIMENTAL', 0, metrics), 'REJECTED');
});
