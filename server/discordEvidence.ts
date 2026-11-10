import type { ChannelRecord } from '../src/types';

/**
 * A stored Discord invite is usable classification evidence only when the
 * validation and relevance lanes agree. The provider itself still evaluates
 * it; this helper only decides whether a completed validation may be supplied
 * to the classifier.
 */
export function validatedDiscordEvidenceInvite(
  channel: Pick<
    ChannelRecord,
    'discord_invite' | 'discord_validation_status' | 'discord_liveness_status' | 'discord_relevance_status'
  > | null | undefined,
): string | undefined {
  if (!channel?.discord_invite || !channel.discord_invite.trim()) return undefined;
  if (channel.discord_validation_status !== 'SUCCEEDED' && channel.discord_validation_status !== 'COMPLETED') return undefined;
  if (channel.discord_liveness_status !== 'ACTIVE') return undefined;
  if (channel.discord_relevance_status !== 'TRADING_RELEVANT') return undefined;
  return channel.discord_invite.trim();
}

/**
 * Discord validation is evidence, never a confirmation. Only an unconfirmed
 * channel with a validated trading-relevant invite earns one bounded
 * reclassification pass; an active classification already owns the work.
 */
export function shouldEnqueueDiscordEvidenceReclassification(input: {
  tradingStatus: string | null | undefined;
  invite: string | undefined;
  hasActiveClassificationJob: boolean;
}): boolean {
  return input.tradingStatus === 'UNCERTAIN'
    && Boolean(input.invite)
    && !input.hasActiveClassificationJob;
}
