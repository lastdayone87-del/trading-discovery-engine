import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTerminalEnrichmentFailure, resolveUncertainLifecycle } from './enrichmentLifecycle';
import { evaluateReviewEligibilityV2 } from './reviewEligibility/policy';

const base={classificationStatus:'UNCERTAIN',investigationState:'UNRESOLVED',plausibleTradingHypothesis:true,evidenceSufficient:true,independentEvidence:true,countryAllowed:true,operationalFailure:false,providerDegraded:false,unsupportedLanguage:false,terminalDecision:false};

test('first uncertain classification schedules enrichment instead of completing', () => {
  assert.deepEqual(resolveUncertainLifecycle(false), {scanStatus:'ENRICHMENT_PENDING',tradingStatus:'UNCERTAIN',shouldEnqueue:true});
});

test('legacy human-review intent without authoritative eligibility remains machine-owned',()=>{
  assert.deepEqual(resolveUncertainLifecycle(true),{scanStatus:'ENRICHMENT_PENDING',tradingStatus:'UNCERTAIN',shouldEnqueue:true});
});

test('evidence-complete human ambiguity is the only authoritative review projection', () => {
  const eligibility=evaluateReviewEligibilityV2(base);
  assert.deepEqual(resolveUncertainLifecycle(true,eligibility), {scanStatus:'NEEDS_REVIEW',tradingStatus:'NEEDS_REVIEW',shouldEnqueue:false});
});

test('provider degradation never becomes human review debt', () => {
  const eligibility=evaluateReviewEligibilityV2({...base,providerDegraded:true});
  assert.equal(eligibility.reasonFamily,'PROVIDER_RECOVERY_REQUIRED');
  assert.deepEqual(resolveUncertainLifecycle(true,eligibility), {scanStatus:'ENRICHMENT_PENDING',tradingStatus:'UNCERTAIN',shouldEnqueue:true});
});

test('insufficient evidence never becomes human review debt', () => {
  const eligibility=evaluateReviewEligibilityV2({...base,evidenceSufficient:false,independentEvidence:false});
  assert.equal(eligibility.reasonFamily,'MORE_EVIDENCE_REQUIRED');
  assert.deepEqual(resolveUncertainLifecycle(true,eligibility), {scanStatus:'ENRICHMENT_PENDING',tradingStatus:'UNCERTAIN',shouldEnqueue:true});
});

const lifecycleChannel=(overrides:Partial<{
  scan_status:'LOCKED'|'ENRICHMENT_PENDING'|'ENRICHING'|'FAILED'|'COMPLETED'|'NEEDS_REVIEW'|'SKIPPED_NON_TRADING';
  trading_status:'TRADING_CONFIRMED'|'UNCERTAIN'|'NEEDS_REVIEW'|'NON_TRADING'|'HUMAN_REJECTED';
  discord_status:'PENDING'|'NOT_FOUND'|'ACTIVE'|'ACTIVE_LOW_VOLUME'|'NON_TRADING'|'DEAD'|'UNCERTAIN';
  discord_validation_status:'NOT_STARTED'|'RETRY_PENDING'|'SUCCEEDED'|'FAILED_OPERATIONAL'|'COMPLETED';
}>={})=>({
  scan_status:'ENRICHMENT_PENDING' as const,
  trading_status:'TRADING_CONFIRMED' as const,
  discord_status:'PENDING' as const,
  discord_validation_status:'NOT_STARTED' as const,
  ...overrides
});

test('terminal post-approval failure preserves human approval and projects recoverable operational failure',()=>{
  assert.deepEqual(resolveTerminalEnrichmentFailure(lifecycleChannel(),true),{
    shouldProject:true,scanStatus:'FAILED',tradingStatus:'TRADING_CONFIRMED',discordStatus:'UNCERTAIN',discordValidationStatus:'FAILED_OPERATIONAL'
  });
});

test('terminal projection preserves an already validated Discord outcome',()=>{
  assert.deepEqual(resolveTerminalEnrichmentFailure(lifecycleChannel({discord_status:'ACTIVE',discord_validation_status:'COMPLETED'}),true),{
    shouldProject:true,scanStatus:'FAILED',tradingStatus:'TRADING_CONFIRMED',discordStatus:'ACTIVE',discordValidationStatus:'COMPLETED'
  });
});

test('nonterminal retry state is not projected by the terminal helper',()=>{
  assert.deepEqual(resolveTerminalEnrichmentFailure(lifecycleChannel({scan_status:'ENRICHMENT_PENDING'}),false),{
    shouldProject:false,scanStatus:'ENRICHMENT_PENDING',tradingStatus:'TRADING_CONFIRMED',discordStatus:'PENDING',discordValidationStatus:'NOT_STARTED'
  });
});

test('machine-owned UNCERTAIN remains semantically UNCERTAIN while terminal operational failure is recoverable',()=>{
  assert.deepEqual(resolveTerminalEnrichmentFailure(lifecycleChannel({trading_status:'UNCERTAIN',scan_status:'ENRICHING'}),true),{
    shouldProject:true,scanStatus:'FAILED',tradingStatus:'UNCERTAIN',discordStatus:'UNCERTAIN',discordValidationStatus:'FAILED_OPERATIONAL'
  });
  assert.deepEqual(resolveUncertainLifecycle(false),{scanStatus:'ENRICHMENT_PENDING',tradingStatus:'UNCERTAIN',shouldEnqueue:true});
});

test('review, rejection, and completed operational paths are never overwritten by approval-failure projection',()=>{
  for(const channel of [
    lifecycleChannel({trading_status:'NEEDS_REVIEW',scan_status:'NEEDS_REVIEW'}),
    lifecycleChannel({trading_status:'HUMAN_REJECTED',scan_status:'SKIPPED_NON_TRADING',discord_status:'NON_TRADING',discord_validation_status:'COMPLETED'}),
    lifecycleChannel({trading_status:'NON_TRADING',scan_status:'SKIPPED_NON_TRADING',discord_status:'NON_TRADING',discord_validation_status:'COMPLETED'}),
    lifecycleChannel({scan_status:'COMPLETED',discord_status:'DEAD',discord_validation_status:'COMPLETED'})
  ]) assert.equal(resolveTerminalEnrichmentFailure(channel,true).shouldProject,false);
});
