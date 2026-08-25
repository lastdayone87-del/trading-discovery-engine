import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCommunityRetryJobMetadata,communityAcquisitionRetryDirective,isCommunityRetryableObservation,isAttemptFreeCommunityFailure,retryAtFromUnknown,attemptFreeDiscordValidation,COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE} from './communityRetryPolicy';

test('new retry payload metadata is explicit and starts unreconciled',()=>{
  const metadata=buildCommunityRetryJobMetadata({code:'BROWSER_RUNTIME_UNAVAILABLE',retryReason:'BROWSER_RUNTIME_UNAVAILABLE',retrySource:'INSPECTION',observedAt:'2026-08-25T12:00:00.000Z'});
  assert.deepEqual(metadata,{
    retryReason:'BROWSER_RUNTIME_UNAVAILABLE',
    retryCode:'BROWSER_RUNTIME_UNAVAILABLE',
    retrySource:'INSPECTION',
    retryObservedAt:'2026-08-25T12:00:00.000Z',
    reconciliationStatus:'NONE'
  });
});

test('recent-video acquisition failure is excluded from Discord community retry ownership',()=>{
  const observation={surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'RECENT_VIDEO_DESCRIPTION_API_FAILED',retryAt:20_000};
  assert.equal(isCommunityRetryableObservation(observation),false);
  assert.equal(communityAcquisitionRetryDirective([observation]),undefined);
});

test('genuine required community acquisition failure remains attempt-free and preserves retry time',()=>{
  const directive=communityAcquisitionRetryDirective([
    {surface:'CREATOR_WEBSITES',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'BROWSER_RUNTIME_UNAVAILABLE',retryAt:20_000},
    {surface:'CREATOR_WEBSITES',required:true,outcome:'INSPECTED_NO_MATCH',retryable:false},
    {surface:'SOCIAL_PROFILES',required:false,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'NETWORK_FAILURE'},
  ]);
  assert.deepEqual(directive,{attemptFree:true,code:'BROWSER_RUNTIME_UNAVAILABLE',retryAt:20_000,reason:'BROWSER_RUNTIME_UNAVAILABLE',retryReason:'BROWSER_RUNTIME_UNAVAILABLE'});
});

test('non-browser community acquisition failure receives a community-owned retry reason',()=>{
  const directive=communityAcquisitionRetryDirective([{surface:'LINKED_WEBSITES',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'NETWORK_FAILURE'}]);
  assert.equal(directive?.retryReason,'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});

test('optional external/social failure alone does not create a retry directive',()=>{
  assert.equal(communityAcquisitionRetryDirective([{required:false,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'NETWORK_FAILURE'}]),undefined);
});

test('global browser runtime failure is separately classified and remains attempt-free',()=>{
  const directive=communityAcquisitionRetryDirective([{required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'BROWSER_BINARY_MISSING'}]);
  assert.equal(directive?.code,'BROWSER_RUNTIME_UNAVAILABLE');
  assert.equal(directive?.retryReason,'BROWSER_RUNTIME_UNAVAILABLE');
  assert.equal(isAttemptFreeCommunityFailure(Object.assign(new Error('browser unavailable'),{code:'BROWSER_RUNTIME_UNAVAILABLE',retryable:true})),true);
});

test('YouTube About acquisition failure is not a community retry',()=>{
  assert.equal(communityAcquisitionRetryDirective([
    {surface:'YOUTUBE_ABOUT',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'YOUTUBE_ABOUT_ACQUISITION_FAILED'}
  ]),undefined);
});

test('no required retryable community acquisition failure produces no retry directive',()=>{
  assert.equal(communityAcquisitionRetryDirective([
    {surface:'CREATOR_WEBSITES',required:true,outcome:'INSPECTED_NO_MATCH',retryable:false},
    {surface:'SOCIAL_PROFILES',required:false,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'NETWORK_FAILURE'}
  ]),undefined);
});

test('provider capacity errors are attempt-free while invalid observation remains meaningful',()=>{
  const cooldown=Object.assign(new Error('providers cooling'),{code:'YOUTUBE_PROVIDERS_COOLING_DOWN',retryable:true,retryAt:123_000});
  assert.equal(isAttemptFreeCommunityFailure(cooldown),true);
  assert.equal(retryAtFromUnknown(cooldown),123_000);
  assert.equal(attemptFreeDiscordValidation('RATE_LIMITED',true),true);
  assert.equal(attemptFreeDiscordValidation('INVALID_OBSERVED',true),false);
});
