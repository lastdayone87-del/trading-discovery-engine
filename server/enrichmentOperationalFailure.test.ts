import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichmentOperationalFailure } from './enrichmentOperationalFailure';
import { decideJobFailure } from './db';
import { resolveUncertainLifecycle } from './enrichmentLifecycle';
import type { EvidenceCollectionReport } from './evidenceEngine';

function report(degraded:boolean, reasonCodes:string[]=[], sufficiency:EvidenceCollectionReport['sufficiency']='SUFFICIENT'):EvidenceCollectionReport {
  return {
    sufficiency, sparseMetadata:false, degraded, fieldsPresent:['video_titles'], reasonCodes:[],
    providers:[{provider:'gemini_semantic',availability:degraded?'FAILED':'AVAILABLE',evidenceCount:0,outcome:degraded?'FAILED_PROVIDER':'EXECUTED_NO_MATCH',reasonCodes}],
    terminalNegativeSufficiency:{status:'INSUFFICIENT',creatorLevelCoverage:false,independentSourceFamilies:0,independentObservations:0,reasonCodes:['TERMINAL_NEGATIVE_EVIDENCE_INSUFFICIENT']}
  };
}

test('sufficient independent enrichment evidence is not vetoed by optional provider degradation',()=>{
  assert.equal(enrichmentOperationalFailure(report(true,['PROVIDER_RATE_LIMIT'],'SUFFICIENT'),true),null);
});

test('insufficient degraded enrichment remains an attempt-free infrastructure retry',()=>{
  const error=enrichmentOperationalFailure(report(true,['PROVIDER_TIMEOUT'],'INSUFFICIENT'),true);
  assert.ok(error);
  assert.equal(error!.name,'OperationalEnrichmentProviderError');
  assert.equal(error!.retryable,true);
  assert.equal(error!.errorClass,'TRANSIENT');
  assert.equal(decideJobFailure(error,4,4,1_700_000_000_000).disposition,'RETRYING_WITHOUT_ATTEMPT');
});

test('all governed operational provider failure classes remain retryable when evidence is insufficient',()=>{
  for(const reason of ['PROVIDER_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_TRANSIENT_FAILURE','PROVIDER_CREDENTIALS_EXHAUSTED','PROVIDER_CANCELLED','PROVIDER_EXECUTION_FAILED']) {
    const error=enrichmentOperationalFailure(report(true,[reason],'INSUFFICIENT'),true);
    assert.ok(error,reason);
    assert.equal(error!.name,'OperationalEnrichmentProviderError');
  }
});

test('non-enrichment and permanent-input degradation are not rewritten by this guard',()=>{
  assert.equal(enrichmentOperationalFailure(report(true,['PROVIDER_TIMEOUT'],'INSUFFICIENT'),false),null);
  assert.equal(enrichmentOperationalFailure(report(true,['PROVIDER_PERMANENT_INPUT'],'INSUFFICIENT'),true),null);
});

test('fully observed genuine ambiguity can still reach human review',()=>{
  assert.equal(enrichmentOperationalFailure(report(false),true),null);
  assert.deepEqual(resolveUncertainLifecycle(true),{scanStatus:'NEEDS_REVIEW',tradingStatus:'NEEDS_REVIEW',shouldEnqueue:false});
});
