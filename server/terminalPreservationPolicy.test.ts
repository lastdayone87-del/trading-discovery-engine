import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelRecord, DiscoverySource } from '../src/types';
import { machineNonTradingRediscoveryEligible, shouldPreserveExistingChannel } from './terminalPreservationPolicy';

const NOW = Date.parse('2026-08-16T04:00:00.000Z');

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
  first_seen: '2026-08-01T00:00:00.000Z',
  last_checked: '2026-08-16T03:00:00.000Z',
  inspection_trail: [],
  trading_status: 'TRADING_CONFIRMED',
  ...overrides
});

const source = (value: string) => value as DiscoverySource;

test('recent machine non-trading decision remains preserved from autonomous churn', () => {
  const channel = base({ trading_status: 'NON_TRADING', scan_status: 'SKIPPED_NON_TRADING', last_checked: '2026-08-16T03:00:00.000Z' });
  assert.equal(shouldPreserveExistingChannel(channel, source('automated_query'), false, NOW), true);
  assert.equal(machineNonTradingRediscoveryEligible(channel, NOW), false);
});

test('aged machine non-trading decision may be reconsidered by fresh autonomous rediscovery', () => {
  const channel = base({ trading_status: 'NON_TRADING', scan_status: 'SKIPPED_NON_TRADING', last_checked: '2026-08-14T03:00:00.000Z' });
  assert.equal(machineNonTradingRediscoveryEligible(channel, NOW), true);
  assert.equal(shouldPreserveExistingChannel(channel, source('automated_query'), false, NOW), false);
});

test('legacy autonomous source alias receives the same bounded reconsideration behavior', () => {
  const channel = base({ trading_status: 'NON_TRADING', scan_status: 'SKIPPED_NON_TRADING', last_checked: '2026-08-14T03:00:00.000Z' });
  assert.equal(shouldPreserveExistingChannel(channel, source('autonomous'), false, NOW), false);
});

test('ordinary manual search still preserves machine non-trading channels', () => {
  const channel = base({ trading_status: 'NON_TRADING', scan_status: 'SKIPPED_NON_TRADING', last_checked: '2026-08-14T03:00:00.000Z' });
  assert.equal(shouldPreserveExistingChannel(channel, source('manual_search'), true, NOW), true);
});

test('human rejected rows remain terminal even when old', () => {
  const channel = base({ trading_status: 'HUMAN_REJECTED', last_checked: '2026-01-01T00:00:00.000Z' });
  assert.equal(machineNonTradingRediscoveryEligible(channel, NOW), false);
  assert.equal(shouldPreserveExistingChannel(channel, source('automated_query'), false, NOW), true);
});

test('country rejected rows remain terminal even when old', () => {
  const channel = base({ country_status: 'REJECTED', trading_status: 'NON_TRADING', scan_status: 'SKIPPED_EXCLUDED', last_checked: '2026-01-01T00:00:00.000Z' });
  assert.equal(machineNonTradingRediscoveryEligible(channel, NOW), false);
  assert.equal(shouldPreserveExistingChannel(channel, source('automated_query'), false, NOW), true);
});

test('explicit recheck remains immediate terminal override lane', () => {
  const channel = base({ trading_status: 'NON_TRADING', scan_status: 'SKIPPED_NON_TRADING' });
  assert.equal(shouldPreserveExistingChannel(channel, source('recheck'), true, NOW), false);
});

test('manual search can still refresh a non-terminal stable trading row', () => {
  assert.equal(shouldPreserveExistingChannel(base(), source('manual_search'), true, NOW), false);
});
