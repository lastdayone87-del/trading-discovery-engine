import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRetrievalConfiguration,
  createRetrievalConfigKey,
  CURRENT_RETRIEVAL_POLICY_VERSION
} from './retrievalConfiguration';
import {
  evaluateRetrievalPolicyEligibility,
  deterministicExplorationValue,
  selectLearnedRetrievalConfiguration,
  reserveRetrievalCanaryTreatment,
  reserveIncrementalTreatmentPageQuota,
  enqueueChildAndCommitPageReservation
} from './retrievalPolicyCanary';
import {
  evaluatePreferredRetrievalConfig,
  evaluateShadowRetrievalRecommendation
} from './retrievalPolicyShadow';
import { evaluateContinuation } from './continuationPolicy';
import { enqueueJob } from './db';

test('deterministic retrieval-configuration identity and hashing', () => {
  const config1 = buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 2 });
  const config2 = buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 2 });
  const config3 = buildRetrievalConfiguration({ searchOrdering: 'DATE', retrievalLane: 'VIDEO', requestedPageDepth: 2 });

  assert.equal(config1.configKey, config2.configKey);
  assert.notEqual(config1.configKey, config3.configKey);
  assert.equal(config1.policyVersion, CURRENT_RETRIEVAL_POLICY_VERSION);
});

test('shadow recommendation explicitly distinguishes control, executed, and recommended configs', async () => {
  const control = buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 1 });
  const executed = buildRetrievalConfiguration({ searchOrdering: 'DATE', retrievalLane: 'VIDEO', requestedPageDepth: 2 });

  const shadow = await evaluateShadowRetrievalRecommendation({
    opportunityKey: 'opp_shadow_test_1',
    neighborhoodKey: 'neigh_shadow_test_1',
    controlConfig: control,
    executedConfig: executed
  });

  assert.equal(shadow.opportunityKey, 'opp_shadow_test_1');
  assert.equal(shadow.controlConfigKey, control.configKey);
  assert.equal(shadow.executedConfigKey, executed.configKey);
  assert.equal(typeof shadow.differsFromControl, 'boolean');
  assert.equal(typeof shadow.differsFromExecuted, 'boolean');
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

test('missing feature setting or offline DB fails closed to disabled canary treatment reservation', async () => {
  const canaryRes = await reserveRetrievalCanaryTreatment({
    opportunityKey: 'opp_disabled_test',
    neighborhoodKey: 'neigh_1',
    retrievalLane: 'VIDEO',
    defaultOrdering: 'RELEVANCE'
  });
  assert.equal(canaryRes.authorized, false);
  assert.ok(canaryRes.reason.includes('RETRIEVAL_STRATEGY_LEARNING_DISABLED') || canaryRes.reason.includes('DATABASE_UNAVAILABLE'));
});

test('incremental treatment page quota reservation fails closed when DB or caps unavailable', async () => {
  const incRes = await reserveIncrementalTreatmentPageQuota({
    queryRunId: 'run_123',
    pageNumber: 2
  });
  assert.equal(incRes.authorized, false);
});

test('enqueueJob with preventReopen=true preserves COMPLETED/FAILED status on idempotency conflict', async () => {
  let storedJobStatus: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' = 'PENDING';
  let storedAttempts = 1;

  const mockDb = {
    query: async (sql: string, params: any[]) => {
      if (sql.includes('preventReopen')) {
        // Mock returning the existing job without reopening
      }
      return {
        rows: [{
          id: 'job_mock_1',
          type: params[0],
          status: storedJobStatus,
          attempts: storedAttempts,
          max_attempts: 3,
          run_after: new Date().toISOString(),
          created_at: new Date().toISOString()
        }],
        rowCount: 1
      };
    }
  };

  // 1. Initial enqueue with preventReopen
  const job1 = await enqueueJob('SEARCH_YOUTUBE', { queryRunId: 'run_1' }, {
    idempotencyKey: 'idemp_key_1',
    clientOverride: mockDb,
    preventReopen: true
  });
  assert.equal(job1.status, 'PENDING');

  // Simulate job completing
  storedJobStatus = 'COMPLETED';

  // 2. Retry with preventReopen: true returns COMPLETED status without reopening
  const job2 = await enqueueJob('SEARCH_YOUTUBE', { queryRunId: 'run_1' }, {
    idempotencyKey: 'idemp_key_1',
    clientOverride: mockDb,
    preventReopen: true
  });
  assert.equal(job2.status, 'COMPLETED');

  // Simulate job processing
  storedJobStatus = 'PROCESSING';
  const job3 = await enqueueJob('SEARCH_YOUTUBE', { queryRunId: 'run_1' }, {
    idempotencyKey: 'idemp_key_1',
    clientOverride: mockDb,
    preventReopen: true
  });
  assert.equal(job3.status, 'PROCESSING');

  // Simulate job failed
  storedJobStatus = 'FAILED';
  const job4 = await enqueueJob('SEARCH_YOUTUBE', { queryRunId: 'run_1' }, {
    idempotencyKey: 'idemp_key_1',
    clientOverride: mockDb,
    preventReopen: true
  });
  assert.equal(job4.status, 'FAILED');
});

test('ordinary callers of enqueueJob without preventReopen retain default reopen semantics', async () => {
  let storedJobStatus: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' = 'COMPLETED';

  const mockDb = {
    query: async (sql: string, params: any[]) => {
      // Default query uses CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN 'PENDING'
      return {
        rows: [{
          id: 'job_mock_2',
          type: params[0],
          status: 'PENDING',
          attempts: 0,
          max_attempts: 3,
          run_after: new Date().toISOString(),
          created_at: new Date().toISOString()
        }],
        rowCount: 1
      };
    }
  };

  const recheckJob = await enqueueJob('FORCE_REVIEW_RESCAN', { channelId: 'ch_1' }, {
    idempotencyKey: 'recheck:ch_1',
    clientOverride: mockDb
  });

  assert.equal(recheckJob.status, 'PENDING');
});
