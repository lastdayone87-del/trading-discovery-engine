import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichmentOperationalFailure, hasDecisionGradeEvidenceWithoutFailedProviders, isProviderDeferredEnrichmentError } from './enrichmentOperationalFailure';
import { decideJobFailure } from './db';
import { resolveUncertainLifecycle } from './enrichmentLifecycle';
import { evaluateReviewEligibilityV2 } from './reviewEligibility/policy';
import type { EvidenceCollectionReport, VerificationDecision } from './evidenceEngine';

function report(degraded:boolean, reasonCodes:string[]=[], sufficiency:EvidenceCollectionReport['sufficiency']='SUFFICIENT'):EvidenceCollectionReport {
  return {
    sufficiency, sparseMetadata:false, degraded, fieldsPresent:['video_titles'], reasonCodes:[],
    providers:[{provider:'gemini_semantic',availability:degraded?'FAILED':'AVAILABLE',evidenceCount:0,outcome:degraded?'FAILED_PROVIDER':'EXECUTED_NO_MATCH',reasonCodes}],
    terminalNegativeSufficiency:{status:'INSUFFICIENT',creatorLevelCoverage:false,independentSourceFamilies:0,independentObservations:0,reasonCodes:['TERMINAL_NEGATIVE_EVIDENCE_INSUFFICIENT']}
  };
}

function decision(args:{lifecycle:'CONFIRM'|'REJECT'|'ENRICH'|'REVIEW'; source?:'video_metadata'|'gemini_semantic'; degraded?:boolean; status?:VerificationDecision['status']}):VerificationDecision {
  const source=args.source||'video_metadata';
  const positive={id:'p1',source,polarity:'POSITIVE' as const,category:'METHODOLOGY_CONCEPT' as const,fact:'trading',rawMatches:['trading'],confidence:90,reliability:'HIGH' as const,reliabilityMultiplier:1,rawWeight:10,finalWeight:9,timestamp:new Date(0).toISOString()};
  const negative={...positive,id:'n1',polarity:'NEGATIVE' as const,category:'IRRELEVANT_DOMAIN' as const,finalWeight:-9};
  const stages=args.lifecycle==='CONFIRM'
    ? [{stage:'CANDIDATE_DETECTION' as const,disposition:'PASS' as const,reasonCodes:[],evidenceIds:['p1'],fields:[],metrics:{}},{stage:'CORROBORATION' as const,disposition:'PASS' as const,reasonCodes:[],evidenceIds:['p1'],fields:[],metrics:{}}]
    : args.lifecycle==='REJECT'
      ? [{stage:'CONTRADICTION' as const,disposition:'FAIL' as const,reasonCodes:[],evidenceIds:['n1'],fields:[],metrics:{}}]
      : [{stage:'CANDIDATE_DETECTION' as const,disposition:'ABSTAIN' as const,reasonCodes:[],evidenceIds:[],fields:[],metrics:{}}];
  return {
    status:args.status??(args.lifecycle==='CONFIRM'?'TRADING_CONFIRMED':args.lifecycle==='REJECT'?'NON_TRADING':'UNCERTAIN'),confidenceScore:50,category:'OTHER',multiVideoConsistencyRatio:0,
    positiveEvidence:[positive],negativeEvidence:args.lifecycle==='REJECT'?[negative]:[],totalPositiveWeight:9,totalNegativeWeight:args.lifecycle==='REJECT'?9:0,
    countryContextUsed:{country:'US',language:'en',matchedTerms:[],matchedNegativeTerms:[]},
    versions:{evidenceEngineVersion:'t',decisionEngineVersion:'t',scoringEngineVersion:'t',knowledgePackVersion:'t',geminiModelVersion:'t'},
    mathematicalJustification:'test',evidenceCollection:report(args.degraded??true,['PROVIDER_RATE_LIMIT'],'SUFFICIENT'),
    stagedClassification:{pipelineVersion:'test',stages,lifecycleAction:args.lifecycle},timestamp:new Date(0).toISOString()
  };
}

test('coarse SUFFICIENT metadata still retries when Gemini failed and no decision-grade stage is resolved',()=>{
  const d=decision({lifecycle:'ENRICH'});
  const ready=hasDecisionGradeEvidenceWithoutFailedProviders(d);
  assert.equal(ready,false);
  const error=enrichmentOperationalFailure(d.evidenceCollection,true,ready);
  assert.ok(error);
  assert.equal(decideJobFailure(error!,4,4,1_700_000_000_000).disposition,'RETRYING_WITHOUT_ATTEMPT');
});

