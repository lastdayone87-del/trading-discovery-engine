import assert from 'node:assert/strict';
import test from 'node:test';
import {inferDiscordOwnership,makeDiscordCandidate} from './discordCandidates';
import {validateDiscordInvite} from './discordValidator';
import {creatorWebsiteHostsFromLinks,runChannelInspection} from './inspector';

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

test('canonical domain corroborates but never decides ownership alone',()=>{
  // creatorWebsiteHosts is wired from channel links by runChannelInspection.
  // A bare link proves reference, not ownership: canonical (+30) keeps a
  // 40-base website invite at 70/UNCERTAIN unless brand (+35) or
  // cross-surface (+15) corroboration is also present.
  const c=candidate('CREATOR_WEBSITES','https://atlasfx.io/community');
  const without=inferDiscordOwnership(c,{creatorName:'Atlas Trading'});
  assert.equal(without.ownershipStatus,'UNCERTAIN');
  const alone=inferDiscordOwnership(c,{creatorName:'Atlas Trading',creatorWebsiteHosts:['atlasfx.io']});
  assert.equal(alone.ownershipStatus,'UNCERTAIN');
  assert.ok(alone.ownershipReasons?.includes('CREATOR_CANONICAL_DOMAIN'));
  const corroborated=inferDiscordOwnership(c,{creatorName:'Atlas Fx',creatorWebsiteHosts:['atlasfx.io']});
  assert.equal(corroborated.ownershipStatus,'CREATOR_OWNED');
  assert.ok(corroborated.ownershipReasons?.includes('CREATOR_CANONICAL_DOMAIN'));
  assert.ok(corroborated.ownershipReasons?.includes('CREATOR_BRAND_DOMAIN_MATCH'));
});

test('third-party linked site without corroboration stays out of creator-owned',()=>{
  // A creator linking an ordinary third-party tools site must not promote
  // that site's Discord to creator-owned on the link alone.
  const neutral=candidate('CREATOR_WEBSITES','https://tools.example/room');
  const neutralOwnership=inferDiscordOwnership(neutral,{creatorName:'Atlas Trading',creatorWebsiteHosts:['tools.example']});
  assert.equal(neutralOwnership.ownershipStatus,'UNCERTAIN');
  // A broker host additionally trips the partner-token guard.
  const broker=candidate('CREATOR_WEBSITES','https://broker.example/broker-room');
  const brokerOwnership=inferDiscordOwnership(broker,{creatorName:'Atlas Trading',creatorWebsiteHosts:['broker.example']});
  assert.equal(brokerOwnership.ownershipStatus,'THIRD_PARTY');
});

test('canonical-domain signal does not rescue partner/affiliate surfaces',()=>{
  const c=candidate('CREATOR_WEBSITES','https://atlasfx.io/partner-bonus');
  const ownership=inferDiscordOwnership(c,{creatorName:'Atlas Trading',creatorWebsiteHosts:['atlasfx.io']});
  assert.equal(ownership.ownershipStatus,'THIRD_PARTY');
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
test('canonical host derivation keeps website domains and drops shared/social/messaging surfaces',()=>{
  assert.deepEqual(
    creatorWebsiteHostsFromLinks([
      'https://atlasfx.io',
      'https://www.atlasfx.io/about',
      'https://youtube.com/redirect?q=https%3A%2F%2Fatlasfx.io%2Flinks',
      'https://instagram.com/atlastrading',
      'https://linktr.ee/atlastrading',
      'https://whop.com/atlastrading',
      'https://t.me/atlastrading',
      'https://discord.gg/room',
      'https://g/',
      'https://community.circle.so/atlas-trading',
      'https://trading.skool.com/atlas',
      null,
      '',
    ]),
    ['atlasfx.io'],
  );
});

test('runChannelInspection promotes a linked-domain invite with brand corroboration',async()=>{
  const inviteHtml = new Response('<html><body>Join us https://discord.gg/room</body></html>',{status:200,headers:{'content-type':'text/html'}});
  const emptyHtml = new Response('<html><body>No Discord invite here</body></html>',{status:200,headers:{'content-type':'text/html'}});
  const result = await runChannelInspection({
    channelId:'canonical-wiring-channel',
    channelName:'Atlas Fx',
    channelBio:'Trading notes',
    channelLinks:['https://atlasfx.io','https://instagram.com/atlastrading'],
    videoDescriptions:['one','two','three','four','five'],
    creatorLikelyTrading:false,
    externalFetchImpl:(async(input:any)=>String(input).includes('atlasfx.io')?inviteHtml.clone():emptyHtml) as typeof fetch,
    renderedFallback:async(seedUrl:string)=>({foundInvite:null,foundLocation:seedUrl,candidates:[],inspectedPages:1,scrolls:0,clicks:0,complete:true,retryable:false,detail:'test rendered without invite'}),
  });
  const owned=(result.discordCandidates||[]).find(c=>c.nativeInviteCode==='room');
  assert.ok(owned,'expected the linked-domain invite to be retained');
  assert.equal(owned?.ownershipStatus,'CREATOR_OWNED');
  assert.ok(owned?.ownershipReasons?.includes('CREATOR_CANONICAL_DOMAIN'));
});
