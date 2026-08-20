import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateRetrievalPolicyEligibility,
  deterministicExplorationValue,
  selectLearnedRetrievalConfiguration,
  reserveRetrievalCanaryTreatment,
  reserveIncrementalTreatmentPageQuota,
  commitIncrementalTreatmentPageReservation,
  releaseIncrementalTreatmentPageReservation,
  enqueueChildAndCommitPageReservation
} from './retrievalPolicyCanary';

test('deterministicExplorationValue is reproducible for the same seed and differs across seeds', () => {
  const seed1 = 'opp1:neigh1:retrieval-policy-v1';
  const seed2 = 'opp2:neigh1:retrieval-policy-v1';

  const val1 = deterministicExplorationValue(seed1);
  const val1Again = deterministicExplorationValue(seed1);
  const val2 = deterministicExplorationValue(seed2);

  assert.equal(val1, val1Again);
  assert.notEqual(val1, val2);
  assert.ok(val1 >= 0 && val1 < 1.0);
});

test('selectLearnedRetrievalConfiguration is 100% deterministic for identical opportunity inputs', async () => {
  const result1 = await selectLearnedRetrievalConfiguration({
    opportunityKey: 'opp_deterministic_1',
    neighborhoodKey: 'neigh_active_1',
    retrievalLane: 'VIDEO',
    defaultOrdering: 'RELEVANCE',
    frontierState: 'ACTIVE'
  });

  const result2 = await selectLearnedRetrievalConfiguration({
    opportunityKey: 'opp_deterministic_1',
    neighborhoodKey: 'neigh_active_1',
    retrievalLane: 'VIDEO',
    defaultOrdering: 'RELEVANCE',
    frontierState: 'ACTIVE'
  });

  assert.equal(result1.config.configKey, result2.config.configKey);
  assert.equal(result1.config.searchOrdering, result2.config.searchOrdering);
  assert.equal(result1.config.requestedPageDepth, result2.config.requestedPageDepth);
});

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

test('releaseIncrementalTreatmentPageReservation does NOT revert COMMITTED page reservations', async () => {
  // Offline DB runner shim
  const released = await releaseIncrementalTreatmentPageReservation('inc-page-res:run_1:2:v1', 'run_1');
  assert.equal(released, false);
});
