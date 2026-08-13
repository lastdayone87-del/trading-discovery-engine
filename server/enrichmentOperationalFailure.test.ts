import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichmentOperationalFailure } from './enrichmentOperationalFailure';
import { decideJobFailure } from './db';
import { resolveUncertainLifecycle } from './enrichmentLifecycle';
import type { EvidenceCollectionReport } from './evidenceEngine';

function report(degraded:boolean, reasonCodes:string[]=[]):EvidenceCollectionReport {
  return {
    sufficiency:'SUFFICIENT', sparseMetadata:false, degraded, fieldsPresent:['video_titles'], reasonCodes:[],
    providers:[{provider:'gemini_semantic',availability:degraded?'FAILED':'AVAILABLE',evidenceCount:0,outcome:degraded?'FAILED_PROVIDER':'EXECUTED_NO_MATCH',reasonCodes}],
    terminalNegativeSufficiency:{status:'INSUFFICIENT',creatorLevelCoverage:false,independentSourceFamilies:0,independentObservations:0,reasonCodes:['TERMINAL_NEGATIVE_EVIDENCE_INSUFFICIENT']}
  };
}

test('degraded enrichment becomes an attempt-free infrastructure retry instead of review',()=>{
  const error=enrichmentOperationalFailure(report(true,['PROVIDER_TIMEOUT']),true);
  assert.ok(error);
  assert.equal(error!.retryable,true);
  assert.equal(error!.errorClass,'TRANSIENT');
  assert.equal(decideJobFailure(error,4,4,1_700_000_000_000).disposition,'RETRYING_WITHOUT_ATTEMPT');
});

test('all governed operational provider failure classes are retryable during enrichment',()=>{
  for(const reason of ['PROVIDER_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_TRANSIENT_FAILURE','PROVIDER_CREDENTIALS_EXHAUSTED','PROVIDER_CANCELLED','PROVIDER_EXECUTION_FAILED']) {
    assert.ok(enrichmentOperationalFailure(report(true,[reason]),true),reason);
  }
});

test('non-enrichment and permanent-input degradation are not rewritten by this guard',()=>{
  assert.equal(enrichmentOperationalFailure(report(true,['PROVIDER_TIMEOUT']),false),null);
  assert.equal(enrichmentOperationalFailure(report(true,['PROVIDER_PERMANENT_INPUT']),true),null);
});

test('fully observed genuine ambiguity can still reach human review',()=>{
  assert.equal(enrichmentOperationalFailure(report(false),true),null);
  assert.deepEqual(resolveUncertainLifecycle(true),{scanStatus:'NEEDS_REVIEW',tradingStatus:'NEEDS_REVIEW',shouldEnqueue:false});
});
