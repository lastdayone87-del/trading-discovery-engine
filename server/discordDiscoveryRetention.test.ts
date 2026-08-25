import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidateFromNativeInvite, extractDiscordCandidates } from './discordCandidates';
import { projectDiscordValidation, reconcileDiscordDiscoveryFromInspection } from './discordProjection';

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
  // Log prose alone must not be required for retention (anti-pattern regression).
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
  const channel: any = {
    discord_status: 'PENDING',
    discord_invite: null,
    discord_candidate_id: null
  };
  const candidate: any = {
    candidateId: 'cand-1',
    rawLocator: 'https://discord.gg/live',
    locatorType: 'NATIVE_INVITE',
    nativeInviteCode: 'live'
  };
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
  const candidate: any = {
    candidateId: 'x',
    rawLocator: 'https://discord.gg/dead',
    locatorType: 'NATIVE_INVITE'
  };
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
  assert.match(source, /isDiscordCommunityAcquisitionSurface/);
  assert.match(source, /effectiveAcquisitionOutcomes/);
});

test('queueManager treats structured candidates as discovery truth independent of foundInvite alone', () => {
  const source = readFileSync('server/queueManager.ts', 'utf8');
  assert.match(source, /structuredCandidates/);
  assert.match(source, /discoveredInvite/);
  assert.match(source, /Structured candidates are authoritative for discovery/);
  assert.match(source, /reconcileDiscordDiscoveryFromInspection/);
  // Catch path must reconcile even when validation throws after discovery.
  const catchIdx = source.indexOf('} catch (err)');
  assert.ok(catchIdx > 0);
  assert.match(source.slice(catchIdx, catchIdx + 900), /reconcileDiscordDiscoveryFromInspection/);
});

test('candidateFromNativeInvite rejects reserved and invalid codes', () => {
  assert.equal(candidateFromNativeInvite({ nativeInviteCode: 'invite', sourceSurface: 'YOUTUBE_ABOUT' }), null);
  assert.equal(candidateFromNativeInvite({ nativeInviteCode: 'a', sourceSurface: 'YOUTUBE_ABOUT' }), null);
  assert.ok(candidateFromNativeInvite({ nativeInviteCode: 'ValidCode99', sourceSurface: 'YOUTUBE_ABOUT' }));
});

test('synthetic Rique-class: structured website discovery must not depend on log prose', () => {
  // Crawl surfaces historically returned foundInvite while log prose lacked a
  // parseable native URL; structured retention must still produce a candidate.
  const structured = candidateFromNativeInvite({
    nativeInviteCode: 'riqueCode',
    sourceSurface: 'CREATOR_WEBSITES',
    sourceUrl: 'https://rique.example',
    extractionConfidence: 'RESOLVED'
  });
  assert.ok(structured);
  assert.equal(structured!.nativeInviteCode, 'riqueCode');
  const proseOnly = extractDiscordCandidates(
    'Discord invite found! [Crawling] https://rique.example\nSuccessfully loaded page',
    'CREATOR_WEBSITES',
    'https://rique.example'
  );
  assert.equal(proseOnly.filter(c => c.nativeInviteCode).length, 0);
});

test('synthetic ALTI-class: discovery and validation stay separated on projection', () => {
  const channel: any = {
    discord_status: 'PENDING',
    discord_invite: null,
    discord_candidate_locator: null
  };
  const candidate = candidateFromNativeInvite({
    nativeInviteCode: 'altiRoom',
    sourceSurface: 'YOUTUBE_ABOUT',
    sourceUrl: 'https://youtube.com/channel/alti'
  })!;
  const result: any = {
    status: 'UNCERTAIN',
    inviteUrl: null,
    candidateInviteUrl: 'https://discord.gg/altiRoom',
    operationalOutcome: 'INVALID_OBSERVED',
    resolutionStatus: 'RESOLVED',
    livenessStatus: 'INVALID_OBSERVED',
    relevanceStatus: 'NOT_CHECKED',
    validationStatus: 'RETRY_PENDING'
  };
  const projected = projectDiscordValidation(channel, result, candidate);
  assert.equal(projected.discord_discovery_status, 'DISCOVERED_VALIDATION_FAILED');
  assert.notEqual(projected.discord_status, 'NOT_FOUND');
  assert.equal(projected.discord_candidate_locator, 'https://discord.gg/altiRoom');
});

