import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactChecksum, classifierReport, reliabilityCurve, validateLedgerInput } from './phase3Validation';

test('classifier report produces per-country confusion matrices without inventing missing provenance',()=>{
  const report=classifierReport([
    {country:'France',expected:true,predicted:true,confidence:.9},
    {country:'France',expected:false,predicted:true,confidence:.6},
    {country:'Italy',expected:true,predicted:false,confidence:.4},
    {country:'Italy',expected:false,predicted:false,confidence:.8}
  ],2);
  assert.deepEqual(report.overall,{truePositive:1,trueNegative:1,falsePositive:1,falseNegative:1,precision:.5,recall:.5,sampleSize:4});
  assert.equal(report.byCountry.France.precision,.5);
  assert.equal(report.byCountry.Italy.precision,null);
  assert.equal(report.reliability.reduce((n,b)=>n+b.count,0),4);
});

test('calibration rejects invalid probabilities',()=>assert.throws(()=>reliabilityCurve([{country:'x',expected:true,predicted:true,confidence:1.1}]),/between 0 and 1/));
test('artifact checksums are deterministic across object key order',()=>assert.equal(artifactChecksum({b:2,a:1}),artifactChecksum({a:1,b:2})));
test('ledger rejects reversed timestamps and oversized/full artifacts',()=>{
  assert.throws(()=>validateLedgerInput({startedAt:'2026-01-02',completedAt:'2026-01-01',artifactChecksum:'a'.repeat(64),summary:{}}),/reversed/);
  assert.throws(()=>validateLedgerInput({startedAt:'2026-01-01',completedAt:'2026-01-02',artifactChecksum:'a'.repeat(64),summary:{payload:'x'.repeat(100_001)}}),/too large/);
});
