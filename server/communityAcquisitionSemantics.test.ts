import assert from 'node:assert/strict';
import test from 'node:test';
import {validateDiscordInvite} from './discordValidator';
import {crawlExternalLinks,runChannelInspection} from './inspector';
import {communityAcquisitionRetryKey} from './queueManager';
import {ProviderCallError} from './providerResilience';
import {readFileSync} from 'node:fs';
import {effectiveAcquisitionOutcomes} from './communitySurfacePolicy';
import {communityAcquisitionRetryDirective} from './communityRetryPolicy';

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

test('a first Discord invalid observation is retryable and only a separate prior observation permits DEAD',async()=>{
  const invalid=()=>response(404,JSON.stringify({message:'Unknown Invite',code:10006}));
  const first=await validateDiscordInvite('expired-invite',{maxAttempts:1,retryDelayMs:0,emitProviderEvent:noEvent,fetchImpl:async()=>invalid()});
  assert.equal(first.status,'UNCERTAIN');assert.equal(first.operationalOutcome,'INVALID_OBSERVED');assert.equal(first.retryable,true);assert.equal(first.livenessStatus,'INVALID_OBSERVED');
  const confirmed=await validateDiscordInvite('expired-invite',{maxAttempts:1,priorInvalidObservations:1,retryDelayMs:0,emitProviderEvent:noEvent,fetchImpl:async()=>invalid()});
  assert.equal(confirmed.status,'DEAD');assert.equal(confirmed.operationalOutcome,'CONFIRMED_INVALID');assert.equal(confirmed.retryable,false);
});

test('an unexpected HTML 404 is a retryable provider failure, never DEAD',async()=>{const result=await validateDiscordInvite('edge-case',{maxAttempts:1,emitProviderEvent:noEvent,fetchImpl:async()=>response(404,'not found','text/html')});assert.equal(result.status,'UNCERTAIN');assert.equal(result.operationalOutcome,'PROVIDER_FAILURE');assert.equal(result.retryable,true);});

test('malformed Discord success payload remains retryable uncertainty',async()=>{
  const result=await validateDiscordInvite('malformed',{maxAttempts:2,retryDelayMs:0,emitProviderEvent:noEvent,fetchImpl:async()=>response(200,'{}')});
  assert.equal(result.status,'UNCERTAIN');assert.equal(result.operationalOutcome,'MALFORMED_RESPONSE');assert.equal(result.attempts.length,2);
});

test('ambiguous successful Discord lookup remains semantic uncertainty after a completed provider call',async()=>{const result=await validateDiscordInvite('community',{maxAttempts:1,emitProviderEvent:noEvent,fetchImpl:async()=>response(200,JSON.stringify({code:'community',guild:{name:'Community'}}))});assert.equal(result.status,'UNCERTAIN');assert.equal(result.operationalOutcome,'SUCCEEDED');assert.equal(result.retryable,false);});
test('successful trading Discord validation retains active semantics',async()=>{const result=await validateDiscordInvite('futures-room',{maxAttempts:1,emitProviderEvent:noEvent,fetchImpl:async()=>response(200,JSON.stringify({code:'futures-room',approximate_member_count:100,guild:{name:'Futures Trading Room'}}))});assert.equal(result.status,'ACTIVE');assert.equal(result.operationalOutcome,'SUCCEEDED');assert.equal(result.inviteUrl,'https://discord.gg/futures-room');});
test('later successful no-match supersedes an earlier raw acquisition failure for retry eligibility',()=>{
  const observations=[
    {requestedUrl:'youtube-api:channel:effective:recent-video-descriptions',surface:'RECENT_VIDEO_DESCRIPTIONS' as const,required:true,outcome:'ACQUISITION_FAILED' as const,retryable:true,detail:'temporary failure',observedAt:'2026-08-25T10:00:00.000Z'},
    {requestedUrl:'youtube-api:channel:effective:recent-video-descriptions',surface:'RECENT_VIDEO_DESCRIPTIONS' as const,required:true,outcome:'INSPECTED_NO_MATCH' as const,retryable:false,detail:'acquired and inspected without invite',observedAt:'2026-08-25T10:01:00.000Z'}
  ];
  const effective=effectiveAcquisitionOutcomes(observations);
  assert.equal(effective.length,1);
  assert.equal(effective[0].outcome,'INSPECTED_NO_MATCH');
  assert.equal(communityAcquisitionRetryDirective(effective),undefined);
  const inspector=readFileSync('server/inspector.ts','utf8');
  assert.match(inspector,/communityRequired=required\.filter\(item=>isDiscordCommunityAcquisitionSurface\(item\.surface\)\)/);
  assert.match(inspector,/retryDirective:communityAcquisitionRetryDirective\(communityRequired\)/);
});

