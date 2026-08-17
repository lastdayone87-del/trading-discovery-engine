import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {validateDiscordInvite} from './discordValidator';
import {applyCreatorAssociationToDiscordValidation,projectDiscordValidation} from './discordProjection';
import {candidateFromNativeInvite} from './discordCandidates';
import type {ChannelRecord} from '../src/types';

const noopEmit=async()=>{};
const liveResponse=(input:{code?:string;guildName?:string;description?:string;channelName?:string;members?:number})=>new Response(JSON.stringify({
  code:input.code||'room',
  approximate_member_count:input.members??100,
  approximate_presence_count:10,
  guild:{name:input.guildName||'General Community',description:input.description||''},
  channel:{name:input.channelName||'general'}
}),{status:200,headers:{'content-type':'application/json'}});

function channel(overrides:Partial<ChannelRecord>={}):ChannelRecord{
  return {
    channel_id:'c1',channel_name:'Lunar - Trading Academy',youtube_url:'https://youtube.com/channel/c1',country:'United States',country_status:'CONFIRMED',confidence_score:100,
    discord_status:'UNCERTAIN',scan_status:'COMPLETED',scan_attempts:0,discovery_source:'automated_query',first_seen:'2026-01-01T00:00:00Z',
    trading_status:'TRADING_CONFIRMED',trading_confidence_score:93,trading_category:'Order Flow',...overrides
  };
}

const creatorCandidate=()=>candidateFromNativeInvite({nativeInviteCode:'atas',sourceSurface:'YOUTUBE_ABOUT',sourceUrl:'https://youtube.com/@lunar'})!;

test('validator directly promotes generic active Discord from complete strong creator context',async()=>{
  const result=await validateDiscordInvite('atas',{
    parentContext:{
      tradingStatus:'TRADING_CONFIRMED',tradingConfidence:93,tradingCategory:'Order Flow',creatorName:'Lunar - Trading Academy',country:'United States',
      sourceSurface:'YOUTUBE_ABOUT',ownershipStatus:'CREATOR_OWNED',ownershipConfidence:95
    },
    fetchImpl:async()=>liveResponse({code:'atas'}),emitProviderEvent:noopEmit as any
  });
  assert.equal(result.livenessStatus,'ACTIVE');
  assert.equal(result.relevanceStatus,'TRADING_RELEVANT');
  assert.equal(result.status,'ACTIVE');
  assert.equal(result.inviteUrl,'https://discord.gg/atas');
  assert.match(result.relevanceReason||'',/creator-owned source/i);
});

test('validator does not promote generic active Discord when ownership context is ambiguous',async()=>{
  const result=await validateDiscordInvite('partner',{
    parentContext:{
      tradingStatus:'TRADING_CONFIRMED',tradingConfidence:93,tradingCategory:'Order Flow',creatorName:'Lunar - Trading Academy',country:'United States',
      sourceSurface:'RECENT_VIDEO_DESCRIPTIONS',ownershipStatus:'UNCERTAIN',ownershipConfidence:65
    },
    fetchImpl:async()=>liveResponse({code:'partner'}),emitProviderEvent:noopEmit as any
  });
  assert.equal(result.livenessStatus,'ACTIVE');
  assert.equal(result.relevanceStatus,'UNCERTAIN');
  assert.equal(result.inviteUrl,null);
});

