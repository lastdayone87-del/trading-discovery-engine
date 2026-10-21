import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChannelRecord, CommunityIntentEvidence } from '../src/types';

// ResultsTable reads reviewer defaults from localStorage during render. This is
// a server-rendering test for the dashboard cell, not a browser test.
const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, String(value)); },
  removeItem: (key: string) => { memory.delete(key); },
  clear: () => { memory.clear(); },
  key: () => null,
  get length() { return memory.size; },
};

const now = '2026-10-19T12:00:00.000Z';
const paidIntent: CommunityIntentEvidence = {
  communityPlatform: 'WHOP',
  communityUrl: 'https://www.whop.com/creator',
  intent: 'PAID',
  paidSignals: ['price', 'membership'],
  privateSignals: ['members-only'],
  observedAt: now,
  sourcePageUrl: 'https://creator.test/',
  extractionConfidence: 'EXPLICIT',
};

const channel = (overrides: Partial<ChannelRecord>): ChannelRecord => ({
  channel_id: 'community-intent-rendering',
  channel_name: 'Creator One',
  youtube_url: 'https://youtube.com/@creatorone',
  country: 'United States',
  country_status: 'CONFIRMED',
  scope_eligibility: 'IN_SCOPE',
  confidence_score: 90,
  discord_status: 'NOT_FOUND',
  discord_invite: null,
  discord_discovery_status: 'NOT_DISCOVERED',
  discord_validation_status: 'COMPLETED',
  discord_resolution_status: 'NOT_ATTEMPTED',
  discord_liveness_status: 'NOT_CHECKED',
  discord_relevance_status: 'NOT_CHECKED',
  community_discovery_status: 'NONE',
  community_intents: null,
  scan_status: 'COMPLETED',
  scan_attempts: 0,
  discovery_source: 'automated_query',
  first_seen: now,
  last_checked: now,
  subscriber_count: '1000',
  quality_score: 80,
  trading_status: 'TRADING_CONFIRMED',
  trading_confidence_score: 90,
  trading_category: 'Trading',
  country_metadata_status: 'AVAILABLE_NOT_DECLARED',
  country_metadata_checked_at: now,
  latest_upload_at: now,
  uploads_last_30_days: 1,
  uploads_last_90_days: 1,
  uploads_last_365_days: 1,
  activity_band: 'ACTIVE',
  activity_score: 80,
  activity_observed_at: now,
  inspection_trail: [],
  ...overrides,
});

async function renderChannels(input: ChannelRecord[]): Promise<string> {
  const { ResultsTable } = await import('../src/components/ResultsTable');
  return renderToStaticMarkup(React.createElement(ResultsTable, {
    channels: input,
    onRecheck: async () => {},
    onInspect: () => {},
  }));
}

async function renderDashboard(input: ChannelRecord): Promise<string> {
  return renderChannels([input]);
}

test('paid community intent uses one compact summary and keeps evidence behind disclosure', async () => {
  const html = await renderDashboard(channel({
    discord_status: 'NOT_FOUND',
    community_discovery_status: 'PAID_COMMUNITY_INDICATED',
    community_intents: [paidIntent],
  }));

  assert.doesNotMatch(html, /Clean inspection · no community found/);
  assert.match(html, /No Discord invite · community indicated/);
  assert.match(html, /Paid community \(Whop\)/);
  assert.doesNotMatch(html, /PAID COMMUNITY INDICATED/);
  assert.match(html, /Whop/);
  assert.match(html, /whop\.com\/creator/);
  assert.match(html, /price, membership/);
  assert.match(html, /data-testid="community-intent"/);
  assert.match(html, /<summary/);
});

test('a private no-invite community shows intent and evidence, never clean inspection', async () => {
  const privateIntent: CommunityIntentEvidence = {
    ...paidIntent,
    communityPlatform: 'CIRCLE',
    communityUrl: 'https://community.circle.so/c/private-trading',
    intent: 'PRIVATE',
    paidSignals: [],
    privateSignals: ['members-only'],
  };
  const html = await renderDashboard(channel({
    community_discovery_status: 'COMMUNITY_INDICATED_NO_INVITE',
    community_intents: [privateIntent],
  }));

  assert.doesNotMatch(html, /Clean inspection · no community found/);
  assert.match(html, /Community indicated \(Circle\) · no invite/);
  assert.match(html, /Circle/);
  assert.match(html, /PRIVATE/);
  assert.match(html, /community\.circle\.so\/c\/private-trading/);
});

