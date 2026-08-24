import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runChannelInspection} from './inspector';
import {isAttemptFreeCommunityFailure,retryAtFromUnknown} from './communityRetryPolicy';

const coolingError=()=>Object.assign(new Error('Every configured YouTube provider is cooling down'),{code:'YOUTUBE_PROVIDERS_COOLING_DOWN',retryable:true,retryAt:2_000_000});

test('recent-video provider cooldown is attempt-free and keeps acquisition uncertain',async()=>{
  const result=await runChannelInspection({
    channelId:'cooling-example',
    channelBio:'Trading creator with no community link',
    channelLinks:[],
    videoDescriptions:[],
    creatorLikelyTrading:true,
    recentVideoDescriptionsLoader:async()=>{throw coolingError();},
  });
  assert.equal(result.acquisitionStatus,'ACQUISITION_FAILED');
  assert.equal(result.retryDirective?.attemptFree,true);
  assert.equal(result.retryDirective?.retryAt,2_000_000);
  assert.equal(result.acquisitionOutcomes?.find(item=>item.surface==='RECENT_VIDEO_DESCRIPTIONS')?.retryAt,2_000_000);
  assert.equal(result.discordCandidates?.length,0);
});

test('structured provider capacity errors retain retry-at metadata for durable scheduling',()=>{
  const error=coolingError();
  assert.equal(isAttemptFreeCommunityFailure(error),true);
  assert.equal(retryAtFromUnknown(error),2_000_000);
});

test('queue gates channel attempt increments and retry scheduling on the directive',()=>{
  const queue=readFileSync(new URL('./queueManager.ts',import.meta.url),'utf8');
  assert.match(queue,/if\(!retryDirective\?\.attemptFree\)channel\.scan_attempts\+\+/);
  assert.match(queue,/if\(retryDirective\?\.attemptFree&&scheduleRetry\)await enqueueCommunityAcquisitionRetry/);
  assert.match(queue,/code:directive\.code,retryable:true,retryAt:directive\.retryAt/);
  assert.doesNotMatch(queue,/inspection\.acquisitionOutcomes\?\.some\(item=>item\.retryable\)&&scheduleRetry/);
  assert.match(queue,/browserCapabilityIsUnavailable/);
  assert.match(queue,/BROWSER_RUNTIME_UNAVAILABLE/);
  assert.match(readFileSync(new URL('./dbCore.ts',import.meta.url),'utf8'),/excludedErrorPatterns/);
});
