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



/**
 * A terminal enrichment job is durable evidence that the work already ran.
 * When a later rediscovery is blocked from reopening it, the channel must not
 * remain ENRICHMENT_PENDING with no runnable job. A blocked COMPLETED job
 * projects COMPLETED; a blocked FAILED job projects FAILED. Terminal/review
 * states are preserved verbatim, and an active owner elsewhere keeps the
 * pending marker.
 */
export function resolveEnrichmentReopenBlockedLifecycle(
  channel: Pick<ChannelRecord, 'scan_status' | 'trading_status'>,
  options: { blockedJobStatus?: string | null; hasOtherActiveEnrichmentJob?: boolean } = {},
): { scanStatus: ScanStatus; tradingStatus: TradingStatus } {
  const active = channel.scan_status === 'ENRICHMENT_PENDING'
    || channel.scan_status === 'ENRICHING'
    || channel.scan_status === 'LOCKED';
  if (!active || options.hasOtherActiveEnrichmentJob === true) {
    return { scanStatus: channel.scan_status, tradingStatus: channel.trading_status };
  }
  // A blocked FAILED job is terminal for this pass; it is not completed work.
  // An active job elsewhere owns the channel and must keep the pending state.
  return {
    scanStatus: String(options.blockedJobStatus || '').toUpperCase() === 'FAILED' ? 'FAILED' : 'COMPLETED',
    tradingStatus: channel.trading_status,
  };
}

/**
 * An enrichment pass must not schedule the stage it just executed. The worker
 * caps the evidence-action sequence (currently stage 3); once a pass reaches
 * the cap, a repeated request is a bookkeeping loop, not new evidence work.
 */
export function isEnrichmentStageExhausted(
  isEnrichmentPass: boolean,
  currentStage: number,
  nextStage: number,
): boolean {
  return isEnrichmentPass === true && nextStage <= Math.max(0, currentStage);
}

export type ExistingEnrichmentAction =
  | 'SCHEDULE_WORKFLOW'
  | 'REUSE_ACTIVE'
  | 'RETRY_FAILED'
  | 'PROJECT_TERMINAL'
  | 'ENQUEUE_IDEMPOTENT';

/**
 * The stable channel/stage key is the single owner of ordinary enrichment.
 * Before the workflow lane creates an investigation step, it must reuse an
 * active job, retry a failed one through the ordinary reopen path, and treat
 * a completed one as terminal. A lookup failure cannot distinguish these
 * states, so it uses the idempotent ordinary enqueue without a workflow step.
 */
export function resolveExistingEnrichmentAction(
  status: string | null | undefined,
  lookupFailed: boolean = false,
): ExistingEnrichmentAction {
  if (lookupFailed) return 'ENQUEUE_IDEMPOTENT';
  switch (String(status || '').toUpperCase()) {
    case 'PENDING':
    case 'PROCESSING':
      return 'REUSE_ACTIVE';
    case 'FAILED':
      return 'RETRY_FAILED';
    case 'COMPLETED':
      return 'PROJECT_TERMINAL';
    default:
      return 'SCHEDULE_WORKFLOW';
  }
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
