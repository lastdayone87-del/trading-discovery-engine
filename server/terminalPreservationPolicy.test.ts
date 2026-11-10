import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelRecord, DiscoverySource } from '../src/types';
import { countryPolicySnapshotFromRow, countryPolicySnapshotMatches, machineNonTradingRediscoveryEligible, shouldPreserveResolvedCountry, shouldBypassPreservationForDiscordEvidence, shouldPreserveExistingChannel, shouldRevalidateConfirmedCountry, shouldShortCircuitConfirmedRediscovery, terminalScanStatusForConfirmedRediscovery } from './terminalPreservationPolicy';

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

test('TRADING_CONFIRMED is preserved under ordinary rediscovery even with uncertain country', () => {
  const confirmed = base({ trading_status: 'TRADING_CONFIRMED', country_status: 'UNCERTAIN', country: '' });
  assert.equal(shouldShortCircuitConfirmedRediscovery(confirmed, false), true);
  assert.equal(shouldPreserveExistingChannel(confirmed, source('automated_query'), false, NOW), true);
  assert.equal(shouldShortCircuitConfirmedRediscovery(confirmed, true), false);
});

test('an active enrichment marker on a confirmed row is projected COMPLETED on rediscovery', () => {
  assert.equal(terminalScanStatusForConfirmedRediscovery('ENRICHMENT_PENDING', false), 'COMPLETED');
  assert.equal(terminalScanStatusForConfirmedRediscovery('ENRICHING', false), 'COMPLETED');
  assert.equal(terminalScanStatusForConfirmedRediscovery('LOCKED', false), 'LOCKED');
  assert.equal(terminalScanStatusForConfirmedRediscovery('ENRICHING', true), 'ENRICHING', 'a live job owns the marker');
  assert.equal(terminalScanStatusForConfirmedRediscovery('NEEDS_REVIEW', false), 'NEEDS_REVIEW');
  assert.equal(terminalScanStatusForConfirmedRediscovery('FAILED', false), 'FAILED');
});

test('confirmed rows with unresolved country get only the deterministic country pass', () => {
  const confirmedUnknown = base({ trading_status: 'TRADING_CONFIRMED', country_status: 'UNCERTAIN', country: '' });
  assert.equal(shouldRevalidateConfirmedCountry(confirmedUnknown, false), true);
  assert.equal(shouldRevalidateConfirmedCountry(confirmedUnknown, true), false);
  assert.equal(shouldRevalidateConfirmedCountry(base(), false), false);
  assert.equal(shouldRevalidateConfirmedCountry(base({ trading_status: 'UNCERTAIN', country_status: 'UNCERTAIN' }), false), false);
});

test('Discord bypass never reopens country-terminal or confirmed rows', () => {
  const completed = base({ trading_status: 'UNCERTAIN', scan_status: 'COMPLETED', country_status: 'CONFIRMED' });
  assert.equal(shouldBypassPreservationForDiscordEvidence(completed, true), true);
  assert.equal(shouldBypassPreservationForDiscordEvidence(base({ trading_status: 'TRADING_CONFIRMED', scan_status: 'COMPLETED' }), true), false);
  assert.equal(shouldBypassPreservationForDiscordEvidence(base({ trading_status: 'UNCERTAIN', scan_status: 'COMPLETED', country_status: 'REJECTED' }), true), false);
  assert.equal(shouldBypassPreservationForDiscordEvidence(base({ trading_status: 'UNCERTAIN', scan_status: 'SKIPPED_EXCLUDED' }), true), false);
  assert.equal(shouldBypassPreservationForDiscordEvidence(completed, false), false);
});

test('a slow country pass cannot overwrite a concurrent rejection or confirmation', () => {
  const unconfirmed = { countryStatus: 'UNCERTAIN', country: '' };
  assert.equal(countryPolicySnapshotMatches(unconfirmed, unconfirmed), true);
  assert.equal(countryPolicySnapshotMatches({ countryStatus: 'REJECTED', country: 'Netherlands' }, unconfirmed), false);
  assert.equal(countryPolicySnapshotMatches({ countryStatus: 'CONFIRMED', country: 'Netherlands' }, unconfirmed), false);
  assert.equal(countryPolicySnapshotMatches({ countryStatus: 'UNCERTAIN', country: 'Belgium' }, unconfirmed), false);
  assert.equal(countryPolicySnapshotMatches(null, unconfirmed), false);
  const policy = { countryStatus: 'UNCERTAIN', country: '', tradingStatus: 'TRADING_CONFIRMED', scanStatus: 'COMPLETED' };
  assert.equal(countryPolicySnapshotMatches({ ...policy }, policy), true);
  assert.equal(countryPolicySnapshotMatches({ ...policy, tradingStatus: 'NON_TRADING' }, policy), false);
  assert.equal(countryPolicySnapshotMatches({ ...policy, scanStatus: 'ENRICHMENT_PENDING' }, policy), false);
});

test('raw channel rows map snake_case country columns before comparison', () => {
  const row = { country_status: 'UNCERTAIN', country: '' };
  assert.deepEqual(countryPolicySnapshotFromRow(row), { countryStatus: 'UNCERTAIN', country: '' });
  assert.equal(countryPolicySnapshotMatches(countryPolicySnapshotFromRow(row), { countryStatus: 'UNCERTAIN', country: '' }), true);
  assert.equal(countryPolicySnapshotMatches(countryPolicySnapshotFromRow({ country_status: 'REJECTED', country: 'Germany' }), { countryStatus: 'UNCERTAIN', country: '' }), false);
  assert.equal(countryPolicySnapshotFromRow(null), null);
  assert.deepEqual(
    countryPolicySnapshotFromRow({ country_status: 'UNCERTAIN', country: '', trading_status: 'TRADING_CONFIRMED', scan_status: 'COMPLETED' }),
    { countryStatus: 'UNCERTAIN', country: '', tradingStatus: 'TRADING_CONFIRMED', scanStatus: 'COMPLETED' },
  );
});

test('a country-only pass never downgrades a resolved country to uncertain', () => {
  assert.equal(shouldPreserveResolvedCountry('CONFIRMED', 'UNCERTAIN'), true);
  assert.equal(shouldPreserveResolvedCountry('LIKELY', 'UNCERTAIN'), true);
  assert.equal(shouldPreserveResolvedCountry('REJECTED', 'UNCERTAIN'), true);
  assert.equal(shouldPreserveResolvedCountry('CONFIRMED', 'LIKELY'), false);
  assert.equal(shouldPreserveResolvedCountry('UNCERTAIN', 'UNCERTAIN'), false);
  assert.equal(shouldPreserveResolvedCountry(undefined, 'UNCERTAIN'), false);
});
