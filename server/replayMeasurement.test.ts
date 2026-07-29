import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMinimalPayload, compareMetrics, replayFunnel, stableChecksum, type ReplayEvent } from './replayMeasurement';

const event=(key:string,recordedAt:string,payload:Record<string,unknown>):ReplayEvent=>({eventKey:key,subjectId:key,eventType:'QUERY_FUNNEL_RECORDED',verificationStatus:'PROVISIONAL',eventTime:'2026-01-01T00:00:00Z',recordedAt,country:'France',retrievalLane:'VIDEO',payload});
test('replay is deterministic under event reordering and segments country/lane',()=>{
  const a=event('a','2026-01-02T00:00:00Z',{rawResults:2,newChannels:1,quotaUsed:100});
  const b=event('b','2026-01-01T00:00:00Z',{rawResults:3,newChannels:2,quotaUsed:100});
  assert.deepEqual(replayFunnel([a,b]),replayFunnel([b,a]));
  assert.equal(replayFunnel([a,b]).segments['France|VIDEO'].rawResults,5);
});
test('duplicate retry keys can be de-duplicated without changing projection',()=>{
  const row=event('stable-key','2026-01-01T00:00:00Z',{rawResults:2});
  const deduplicated=[...new Map([row,row].map(e=>[e.eventKey,e])).values()];
  assert.equal(replayFunnel(deduplicated).totals.rawResults,2);
});
test('late corrective review remains replay-visible',()=>{
  const correction:ReplayEvent={...event('review:1','2026-02-01T00:00:00Z',{}),eventType:'REVIEW_CORRECTED',verificationStatus:'CORRECTIVE'};
  assert.equal(replayFunnel([correction]).corrections,1);
});
test('comparison reports explained metric residuals',()=>assert.equal(compareMetrics(replayFunnel([event('a','2026-01-01T00:00:00Z',{rawResults:10})]).totals,{rawResults:9},.12).pass,true));
test('checksums are stable and payload safety rejects secrets and oversized data',()=>{
  assert.equal(stableChecksum({b:2,a:1}),stableChecksum({a:1,b:2}));
  assert.throws(()=>assertMinimalPayload({authorization:'bearer'}),/sensitive/);
  assert.throws(()=>assertMinimalPayload({value:'x'.repeat(20_001)}),/20KB/);
});
