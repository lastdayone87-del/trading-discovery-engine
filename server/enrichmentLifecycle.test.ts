import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUncertainLifecycle } from './enrichmentLifecycle';
import { evaluateReviewEligibilityV2 } from './reviewEligibility/policy';

const base={classificationStatus:'UNCERTAIN',investigationState:'UNRESOLVED',plausibleTradingHypothesis:true,evidenceSufficient:true,independentEvidence:true,countryAllowed:true,operationalFailure:false,providerDegraded:false,unsupportedLanguage:false,terminalDecision:false};

test('first uncertain classification schedules enrichment instead of completing', () => {
  assert.deepEqual(resolveUncertainLifecycle(false), {scanStatus:'ENRICHMENT_PENDING',tradingStatus:'UNCERTAIN',shouldEnqueue:true});
});

test('evidence-complete human ambiguity is the only authoritative review projection', () => {
  const eligibility=evaluateReviewEligibilityV2(base);
  assert.deepEqual(resolveUncertainLifecycle(true,eligibility), {scanStatus:'NEEDS_REVIEW',tradingStatus:'NEEDS_REVIEW',shouldEnqueue:false});
});

test('provider degradation never becomes human review debt', () => {
  const eligibility=evaluateReviewEligibilityV2({...base,providerDegraded:true});
  assert.equal(eligibility.reasonFamily,'PROVIDER_RECOVERY_REQUIRED');
  assert.deepEqual(resolveUncertainLifecycle(true,eligibility), {scanStatus:'COMPLETED',tradingStatus:'UNCERTAIN',shouldEnqueue:false});
});

test('insufficient evidence never becomes human review debt', () => {
  const eligibility=evaluateReviewEligibilityV2({...base,evidenceSufficient:false,independentEvidence:false});
  assert.equal(eligibility.reasonFamily,'MORE_EVIDENCE_REQUIRED');
  assert.deepEqual(resolveUncertainLifecycle(true,eligibility), {scanStatus:'COMPLETED',tradingStatus:'UNCERTAIN',shouldEnqueue:false});
});
