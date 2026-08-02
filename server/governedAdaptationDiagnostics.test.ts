import assert from 'node:assert/strict';
import test from 'node:test';
import { missContextFromDiagnostic } from './governedAdaptation';

test('corrective learning consumes the persisted staged_report and production collection envelope',()=>{
  const context=missContextFromDiagnostic({staged_report:{stages:[{stage:'AVAILABILITY',disposition:'PASS'},{stage:'CANDIDATE_DETECTION',disposition:'PASS'},{stage:'CORROBORATION',disposition:'PASS'}]},provider_execution:[{availability:'AVAILABLE'}],decision:{confidenceScore:64,evidenceCollection:{sufficiency:'SUFFICIENT'},decisionPolicy:{minimumTradingScore:65}}});
  assert.deepEqual(context,{retrieved:true,providerFailures:0,evidenceSufficient:true,semanticCandidate:true,corroborated:true,score:64,threshold:65,policyBlocked:false});
});

test('legacy diagnostic envelopes remain readable during migration',()=>{
  const context=missContextFromDiagnostic({provider_execution:[{availability:'FAILED'}],decision:{confidenceScore:50,evidenceCollection:{sufficiency:'INSUFFICIENT'},stagedClassification:{stages:[]}}});
  assert.equal(context.providerFailures,1);assert.equal(context.evidenceSufficient,false);assert.equal(context.threshold,65);
});