test('historical NOT_FOUND + current FOUND + validation throw path must leave discovered state', () => {
  const channel: any = {
    discord_status: 'NOT_FOUND',
    discord_discovery_status: 'NOT_DISCOVERED',
    discord_invite: null,
    discord_candidate_locator: null,
    discord_validation_status: 'COMPLETED',
    discord_liveness_status: 'NOT_CHECKED',
    discord_resolution_status: 'NOT_ATTEMPTED'
  };
  const structured = candidateFromNativeInvite({
    nativeInviteCode: 'rescued',
    sourceSurface: 'CREATOR_WEBSITES',
    sourceUrl: 'https://example.com'
  });
  const inspection = {
    foundInvite: 'rescued',
    discordCandidates: structured ? [structured] : [],
    steps: [{ status: 'FOUND', detectedInvite: 'rescued', details: 'Discord invite found' }]
  };
  reconcileDiscordDiscoveryFromInspection(channel, inspection, { validationProjected: false });
  assert.notEqual(channel.discord_status, 'NOT_FOUND');
  assert.equal(channel.discord_discovery_status, 'DISCOVERED_VALIDATION_FAILED');
  assert.ok(channel.discord_candidate_locator);
  assert.equal(channel.discord_validation_status, 'RETRY_PENDING');
});

test('brand-new channel + current FOUND + validation throw: same non-absence outcome', () => {
  const channel: any = {
    discord_status: 'PENDING',
    discord_discovery_status: null,
    discord_invite: null,
    discord_candidate_locator: null
  };
  const structured = candidateFromNativeInvite({
    nativeInviteCode: 'brandNew',
    sourceSurface: 'YOUTUBE_ABOUT'
  });
  reconcileDiscordDiscoveryFromInspection(channel, {
    foundInvite: 'brandNew',
    discordCandidates: structured ? [structured] : [],
    steps: [{ status: 'FOUND', detectedInvite: 'brandNew' }]
  }, { validationProjected: false });
  assert.equal(channel.discord_status, 'UNCERTAIN');
  assert.equal(channel.discord_discovery_status, 'DISCOVERED_VALIDATION_FAILED');
  assert.ok(channel.discord_candidate_locator);
});

test('complete inspection with zero candidates still yields legitimate NOT_FOUND path', () => {
  const channel: any = {
    discord_status: 'NOT_FOUND',
    discord_discovery_status: 'NOT_DISCOVERED',
    discord_invite: null,
    discord_candidate_locator: null
  };
  reconcileDiscordDiscoveryFromInspection(channel, {
    foundInvite: null,
    discordCandidates: [],
    steps: [
      { status: 'NOT_FOUND', details: 'No invite in bio' },
      { status: 'NOT_FOUND', details: 'No invite in links' }
    ]
  }, { validationProjected: false });
  assert.equal(channel.discord_status, 'NOT_FOUND');
  assert.equal(channel.discord_discovery_status, 'NOT_DISCOVERED');
  assert.equal(channel.discord_candidate_locator, null);
});

test('completed NOT_FOUND is not reopened by text-only Discord trail evidence', () => {
  const channel: any = {
    discord_status: 'NOT_FOUND',
    discord_discovery_status: 'NOT_DISCOVERED',
    discord_candidate_locator: null,
    discord_validation_status: 'COMPLETED',
    discord_liveness_status: 'NOT_CHECKED',
    discord_resolution_status: 'NOT_ATTEMPTED'
  };
  reconcileDiscordDiscoveryFromInspection(channel, {
    foundInvite: null,
    discordCandidates: [],
    steps: [{ status: 'FOUND', details: 'Discord link was considered but no structured candidate was retained' }]
  }, { validationProjected: false });
  assert.equal(channel.discord_status, 'NOT_FOUND');
  assert.equal(channel.discord_discovery_status, 'NOT_DISCOVERED');
  assert.equal(channel.discord_validation_status, 'COMPLETED');
  assert.equal(channel.discord_resolution_status, 'NOT_ATTEMPTED');
});

