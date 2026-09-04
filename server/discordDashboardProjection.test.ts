import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { projectDiscordValidation } from './discordProjection';
import { candidateFromNativeInvite } from './discordCandidates';

const uncertainResult: any = {
  status: 'UNCERTAIN',
  confidence: 40,
  inviteUrl: null,
  candidateInviteUrl: 'https://discord.gg/retained1',
  operationalOutcome: 'RATE_LIMITED',
  retryable: true,
  attempts: [],
  livenessStatus: 'UNCERTAIN',
  relevanceStatus: 'NOT_CHECKED',
  resolutionStatus: 'RESOLVED',
  validationStatus: 'RETRY_PENDING'
};

test('uncertain validation retains the discovered locator without projecting an invite', () => {
  const channel: any = {
    discord_status: 'UNCERTAIN',
    discord_invite: null,
    discord_candidate_locator: null,
    discord_validation_status: 'NOT_STARTED'
  };
  const candidate = candidateFromNativeInvite({
    nativeInviteCode: 'retained1',
    sourceSurface: 'RECENT_VIDEO_DESCRIPTIONS',
    sourceUrl: 'youtube:channel:UC1:VIDEO_1_DESCRIPTION'
  })!;
  const projected = projectDiscordValidation(channel, uncertainResult, candidate);
  assert.equal(projected.discord_candidate_locator, 'https://discord.gg/retained1');
  assert.equal(projected.discord_invite, null);
  assert.equal(projected.discord_discovery_status, 'DISCOVERED_VALIDATION_FAILED');
  assert.notEqual(projected.discord_status, 'ACTIVE');
});

test('a second uncertain validation never erases the retained locator', () => {
  const channel: any = {
    discord_status: 'UNCERTAIN',
    discord_invite: null,
    discord_candidate_locator: 'https://discord.gg/retained1',
    discord_candidate_id: 'prior',
    discord_validation_status: 'RETRY_PENDING',
    discord_liveness_status: 'UNCERTAIN'
  };
  const candidate = candidateFromNativeInvite({
    nativeInviteCode: 'retained1',
    sourceSurface: 'RECENT_VIDEO_DESCRIPTIONS',
    sourceUrl: 'youtube:channel:UC1:VIDEO_1_DESCRIPTION'
  })!;
  const projected = projectDiscordValidation(channel, uncertainResult, candidate);
  assert.equal(projected.discord_candidate_locator, 'https://discord.gg/retained1');
  assert.equal(projected.discord_invite, null);
});

test('dashboard exposes the retained locator without requiring ACTIVE liveness', () => {
  const table = readFileSync(new URL('../src/components/ResultsTable.tsx', import.meta.url), 'utf8');
  assert.match(table, /Discovered candidate:/);
  assert.match(
    table,
    /c\.discord_candidate_locator && !c\.discord_invite && c\.discord_liveness_status !== 'ACTIVE'/
  );
  assert.match(table, /Discovered · validation failed/);
});
