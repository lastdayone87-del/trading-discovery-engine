import assert from 'node:assert/strict';
import test from 'node:test';
import {validateDiscordInvite} from './discordValidator';
import {crawlExternalLinks,runChannelInspection} from './inspector';
import {communityAcquisitionRetryKey} from './queueManager';
import {ProviderCallError} from './providerResilience';
import {readFileSync} from 'node:fs';

const noEvent=async()=>undefined;
const response=(status:number,body='{}',contentType='application/json')=>new Response(body,{status,headers:{'content-type':contentType}});

test('Discord rate limits remain operational uncertainty and preserve the candidate locator',async()=>{
  const result=await validateDiscordInvite('rate-limit',{maxAttempts:3,retryDelayMs:0,emitProviderEvent:noEvent,fetchImpl:async()=>response(429)});
  assert.equal(result.status,'UNCERTAIN');assert.equal(result.operationalOutcome,'RATE_LIMITED');assert.equal(result.retryable,true);
  assert.equal(result.candidateInviteUrl,'https://discord.gg/rate-limit');assert.equal(result.attempts.length,3);
  assert.ok(result.attempts.every(attempt=>attempt.operationalOutcome==='RATE_LIMITED'));
});

test('Discord provider failures and timeouts never become DEAD',async()=>{
  const failure=await validateDiscordInvite('network-failure',{maxAttempts:2,retryDelayMs:0,emitProviderEvent:noEvent,fetchImpl:async()=>{throw new Error('ECONNRESET');}});
  assert.equal(failure.status,'UNCERTAIN');assert.notEqual(failure.operationalOutcome,'CONFIRMED_INVALID');
  const timeout=await validateDiscordInvite('timeout-case',{maxAttempts:1,retryDelayMs:0,emitProviderEvent:noEvent,fetchImpl:async()=>{throw new ProviderCallError('deadline','TIMEOUT',true);}});
  assert.equal(timeout.status,'UNCERTAIN');assert.notEqual(timeout.status,'DEAD');assert.equal(timeout.operationalOutcome,'TIMEOUT');assert.equal(timeout.retryable,true);
});

test('only a confirmed invalid Discord response projects DEAD',async()=>{
  const result=await validateDiscordInvite('expired-invite',{maxAttempts:3,retryDelayMs:0,emitProviderEvent:noEvent,fetchImpl:async()=>response(404)});
  assert.equal(result.status,'DEAD');assert.equal(result.operationalOutcome,'CONFIRMED_INVALID');assert.equal(result.retryable,false);assert.equal(result.attempts.length,1);
});

test('malformed Discord success payload remains retryable uncertainty',async()=>{
  const result=await validateDiscordInvite('malformed',{maxAttempts:2,retryDelayMs:0,emitProviderEvent:noEvent,fetchImpl:async()=>response(200,'{}')});
  assert.equal(result.status,'UNCERTAIN');assert.equal(result.operationalOutcome,'MALFORMED_RESPONSE');assert.equal(result.attempts.length,2);
});

test('ambiguous successful Discord lookup remains semantic uncertainty after a completed provider call',async()=>{const result=await validateDiscordInvite('community',{maxAttempts:1,emitProviderEvent:noEvent,fetchImpl:async()=>response(200,JSON.stringify({code:'community',guild:{name:'Community'}}))});assert.equal(result.status,'UNCERTAIN');assert.equal(result.operationalOutcome,'SUCCEEDED');assert.equal(result.retryable,false);});
test('successful trading Discord validation retains active semantics',async()=>{const result=await validateDiscordInvite('futures-room',{maxAttempts:1,emitProviderEvent:noEvent,fetchImpl:async()=>response(200,JSON.stringify({code:'futures-room',approximate_member_count:100,guild:{name:'Futures Trading Room'}}))});assert.equal(result.status,'ACTIVE');assert.equal(result.operationalOutcome,'SUCCEEDED');assert.equal(result.inviteUrl,'https://discord.gg/futures-room');});
test('failed YouTube About acquisition is retryable rather than NOT_FOUND',async()=>{const result=await runChannelInspection({channelId:'c1',channelBio:'',youtubeUrl:'https://youtube.test/c1',forceLiveFetch:true,videoDescriptions:['one','two','three','four','five'],liveChannelDataLoader:async()=>null});assert.equal(result.acquisitionStatus,'ACQUISITION_FAILED');assert.equal(result.acquisitionOutcomes?.[0].failureClass,'YOUTUBE_ABOUT_ACQUISITION_FAILED');});
test('community retry identity is stable and channel-scoped',()=>{assert.equal(communityAcquisitionRetryKey('creator-1'),communityAcquisitionRetryKey('creator-1'));assert.notEqual(communityAcquisitionRetryKey('creator-1'),communityAcquisitionRetryKey('creator-2'));});

test('failed website acquisition is not confirmed NOT_FOUND',async()=>{
  const result=await crawlExternalLinks(['https://example.test'],[],undefined,async()=>response(503,'','text/html'));
  assert.equal(result.foundInvite,null);assert.equal(result.outcome,'ACQUISITION_FAILED');assert.equal(result.observations[0].retryable,true);
  assert.equal(result.observations[0].outcome,'ACQUISITION_FAILED');
});

test('mixed website acquisition is PARTIALLY_INSPECTED with per-URL provenance',async()=>{
  const result=await crawlExternalLinks(['https://ok.test','https://failed.test'],[],undefined,async input=>String(input).includes('failed')?response(500,'','text/html'):response(200,'<html><body>No community link</body></html>','text/html'));
  assert.equal(result.foundInvite,null);assert.equal(result.outcome,'PARTIALLY_INSPECTED');assert.equal(result.observations.length,2);
  assert.deepEqual(new Set(result.observations.map(item=>item.outcome)),new Set(['INSPECTED_NO_MATCH','ACQUISITION_FAILED']));
});

test('queue compatibility projection keeps failed acquisition uncertain and observational writes failure-contained',()=>{
  const queue=readFileSync('server/queueManager.ts','utf8'),diagnostics=readFileSync('server/classificationDiagnostics.ts','utf8');
  assert.match(queue,/acquisitionStatus==='ACQUISITION_FAILED'\|\|inspection\.acquisitionStatus==='PARTIALLY_INSPECTED'/);
  assert.match(queue,/channel\.discord_status='UNCERTAIN'/);assert.match(queue,/channel\.scan_status='FAILED'/);
  assert.match(queue,/appendDiscordCheckAttempts[\s\S]+\.catch/);assert.match(queue,/appendExternalAcquisitionObservations[\s\S]+\.catch/);
  assert.match(queue,/discord_candidate_locator = discordVal\.candidateInviteUrl/);assert.match(queue,/DISCOVERED_VALIDATION_FAILED/);
  assert.match(diagnostics,/persistClassificationEvidenceBundle\([\s\S]+\.catch/);
});
