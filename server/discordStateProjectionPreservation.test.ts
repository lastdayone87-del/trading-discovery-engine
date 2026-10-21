import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDiscordCandidate } from './discordCandidates';
import {
  canProjectDiscordValidation,
  hasEstablishedValidatedDiscordSelection,
  projectDiscordValidation,
  projectTradingReclassificationDiscordState,
  reconcileDiscordDiscoveryFromInspection,
} from './discordProjection';
import type { DiscordValidationResult } from './discordValidator';
import { buildChannelListingWhere, CONFIRMED_DISCORD_INVITE_SQL } from './db';
import { isConfirmedDiscordInvite } from '../src/discordInviteView';

const VALID_CODE = 'aHJH5Zuxgb';
const VALID_URL = `https://discord.gg/${VALID_CODE}`;
const INVALID_CODE = 'RuhggKuW';
const INVALID_URL = `https://discord.gg/${INVALID_CODE}`;
const NEW_VALID_CODE = 'Bjm4dEeveq';
const NEW_VALID_URL = `https://discord.gg/${NEW_VALID_CODE}`;

const candidateFor = (code: string, sourceSurface: 'CREATOR_WEBSITES' | 'RECENT_VIDEO_DESCRIPTIONS' = 'CREATOR_WEBSITES') =>
  makeDiscordCandidate({
    locatorType: 'NATIVE_INVITE',
    sourceSurface,
    rawLocator: `https://discord.com/invite/${code}`,
    nativeInviteCode: code,
    normalizedLocator: `https://discord.gg/${code.toLowerCase()}`,
    sourceUrl: 'https://www.youtube.com/channel/UCBW5wxHVa0pyrR_wpRUBn4Q',
    extractionConfidence: 'EXPLICIT',
  });

const validCandidate = candidateFor(VALID_CODE);
const invalidCandidate = candidateFor(INVALID_CODE);
const newValidCandidate = candidateFor(NEW_VALID_CODE, 'RECENT_VIDEO_DESCRIPTIONS');

const cbrackn = (overrides: Record<string, unknown> = {}) => ({
  channel_id: 'UCBW5wxHVa0pyrR_wpRUBn4Q',
  channel_name: 'cbrackn',
  youtube_url: 'https://www.youtube.com/channel/UCBW5wxHVa0pyrR_wpRUBn4Q',
  country: 'United States',
  country_status: 'CONFIRMED',
  confidence_score: 95,
  trading_status: 'TRADING_CONFIRMED',
  trading_confidence_score: 96,
  discord_status: 'ACTIVE',
  discord_invite: VALID_URL,
  discord_candidate_id: validCandidate.candidateId,
  discord_candidate_locator: VALID_URL,
  discord_candidate_raw_locator: `https://discord.com/invite/${VALID_CODE}`,
  discord_candidate_type: 'NATIVE_INVITE',
  discord_resolution_status: 'RESOLVED',
  discord_liveness_status: 'ACTIVE',
  discord_relevance_status: 'TRADING_RELEVANT',
  discord_validation_status: 'COMPLETED',
  discord_discovery_status: 'VALIDATED',
  discord_duplicate_owner_channel_id: null,
  scan_status: 'COMPLETED',
  scan_attempts: 0,
  first_seen: '2026-10-09T19:59:17.345Z',
  last_checked: '2026-10-21T00:31:09.650Z',
  ...overrides,
});

const validation = (overrides: Partial<DiscordValidationResult>): DiscordValidationResult => ({
  status: 'ACTIVE',
  confidence: 95,
  inviteUrl: VALID_URL,
  candidateInviteUrl: VALID_URL,
  operationalOutcome: 'SUCCEEDED',
  retryable: false,
  attempts: [],
  livenessStatus: 'ACTIVE',
  relevanceStatus: 'TRADING_RELEVANT',
  resolutionStatus: 'RESOLVED',
  validationStatus: 'COMPLETED',
  ...overrides,
});

const invalidSelectedValidation = validation({
  status: 'DEAD',
  inviteUrl: null,
  candidateInviteUrl: INVALID_URL,
  operationalOutcome: 'CONFIRMED_INVALID',
  livenessStatus: 'DEAD',
  relevanceStatus: 'NOT_CHECKED',
  validationStatus: 'COMPLETED',
});

