import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidateFromNativeInvite, extractDiscordCandidates } from './discordCandidates';
import { projectDiscordValidation } from './discordProjection';

test('structured native invite candidate is retained without log-prose reparse', () => {
  const structured = candidateFromNativeInvite({
    nativeInviteCode: '8i7rSxaaW6',
    sourceSurface: 'CREATOR_WEBSITES',
    sourceUrl: 'https://example-creator.example',
    extractionConfidence: 'RESOLVED'
  });
  assert.ok(structured);
  assert.equal(structured!.nativeInviteCode, '8i7rSxaaW6');
  assert.equal(structured!.normalizedLocator, 'https://discord.gg/8i7rSxaaW6');
  const fromLogOnly = extractDiscordCandidates(
    'Discord invite extracted from page HTML payload (Invite: 8i7rSxaaW6)',
    'CREATOR_WEBSITES',
    'https://example-creator.example'
  );
  assert.equal(fromLogOnly.filter(c => c.nativeInviteCode).length, 0);
});

test('bio and external-link surfaces extract deterministic native candidates', () => {
  const bio = extractDiscordCandidates('Join us at https://discord.gg/bioCode99 for signals', 'YOUTUBE_ABOUT');
  assert.ok(bio.some(c => c.nativeInviteCode === 'bioCode99'));
  const links = extractDiscordCandidates('https://discord.com/invite/linkCode88', 'CHANNEL_EXTERNAL_LINKS', 'https://discord.com/invite/linkCode88');
  assert.ok(links.some(c => c.nativeInviteCode === 'linkCode88'));
  const video = extractDiscordCandidates('Community: discord.gg/vidCode77', 'RECENT_VIDEO_DESCRIPTIONS');
  assert.ok(video.some(c => c.nativeInviteCode === 'vidCode77'));
});

test('duplicate invite representations collapse to one candidate identity space', () => {
  const a = extractDiscordCandidates('https://discord.gg/SameCode1', 'YOUTUBE_ABOUT');
  const b = extractDiscordCandidates('https://discord.com/invite/SameCode1', 'CHANNEL_EXTERNAL_LINKS');
  assert.equal(a[0]?.nativeInviteCode, b[0]?.nativeInviteCode);
});

test('validation retry failure preserves discovery and does not project absence', () => {
  const channel: any = { discord_status: 'PENDING', discord_invite: null, discord_candidate_id: null };
  const candidate: any = { candidateId: 'cand-1', rawLocator: 'https://discord.gg/live', locatorType: 'NATIVE_INVITE', nativeInviteCode: 'live' };
  const result: any = {
    status: 'UNCERTAIN',
    inviteUrl: null,
    candidateInviteUrl: 'https://discord.gg/live',
    operationalOutcome: 'INVALID_OBSERVED',
    resolutionStatus: 'RESOLVED',
    livenessStatus: 'INVALID_OBSERVED',
    relevanceStatus: 'NOT_CHECKED',
    validationStatus: 'RETRY_PENDING'
  };
  const projected = projectDiscordValidation(channel, result, candidate);
  assert.notEqual(projected.discord_status, 'NOT_FOUND');
  assert.equal(projected.discord_discovery_status, 'DISCOVERED_VALIDATION_FAILED');
  assert.equal(projected.discord_validation_status, 'RETRY_PENDING');
});

test('confirmed invalid remains explicit and is not absence', () => {
  const channel: any = { discord_status: 'PENDING', discord_invite: null };
  const candidate: any = { candidateId: 'x', rawLocator: 'https://discord.gg/dead', locatorType: 'NATIVE_INVITE' };
  const result: any = {
    status: 'DEAD',
    inviteUrl: null,
    candidateInviteUrl: 'https://discord.gg/dead',
    operationalOutcome: 'CONFIRMED_INVALID',
    resolutionStatus: 'RESOLVED',
    livenessStatus: 'DEAD',
    relevanceStatus: 'NOT_CHECKED',
    validationStatus: 'COMPLETED'
  };
  const projected = projectDiscordValidation(channel, result, candidate);
  assert.equal(projected.discord_status, 'DEAD');
  assert.notEqual(projected.discord_status, 'NOT_FOUND');
  assert.equal(projected.discord_discovery_status, 'VALIDATED');
});

test('inspector uses structured crawl retention and avoids post-FOUND NOT_FOUND bookkeeping', () => {
  const source = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  assert.match(source, /candidateFromNativeInvite/);
  assert.match(source, /Structured crawl result is authoritative/);
  assert.match(source, /websiteFound/);
  assert.match(source, /socialFound/);
  assert.match(source, /if\(!websiteFound\)/);
  assert.match(source, /if\(!socialFound\)/);
});

test('queueManager treats structured candidates as discovery truth independent of foundInvite alone', () => {
  const source = readFileSync('server/queueManager.ts', 'utf8');
  assert.match(source, /structuredCandidates/);
  assert.match(source, /discoveredInvite/);
  assert.match(source, /Structured candidates are authoritative for discovery/);
});