test('independent confirm evidence may proceed despite optional Gemini degradation',()=>{
  const d=decision({lifecycle:'CONFIRM',source:'video_metadata'});
  const ready=hasDecisionGradeEvidenceWithoutFailedProviders(d);
  assert.equal(ready,true);
  assert.equal(enrichmentOperationalFailure(d.evidenceCollection,true,ready),null);
});

test('stage CONFIRM without a terminal confirmed decision still retries provider degradation',()=>{
  const d=decision({lifecycle:'CONFIRM',source:'video_metadata',status:'UNCERTAIN'});
  const ready=hasDecisionGradeEvidenceWithoutFailedProviders(d);
  assert.equal(ready,false);
  assert.ok(enrichmentOperationalFailure(d.evidenceCollection,true,ready));
});

test('stage REJECT without a terminal non-trading decision still retries provider degradation',()=>{
  const d=decision({lifecycle:'REJECT',source:'video_metadata',status:'UNCERTAIN'});
  const ready=hasDecisionGradeEvidenceWithoutFailedProviders(d);
  assert.equal(ready,false);
  assert.ok(enrichmentOperationalFailure(d.evidenceCollection,true,ready));
});

test('failed-provider evidence never qualifies as independent decision-grade support',()=>{
  const d=decision({lifecycle:'CONFIRM',source:'gemini_semantic'});
  assert.equal(hasDecisionGradeEvidenceWithoutFailedProviders(d),false);
  assert.ok(enrichmentOperationalFailure(d.evidenceCollection,true,false));
});

test('insufficient degraded enrichment remains an attempt-free infrastructure retry',()=>{
  const error=enrichmentOperationalFailure(report(true,['PROVIDER_TIMEOUT'],'INSUFFICIENT'),true,false);
  assert.ok(error);
  assert.equal(error!.name,'OperationalEnrichmentProviderError');
  assert.equal(error!.retryable,true);
  assert.equal(error!.errorClass,'TRANSIENT');
});

test('all governed operational provider failure classes remain retryable without decision-grade support',()=>{
  for(const reason of ['PROVIDER_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_TRANSIENT_FAILURE','PROVIDER_CREDENTIALS_EXHAUSTED','PROVIDER_CANCELLED','PROVIDER_EXECUTION_FAILED']) {
    const error=enrichmentOperationalFailure(report(true,[reason]),true,false);
    assert.ok(error,reason);
  }
});

test('non-enrichment and permanent-input degradation are not rewritten by this guard',()=>{
  assert.equal(enrichmentOperationalFailure(report(true,['PROVIDER_TIMEOUT']),false,false),null);
  assert.equal(enrichmentOperationalFailure(report(true,['PROVIDER_PERMANENT_INPUT']),true,false),null);
});

test('fully observed genuine ambiguity can still reach human review when providers are healthy',()=>{
  assert.equal(enrichmentOperationalFailure(report(false),true,false),null);
  const eligibility=evaluateReviewEligibilityV2({classificationStatus:'UNCERTAIN',investigationState:'UNRESOLVED',plausibleTradingHypothesis:true,evidenceSufficient:true,independentEvidence:true,countryAllowed:true,operationalFailure:false,providerDegraded:false,unsupportedLanguage:false,terminalDecision:false});
  assert.deepEqual(resolveUncertainLifecycle(true,eligibility),{scanStatus:'NEEDS_REVIEW',tradingStatus:'NEEDS_REVIEW',shouldEnqueue:false});
});


test('only machine-owned operational provider errors project PROVIDER_DEFERRED',()=>{
  const error=enrichmentOperationalFailure(report(true,['PROVIDER_RATE_LIMIT']),true,false);
  assert.ok(error);
  assert.equal(isProviderDeferredEnrichmentError(error),true);
  assert.equal(isProviderDeferredEnrichmentError(new Error('ordinary pipeline failure')),false);
  assert.equal(isProviderDeferredEnrichmentError({name:'ProviderCallError',errorClass:'RATE_LIMIT',retryable:true}),false);
});