test('cbrackn: a validated ACTIVE invite survives a later UNCERTAIN trading reclassification', () => {
  const original = cbrackn() as any;
  const reclassified = {
    ...cbrackn(),
    trading_status: 'UNCERTAIN',
    scan_status: 'ENRICHMENT_PENDING',
    last_checked: '2026-10-21T01:03:09.000Z',
  } as any;

  Object.assign(reclassified, projectTradingReclassificationDiscordState(original));

  assert.equal((reclassified as any).discord_status, 'ACTIVE');
  assert.equal((reclassified as any).discord_invite, VALID_URL);
  assert.equal((reclassified as any).discord_candidate_id, validCandidate.candidateId);
  assert.equal((reclassified as any).discord_liveness_status, 'ACTIVE');
  assert.equal((reclassified as any).discord_validation_status, 'COMPLETED');
  assert.equal((reclassified as any).discord_discovery_status, 'VALIDATED');
  assert.equal(hasEstablishedValidatedDiscordSelection(original), true);
});

test('cbrackn: a later inspection containing only RuhggKuW cannot replace the live aHJH5Zuxgb invite', () => {
  const reclassified = cbrackn({ trading_status: 'UNCERTAIN', discord_status: 'UNCERTAIN' }) as any;
  assert.equal(hasEstablishedValidatedDiscordSelection(reclassified), true, 'validation identity is independent of the mutable top-level status');
  assert.equal(canProjectDiscordValidation(reclassified, invalidSelectedValidation, invalidCandidate), false);

  const afterRetry = { ...reclassified } as any;
  if (canProjectDiscordValidation(afterRetry, invalidSelectedValidation, invalidCandidate)) {
    Object.assign(afterRetry, projectDiscordValidation(afterRetry, invalidSelectedValidation, invalidCandidate));
  }

  assert.equal(afterRetry.discord_invite, VALID_URL);
  assert.equal(afterRetry.discord_candidate_id, validCandidate.candidateId);
  assert.equal(afterRetry.discord_liveness_status, 'ACTIVE');
  assert.equal(afterRetry.discord_validation_status, 'COMPLETED');
  assert.notEqual(afterRetry.discord_status, 'DEAD');
});

test('cbrackn: a genuinely dead selected invite can still transition to DEAD', () => {
  const channel = cbrackn({ trading_status: 'UNCERTAIN', discord_status: 'UNCERTAIN' }) as any;
  const sameSelectedDead = validation({
    status: 'DEAD',
    inviteUrl: null,
    candidateInviteUrl: VALID_URL,
    operationalOutcome: 'CONFIRMED_INVALID',
    livenessStatus: 'DEAD',
    relevanceStatus: 'NOT_CHECKED',
    validationStatus: 'COMPLETED',
  });

  assert.equal(canProjectDiscordValidation(channel, sameSelectedDead, validCandidate), true);
  Object.assign(channel, projectDiscordValidation(channel, sameSelectedDead, validCandidate));

  assert.equal((channel as any).discord_status, 'DEAD');
  assert.equal((channel as any).discord_invite, null);
  assert.equal((channel as any).discord_candidate_id, validCandidate.candidateId);
  assert.equal((channel as any).discord_validation_status, 'COMPLETED');
});

test('a new valid candidate can still be selected normally after the reclassification', () => {
  const channel = cbrackn({ trading_status: 'UNCERTAIN', discord_status: 'UNCERTAIN' }) as any;
  const newValid = validation({
    status: 'ACTIVE',
    inviteUrl: NEW_VALID_URL,
    candidateInviteUrl: NEW_VALID_URL,
  });

  assert.equal(canProjectDiscordValidation(channel, newValid, newValidCandidate), true);
  Object.assign(channel, projectDiscordValidation(channel, newValid, newValidCandidate));

  assert.equal((channel as any).discord_status, 'ACTIVE');
  assert.equal((channel as any).discord_invite, NEW_VALID_URL);
  assert.equal((channel as any).discord_candidate_id, newValidCandidate.candidateId);
  assert.equal((channel as any).discord_discovery_status, 'VALIDATED');
});

