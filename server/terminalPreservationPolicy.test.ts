import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelRecord, DiscoverySource } from '../src/types';
import { shouldPreserveExistingChannel } from './terminalPreservationPolicy';

const base = (overrides: Partial<ChannelRecord> = {}): ChannelRecord => ({
  channel_id: 'channel-1',
  channel_name: 'Example',
  youtube_url: 'https://youtube.com/channel/channel-1',
  country: 'United States',
  country_status: 'CONFIRMED',
  confidence_score: 90,
  discord_status: 'NOT_FOUND',
  discord_invite: null,
  scan_status: 'COMPLETED',
  scan_attempts: 1,
  discovery_source: 'manual_search',
  first_seen: new Date().toISOString(),
  last_checked: new Date().toISOString(),
  inspection_trail: [],
  trading_status: 'TRADING_CONFIRMED',
  ...overrides
});

const source = (value: string) => value as DiscoverySource;

test('autonomous discovery preserves terminal non-trading channels', () => {
  assert.equal(shouldPreserveExistingChannel(base({ trading_status: 'NON_TRADING', scan_status: 'SKIPPED_NON_TRADING' }), source('autonomous'), false), true);
});

test('ordinary manual search also preserves terminal non-trading channels', () => {
  assert.equal(shouldPreserveExistingChannel(base({ trading_status: 'NON_TRADING', scan_status: 'SKIPPED_NON_TRADING' }), source('manual_search'), true), true);
});

test('human rejected rows are terminal for ordinary manual search', () => {
  assert.equal(shouldPreserveExistingChannel(base({ trading_status: 'HUMAN_REJECTED' }), source('manual_search'), true), true);
});

test('explicit recheck remains the only terminal override lane', () => {
  assert.equal(shouldPreserveExistingChannel(base({ trading_status: 'NON_TRADING', scan_status: 'SKIPPED_NON_TRADING' }), source('recheck'), true), false);
});

test('manual search can still refresh a non-terminal stable trading row', () => {
  assert.equal(shouldPreserveExistingChannel(base(), source('manual_search'), true), false);
});
