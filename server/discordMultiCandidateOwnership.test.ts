import assert from 'node:assert/strict';
import test from 'node:test';
import {crawlExternalLinks,runChannelInspection} from './inspector';
import {mergeDiscordCandidates} from './discordCandidates';

const html=(body:string,url:string)=>{const response=new Response(body,{status:200,headers:{'content-type':'text/html'}});Object.defineProperty(response,'url',{value:url});return response;};

test('partner page first does not prevent later creator page from being crawled',async()=>{
  const requested:string[]=[];
  const result=await crawlExternalLinks(['https://partner.test','https://creator.test'],[],undefined,async input=>{
    const url=String(input);requested.push(url);
    return url.includes('partner')?html('<a href="https://discord.gg/partner-room">Partner Discord</a>',url):html('<a href="https://discord.gg/creator-room">Creator Discord</a>',url);
  });
  assert.ok(requested.some(url=>url.includes('partner.test')));assert.ok(requested.some(url=>url.includes('creator.test')));
  assert.deepEqual(new Set(result.candidates.map(candidate=>candidate.nativeInviteCode)),new Set(['partner-room','creator-room']));
});

test('one page can retain two distinct Discord invites',async()=>{
  const result=await crawlExternalLinks(['https://creator.test'],[],undefined,async input=>html('<a href="https://discord.gg/partner-room">Partner</a><a href="https://discord.gg/creator-room">Creator</a>',String(input)));
  assert.deepEqual(new Set(result.candidates.map(candidate=>candidate.nativeInviteCode)),new Set(['partner-room','creator-room']));
});

test('same invite across About and video becomes one canonical candidate with multiple observations',async()=>{
  const result=await runChannelInspection({channelId:'canonical',channelBio:'Join https://discord.gg/same-room',videoDescriptions:['Also https://discord.gg/same-room','2','3','4','5']});
  const matching=(result.discordCandidates||[]).filter(candidate=>candidate.nativeInviteCode==='same-room');
  assert.equal(matching.length,1);assert.ok((matching[0].observations||[]).length>=2);
});

test('ownership sorting keeps direct creator evidence ahead of affiliate-only evidence',()=>{
  const items=[
    ...require('./discordCandidates').extractDiscordCandidates('https://discord.gg/partner','CREATOR_WEBSITES','https://broker.test/referral/creator'),
    ...require('./discordCandidates').extractDiscordCandidates('https://discord.gg/creator','YOUTUBE_ABOUT','https://youtube.test/channel')
  ];
  const merged=mergeDiscordCandidates(items,{creatorName:'Creator'});
  assert.equal(merged[0].nativeInviteCode,'creator');assert.equal(merged[0].ownershipStatus,'CREATOR_OWNED');assert.equal(merged.find(candidate=>candidate.nativeInviteCode==='partner')?.ownershipStatus,'THIRD_PARTY');
});
