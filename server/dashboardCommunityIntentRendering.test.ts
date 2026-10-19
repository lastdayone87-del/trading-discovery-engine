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

async function renderDashboard(input: ChannelRecord): Promise<string> {
  const { ResultsTable } = await import('../src/components/ResultsTable');
  return renderToStaticMarkup(React.createElement(ResultsTable, {
    channels: [input],
    onRecheck: async () => {},
    onInspect: () => {},
  }));
}

test('paid community intent replaces the clean-inspection text with status and evidence', async () => {
  const html = await renderDashboard(channel({
    discord_status: 'NOT_FOUND',
    community_discovery_status: 'PAID_COMMUNITY_INDICATED',
    community_intents: [paidIntent],
  }));

  assert.doesNotMatch(html, /Clean inspection · no community found/);
  assert.match(html, /No Discord invite · community indicated/);
  assert.match(html, /PAID COMMUNITY INDICATED/);
  assert.match(html, /WHOP/);
  assert.match(html, /whop\.com\/creator/);
  assert.match(html, /price, membership/);
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
  assert.match(html, /COMMUNITY INDICATED · NO INVITE/);
  assert.match(html, /CIRCLE/);
  assert.match(html, /PRIVATE/);
  assert.match(html, /community\.circle\.so\/c\/private-trading/);
});

test('a genuinely clean inspection still renders the no-community label', async () => {
  const html = await renderDashboard(channel({}));

  assert.match(html, /Clean inspection · no community found/);
  assert.doesNotMatch(html, /data-testid="community-intent"/);
});

test('a retained invite and an additional intent render side by side without overwriting either', async () => {
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
  assert.match(html, /PAID COMMUNITY INDICATED/);
  assert.match(html, /WHOP/);
  assert.match(html, /whop\.com\/creator/);
  assert.doesNotMatch(html, /Clean inspection · no community found/);
});