test('fully inspected no-invite acquisition is completed negative and emits no retry',async()=>{
  const result=await runChannelInspection({channelId:'completed-negative',channelName:'No Match Channel',channelBio:'No community invite here',channelLinks:['https://example.test/no-community'],videoDescriptions:['one','two','three','four','five'],externalFetchImpl:async()=>response(200,'<html><body>No Discord invite</body></html>','text/html')});
  assert.equal(result.foundInvite,null);
  assert.equal(result.acquisitionStatus,'INSPECTED_NO_MATCH');
  assert.equal(result.retryDirective,undefined);
  assert.ok(result.steps.some(step=>step.step==='EXTERNAL_LINKS'&&step.status==='NOT_FOUND'));
});

test('failed YouTube About acquisition does not change a Discord negative or create a community retry',async()=>{const result=await runChannelInspection({channelId:'c1',channelBio:'',youtubeUrl:'https://youtube.test/c1',forceLiveFetch:true,videoDescriptions:['one','two','three','four','five'],liveChannelDataLoader:async()=>null});assert.equal(result.acquisitionStatus,'INSPECTED_NO_MATCH');assert.equal(result.retryDirective,undefined);assert.equal(result.acquisitionOutcomes?.[0].failureClass,'YOUTUBE_ABOUT_ACQUISITION_FAILED');});
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
  assert.doesNotMatch(queue,/appendDiscordCheckAttempts[\s\S]{0,300}\.catch/);assert.match(queue,/appendExternalAcquisitionObservations[\s\S]+\.catch/);
  assert.match(queue,/projectDiscordValidation\(channel,selected,selectedCandidate\)/);assert.match(queue,/DISCOVERED_VALIDATION_FAILED/);
  assert.match(diagnostics,/persistClassificationEvidenceBundle/);
});

test('YouTube redirect destinations are decoded, normalized, classified by hostname, and deduplicable',async()=>{
  const {normalizeExternalUrl}=await import('./inspector');
  const wrapper='https://www.youtube.com/redirect?event=channel_description&q='+encodeURIComponent('https://Instagram.com/trader/?utm_source=youtube#bio');
  const normalized=normalizeExternalUrl(wrapper);assert.equal(normalized?.url,'https://instagram.com/trader');assert.equal(normalized?.kind,'SOCIAL');assert.equal(normalized?.wrapperUrl,wrapper);
  assert.equal(normalizeExternalUrl('https://youtube.com/watch?v=abcdefghijk'),null);
});

test('recent-video Discord is preserved before optional acquisition',async()=>{
  const result=await runChannelInspection({channelId:'recent',channelBio:'No invite',channelLinks:[],videoDescriptions:['one','two https://discord.gg/recent-room','three','four','five']});
  assert.equal(result.foundInvite,'recent-room');assert.equal(result.foundLocation,'VIDEO_2_DESCRIPTION');assert.equal(result.acquisitionStatus,'FOUND');
  assert.ok(result.acquisitionOutcomes?.some(item=>item.surface==='RECENT_VIDEO_DESCRIPTIONS'&&item.outcome==='FOUND'));
});

test('Discord extraction is preserved across supported acquired surfaces',async()=>{
  const about=await runChannelInspection({channelId:'about',channelBio:'Join https://discord.com/invite/about-room',videoDescriptions:['1','2','3','4','5']});
  const links=await runChannelInspection({channelId:'links',channelBio:'none',channelLinks:['https://discord.gg/link-room'],videoDescriptions:['1','2','3','4','5']});
  assert.equal(about.foundInvite,'about-room');assert.equal(links.foundInvite,'link-room');
});

test('optional website failure does not contaminate social or required acquisition coverage',async()=>{
  const result=await runChannelInspection({channelId:'optional',channelBio:'https://unreachable.invalid',videoDescriptions:['1','2','3','4','5'],externalFetchImpl:async()=>response(503,'','text/html')});
  assert.equal(result.acquisitionStatus,'INSPECTED_NO_MATCH');
  const website=result.steps.find(step=>step.step==='CUSTOM_DOMAINS'),social=result.steps.find(step=>step.step==='SOCIAL_BIO');
  assert.equal(website?.status,'ERROR');assert.equal(social?.status,'SKIPPED');
  assert.equal(result.acquisitionOutcomes?.find(item=>item.surface==='CREATOR_WEBSITES')?.required,false);
});