test('dashboard count, active filter, recent-confirmed filter, and selected candidate stay consistent', () => {
  const channel = cbrackn() as any;
  assert.equal(isConfirmedDiscordInvite(channel), true);
  assert.equal(['ACTIVE', 'ACTIVE_LOW_VOLUME'].includes(channel.discord_status), true);

  const where = buildChannelListingWhere(
    { predicate: 'TRUE', scope: 'TEST' },
    { includeRejected: false, diagnosticsOnly: false, discordStatus: 'ACTIVE', recentInvites: true },
  );
  assert.match(where.where, /discord_status=\$1/);
  assert.match(where.where, /discord_duplicate_owner_channel_id IS NULL/);
  assert.deepEqual(where.values, ['ACTIVE']);
  assert.match(CONFIRMED_DISCORD_INVITE_SQL, /discord_validation_status IN \('SUCCEEDED','COMPLETED'\)/);
  assert.match(CONFIRMED_DISCORD_INVITE_SQL, /discord_liveness_status='ACTIVE'/);

  const dbCore = readFileSync(fileURLToPath(new URL('./dbCore.ts', import.meta.url)), 'utf8');
  assert.match(dbCore, /COUNT\(\*\) FILTER\(WHERE discord_status IN\('ACTIVE','ACTIVE_LOW_VOLUME'\)\)::int active_discords/);
  assert.match(dbCore, /discord_status IN \('ACTIVE','ACTIVE_LOW_VOLUME','NON_TRADING'\)/);
});

test('failed or partial reconcile does not downgrade a completed established validation', () => {
  const channel = cbrackn({
    discord_status: 'ACTIVE',
    trading_status: 'UNCERTAIN',
    discord_validation_status: 'COMPLETED',
  }) as any;
  const otherCandidate = candidateFor('otherCode');

  reconcileDiscordDiscoveryFromInspection(channel, {
    foundInvite: 'otherCode',
    discordCandidates: [otherCandidate],
    steps: [{ status: 'FOUND', detectedInvite: 'otherCode' }],
  }, { validationProjected: false });

  assert.equal(channel.discord_status, 'ACTIVE');
  assert.equal(channel.discord_invite, VALID_URL);
  assert.equal(channel.discord_candidate_id, validCandidate.candidateId);
  assert.equal(channel.discord_candidate_locator, VALID_URL);
  assert.equal(channel.discord_liveness_status, 'ACTIVE');
  assert.equal(channel.discord_validation_status, 'COMPLETED');
  assert.equal(channel.discord_discovery_status, 'VALIDATED');
});

test('pipeline and queue delegate Discord preservation to the shared guards', () => {
  const pipeline = readFileSync(fileURLToPath(new URL('./ingestionPipeline.ts', import.meta.url)), 'utf8');
  const queue = readFileSync(fileURLToPath(new URL('./queueManager.ts', import.meta.url)), 'utf8');

  assert.match(pipeline, /preservedDiscordState=existing&&hasEstablishedValidatedDiscordSelection\(existing\)/);
  assert.match(pipeline, /uncertainChannel\.discord_status = preservedDiscordState\?\.discord_status \?\? 'UNCERTAIN'/);
  assert.doesNotMatch(pipeline, /uncertainChannel\.discord_status = 'UNCERTAIN';/);
  assert.match(pipeline, /withheldChannel\.discord_status=preservedDiscordState\?\.discord_status\?\?'UNCERTAIN'/);

  assert.match(queue, /const shouldProjectValidation=canProjectDiscordValidation\(channel,selected,selectedCandidate\);/);
  assert.match(queue, /if\(shouldProjectValidation\)\{Object\.assign\(channel,projectDiscordValidation\(channel,selected,selectedCandidate\)\);await selectDiscordCandidate\(channel\.channel_id,selectedCandidate\.candidateId\);\}/);
  assert.doesNotMatch(queue, /channel\.discord_discovery_status==='VALIDATED'&&\(channel\.discord_status==='ACTIVE'\|\|channel\.discord_status==='DEAD'\)/);
});
