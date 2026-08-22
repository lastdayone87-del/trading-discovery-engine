import assert from 'node:assert/strict';
import test from 'node:test';
import {communityAcquisitionRetryDirective,isAttemptFreeCommunityFailure,retryAtFromUnknown,attemptFreeDiscordValidation,COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE} from './communityRetryPolicy';

test('required retryable acquisition failure is attempt-free and preserves earliest retry time',()=>{
  const directive=communityAcquisitionRetryDirective([
    {required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'RECENT_VIDEO_DESCRIPTION_API_FAILED',retryAt:20_000},
    {required:true,outcome:'INSPECTED_NO_MATCH',retryable:false},
    {required:false,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'NETWORK_FAILURE'},
  ]);
  assert.deepEqual(directive,{attemptFree:true,code:COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE,retryAt:20_000,reason:'RECENT_VIDEO_DESCRIPTION_API_FAILED'});
});

test('optional external/social failure alone does not create a retry directive',()=>{
  assert.equal(communityAcquisitionRetryDirective([{required:false,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'NETWORK_FAILURE'}]),undefined);
});

test('provider capacity errors are attempt-free while invalid observation remains meaningful',()=>{
  const cooldown=Object.assign(new Error('providers cooling'),{code:'YOUTUBE_PROVIDERS_COOLING_DOWN',retryable:true,retryAt:123_000});
  assert.equal(isAttemptFreeCommunityFailure(cooldown),true);
  assert.equal(retryAtFromUnknown(cooldown),123_000);
  assert.equal(attemptFreeDiscordValidation('RATE_LIMITED',true),true);
  assert.equal(attemptFreeDiscordValidation('INVALID_OBSERVED',true),false);
});