test('alternative locators retain their type and are not reinterpreted as native invite codes',async()=>{const {extractDiscordCandidates}=await import('./discordCandidates');const [candidate]=extractDiscordCandidates('https://dsc.gg/trading-room','CHANNEL_EXTERNAL_LINKS');assert.equal(candidate.locatorType,'ALTERNATIVE_REDIRECT');assert.equal(candidate.nativeInviteCode,undefined);assert.equal(candidate.rawLocator,'https://dsc.gg/trading-room');});

test('candidate extraction never truncates and retains multiple native candidates',async()=>{const {extractDiscordCandidates}=await import('./discordCandidates');const long='a'.repeat(129),items=extractDiscordCandidates(`https://discord.gg/${long} https://discord.gg/stale https://discord.gg/active`,'YOUTUBE_ABOUT');assert.deepEqual(items.map(item=>item.nativeInviteCode),['stale','active']);});

test('parent creator text is not counted as Discord-native relevance evidence',async()=>{const result=await validateDiscordInvite('community',{parentChannelIsTrading:true,channelName:'Futures Trading Academy',maxAttempts:1,emitProviderEvent:noEvent,fetchImpl:async()=>response(200,JSON.stringify({code:'community',approximate_member_count:100,guild:{name:'General Community'}}))});assert.equal(result.livenessStatus,'ACTIVE');assert.equal(result.relevanceStatus,'UNCERTAIN');assert.equal(result.status,'UNCERTAIN');});

test('inspection retains candidates across surfaces instead of early-stopping on the first locator',async()=>{const result=await runChannelInspection({channelId:'multi',channelBio:'https://discord.gg/stale',videoDescriptions:['https://discord.gg/active','2','3','4','5']});const codes=result.discordCandidates?.map(candidate=>candidate.nativeInviteCode)||[];assert.ok(codes.includes('stale'));assert.ok(codes.includes('active'));assert.ok(result.steps.filter(step=>step.status==='FOUND').length>=2);});

test('alternative redirect resolution preserves raw locator and resolved native code',async()=>{const redirected=response(200,'<html></html>','text/html');Object.defineProperty(redirected,'url',{value:'https://discord.gg/native-room'});const result=await runChannelInspection({channelId:'alternative',channelBio:'',channelLinks:['https://dsc.gg/vanity-room'],videoDescriptions:['1','2','3','4','5'],externalFetchImpl:async()=>redirected});const candidate=result.discordCandidates?.[0];assert.equal(candidate?.locatorType,'ALTERNATIVE_REDIRECT');assert.equal(candidate?.rawLocator,'https://dsc.gg/vanity-room');assert.equal(candidate?.nativeInviteCode,'native-room');assert.equal(candidate?.extractionConfidence,'RESOLVED');});


test('recent-video acquisition failure does not become a Discord/community retry',async()=>{
  const result=await runChannelInspection({
    channelId:'recent-video-upstream-failure',
    channelName:'Video Failure',
    channelBio:'No Discord invite',
    videoDescriptions:[],
    recentVideoDescriptionsLoader:async()=>{throw new Error('recent video provider unavailable');}
  });
  assert.equal(result.acquisitionStatus,'INSPECTED_NO_MATCH');
  assert.equal(result.retryDirective,undefined);
  assert.ok(result.acquisitionOutcomes?.some(item=>item.surface==='RECENT_VIDEO_DESCRIPTIONS'&&item.outcome==='ACQUISITION_FAILED'&&item.required));
});

test('live country terminal projection preserves the already executed inspection trail',()=>{
  const queue=readFileSync('server/queueManager.ts','utf8');
  assert.match(queue,/const liveCountry = mergeCountryValidationResults\(valRes, rawLiveCountry\)/);
  assert.match(queue,/channel\.inspection_trail=\[countryStep, \.\.\.inspection\.steps, liveCountryStep\]/);
  assert.doesNotMatch(queue,/channel\.discord_invite=null;\s*channel\.discord_status='NOT_FOUND'/);
});

test('country terminal projection does not invent a Discord result before inspection',()=>{
  const queue=readFileSync('server/queueManager.ts','utf8');
  const initialReject=queue.slice(queue.indexOf("if (valRes.status === 'REJECTED')"),queue.indexOf('// Update country status & decision trail'));
  assert.doesNotMatch(initialReject,/discord_status\s*=/);
  assert.doesNotMatch(initialReject,/discord_validation_status\s*=/);
});
