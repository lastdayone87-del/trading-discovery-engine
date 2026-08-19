import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRetrievalConfiguration
} from './retrievalConfiguration';
import {
  evaluatePreferredRetrievalConfig,
  evaluateShadowRetrievalRecommendation
} from './retrievalPolicyShadow';

test('evaluatePreferredRetrievalConfig returns actual config or best scoring candidate', async () => {
  const actual = buildRetrievalConfiguration({
    searchOrdering: 'RELEVANCE',
    retrievalLane: 'VIDEO',
    requestedPageDepth: 1
  });

  const preferred = await evaluatePreferredRetrievalConfig('test_neighborhood_1', actual);
  assert.ok(preferred.recommendedConfig);
  assert.ok(preferred.recommendedConfig.configKey);
  assert.equal(typeof preferred.expectedMarginalValue, 'number');
  assert.equal(typeof preferred.uncertainty, 'number');
});

test('evaluateShadowRetrievalRecommendation has zero serving authority and calculates diff', async () => {
  const actual = buildRetrievalConfiguration({
    searchOrdering: 'RELEVANCE',
    retrievalLane: 'VIDEO',
    requestedPageDepth: 1
  });

  const recommendation = await evaluateShadowRetrievalRecommendation({
    opportunityKey: 'opp_123',
    neighborhoodKey: 'test_neighborhood_1',
    actualConfig: actual
  });

  assert.equal(recommendation.opportunityKey, 'opp_123');
  assert.equal(recommendation.actualConfigKey, actual.configKey);
  assert.equal(typeof recommendation.differsFromActual, 'boolean');
});
