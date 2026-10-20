import type { ChannelRecord } from './types';

/** Mirrors the server's recently-confirmed predicate for immediate local
 * filtering. The server applies the same rules before pagination; this helper
 * only prevents a stale row from flashing into the new view while a fetch is
 * in flight. It never invents a confirmation timestamp. */
export function isConfirmedDiscordInvite(channel: Pick<ChannelRecord,
  'discord_invite'|'discord_status'|'discord_validation_status'|'discord_liveness_status'|'discord_discovery_status'|'discord_duplicate_owner_channel_id'>): boolean {
  return Boolean(channel.discord_invite)
    && (channel.discord_status === 'ACTIVE' || channel.discord_status === 'ACTIVE_LOW_VOLUME' || channel.discord_status === 'NON_TRADING')
    && (channel.discord_validation_status === 'SUCCEEDED' || channel.discord_validation_status === 'COMPLETED')
    && channel.discord_liveness_status === 'ACTIVE'
    && channel.discord_discovery_status === 'VALIDATED'
    && !channel.discord_duplicate_owner_channel_id;
}
