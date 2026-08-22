import type { ChannelRecord, DiscordStatus, DiscordValidationStatus, ScanStatus, TradingStatus } from '../src/types';
import type { ReviewEligibilityDecision } from './reviewEligibility/policy';

export interface UncertainLifecycleState {
  scanStatus: ScanStatus;
  tradingStatus: TradingStatus;
  shouldEnqueue: boolean;
}

/**
 * NEEDS_REVIEW is reserved for an explicit evidence-complete serving decision.
 * Legacy callers that have not supplied eligibility remain machine-owned; the
 * authoritative eligibility recorder can materialize a genuine pending review
 * after the channel write, but absence of eligibility can never create review.
 */
export function resolveUncertainLifecycle(wantsHumanReview: boolean, eligibility?: ReviewEligibilityDecision): UncertainLifecycleState {
  if (!wantsHumanReview) return { scanStatus: 'ENRICHMENT_PENDING', tradingStatus: 'UNCERTAIN', shouldEnqueue: true };
  if (eligibility?.servingAuthority && eligibility.status === 'ELIGIBLE' && eligibility.reasonFamily === 'HUMAN_AMBIGUITY') {
    return { scanStatus: 'NEEDS_REVIEW', tradingStatus: 'NEEDS_REVIEW', shouldEnqueue: false };
  }
  return { scanStatus: 'ENRICHMENT_PENDING', tradingStatus: 'UNCERTAIN', shouldEnqueue: true };
}

export interface TerminalEnrichmentFailureProjection {
  shouldProject: boolean;
  scanStatus: ScanStatus;
  tradingStatus: TradingStatus;
  discordStatus: DiscordStatus;
  discordValidationStatus: DiscordValidationStatus;
}

type EnrichmentFailureInput = Pick<ChannelRecord, 'scan_status' | 'trading_status' | 'discord_status' | 'discord_validation_status'>;

const SEMANTICALLY_PROTECTED_TRADING_STATUSES: TradingStatus[] = ['NON_TRADING', 'NEEDS_REVIEW', 'HUMAN_REJECTED'];
const OPERATIONALLY_ACTIVE_SCAN_STATUSES: ScanStatus[] = ['LOCKED', 'ENRICHMENT_PENDING', 'ENRICHING'];
const SEMANTICALLY_TERMINAL_DISCORD_STATUSES: DiscordStatus[] = ['ACTIVE', 'ACTIVE_LOW_VOLUME', 'DEAD', 'NON_TRADING'];

/**
 * Projects a terminal post-approval enrichment failure without reclassifying
 * the channel. Human approval remains authoritative; the operational scan is
 * marked FAILED so recovery can reactivate it explicitly. Existing terminal
 * Discord outcomes are retained, while an incomplete Discord pass becomes an
 * operationally failed/uncertain outcome rather than a false absence.
 */
export function resolveTerminalEnrichmentFailure(channel: EnrichmentFailureInput, terminal: boolean): TerminalEnrichmentFailureProjection {
  if (!terminal) {
    return {
      shouldProject: false,
      scanStatus: channel.scan_status,
      tradingStatus: channel.trading_status,
      discordStatus: channel.discord_status,
      discordValidationStatus: channel.discord_validation_status
    };
  }
  const protectedSemanticDecision = SEMANTICALLY_PROTECTED_TRADING_STATUSES.includes(channel.trading_status);
  const expectedActiveScan = OPERATIONALLY_ACTIVE_SCAN_STATUSES.includes(channel.scan_status);
  if (protectedSemanticDecision || !expectedActiveScan) {
    return {
      shouldProject: false,
      scanStatus: channel.scan_status,
      tradingStatus: channel.trading_status,
      discordStatus: channel.discord_status,
      discordValidationStatus: channel.discord_validation_status
    };
  }

  const discordHasTerminalOutcome = SEMANTICALLY_TERMINAL_DISCORD_STATUSES.includes(channel.discord_status)
    || channel.discord_validation_status === 'COMPLETED';
  return {
    shouldProject: true,
    scanStatus: 'FAILED',
    tradingStatus: channel.trading_status,
    discordStatus: discordHasTerminalOutcome ? channel.discord_status : 'UNCERTAIN',
    discordValidationStatus: discordHasTerminalOutcome ? channel.discord_validation_status : 'FAILED_OPERATIONAL'
  };
}
