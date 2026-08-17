import assert from 'node:assert/strict';
import test from 'node:test';
import {inferDiscordOwnership,makeDiscordCandidate} from './discordCandidates';
import {validateDiscordInvite} from './discordValidator';

const noopEmit=async()=>{};
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

function candidate(surface:any,sourceUrl:string){
  return makeDiscordCandidate({
    locatorType:'NATIVE_INVITE',sourceSurface:surface,rawLocator:'https://discord.gg/room',nativeInviteCode:'room',normalizedLocator:'https://discord.gg/room',sourceUrl,extractionConfidence:'EXPLICIT'
  });
}

test('creator-branded linked website crosses the existing ownership gate without lowering it',()=>{
  const c=candidate('CREATOR_WEBSITES','https://scottiecummings.com/community');
  const ownership=inferDiscordOwnership(c,{creatorName:'Scottie Cummings'});
  assert.equal(ownership.ownershipStatus,'CREATOR_OWNED');
  assert.ok((ownership.ownershipConfidence||0)>=75);
  assert.ok(ownership.ownershipReasons?.includes('CREATOR_BRAND_DOMAIN_MATCH'));
});

test('creator social profile identity corroborates ownership but generic social URL does not',()=>{
  const owned=inferDiscordOwnership(candidate('SOCIAL_PROFILES','https://instagram.com/scottie.cummings'),{creatorName:'Scottie Cummings'});
  assert.equal(owned.ownershipStatus,'CREATOR_OWNED');
  assert.ok(owned.ownershipReasons?.includes('CREATOR_SOCIAL_IDENTITY_MATCH'));

  const generic=inferDiscordOwnership(candidate('SOCIAL_PROFILES','https://instagram.com/community'),{creatorName:'Scottie Cummings'});
  assert.notEqual(generic.ownershipStatus,'CREATOR_OWNED');
});

test('partner evidence still blocks creator-owned promotion even on a brand-looking surface',()=>{
  const c=candidate('CREATOR_WEBSITES','https://scottiecummings.com/broker-partner');
  const ownership=inferDiscordOwnership(c,{creatorName:'Scottie Cummings'});
  assert.notEqual(ownership.ownershipStatus,'CREATOR_OWNED');
  assert.ok(ownership.ownershipReasons?.includes('PARTNER_OR_AFFILIATE_SURFACE'));
});

test('public Discord invite landing-page metadata can confirm trading relevance without joining',async()=>{
  const calls:string[]=[];
  const result=await validateDiscordInvite('room',{
    publicEvidenceMaxRequests:3,
    emitProviderEvent:noopEmit as any,
    fetchImpl:async(input:any)=>{
      const url=String(input);calls.push(url);
      if(url.includes('/api/v9/invites/'))return json({code:'room',approximate_member_count:120,approximate_presence_count:15,guild:{id:'g1',name:'General Community',description:''},channel:{name:'general'}});
      if(url.includes('/welcome-screen'))return json({message:'not enabled'},404);
      if(url.includes('/widget.json'))return json({message:'not enabled'},403);
      if(url.includes('/invite/room'))return new Response('<html><head><meta property="og:title" content="Scottie Trading Room"><meta property="og:description" content="Futures trading, market structure and risk management"></head></html>',{status:200,headers:{'content-type':'text/html'}});
      throw new Error(`unexpected ${url}`);
    }
  });
  assert.equal(result.relevanceStatus,'TRADING_RELEVANT');
  assert.equal(result.livenessStatus,'ACTIVE');
  assert.equal(result.inviteUrl,'https://discord.gg/room');
  assert.equal(result.evidenceCoverage?.publicInvitePage,'COMPLETED');
  assert.equal(calls.filter(url=>url.includes('/api/v9/invites/')).length,1);
});

test('public landing-page inspection does not override explicit non-trading native evidence',async()=>{
  let calls=0;
  const result=await validateDiscordInvite('room',{
    publicEvidenceMaxRequests:3,
    emitProviderEvent:noopEmit as any,
    fetchImpl:async()=>{calls++;return json({code:'room',approximate_member_count:100,guild:{id:'g1',name:'Minecraft Gaming Community',description:''},channel:{name:'general'}});}
  });
  assert.equal(result.relevanceStatus,'NON_TRADING');
  assert.equal(calls,1);
  assert.equal(result.evidenceCoverage?.publicInvitePage,'NOT_ATTEMPTED');
});