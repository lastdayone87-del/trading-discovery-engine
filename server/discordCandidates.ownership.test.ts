import test from 'node:test';
import assert from 'node:assert/strict';
import {inferDiscordOwnership, makeDiscordCandidate, mergeDiscordCandidates, type DiscordCandidateObservation} from './discordCandidates';

const base=(sourceSurface:any,sourceUrl:string)=>makeDiscordCandidate({
  locatorType:'NATIVE_INVITE',
  sourceSurface,
  rawLocator:'https://discord.gg/trader-room',
  nativeInviteCode:'trader-room',
  normalizedLocator:'https://discord.gg/trader-room',
  sourceUrl,
  extractionConfidence:'EXPLICIT'
});

test('explicit channel external Discord link is creator-owned without lowering the global threshold',()=>{
  const candidate=base('CHANNEL_EXTERNAL_LINKS','https://www.youtube.com/@creator');
  const ownership=inferDiscordOwnership(candidate);
  assert.equal(ownership.ownershipStatus,'CREATOR_OWNED');
  assert.ok((ownership.ownershipConfidence||0)>=75);
  assert.ok(ownership.ownershipReasons?.includes('EXPLICIT_CHANNEL_CONTROLLED_LINK'));
});

test('single recent video-description Discord remains uncertain',()=>{
  const candidate=base('RECENT_VIDEO_DESCRIPTIONS','https://www.youtube.com/watch?v=one');
  const ownership=inferDiscordOwnership(candidate);
  assert.equal(ownership.ownershipStatus,'UNCERTAIN');
  assert.equal(ownership.ownershipConfidence,65);
});

test('repeated Discord across distinct creator videos becomes creator-owned',()=>{
  const first=base('RECENT_VIDEO_DESCRIPTIONS','https://www.youtube.com/watch?v=one');
  const second=base('RECENT_VIDEO_DESCRIPTIONS','https://www.youtube.com/watch?v=two');
  const merged=mergeDiscordCandidates([first,second]);
  assert.equal(merged.length,1);
  assert.equal(merged[0].ownershipStatus,'CREATOR_OWNED');
  assert.ok((merged[0].ownershipConfidence||0)>=75);
  assert.ok(merged[0].ownershipReasons?.includes('REPEATED_CREATOR_VIDEO_OBSERVATION'));
});

test('partner or sponsor provenance blocks creator-owned promotion',()=>{
  const candidate=base('CHANNEL_EXTERNAL_LINKS','https://www.youtube.com/@creator');
  const observation:DiscordCandidateObservation={
    sourceSurface:'CHANNEL_EXTERNAL_LINKS',
    sourceUrl:'https://www.youtube.com/@creator',
    sourcePageUrl:'https://www.youtube.com/@creator',
    sourceAnchorText:'Sponsored partner Discord',
    rawLocator:'https://discord.gg/trader-room',
    extractionConfidence:'EXPLICIT'
  };
  candidate.observations=[observation];
  const ownership=inferDiscordOwnership(candidate);
  assert.notEqual(ownership.ownershipStatus,'CREATOR_OWNED');
  assert.ok(ownership.ownershipReasons?.includes('PARTNER_OR_AFFILIATE_SURFACE'));
});
