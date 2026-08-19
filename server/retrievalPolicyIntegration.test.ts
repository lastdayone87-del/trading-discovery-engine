import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRetrievalConfiguration,
  createRetrievalConfigKey,
  CURRENT_RETRIEVAL_POLICY_VERSION
} from './retrievalConfiguration';
import {
  evaluateRetrievalPolicyEligibility,
  evaluateRetrievalCanaryAuthority,
  selectLearnedRetrievalConfiguration
} from './retrievalPolicyCanary';
import {
  evaluatePreferredRetrievalConfig,
  evaluateShadowRetrievalRecommendation
} from './retrievalPolicyShadow';
import { evaluateContinuation } from './continuationPolicy';

test('deterministic retrieval-configuration identity and hashing', () => {
  const config1 = buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 2 });
  const config2 = buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 2 });
  const config3 = buildRetrievalConfiguration({ searchOrdering: 'DATE', retrievalLane: 'VIDEO', requestedPageDepth: 2 });

  assert.equal(config1.configKey, config2.configKey);
  assert.notEqual(config1.configKey, config3.configKey);
  assert.equal(config1.policyVersion, CURRENT_RETRIEVAL_POLICY_VERSION);
});

test('shadow recommendation has zero serving effect and records diff', async () => {
  const actualConfig = buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 1 });

  const shadow = await evaluateShadowRetrievalRecommendation({
    opportunityKey: 'opp_shadow_test_1',
    neighborhoodKey: 'neigh_shadow_test_1',
    actualConfig
  });

  assert.equal(shadow.opportunityKey, 'opp_shadow_test_1');
  assert.equal(shadow.actualConfigKey, actualConfig.configKey);
  assert.equal(typeof shadow.differsFromActual, 'boolean');
});

test('DATE and RELEVANCE orderings are attributable separately', () => {
  const relevance = buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 1 });
  const date = buildRetrievalConfiguration({ searchOrdering: 'DATE', retrievalLane: 'VIDEO', requestedPageDepth: 1 });

  assert.equal(relevance.searchOrdering, 'RELEVANCE');
  assert.equal(date.searchOrdering, 'DATE');
  assert.notEqual(relevance.configKey, date.configKey);
});

test('HARMFUL and SATURATED neighborhoods remain ineligible for Phase 9 deep retrieval', () => {
  const harmful = evaluateRetrievalPolicyEligibility({ neighborhoodKey: 'n1', frontierState: 'HARMFUL' });
  assert.equal(harmful.eligible, false);
  assert.equal(harmful.maxPageDepthCeiling, 1);
  assert.deepEqual(harmful.allowedOrderings, ['RELEVANCE']);

  const saturated = evaluateRetrievalPolicyEligibility({ neighborhoodKey: 'n2', frontierState: 'SATURATED', isSaturating: true });
  assert.equal(saturated.eligible, false);
  assert.equal(saturated.maxPageDepthCeiling, 1);
});

test('evaluateContinuation remains authoritative stopping boundary for deeper pagination', () => {
  // Page 1 productive
  const p1 = evaluateContinuation({
    pageNumber: 1, maxPages: 3, hasNextPage: true,
    distinctCreators: 10, cumulativeDistinctCreators: 10,
    newCreators: 8, confirmedCreators: 5, qualityConfirmedCreators: 3,
    countryPrecision: 0.9, communityDiversity: 0.4, duplicateRatio: 0.1,
    consecutiveLowYieldPages: 0, maxConsecutiveLowYieldPages: 2
  });
  assert.equal(p1.shouldContinue, true);

  // Page 2 duplicate-heavy & zero value (second consecutive low yield page)
  const p2 = evaluateContinuation({
    pageNumber: 2, maxPages: 3, hasNextPage: true,
    distinctCreators: 10, cumulativeDistinctCreators: 20,
    newCreators: 0, confirmedCreators: 0, qualityConfirmedCreators: 0,
    countryPrecision: 0.4, communityDiversity: 0, duplicateRatio: 0.9,
    consecutiveLowYieldPages: 1, maxConsecutiveLowYieldPages: 2
  });
  assert.equal(p2.shouldContinue, false);
  assert.ok(p2.reasonCodes.includes('ZERO_CONFIRMED_VALUE') || p2.reasonCodes.includes('DUPLICATE_HEAVY'));
});

test('missing feature setting or offline DB fails closed to disabled canary', async () => {
  const canaryAuth = await evaluateRetrievalCanaryAuthority({});
  assert.equal(canaryAuth.enabled, false);
  assert.equal(canaryAuth.withinCaps, false);
});
