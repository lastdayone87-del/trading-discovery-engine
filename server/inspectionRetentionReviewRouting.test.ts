import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runChannelInspection} from './inspector';

test('channel-link trail counts distinct Discord invites and exposes all retained codes',async()=>{
  const result=await runChannelInspection({channelId:'c1',channelName:'Creator',channelBio:'bio',channelLinks:['https://discord.gg/same','https://discord.com/invite/same','https://discord.gg/other'],videoDescriptions:[]});
  const step=result.steps.find(item=>item.step==='EXTERNAL_LINKS');
  assert.equal(step?.status,'FOUND');
  assert.match(step?.details||'',/2 distinct direct Discord candidate\(s\) retained/);
  assert.deepEqual(step?.detectedInvites?.sort(),['other','same']);
});

test('post-enrichment no-independent-hypothesis path is reviewable, never silently completed',()=>{
  const source=readFileSync('server/ingestionPipeline.ts','utf8');
  const start=source.indexOf("if (currentStage > 0 && !independentHypothesis)");
  const end=source.indexOf('const legacyAction',start);
  const block=source.slice(start,end);
  assert.match(block,/trading_status='NEEDS_REVIEW'/);
  assert.match(block,/scan_status='NEEDS_REVIEW'/);
  assert.match(block,/tradingStatus:'NEEDS_REVIEW'/);
});

test('evidence-complete human ambiguity is not remapped to UNCERTAIN/COMPLETED',()=>{
  const source=readFileSync('server/ingestionPipeline.ts','utf8');
  const start=source.indexOf('const reviewEligibility=evaluateReviewEligibilityV2(reviewEligibilityInput);');
  const end=source.indexOf('const uncertainChannel:',start);
  const block=source.slice(start,end);
  assert.match(block,/const lifecycle = resolveUncertainLifecycle\(shouldReview,reviewEligibility\);/);
  assert.match(block,/const finalUncertainStatus = lifecycle\.tradingStatus;/);
  assert.match(block,/const finalScanStatus = lifecycle\.scanStatus;/);
  assert.doesNotMatch(block,/lifecycle\.tradingStatus===['\"]NEEDS_REVIEW['\"]\?['\"]UNCERTAIN/);
  assert.doesNotMatch(block,/lifecycle\.scanStatus===['\"]NEEDS_REVIEW['\"]\?['\"]COMPLETED/);
});

test('review eligibility still defers low-information or degraded ambiguity',async()=>{
  const { evaluateReviewEligibilityV2 } = await import('./reviewEligibility/policy');
  const base={classificationStatus:'UNCERTAIN',investigationState:'UNRESOLVED',plausibleTradingHypothesis:true,evidenceSufficient:true,independentEvidence:true,countryAllowed:true,operationalFailure:false,providerDegraded:false,unsupportedLanguage:false,terminalDecision:false};
  assert.equal(evaluateReviewEligibilityV2({...base,evidenceSufficient:false}).status,'DEFERRED');
  assert.equal(evaluateReviewEligibilityV2({...base,providerDegraded:true}).status,'DEFERRED');
  assert.equal(evaluateReviewEligibilityV2({...base,independentEvidence:false}).status,'DEFERRED');
  assert.equal(evaluateReviewEligibilityV2(base).status,'ELIGIBLE');
});

 test('lifecycle preserves the review boundary only for serving-authorized human ambiguity',async()=>{
  const { resolveUncertainLifecycle } = await import('./enrichmentLifecycle');
  const { evaluateReviewEligibilityV2 } = await import('./reviewEligibility/policy');
  const base={classificationStatus:'UNCERTAIN',investigationState:'UNRESOLVED',plausibleTradingHypothesis:true,evidenceSufficient:true,independentEvidence:true,countryAllowed:true,operationalFailure:false,providerDegraded:false,unsupportedLanguage:false,terminalDecision:false};
  const eligible=evaluateReviewEligibilityV2(base);
  const deferred=evaluateReviewEligibilityV2({...base,providerDegraded:true});
  assert.deepEqual(resolveUncertainLifecycle(true,eligible),{scanStatus:'NEEDS_REVIEW',tradingStatus:'NEEDS_REVIEW',shouldEnqueue:false});
  assert.deepEqual(resolveUncertainLifecycle(true,deferred),{scanStatus:'ENRICHMENT_PENDING',tradingStatus:'UNCERTAIN',shouldEnqueue:true});
  assert.deepEqual(resolveUncertainLifecycle(false,eligible),{scanStatus:'ENRICHMENT_PENDING',tradingStatus:'UNCERTAIN',shouldEnqueue:true});
});