test('a retained invite makes the additional community label invite-neutral', async () => {
  const html = await renderDashboard(channel({
    discord_invite: 'https://discord.gg/retained',
    community_discovery_status: 'COMMUNITY_INDICATED_NO_INVITE',
    community_intents: [{ ...paidIntent, intent: 'UNKNOWN', paidSignals: [] }],
  }));

  assert.match(html, /Additional community \(Whop\)/);
  assert.doesNotMatch(html, /Community indicated \(Whop\) · no invite/);
  assert.match(html, /https:\/\/discord\.gg\/retained/);
});

test('duplicate ownership is one compact summary with a linked owner name, not a repeated warning or raw id', async () => {
  const html = await renderDashboard(channel({
    discord_duplicate_owner_channel_id: 'UC_owner_other',
    discord_duplicate_owner_channel_name: 'OFM',
  }));

  assert.match(html, /Second invite owned elsewhere/);
  assert.match(html, /data-testid="duplicate-owned-invite"/);
  assert.match(html, /href="#channel-row-UC_owner_other"[^>]*>OFM<\/a>/);
  assert.doesNotMatch(html, /Invite found, owned by another channel/);
  assert.doesNotMatch(html, /Owner channel: UC_owner_other/);
  assert.doesNotMatch(html, /Clean inspection · no community found/);
});

test('duplicate owner name falls back to the loaded owner row and links to that row', async () => {
  const owner = channel({ channel_id: 'UC_owner_other', channel_name: 'OFM' });
  const duplicate = channel({
    channel_id: 'UC_duplicate',
    channel_name: 'Duplicate Creator',
    discord_duplicate_owner_channel_id: owner.channel_id,
  });
  const html = await renderChannels([duplicate, owner]);

  assert.match(html, /id="channel-row-UC_owner_other"/);
  assert.match(html, /href="#channel-row-UC_owner_other"[^>]*>OFM<\/a>/);
  assert.match(html, /data-testid="discord-owner-link"/);
});

test('a genuinely clean inspection still renders the no-community summary', async () => {
  const html = await renderDashboard(channel({}));

  assert.match(html, /Clean inspection · no community found/);
  assert.match(html, /data-testid="discord-generic-summary"/);
  assert.doesNotMatch(html, /data-testid="community-intent"/);
});

test('a retained invite and an additional intent render independently without overwriting either', async () => {
  const html = await renderDashboard(channel({
    discord_status: 'ACTIVE',
    discord_invite: 'https://discord.gg/creatora',
    discord_discovery_status: 'VALIDATED',
    discord_validation_status: 'SUCCEEDED',
    community_discovery_status: 'PAID_COMMUNITY_INDICATED',
    community_intents: [paidIntent],
  }));

  assert.match(html, />ACTIVE<\/span>/);
  assert.match(html, /Discovered · validation completed/);
  assert.match(html, /discord\.gg\/creatora/);
  assert.match(html, /data-testid="community-intent"/);
  assert.match(html, /Paid community \(Whop\)/);
  assert.match(html, /Whop/);
  assert.match(html, /whop\.com\/creator/);
  assert.doesNotMatch(html, /Clean inspection · no community found/);
});

test('retry and candidate evidence remain available behind the single summary', async () => {
  const html = await renderDashboard(channel({
    discord_status: 'ACTIVE',
    discord_invite: 'https://discord.gg/retained',
    discord_discovery_status: 'VALIDATED',
    discord_validation_status: 'RETRY_PENDING',
    scan_status: 'FAILED',
    community_retry_job_status: 'PENDING',
    community_retry_job_retry_reason: 'NO_SURFACE',
    community_retry_job_attempts: 0,
    community_retry_job_max_attempts: 3,
    community_retry_job_execution_count: 0,
  }));

  assert.match(html, /data-testid="discord-generic-summary"/);
  assert.match(html, /Automatic retry queued · reason: NO SURFACE/);
  assert.match(html, /Retry-window attempts: 0\/3|Pending · not yet executed \(0\/3\)/);
  assert.match(html, /https:\/\/discord\.gg\/retained/);
});