test('existing validated ACTIVE candidate is not downgraded by error-path reconcile', () => {
  const channel: any = {
    discord_status: 'ACTIVE',
    discord_discovery_status: 'VALIDATED',
    discord_invite: 'https://discord.gg/liveServing',
    discord_candidate_locator: 'https://discord.gg/liveServing',
    discord_validation_status: 'SUCCEEDED',
    discord_liveness_status: 'ACTIVE'
  };
  const structured = candidateFromNativeInvite({
    nativeInviteCode: 'otherCode',
    sourceSurface: 'YOUTUBE_ABOUT'
  });
  reconcileDiscordDiscoveryFromInspection(channel, {
    foundInvite: 'otherCode',
    discordCandidates: structured ? [structured] : [],
    steps: [{ status: 'FOUND', detectedInvite: 'otherCode' }]
  }, { validationProjected: false });
  assert.equal(channel.discord_status, 'ACTIVE');
  assert.equal(channel.discord_discovery_status, 'VALIDATED');
  assert.equal(channel.discord_invite, 'https://discord.gg/liveServing');
  assert.equal(channel.discord_candidate_locator, 'https://discord.gg/liveServing');
});

test('candidate locator and provenance survive failure path when structured candidates present', () => {
  const channel: any = {
    discord_status: 'NOT_FOUND',
    discord_discovery_status: 'NOT_DISCOVERED',
    discord_candidate_locator: null
  };
  const structured = candidateFromNativeInvite({
    nativeInviteCode: 'persistMe',
    sourceSurface: 'CREATOR_WEBSITES',
    sourceUrl: 'https://creator.test',
    rawLocator: 'https://creator.test'
  });
  reconcileDiscordDiscoveryFromInspection(channel, {
    foundInvite: 'persistMe',
    discordCandidates: structured ? [structured] : [],
    steps: [{ status: 'FOUND', detectedInvite: 'persistMe' }]
  }, { validationProjected: false });
  assert.ok(channel.discord_candidate_locator);
  assert.equal(channel.discord_candidate_id, structured!.candidateId);
  assert.equal(channel.discord_candidate_raw_locator, structured!.rawLocator);
  assert.equal(channel.discord_candidate_type, 'NATIVE_INVITE');
});

test('success-path projection VALIDATED is not undone by subsequent reconcile', () => {
  const channel: any = {
    discord_status: 'NOT_FOUND',
    discord_discovery_status: 'NOT_DISCOVERED',
    discord_invite: null
  };
  const candidate = candidateFromNativeInvite({
    nativeInviteCode: 'okRoom',
    sourceSurface: 'YOUTUBE_ABOUT'
  })!;
  const validation: any = {
    status: 'ACTIVE',
    inviteUrl: 'https://discord.gg/okRoom',
    candidateInviteUrl: 'https://discord.gg/okRoom',
    operationalOutcome: 'SUCCEEDED',
    resolutionStatus: 'RESOLVED',
    livenessStatus: 'ACTIVE',
    relevanceStatus: 'UNCERTAIN',
    validationStatus: 'SUCCEEDED'
  };
  Object.assign(channel, projectDiscordValidation(channel, validation, candidate));
  reconcileDiscordDiscoveryFromInspection(channel, {
    discordCandidates: [candidate],
    foundInvite: 'okRoom',
    steps: [{ status: 'FOUND', detectedInvite: 'okRoom' }]
  }, { validationProjected: true });
  assert.equal(channel.discord_status, 'ACTIVE');
  assert.equal(channel.discord_discovery_status, 'VALIDATED');
  assert.equal(channel.discord_invite, 'https://discord.gg/okRoom');
});
