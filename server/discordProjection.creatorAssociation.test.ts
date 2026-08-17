import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCreatorAssociationToDiscordValidation} from './discordProjection';
import {inferDiscordOwnership, makeDiscordCandidate} from './discordCandidates';

test('ACTIVE + UNCERTAIN creator Discord is promoted when parent is strongly trading-confirmed',()=>{
  const candidate=makeDiscordCandidate({
    locatorType:'NATIVE_INVITE',
    sourceSurface:'CHANNEL_EXTERNAL_LINKS',
    rawLocator:'https://discord.gg/trader-room',
    nativeInviteCode:'trader-room',
    normalizedLocator:'https://discord.gg/trader-room',
    sourceUrl:'https://www.youtube.com/@creator',
    extractionConfidence:'EXPLICIT'
  });
  Object.assign(candidate,inferDiscordOwnership(candidate));
  assert.equal(candidate.ownershipStatus,'CREATOR_OWNED');

  const projected=applyCreatorAssociationToDiscordValidation({
    trading_status:'TRADING_CONFIRMED',
    trading_confidence_score:100
  } as any,{
    status:'UNCERTAIN',
    confidence:53,
    inviteUrl:null,
    candidateInviteUrl:'https://discord.gg/trader-room',
    operationalOutcome:'SUCCEEDED',
    retryable:false,
    attempts:[],
    livenessStatus:'ACTIVE',
    relevanceStatus:'UNCERTAIN',
    resolutionStatus:'RESOLVED',
    validationStatus:'SUCCEEDED'
  });

  assert.equal(projected.relevanceStatus,'TRADING_RELEVANT');
  assert.equal(projected.status,'ACTIVE_LOW_VOLUME');
  assert.equal(projected.inviteUrl,'https://discord.gg/trader-room');
});

test('ACTIVE + UNCERTAIN third-party or ambiguous Discord is not promoted',()=>{
  const candidate=makeDiscordCandidate({
    locatorType:'NATIVE_INVITE',
    sourceSurface:'RECENT_VIDEO_DESCRIPTIONS',
    rawLocator:'https://discord.gg/sponsor-room',
    nativeInviteCode:'sponsor-room',
    normalizedLocator:'https://discord.gg/sponsor-room',
    sourceUrl:'https://www.youtube.com/watch?v=one',
    extractionConfidence:'EXPLICIT'
  });
  Object.assign(candidate,inferDiscordOwnership(candidate));
  assert.equal(candidate.ownershipStatus,'UNCERTAIN');

  const validation:any={
    status:'UNCERTAIN',confidence:53,inviteUrl:null,candidateInviteUrl:'https://discord.gg/sponsor-room',
    operationalOutcome:'SUCCEEDED',retryable:false,attempts:[],livenessStatus:'ACTIVE',relevanceStatus:'UNCERTAIN',
    resolutionStatus:'RESOLVED',validationStatus:'SUCCEEDED'
  };
  const projected=applyCreatorAssociationToDiscordValidation({trading_status:'TRADING_CONFIRMED',trading_confidence_score:100} as any,validation,candidate);
  assert.equal(projected.relevanceStatus,'UNCERTAIN');
  assert.equal(projected.inviteUrl,null);
});
