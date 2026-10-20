import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildChannelListingWhere } from './db';
import { isConfirmedDiscordInvite } from '../src/discordInviteView';
import type { ChannelRecord } from '../src/types';

const serving = { predicate: "country_status <> 'REJECTED'", scope: 'ELIGIBLE_OPERATOR_VISIBLE_CHANNELS' };
const baseFilters = { includeRejected: false, diagnosticsOnly: false };
type InviteFields = Pick<ChannelRecord,
  'discord_invite'|'discord_status'|'discord_validation_status'|'discord_liveness_status'|'discord_discovery_status'|'discord_duplicate_owner_channel_id'>;

const confirmed: InviteFields = {
  discord_invite: 'https://discord.gg/trading',
  discord_status: 'ACTIVE',
  discord_validation_status: 'SUCCEEDED',
  discord_liveness_status: 'ACTIVE',
  discord_discovery_status: 'VALIDATED',
  discord_duplicate_owner_channel_id: null,
};

test('recent view requires a confirmed, validated, live invite before pagination', () => {
  const result = buildChannelListingWhere(serving, { ...baseFilters, recentInvites: true, discordStatus: 'ACTIVE_LOW_VOLUME' });
  assert.match(result.where, /discord_invite IS NOT NULL/);
  assert.match(result.where, /discord_validation_status IN \('SUCCEEDED','COMPLETED'\)/);
  assert.match(result.where, /discord_liveness_status='ACTIVE'/);
  assert.match(result.where, /discord_discovery_status='VALIDATED'/);
  assert.match(result.where, /discord_status IN \('ACTIVE','ACTIVE_LOW_VOLUME','NON_TRADING'\)/);
  assert.match(result.where, /discord_duplicate_owner_channel_id IS NULL/);
  // Category selection is an independent AND clause, not an override.
  assert.match(result.where, /discord_status=\$1/);
  assert.deepEqual(result.values, ['ACTIVE_LOW_VOLUME']);
});

test('default listing does not silently become the recently-confirmed view', () => {
  const result = buildChannelListingWhere(serving, baseFilters);
  assert.doesNotMatch(result.where, /discord_invite IS NOT NULL/);
  assert.doesNotMatch(result.where, /discord_discovery_status='VALIDATED'/);
});

test('local confirmed-invite filter excludes non-finds and unconfirmed states', () => {
  assert.equal(isConfirmedDiscordInvite(confirmed), true);
  assert.equal(isConfirmedDiscordInvite({ ...confirmed, discord_status: 'ACTIVE_LOW_VOLUME' }), true);
  assert.equal(isConfirmedDiscordInvite({ ...confirmed, discord_status: 'NON_TRADING' }), true);
  assert.equal(isConfirmedDiscordInvite({ ...confirmed, discord_status: 'UNCERTAIN' }), false);
  assert.equal(isConfirmedDiscordInvite({ ...confirmed, discord_status: 'NOT_FOUND' }), false);
  assert.equal(isConfirmedDiscordInvite({ ...confirmed, discord_status: 'PENDING' }), false);
  assert.equal(isConfirmedDiscordInvite({ ...confirmed, discord_status: 'DEAD' }), false);
  assert.equal(isConfirmedDiscordInvite({ ...confirmed, discord_invite: null }), false);
  assert.equal(isConfirmedDiscordInvite({ ...confirmed, discord_duplicate_owner_channel_id: 'UC-owner' }), false);
  assert.equal(isConfirmedDiscordInvite({ ...confirmed, discord_validation_status: 'RETRY_PENDING' }), false);
  assert.equal(isConfirmedDiscordInvite({ ...confirmed, discord_liveness_status: 'UNCERTAIN' }), false);
  assert.equal(isConfirmedDiscordInvite({ ...confirmed, discord_discovery_status: 'DISCOVERED_VALIDATION_FAILED' }), false);
});

test('recent invite sorting is server-side and has a stable channel tie-breaker', () => {
  const db = readFileSync(fileURLToPath(new URL('./dbCore.ts', import.meta.url)), 'utf8');
  const server = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');
  const query = readFileSync(fileURLToPath(new URL('../src/channelListingQuery.ts', import.meta.url)), 'utf8');
  const ui = readFileSync(fileURLToPath(new URL('../src/components/ResultsTable.tsx', import.meta.url)), 'utf8');
  assert.match(db, /const orderBy=args\.recentInvites\?RECENT_INVITE_ORDER_SQL:'first_seen DESC,channel_id'/);
  assert.match(db, /ORDER BY \$\{orderBy\} LIMIT/);
  assert.match(db, /RECENT_INVITE_ORDER_SQL = 'discord_invite_first_validated_at DESC NULLS LAST,channel_id DESC'/);
  assert.match(server, /recentInvites:req\.query\.recent_invites==='true'/);
  assert.match(query, /if\(filters\.recentInvites\)params\.set\('recent_invites','true'\)/);
  assert.match(ui, /Recently confirmed/);
  assert.match(ui, /Found time unavailable/);
  assert.match(ui, /formatFoundAgo\(c\.discord_invite_first_validated_at\)/);
  assert.doesNotMatch(ui, /audit checkbox|reviewed marker|unaudited/i);
});