test('production queue supplies complete candidate-specific parentContext to validator',()=>{
  const queue=readFileSync('server/queueManager.ts','utf8');
  assert.match(queue,/validateDiscordInvite\(candidate\.nativeInviteCode,\{\s*parentContext:\{/);
  assert.match(queue,/tradingStatus:channel\.trading_status/);
  assert.match(queue,/tradingConfidence:Number\(channel\.trading_confidence_score\|\|0\)/);
  assert.match(queue,/tradingCategory:channel\.trading_category/);
  assert.match(queue,/creatorName:channel\.channel_name/);
  assert.match(queue,/country:channel\.country/);
  assert.match(queue,/sourceSurface:candidate\.sourceSurface/);
  assert.match(queue,/ownershipStatus:candidate\.ownershipStatus/);
  assert.match(queue,/ownershipConfidence:candidate\.ownershipConfidence/);
});

test('generic active Discord from strong creator-owned trading source is promoted by association',async()=>{
  const base=await validateDiscordInvite('atas',{parentChannelIsTrading:true,channelName:'Lunar - Trading Academy',fetchImpl:async()=>liveResponse({code:'atas'}),emitProviderEvent:noopEmit as any});
  assert.equal(base.livenessStatus,'ACTIVE');
  assert.equal(base.relevanceStatus,'UNCERTAIN');
  const candidate={...creatorCandidate(),ownershipStatus:'CREATOR_OWNED' as const,ownershipConfidence:95};
  const effective=applyCreatorAssociationToDiscordValidation(channel(),base,candidate);
  assert.equal(effective.relevanceStatus,'TRADING_RELEVANT');
  assert.equal(effective.status,'ACTIVE');
  assert.equal(effective.inviteUrl,'https://discord.gg/atas');
  assert.match(effective.relevanceReason||'',/creator-owned source/i);
});

test('same generic active Discord on a third-party source is not promoted by parent trading status',async()=>{
  const base=await validateDiscordInvite('partner',{parentChannelIsTrading:true,channelName:'Lunar - Trading Academy',fetchImpl:async()=>liveResponse({code:'partner'}),emitProviderEvent:noopEmit as any});
  const candidate={...candidateFromNativeInvite({nativeInviteCode:'partner',sourceSurface:'CREATOR_WEBSITES',sourceUrl:'https://broker.example/referral'})!,ownershipStatus:'THIRD_PARTY' as const,ownershipConfidence:95};
  const effective=applyCreatorAssociationToDiscordValidation(channel(),base,candidate);
  assert.equal(effective.relevanceStatus,'UNCERTAIN');
  assert.equal(effective.inviteUrl,null);
});

test('invite code cannot create Discord-native trading evidence',async()=>{
  const result=await validateDiscordInvite('trade-room',{fetchImpl:async()=>liveResponse({code:'trade-room',guildName:'General Community',channelName:'general',members:100}),emitProviderEvent:noopEmit as any});
  assert.equal(result.livenessStatus,'ACTIVE');
  assert.equal(result.relevanceStatus,'UNCERTAIN');
  assert.equal(result.inviteUrl,null);
});

test('explicit Discord-native unrelated evidence is not overridden by creator association',async()=>{
  const base=await validateDiscordInvite('gaming',{parentChannelIsTrading:true,fetchImpl:async()=>liveResponse({code:'gaming',guildName:'Minecraft Gaming Community',members:100}),emitProviderEvent:noopEmit as any});
  assert.equal(base.relevanceStatus,'NON_TRADING');
  const candidate={...creatorCandidate(),ownershipStatus:'CREATOR_OWNED' as const,ownershipConfidence:95};
  const effective=applyCreatorAssociationToDiscordValidation(channel(),base,candidate);
  assert.equal(effective.relevanceStatus,'NON_TRADING');
  assert.equal(effective.inviteUrl,null);
});

test('projection serves creator-associated active candidate while preserving independent dimensions',async()=>{
  const base=await validateDiscordInvite('atas',{parentChannelIsTrading:true,fetchImpl:async()=>liveResponse({code:'atas'}),emitProviderEvent:noopEmit as any});
  const candidate={...creatorCandidate(),ownershipStatus:'CREATOR_OWNED' as const,ownershipConfidence:95};
  const projected=projectDiscordValidation(channel(),base,candidate);
  assert.equal(projected.discord_status,'ACTIVE');
  assert.equal(projected.discord_liveness_status,'ACTIVE');
  assert.equal(projected.discord_relevance_status,'TRADING_RELEVANT');
  assert.equal(projected.discord_validation_status,'SUCCEEDED');
  assert.equal(projected.discord_invite,'https://discord.gg/atas');
});
