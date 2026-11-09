import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelRecord } from '../src/types';
import {
  shouldEnqueueDiscordEvidenceReclassification,
  validatedDiscordEvidenceInvite,
} from './discordEvidence';
import { DiscordProvider } from './evidenceEngine/providers/DiscordProvider';
import { enqueueDiscordEvidenceReclassification } from './queueManager';

const channel = (overrides: Partial<ChannelRecord> = {}): ChannelRecord => ({
  channel_id: 'UCbowie',
  channel_name: 'Trading With The Bowie',
  youtube_url: 'https://www.youtube.com/channel/UCbowie',
  country: '',
  country_status: 'UNCERTAIN',
  confidence_score: 0,
  discord_status: 'ACTIVE',
  discord_invite: 'https://discord.gg/9GqfAbpXrv',
  discord_validation_status: 'SUCCEEDED',
  discord_liveness_status: 'ACTIVE',
  discord_relevance_status: 'TRADING_RELEVANT',
  scan_status: 'ENRICHMENT_PENDING',
  scan_attempts: 0,
  discovery_source: 'automated_query',
  first_seen: '2026-11-08T01:18:16.353Z',
  last_checked: '2026-11-09T08:14:17.941Z',
  inspection_trail: [],
  subscriber_count: '193',
  trading_status: 'UNCERTAIN',
  ...overrides,
});

test('only fully validated trading-relevant invites become classifier evidence', () => {
  assert.equal(validatedDiscordEvidenceInvite(channel()), 'https://discord.gg/9GqfAbpXrv');
  for (const overrides of [
    { discord_validation_status: 'RETRY_PENDING' as const },
    { discord_liveness_status: 'NOT_CHECKED' as const },
    { discord_relevance_status: 'UNCERTAIN' as const },
    { discord_invite: null },
  ]) {
    assert.equal(validatedDiscordEvidenceInvite(channel(overrides)), undefined, JSON.stringify(overrides));
  }
});

test('Discord provider evaluates a stored validated invite instead of reporting NOT_APPLICABLE', async () => {
  const provider = new DiscordProvider();
  const input = {
    channel_id: channel().channel_id,
    channel_name: channel().channel_name,
    discord_invite: channel().discord_invite,
  };
  assert.deepEqual(provider.availability(input as any), { availability: 'AVAILABLE' });
  const evidence = await provider.collectEvidence(input as any, {} as any);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].source, 'discord_metadata');
  assert.equal(evidence[0].polarity, 'POSITIVE');
  assert.match(evidence[0].fact, /9GqfAbpXrv/);
});

test('Discord evidence alone requests a bounded pass only while unconfirmed and idle', () => {
  assert.equal(shouldEnqueueDiscordEvidenceReclassification({
    tradingStatus: 'UNCERTAIN', invite: 'https://discord.gg/x', hasActiveClassificationJob: false,
  }), true);
  assert.equal(shouldEnqueueDiscordEvidenceReclassification({
    tradingStatus: 'TRADING_CONFIRMED', invite: 'https://discord.gg/x', hasActiveClassificationJob: false,
  }), false);
  assert.equal(shouldEnqueueDiscordEvidenceReclassification({
    tradingStatus: 'UNCERTAIN', invite: 'https://discord.gg/x', hasActiveClassificationJob: true,
  }), false);
  assert.equal(shouldEnqueueDiscordEvidenceReclassification({
    tradingStatus: 'UNCERTAIN', invite: undefined, hasActiveClassificationJob: false,
  }), false);
});

test('Discord reclassification enqueues one day-scoped pass when a validated invite is stored', async () => {
  assert.equal(validatedDiscordEvidenceInvite(channel()), 'https://discord.gg/9GqfAbpXrv');
  let captured: { type: string; payload: any; opts: any } | undefined;
  const ok = await enqueueDiscordEvidenceReclassification(channel(), undefined, {
    hasActiveClassificationJob: async () => false,
    db: { query: async () => ({ rows: [{ target_country: 'Netherlands' }] }) },
    checkCountryAllowed: async () => undefined,
    enqueue: async (type, payload, opts) => {
      captured = { type, payload, opts };
      return { status: 'PENDING' };
    },
    config: { priority: 15, maxAttempts: 4 },
  });
  assert.equal(ok, true);
  assert.equal(captured?.type, 'CLASSIFY_DISCOVERED_CHANNEL');
  assert.equal(captured?.payload.targetCountry, 'Netherlands');
  assert.equal(captured?.payload.candidate.channelId, 'UCbowie');
  assert.equal(captured?.payload.forceClassification, true);
  assert.match(String(captured?.opts.idempotencyKey), /^discord-classify:UCbowie:\d{4}-\d{2}-\d{2}$/);
  assert.equal(captured?.opts.preventReopen, true);
});

test('Discord reclassification skips when no retrieval target or the target is excluded', async () => {
  let enqueued = 0;
  const baseDeps = {
    hasActiveClassificationJob: async () => false,
    enqueue: async () => { enqueued += 1; return { status: 'PENDING' }; },
    config: { priority: 15, maxAttempts: 4 },
  };
  assert.equal(await enqueueDiscordEvidenceReclassification(channel(), undefined, {
    ...baseDeps,
    db: { query: async () => ({ rows: [] }) },
    checkCountryAllowed: async () => undefined,
  }), false, 'creator country must not substitute for retrieval context');
  assert.equal(await enqueueDiscordEvidenceReclassification(channel(), undefined, {
    ...baseDeps,
    db: { query: async () => ({ rows: [{ target_country: 'Excluded' }] }) },
    checkCountryAllowed: async () => { throw new Error('excluded country'); },
  }), false);
  assert.equal(enqueued, 0);
});

test('confirmed channels and active classifications never get a Discord reclassification job', async () => {
  let enqueued = 0;
  const deps = {
    db: { query: async () => ({ rows: [{ target_country: 'Netherlands' }] }) },
    enqueue: async () => { enqueued += 1; return { status: 'PENDING' }; },
    config: { priority: 15, maxAttempts: 4 },
  };
  assert.equal(await enqueueDiscordEvidenceReclassification(channel({ trading_status: 'TRADING_CONFIRMED' }), undefined, {
    ...deps, hasActiveClassificationJob: async () => false,
  }), false);
  assert.equal(await enqueueDiscordEvidenceReclassification(channel(), undefined, {
    ...deps, hasActiveClassificationJob: async () => true,
  }), false);
  assert.equal(enqueued, 0);
});
