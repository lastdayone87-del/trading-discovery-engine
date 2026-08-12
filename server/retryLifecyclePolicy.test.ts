import test from 'node:test';
import assert from 'node:assert/strict';
import { decideJobFailure, isRetryableInfrastructureFailure } from './db';

const now=1_700_000_000_000;

test('quota/provider capacity waits without consuming an attempt even without retryAt',()=>{
  const result=decideJobFailure({code:'QUOTA_ALLOCATION_EXHAUSTED'},3,3,now);
  assert.equal(result.disposition,'RETRYING_WITHOUT_ATTEMPT');
  assert.ok((result.runAfter||0)>now);
});

test('provider cooldown honors retryAt without consuming an attempt',()=>{
  const retryAt=now+60_000;
  assert.deepEqual(decideJobFailure({code:'YOUTUBE_PROVIDERS_COOLING_DOWN',retryAt},2,3,now),{disposition:'RETRYING_WITHOUT_ATTEMPT',runAfter:retryAt});
});

test('common network/provider outages are retryable infrastructure failures',()=>{
  for(const error of [{code:'ETIMEDOUT'},{code:'ECONNRESET'},{code:'EAI_AGAIN'},{status:429},{statusCode:503},{name:'TimeoutError'}]){
    assert.equal(isRetryableInfrastructureFailure(error),true,JSON.stringify(error));
    assert.equal(decideJobFailure(error,3,3,now).disposition,'RETRYING_WITHOUT_ATTEMPT');
  }
});

test('application/logic failures still consume the bounded retry budget',()=>{
  assert.equal(decideJobFailure(new Error('classifier invariant failed'),1,3,now).disposition,'RETRYING');
  assert.equal(decideJobFailure(new Error('classifier invariant failed'),3,3,now).disposition,'FAILED');
});

test('investigation deadline remains terminal and cannot loop forever',()=>{
  assert.equal(decideJobFailure({code:'INVESTIGATION_DEADLINE_EXCEEDED'},1,5,now).disposition,'FAILED');
});
