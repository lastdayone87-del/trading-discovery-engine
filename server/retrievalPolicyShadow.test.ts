import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRetrievalConfiguration
} from './retrievalConfiguration';
import {
  evaluatePreferredRetrievalConfig,
  evaluateShadowRetrievalRecommendation
} from './retrievalPolicyShadow';

test('evaluatePreferredRetrievalConfig returns base config or best scoring candidate', async () => {
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

test('evaluateShadowRetrievalRecommendation explicitly distinguishes control, executed, and recommended configs', async () => {
  const control = buildRetrievalConfiguration({
    searchOrdering: 'RELEVANCE',
    retrievalLane: 'VIDEO',
    requestedPageDepth: 1
  });

  const executed = buildRetrievalConfiguration({
    searchOrdering: 'DATE',
    retrievalLane: 'VIDEO',
    requestedPageDepth: 2
  });

  const recommendation = await evaluateShadowRetrievalRecommendation({
    opportunityKey: 'opp_shadow_test_2',
    neighborhoodKey: 'test_neighborhood_1',
    controlConfig: control,
    executedConfig: executed
  });

  assert.equal(recommendation.opportunityKey, 'opp_shadow_test_2');
  assert.equal(recommendation.controlConfigKey, control.configKey);
  assert.equal(recommendation.executedConfigKey, executed.configKey);
  assert.equal(typeof recommendation.differsFromControl, 'boolean');
  assert.equal(typeof recommendation.differsFromExecuted, 'boolean');
});
