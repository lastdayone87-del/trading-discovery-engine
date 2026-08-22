import test from 'node:test';
import assert from 'node:assert/strict';
import { decideJobFailure, isRetryableInfrastructureFailure } from './db';

const now=1_700_000_000_000;

test('quota/provider capacity waits without consuming an attempt even without retryAt',()=>{
  const result=decideJobFailure({code:'QUOTA_ALLOCATION_EXHAUSTED'},3,3,now);
  assert.equal(result.disposition,'RETRYING_WITHOUT_ATTEMPT');
  assert.ok((result.runAfter||0)>now);
});

test('community acquisition capacity failure is attempt-free and honors provider retryAt',()=>{
  const retryAt=now+90_000;
  const result=decideJobFailure({code:'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE',retryable:true,retryAt},5,5,now);
  assert.deepEqual(result,{disposition:'RETRYING_WITHOUT_ATTEMPT',runAfter:retryAt});
});

test('provider cooldown honors retryAt while consuming the bounded attempt budget',()=>{
  const retryAt=now+60_000;
  assert.deepEqual(decideJobFailure({code:'YOUTUBE_PROVIDERS_COOLING_DOWN',retryAt},2,3,now),{disposition:'RETRYING_WITHOUT_ATTEMPT',runAfter:retryAt});
  assert.deepEqual(decideJobFailure({code:'YOUTUBE_PROVIDERS_COOLING_DOWN',retryAt},3,3,now),{disposition:'FAILED'});
});

test('provider pool exhaustion becomes terminal at max attempts',()=>{
  assert.equal(decideJobFailure({code:'YOUTUBE_PROVIDER_POOL_EXHAUSTED',retryAt:now+60_000},3,3,now).disposition,'FAILED');
});

test('common network/provider outages are retryable infrastructure failures',()=>{
  for(const error of [{code:'ETIMEDOUT'},{code:'ECONNRESET'},{code:'EAI_AGAIN'},{status:429},{statusCode:503},{name:'TimeoutError'}]){
    assert.equal(isRetryableInfrastructureFailure(error),true,JSON.stringify(error));
    assert.equal(decideJobFailure(error,3,3,now).disposition,'RETRYING_WITHOUT_ATTEMPT');
  }
});

test('normalized provider resilience failures stay attempt-free when marked retryable',()=>{
  for(const error of [
    {name:'ProviderCallError',errorClass:'TIMEOUT',retryable:true},
    {name:'ProviderCallError',errorClass:'TRANSIENT',retryable:true},
    {name:'ProviderCallError',errorClass:'RATE_LIMIT',retryable:true,status:429},
    {name:'ProviderCallError',errorClass:'CANCELLED',retryable:true}
  ]){
    assert.equal(isRetryableInfrastructureFailure(error),true,JSON.stringify(error));
    assert.equal(decideJobFailure(error,3,3,now).disposition,'RETRYING_WITHOUT_ATTEMPT');
  }
});

test('normalized permanent provider input failures remain bounded',()=>{
  const error={name:'ProviderCallError',errorClass:'PERMANENT_INPUT',retryable:false,status:400};
  assert.equal(isRetryableInfrastructureFailure(error),false);
  assert.equal(decideJobFailure(error,3,3,now).disposition,'FAILED');
});

test('application/logic failures still consume the bounded retry budget',()=>{
  assert.equal(decideJobFailure(new Error('classifier invariant failed'),1,3,now).disposition,'RETRYING');
  assert.equal(decideJobFailure(new Error('classifier invariant failed'),3,3,now).disposition,'FAILED');
});

test('investigation deadline remains terminal and cannot loop forever',()=>{
  assert.equal(decideJobFailure({code:'INVESTIGATION_DEADLINE_EXCEEDED'},1,5,now).disposition,'FAILED');
});
