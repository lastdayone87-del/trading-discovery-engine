import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCommunityRetryJobMetadata,communityAcquisitionRetryDirective,hasRetryableCommunityAcquisitionFailure,isCommunityRetryableObservation,isAttemptFreeCommunityFailure,retryAtFromUnknown,attemptFreeDiscordValidation,COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE} from './communityRetryPolicy';

test('new retry payload metadata is explicit and starts unreconciled',()=>{
  const metadata=buildCommunityRetryJobMetadata({code:'BROWSER_RUNTIME_UNAVAILABLE',retryReason:'BROWSER_RUNTIME_UNAVAILABLE',retrySource:'INSPECTION',observedAt:'2026-08-25T12:00:00.000Z'});
  assert.deepEqual(metadata,{
    retryLifecycleVersion:2,
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
  const zeroEvidence = { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 };
  const directive=communityAcquisitionRetryDirective([
    {surface:'CREATOR_WEBSITES',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'BROWSER_RUNTIME_UNAVAILABLE',retryAt:20_000,telemetry:zeroEvidence},
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
  const zeroEvidence = { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 };
  const directive=communityAcquisitionRetryDirective([{required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'BROWSER_BINARY_MISSING',telemetry:zeroEvidence}]);
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

test('new community retry metadata carries the current lifecycle version',()=>{
  const metadata=buildCommunityRetryJobMetadata({code:'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE',retryReason:'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',retrySource:'INSPECTION',observedAt:'2026-08-25T12:00:00.000Z'});
  assert.equal(metadata.retryLifecycleVersion,2);
});

test('required partial coverage preserves retry ownership as recoverable',()=>{
  const partial={surface:'CREATOR_WEBSITES',required:true,outcome:'PARTIALLY_INSPECTED',retryable:true,failureClass:'RENDERED_BUDGET_EXPIRED'};
  assert.equal(isCommunityRetryableObservation(partial),true);
  const directive=communityAcquisitionRetryDirective([partial]);
  assert.equal(directive?.retryReason,'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(directive?.attemptFree,true);
});

test('non-retryable partial coverage owns no retry',()=>{
  assert.equal(isCommunityRetryableObservation({surface:'CREATOR_WEBSITES',required:true,outcome:'PARTIALLY_INSPECTED',retryable:false}),false);
});

test('partial-only required acquisition follows RETRY_PENDING via the shared boundary',()=>{
  const partialOnly=[
    {surface:'CREATOR_WEBSITES',required:true,outcome:'PARTIALLY_INSPECTED',retryable:true,failureClass:'RENDERED_BUDGET_EXPIRED'},
  ];
  assert.equal(hasRetryableCommunityAcquisitionFailure(partialOnly),true);
  // Definitive failures keep their behavior.
  assert.equal(hasRetryableCommunityAcquisitionFailure([
    {surface:'CREATOR_WEBSITES',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'NO_PAGE_PROCESSED'},
  ]),true);
  // Non-retryable partials must not claim retry ownership.
  assert.equal(hasRetryableCommunityAcquisitionFailure([
    {surface:'CREATOR_WEBSITES',required:true,outcome:'PARTIALLY_INSPECTED',retryable:false},
  ]),false);
  // YouTube exclusions remain unchanged.
  assert.equal(hasRetryableCommunityAcquisitionFailure([
    {surface:'YOUTUBE_ABOUT',required:true,outcome:'PARTIALLY_INSPECTED',retryable:true},
    {surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable:true},
  ]),false);
  // Successful/FOUND outcomes remain unaffected (no retry ownership).
  assert.equal(hasRetryableCommunityAcquisitionFailure([
    {surface:'CREATOR_WEBSITES',required:true,outcome:'FOUND',retryable:false},
    {surface:'CREATOR_WEBSITES',required:true,outcome:'INSPECTED_NO_MATCH',retryable:false},
  ]),false);
});

test('provider-requested retry delays are bounded by the queue backoff ceiling',async()=>{
  const {clampRetryAtTimestamp,MAX_COMMUNITY_RETRY_DELAY_MS}=await import('./communityRetryPolicy');
  const now=Date.now();
  assert.equal(MAX_COMMUNITY_RETRY_DELAY_MS,900000);
  // Absurd Retry-After values (legal HTTP, e.g. one year) cannot park a retry
  // job beyond the queue's own maximum backoff horizon.
  assert.equal(clampRetryAtTimestamp(now+31_536_000_000,now),now+900000);
  assert.equal(clampRetryAtTimestamp(now+3_600_000,now),now+900000);
  // Normal delays pass through untouched; due/overdue stays due.
  assert.equal(clampRetryAtTimestamp(now+60_000,now),now+60_000);
  assert.equal(clampRetryAtTimestamp(now-1000,now),now-1000);
  assert.equal(clampRetryAtTimestamp(undefined,now),undefined);
  assert.equal(clampRetryAtTimestamp(NaN,now),undefined);
});

test('retryAtFromUnknown never yields an unbounded future timestamp',async()=>{
  const {retryAtFromUnknown}=await import('./communityRetryPolicy');
  const now=Date.now();
  assert.ok((retryAtFromUnknown({retryAfterMs:31_536_000_000},now) as number)<=now+900000);
  assert.ok((retryAtFromUnknown({retryAt:now+31_536_000_000},now) as number)<=now+900000);
  assert.equal(retryAtFromUnknown({retryAfterMs:5000},now),now+5000);
});

test('directive retryAt honors the same bound',async()=>{
  const {communityAcquisitionRetryDirective}=await import('./communityRetryPolicy');
  const directive=communityAcquisitionRetryDirective([
    {surface:'CREATOR_WEBSITES',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'TRANSIENT',retryAt:Date.now()+31_536_000_000},
  ]);
  assert.ok(directive?.retryAt!==undefined&&(directive?.retryAt as number)<=Date.now()+900000);
});

test('unbounded Infinity retry delay collapses to the ceiling instead of undefined', async () => {
  const { clampRetryAtTimestamp } = await import('./communityRetryPolicy');
  const now = Date.now();
  assert.equal(clampRetryAtTimestamp(Infinity, now), now + 900000);
  assert.equal(clampRetryAtTimestamp(-Infinity, now), undefined);
});

test('browser-runtime-only failures classify as capacity without consuming attempts', async () => {
  const { communityAcquisitionRetryDirective } = await import('./communityRetryPolicy');
  const zeroEvidence = { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 };
  const directive = communityAcquisitionRetryDirective([
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'BROWSER_LAUNCH_FAILED', telemetry: zeroEvidence },
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'BROWSER_RUNTIME_UNAVAILABLE', telemetry: zeroEvidence },
  ]);
  assert.equal(directive?.retryReason, 'BROWSER_RUNTIME_UNAVAILABLE');
  assert.equal(directive?.code, 'BROWSER_RUNTIME_UNAVAILABLE');
});

test('browser-runtime failure WITH processed pages consumes an attempt', async () => {
  const { communityAcquisitionRetryDirective } = await import('./communityRetryPolicy');
  // A browser crash after useful work is executed work: the class alone must
  // never grant attempt-free behavior once pages were processed.
  const directive = communityAcquisitionRetryDirective([
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'BROWSER_LAUNCH_FAILED', telemetry: { pagesInspected: 2, requestsStarted: 3, redirectsFollowed: 0 } },
  ]);
  assert.equal(directive?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(directive?.code, 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE');
});

test('browser-runtime class without telemetry cannot prove no-start and consumes', async () => {
  const { communityAcquisitionRetryDirective } = await import('./communityRetryPolicy');
  // Absence of telemetry is not evidence of absence: legacy/telemetry-less
  // rows count as evidenced and consume, matching collapse accounting.
  const directive = communityAcquisitionRetryDirective([
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'BROWSER_BINARY_MISSING' },
  ]);
  assert.equal(directive?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});

test('mixed capacity plus processed browser failure consumes an attempt', async () => {
  const { communityAcquisitionRetryDirective } = await import('./communityRetryPolicy');
  const zeroEvidence = { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 };
  const directive = communityAcquisitionRetryDirective([
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'RENDERED_FALLBACK_SATURATED', telemetry: zeroEvidence },
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'BROWSER_LAUNCH_FAILED', telemetry: { pagesInspected: 1, requestsStarted: 2, redirectsFollowed: 0 } },
  ]);
  assert.equal(directive?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});

test('all-saturated zero-evidence failures defer attempt-free as capacity', async () => {
  const { communityAcquisitionRetryDirective } = await import('./communityRetryPolicy');
  const zeroEvidence = { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 };
  const directive = communityAcquisitionRetryDirective([
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'RENDERED_FALLBACK_SATURATED', telemetry: zeroEvidence },
    { surface: 'SOCIAL_PROFILES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'RENDERED_FALLBACK_SATURATED', telemetry: zeroEvidence },
  ]);
  assert.equal(directive?.retryReason, 'BROWSER_RUNTIME_UNAVAILABLE');
  assert.equal(directive?.code, 'BROWSER_RUNTIME_UNAVAILABLE');
});

test('genuine acquisition failure consumes an attempt even without capacity signals', async () => {
  const { communityAcquisitionRetryDirective } = await import('./communityRetryPolicy');
  const directive = communityAcquisitionRetryDirective([
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'NO_PAGE_PROCESSED' },
  ]);
  assert.equal(directive?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});

test('mixed browser-runtime + genuine failure MUST NOT classify as attempt-free capacity', async () => {
  const { communityAcquisitionRetryDirective } = await import('./communityRetryPolicy');
  // One capacity row must never launder genuine executed work: real inspection
  // ran for the TIMEOUT root, so the retry consumes a bounded attempt. The
  // browser row carries zero-evidence telemetry (proven unstarted) to isolate
  // the unanimity semantic: unanimity fails because of the genuine row alone.
  const zeroEvidence = { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 };
  const directive = communityAcquisitionRetryDirective([
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'BROWSER_RUNTIME_UNAVAILABLE', telemetry: zeroEvidence },
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'TIMEOUT', telemetry: { pagesInspected: 0, requestsStarted: 1, redirectsFollowed: 0 } },
  ]);
  assert.equal(directive?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(directive?.code, 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE');
  // And symmetrically regardless of observation order.
  const reversed = communityAcquisitionRetryDirective([
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'PARTIALLY_INSPECTED', retryable: true, failureClass: 'RENDERED_BUDGET_EXPIRED', telemetry: { pagesInspected: 3, requestsStarted: 4, redirectsFollowed: 0 } },
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'BROWSER_BINARY_MISSING', telemetry: zeroEvidence },
  ]);
  assert.equal(reversed?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});
