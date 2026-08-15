import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUncertainLifecycle } from './enrichmentLifecycle';
import { evaluateReviewEligibilityV2 } from './reviewEligibility/policy';
import { evaluateLowAudienceGate } from './lowAudienceGate';
import { reformulatePollutedQuery } from './queryPlanner';
import { evaluateContinuation } from './continuationPolicy';

test('E2E Fixture: retrieval -> enrichment -> provider failure -> retry/recovery -> machine-owned uncertainty', () => {
  const eligibility = evaluateReviewEligibilityV2({
    classificationStatus: 'UNCERTAIN',
    investigationState: 'ACTIVE',
    plausibleTradingHypothesis: true,
    evidenceSufficient: false,
    independentEvidence: false,
    countryAllowed: true,
    operationalFailure: true,
    providerDegraded: true,
    unsupportedLanguage: false,
    terminalDecision: false
  });

  assert.equal(eligibility.status, 'DEFERRED');
  assert.equal(eligibility.reasonFamily, 'OPERATIONAL_FAILURE');

  const lifecycle = resolveUncertainLifecycle(true, eligibility);
  assert.equal(lifecycle.scanStatus, 'ENRICHMENT_PENDING');
  assert.equal(lifecycle.tradingStatus, 'UNCERTAIN');
  assert.equal(lifecycle.shouldEnqueue, true);
});

test('E2E Fixture: retrieval -> enrichment -> evidence-complete genuine ambiguity -> human review', () => {
  const eligibility = evaluateReviewEligibilityV2({
    classificationStatus: 'UNCERTAIN',
    investigationState: 'UNRESOLVED',
    plausibleTradingHypothesis: true,
    evidenceSufficient: true,
    independentEvidence: true,
    countryAllowed: true,
    operationalFailure: false,
    providerDegraded: false,
    unsupportedLanguage: false,
    terminalDecision: false
  });

  assert.equal(eligibility.status, 'ELIGIBLE');
  assert.equal(eligibility.reasonFamily, 'HUMAN_AMBIGUITY');

  const lifecycle = resolveUncertainLifecycle(true, eligibility);
  assert.equal(lifecycle.scanStatus, 'NEEDS_REVIEW');
  assert.equal(lifecycle.tradingStatus, 'NEEDS_REVIEW');
  assert.equal(lifecycle.shouldEnqueue, false);
});

test('E2E Fixture: low-audience discovery -> stored -> skipped -> subscriber growth -> eligible', () => {
  const initialGate = evaluateLowAudienceGate('18');
  assert.equal(initialGate.shouldSkipDeepEnrichment, true);

  const grownGate = evaluateLowAudienceGate('45');
  assert.equal(grownGate.shouldSkipDeepEnrichment, false);
});

test('E2E Fixture: poor query -> contamination detection -> reformulation', () => {
  const reformulated = reformulatePollutedQuery({
    pollutedQuery: 'DAX',
    country: 'Germany',
    intent: 'strategy'
  });

  assert.ok(reformulated);
  assert.match(reformulated.query, /DAX/i);
  assert.equal(reformulated.generationMode, 'EXPLORATION');
});

test('E2E Fixture: productive query -> delayed enrichment -> deeper pagination', () => {
  const decision = evaluateContinuation({
    pageNumber: 1,
    maxPages: 5,
    hasNextPage: true,
    distinctCreators: 10,
    cumulativeDistinctCreators: 10,
    newCreators: 8,
    confirmedCreators: 0,
    qualityConfirmedCreators: 0,
    countryPrecision: 0.9,
    communityDiversity: 0.0,
    duplicateRatio: 0.1,
    consecutiveLowYieldPages: 0,
    maxConsecutiveLowYieldPages: 2
  });

  assert.equal(decision.shouldContinue, true);
  assert.equal(decision.lowYield, false);
});
