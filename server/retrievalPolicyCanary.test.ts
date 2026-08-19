import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateRetrievalPolicyEligibility,
  selectLearnedRetrievalConfiguration
} from './retrievalPolicyCanary';

test('evaluateRetrievalPolicyEligibility rejects HARMFUL and SATURATED neighborhoods from deep retrieval', () => {
  const harmful = evaluateRetrievalPolicyEligibility({
    neighborhoodKey: 'neigh_harmful',
    frontierState: 'HARMFUL'
  });
  assert.equal(harmful.eligible, false);
  assert.equal(harmful.maxPageDepthCeiling, 1);
  assert.deepEqual(harmful.allowedOrderings, ['RELEVANCE']);

  const saturated = evaluateRetrievalPolicyEligibility({
    neighborhoodKey: 'neigh_sat',
    frontierState: 'SATURATED',
    isSaturating: true
  });
  assert.equal(saturated.eligible, false);
  assert.equal(saturated.maxPageDepthCeiling, 1);

  const active = evaluateRetrievalPolicyEligibility({
    neighborhoodKey: 'neigh_active',
    frontierState: 'ACTIVE'
  });
  assert.equal(active.eligible, true);
  assert.equal(active.maxPageDepthCeiling, 3);
  assert.deepEqual(active.allowedOrderings, ['RELEVANCE', 'DATE']);
});

test('selectLearnedRetrievalConfiguration respects eligibility and produces bounded config', async () => {
  const result = await selectLearnedRetrievalConfiguration({
    neighborhoodKey: 'neigh_active_1',
    retrievalLane: 'VIDEO',
    defaultOrdering: 'RELEVANCE',
    frontierState: 'ACTIVE'
  });

  assert.ok(result.config);
  assert.ok(result.config.configKey);
  assert.ok(result.config.requestedPageDepth >= 1 && result.config.requestedPageDepth <= 3);
  assert.ok(['RELEVANCE', 'DATE'].includes(result.config.searchOrdering));
  assert.equal(result.config.retrievalLane, 'VIDEO');
});
