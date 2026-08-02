import test from 'node:test';
import assert from 'node:assert/strict';
import { submitReviewDecision } from '../src/reviewDecision';

const successfulResult = (decision:'APPROVE'|'REJECT') => ({
  decision:{decision,resulting_status:decision==='APPROVE'?'APPROVED':'REJECTED',review_version:2},
  review:{state:decision==='APPROVE'?'APPROVED':'REJECTED',reviewVersion:2},
  channel:{channelId:'channel/1',tradingStatus:decision==='APPROVE'?'TRADING_CONFIRMED':'HUMAN_REJECTED',scanStatus:decision==='APPROVE'?'ENRICHMENT_PENDING':'SKIPPED_NON_TRADING',discordStatus:'NON_TRADING'},
  queuePending:false,idempotent:false
});

for (const action of ['approve','reject'] as const) test(`frontend sends ${action} and receives immediate channel and queue state`,async()=>{
  let url=''; let init:RequestInit|undefined;
  const expected=successfulResult(action==='approve'?'APPROVE':'REJECT');
  const fetcher:typeof fetch=async(input,requestInit)=>{url=String(input);init=requestInit;return new Response(JSON.stringify(expected),{status:200,headers:{'content-type':'application/json'}});};
  const result=await submitReviewDecision({channelId:'channel/1',action,reviewVersion:1,reason:'manual evidence'},fetcher,{'X-Reviewer-Id':'reviewer'},'decision-key');
  assert.equal(url,`/api/reviews/channel%2F1/${action}`);
  assert.equal(init?.method,'POST');
  assert.deepEqual(JSON.parse(String(init?.body)),{reviewVersion:1,reason:'manual evidence',notes:''});
  assert.equal(new Headers(init?.headers).get('Idempotency-Key'),'decision-key');
  assert.equal(result.queuePending,false);
  assert.equal(result.review.state,action==='approve'?'APPROVED':'REJECTED');
});

test('frontend surfaces API validation messages and request IDs',async()=>{
  const fetcher:typeof fetch=async()=>new Response(JSON.stringify({error:'reason is required',code:'REVIEW_VALIDATION_ERROR',requestId:'req-123'}),{status:422,headers:{'content-type':'application/json'}});
  await assert.rejects(()=>submitReviewDecision({channelId:'c',action:'approve',reviewVersion:1,reason:''},fetcher,{},'key'),/reason is required \(request req-123\)/);
});
