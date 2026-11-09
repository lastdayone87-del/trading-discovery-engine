/**
 * Phase 0 acquisition lane taxonomy and truthfulness classifier.
 *
 * The capacity plan needs a complete per-lane baseline before Phase 1 changes
 * scheduling. This module is pure: it names the lanes and outcomes, maps
 * durable job types to lanes, and derives one outcome from an inspection.
 *
 * Truthfulness rules:
 *
 *   * A started request is not an executed inspection. A clean no-match needs
 *     direct processed evidence (pages, finished requests, clicks, or FOUND).
 *   * A capacity/gate/browser-runtime wait is not an acquisition failure.
 *   * A bare HTTP 403/404 is not conclusive external blocking. Blocking needs
 *     supporting evidence (confirmed login/paywall/permanent block, or a
 *     body-confirmed static terminal not-found).
 *   * Missing observations are never promoted to a clean outcome: they stay
 *     NEVER_EXECUTED only when no work signal exists, otherwise INCONCLUSIVE.
 */

import {
  isBrowserRuntimeFailureClass,
  isCommunityRetryableObservation,
  type CommunityRetryObservation,
} from './communityRetryPolicy';
import { isInfrastructureFailureClass } from './communityAcquisitionWorkLedger';
import { effectiveAcquisitionOutcomes, type AcquisitionObservationLike } from './communitySurfacePolicy';
import {
  ACQUISITION_LANES,
  ACQUISITION_OUTCOMES,
  isAcquisitionLane,
  isAcquisitionOutcome,
  type AcquisitionLane,
  type AcquisitionOutcome,
} from './acquisitionLaneKeys';

export {
  ACQUISITION_LANES,
  ACQUISITION_OUTCOMES,
  isAcquisitionLane,
  isAcquisitionOutcome,
  type AcquisitionLane,
  type AcquisitionOutcome,
};

/**
 * Lane mapping for every durable queue type. The mapping is deliberately total
 * over the claimable taxonomy so a future job type cannot silently inherit the
 * wrong capacity lane: an unmapped type falls back to UNKNOWN and is visible.
 */
const JOB_TYPE_LANES: Readonly<Record<string, AcquisitionLane>> = {
  SEARCH_YOUTUBE: 'DISCOVERY',
  CLASSIFY_DISCOVERED_CHANNEL: 'DISCOVERY',
  INSPECT_PLAYLIST: 'DISCOVERY',
  INSPECT_FEATURED_CHANNELS: 'DISCOVERY',
  RELATIONSHIP_CANARY_EXPANSION: 'DISCOVERY',
  ENRICH_CHANNEL: 'ENRICHMENT',
  POST_APPROVAL_ENRICH: 'ENRICHMENT',
  RETRY_COMMUNITY_ACQUISITION: 'RETRY',
  MANUAL_SEARCH_PAGE: 'MANUAL',
  FORCE_REVIEW_RESCAN: 'MANUAL',
  TERM_HARVEST: 'MAINTENANCE',
  RESOLVE_STAGED_CANDIDATE: 'MAINTENANCE',
  SCORE_CANDIDATES: 'MAINTENANCE',
  AI_ADJUDICATE_CANDIDATE: 'MAINTENANCE',
  PROPOSE_CONCEPT_RESOLUTION: 'MAINTENANCE',
  OFFLINE_CANDIDATE_EVALUATION: 'MAINTENANCE',
  PERSISTENT_RESEARCH_EXTERNAL_PROVIDER: 'MAINTENANCE',
  COUNTRY_BOUNDARY_REPROCESS: 'MAINTENANCE',
};

export function acquisitionLaneForJobType(jobType: unknown): AcquisitionLane {
  const key = String(jobType || '').trim().toUpperCase();
  return JOB_TYPE_LANES[key] || 'UNKNOWN';
}

export interface AcquisitionAttribution {
  lane: AcquisitionLane;
  jobType?: string;
  jobId?: string;
  channelId?: string;
  /** 1-based inspection pass. Phase 0 inspections are single-pass; Phase 1
   * bounded URL slices will advance this per slice. */
  slicePass?: number;
  /** Required retryable work left unexamined after this pass. */
  workRemaining?: number;
}

const MAX_ATTRIBUTION_TEXT = 96;
const MAX_ATTRIBUTION_COUNT = 999999;

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flat = value.replace(/\s+/g, ' ').trim().slice(0, MAX_ATTRIBUTION_TEXT);
  return flat || undefined;
}

function boundedCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(MAX_ATTRIBUTION_COUNT, Math.floor(value));
}

/**
 * Bounded attribution for persisted observation provenance. Unknown lanes are
 * dropped rather than stored so a malformed caller cannot poison the ledger.
 */
export function sanitizeAcquisitionAttribution(input: unknown): AcquisitionAttribution | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const candidate = input as Partial<AcquisitionAttribution>;
  if (!isAcquisitionLane(candidate.lane)) return undefined;
  const jobType = boundedText(candidate.jobType);
  const jobId = boundedText(candidate.jobId);
  const channelId = boundedText(candidate.channelId);
  const slicePass = boundedCount(candidate.slicePass);
  const workRemaining = boundedCount(candidate.workRemaining);
  return {
    lane: candidate.lane,
    ...(jobType ? { jobType } : {}),
    ...(jobId ? { jobId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(slicePass !== undefined ? { slicePass } : {}),
    ...(workRemaining !== undefined ? { workRemaining } : {}),
  };
}

export interface AcquisitionLaneTelemetryLike {
  pagesInspected?: unknown;
  requestsStarted?: unknown;
  requestsFinished?: unknown;
  clicksSucceeded?: unknown;
  gateWaitMs?: unknown;
}

export interface AcquisitionLaneObservation {
  requestedUrl?: string;
  rootUrl?: string;
  surface?: string;
  required?: boolean;
  outcome?: string;
  retryable?: boolean;
  failureClass?: string;
  httpStatus?: number;
  staticTerminalNotFound?: boolean;
  staticNotFoundBodyConfirmed?: boolean;
  sharedEvidenceFrom?: string;
  relevanceTier?: string;
  telemetry?: AcquisitionLaneTelemetryLike | null;
}

export interface AcquisitionLaneRetryDirective {
  attemptFree?: boolean;
  code?: string;
  retryReason?: string;
  reason?: string;
}

export interface AcquisitionLaneInspection {
  acquisitionStatus?: string;
  acquisitionOutcomes?: AcquisitionLaneObservation[];
  retryDirective?: AcquisitionLaneRetryDirective;
}

export interface AcquisitionLaneSignals {
  observations: number;
  effectiveObservations: number;
  requiredObservations: number;
  foundObservations: number;
  failedObservations: number;
  partialObservations: number;
  inspectedNoMatchObservations: number;
  retryOwningObservations: number;
  infrastructureFailureObservations: number;
  conclusiveBlockObservations: number;
  processedObservations: number;
}

export interface AcquisitionLaneSummary {
  outcome: AcquisitionOutcome;
  pagesInspected: number;
  requestsStarted: number;
  /** Longest gate wait observed in this inspection (not a sum: each seed has
   * its own crawl and adding waits would overstate capacity pressure). */
  gateWaitMs?: number;
  workRemaining: number;
  /** Bounded capacity/browser wait code when the outcome is a deferral. */
  capacityEvent?: string;
  signals: AcquisitionLaneSignals;
}

function nonNegativeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function upper(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

/** Direct processed acquisition evidence. Borrowed evidence and started-only
 * requests never prove this URL was inspected. Mirrors the Phase 0 work ledger. */
export function hasDirectProcessedAcquisitionEvidence(observation: AcquisitionLaneObservation): boolean {
  if (observation.sharedEvidenceFrom) return false;
  const telemetry = observation.telemetry || {};
  if (nonNegativeCount(telemetry.pagesInspected) > 0) return true;
  if (nonNegativeCount(telemetry.requestsFinished) > 0) return true;
  if (nonNegativeCount(telemetry.clicksSucceeded) > 0) return true;
  return observation.outcome === 'FOUND';
}

function retryObservation(observation: AcquisitionLaneObservation): CommunityRetryObservation {
  return {
    required: observation.required,
    surface: observation.surface,
    outcome: String(observation.outcome || ''),
    retryable: observation.retryable === true,
    failureClass: observation.failureClass,
    requestedUrl: observation.requestedUrl,
    rootUrl: observation.rootUrl,
    relevanceTier: observation.relevanceTier,
  };
}

/** Production retry ownership, shared so lane accounting cannot drift. */
export function observationOwnsAcquisitionRetry(observation: AcquisitionLaneObservation): boolean {
  if (observation.sharedEvidenceFrom) return false;
  try {
    return isCommunityRetryableObservation(retryObservation(observation));
  } catch {
    return false;
  }
}

/**
 * Conclusive external blocking only. A bare 403/404/999 is deliberately not
 * enough: the retry policy keeps uncertain 403s retryable, and Phase 0 must not
 * park work on a single unsupported status. Supporting evidence is a confirmed
 * login/paywall/permanent block or a body-confirmed static terminal 404/410.
 */
const CONCLUSIVE_EXTERNAL_BLOCK_CLASSES = new Set([
  'LOGIN_WALL',
  'PAYWALL_WALL',
  'PERMANENT_ACCESS_BLOCK',
]);

export function isConclusiveExternalBlock(observation: AcquisitionLaneObservation): boolean {
  if (observation.outcome !== 'ACQUISITION_FAILED' || observation.retryable === true) return false;
  if (observation.staticTerminalNotFound === true || observation.staticNotFoundBodyConfirmed === true) return true;
  return CONCLUSIVE_EXTERNAL_BLOCK_CLASSES.has(upper(observation.failureClass));
}

const QUOTA_CAPACITY_CODES = new Set([
  'YOUTUBE_KEY_CAP_EXCEEDED',
  'YOUTUBE_KEY_CAP_UNAVAILABLE',
  'QUOTA_ALLOCATION_EXHAUSTED',
  'PROVIDER_COOLDOWN',
  'PROVIDER_CONCURRENCY_CAP_EXCEEDED',
  'YOUTUBE_PROVIDERS_COOLING_DOWN',
  'YOUTUBE_PROVIDER_POOL_EXHAUSTED',
  'YOUTUBE_RUNTIME_RATE_PRESSURE',
]);

const QUOTA_CAPACITY_REASON_FRAGMENTS = [
  'YOUTUBE_KEY_CAP',
  'QUOTA_ALLOCATION_EXHAUSTED',
  'PROVIDER_COOLDOWN',
  'PROVIDER_CONCURRENCY_CAP',
  'YOUTUBE_PROVIDERS_COOLING_DOWN',
  'YOUTUBE_PROVIDER_POOL_EXHAUSTED',
  'YOUTUBE_RUNTIME_RATE_PRESSURE',
];

interface CapacitySignal {
  kind: 'CAPACITY' | 'RUNTIME';
  code: string;
}

/**
 * The retry worker grants attempt-free execution only for a proven browser
 * runtime wait; gate saturation is capacity. A generic
 * `COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE` code is intentionally not
 * treated as capacity by itself because the same code also labels genuine
 * retryable acquisition failures.
 */
function capacitySignalFor(directive: AcquisitionLaneRetryDirective | null | undefined): CapacitySignal | undefined {
  if (!directive) return undefined;
  const code = upper(directive.code);
  const retryReason = upper(directive.retryReason);
  const reason = upper(directive.reason);

  const reasonFragments = reason.split(/[,;|]/).map(fragment => fragment.trim()).filter(Boolean);
  const everyReasonIsSaturation = reasonFragments.length > 0
    && reasonFragments.every(fragment => fragment === 'RENDERED_FALLBACK_SATURATED' || fragment === 'BROWSER_GATE_SATURATION');
  if (code === 'RENDERED_FALLBACK_SATURATED' || everyReasonIsSaturation) {
    return { kind: 'CAPACITY', code: 'RENDERED_FALLBACK_SATURATED' };
  }
  if (retryReason === 'BROWSER_RUNTIME_UNAVAILABLE' || isBrowserRuntimeFailureClass(code)) {
    return { kind: 'RUNTIME', code: code || retryReason || 'BROWSER_RUNTIME_UNAVAILABLE' };
  }
  if (QUOTA_CAPACITY_CODES.has(code)) {
    return { kind: 'CAPACITY', code };
  }
  if (QUOTA_CAPACITY_REASON_FRAGMENTS.some(fragment => reason.includes(fragment))) {
    return { kind: 'CAPACITY', code: code || 'QUOTA_ALLOCATION_EXHAUSTED' };
  }
  return undefined;
}

/** Collapse repeated attempts for the same surface+URL to the effective
 * outcome, so a recovered rendered pass supersedes an earlier static failure.
 * Observations without a usable surface/URL stay as-is for audit. */
function collapseLaneObservations(observations: AcquisitionLaneObservation[]): AcquisitionLaneObservation[] {
  const usable = observations.filter(observation =>
    typeof observation.requestedUrl === 'string' && observation.requestedUrl.trim()
    && typeof observation.surface === 'string' && observation.surface.trim()
    && ['FOUND', 'INSPECTED_NO_MATCH', 'PARTIALLY_INSPECTED', 'ACQUISITION_FAILED'].includes(String(observation.outcome || ''))
  );
  const unusable = observations.filter(observation => !usable.includes(observation));
  if (!usable.length) return observations;
  const mapped = usable.map(observation => ({
    ...observation,
    requestedUrl: observation.requestedUrl!,
    surface: observation.surface!,
    outcome: observation.outcome as AcquisitionObservationLike['outcome'],
    required: observation.required === true,
  })) as Array<AcquisitionObservationLike & AcquisitionLaneObservation>;
  return [
    ...effectiveAcquisitionOutcomes(mapped).map(item => item as AcquisitionLaneObservation),
    ...unusable,
  ];
}

export function summarizeAcquisitionInspection(input: {
  inspection?: AcquisitionLaneInspection | null;
  retryDirective?: AcquisitionLaneRetryDirective | null;
}): AcquisitionLaneSummary {
  const inspection = input.inspection || undefined;
  const observations = Array.isArray(inspection?.acquisitionOutcomes)
    ? inspection!.acquisitionOutcomes!.filter((item): item is AcquisitionLaneObservation => !!item && typeof item === 'object')
    : [];
  const directive = input.retryDirective || inspection?.retryDirective;

  let pagesInspected = 0;
  let requestsStarted = 0;
  let gateWaitMs: number | undefined;
  let workRemaining = 0;
  let requiredObservations = 0;
  let foundObservations = 0;
  let failedObservations = 0;
  let partialObservations = 0;
  let inspectedNoMatchObservations = 0;
  let retryOwningObservations = 0;
  let infrastructureFailureObservations = 0;
  let conclusiveBlockObservations = 0;
  let processedObservations = 0;

  // Telemetry is summed over raw attempts; outcome accounting uses the
  // collapsed effective result per surface+URL so recovered work is not
  // reported as still incomplete.
  for (const observation of observations) {
    const telemetry = observation.telemetry || {};
    pagesInspected += nonNegativeCount(telemetry.pagesInspected);
    requestsStarted += nonNegativeCount(telemetry.requestsStarted);
    const wait = nonNegativeCount(telemetry.gateWaitMs);
    if (wait > 0) gateWaitMs = Math.max(gateWaitMs || 0, wait);
  }

  const effectiveObservations = collapseLaneObservations(observations);
  for (const observation of effectiveObservations) {
    if (observation.required === true) requiredObservations++;
    if (observation.outcome === 'FOUND') foundObservations++;
    if (observation.outcome === 'ACQUISITION_FAILED') failedObservations++;
    if (observation.outcome === 'PARTIALLY_INSPECTED') partialObservations++;
    if (observation.outcome === 'INSPECTED_NO_MATCH') inspectedNoMatchObservations++;
    if (isInfrastructureFailureClass(observation.failureClass)) infrastructureFailureObservations++;
    if (isConclusiveExternalBlock(observation)) conclusiveBlockObservations++;
    if (hasDirectProcessedAcquisitionEvidence(observation)) processedObservations++;
    if (observationOwnsAcquisitionRetry(observation)) {
      retryOwningObservations++;
      workRemaining++;
    }
  }

  const signals: AcquisitionLaneSignals = {
    observations: observations.length,
    effectiveObservations: effectiveObservations.length,
    requiredObservations,
    foundObservations,
    failedObservations,
    partialObservations,
    inspectedNoMatchObservations,
    retryOwningObservations,
    infrastructureFailureObservations,
    conclusiveBlockObservations,
    processedObservations,
  };
  const summary = (outcome: AcquisitionOutcome, capacityEvent?: string): AcquisitionLaneSummary => ({
    outcome,
    pagesInspected,
    requestsStarted,
    ...(gateWaitMs !== undefined ? { gateWaitMs } : {}),
    workRemaining,
    ...(capacityEvent ? { capacityEvent } : {}),
    signals,
  });

  const capacity = capacitySignalFor(directive);
  const anyProcessed = observations.some(hasDirectProcessedAcquisitionEvidence);
  const anyAttempted = observations.some(observation => nonNegativeCount(observation.telemetry?.requestsStarted) > 0);
  if (capacity) {
    if (capacity.kind === 'RUNTIME') {
      // The runtime failed after pages/requests were observed. The crawl was
      // cut short, so the result is inconclusive rather than a clean wait.
      return summary(anyProcessed || anyAttempted ? 'INCONCLUSIVE' : 'RUNTIME_UNAVAILABLE', capacity.code);
    }
    // Gate/quota capacity remains a deferral. If work already executed, the
    // pass is inconclusive rather than a clean capacity wait or a failure.
    return summary(anyProcessed ? 'INCONCLUSIVE' : 'CAPACITY_DEFERRED', capacity.code);
  }

  if (foundObservations > 0) return summary('ACQUIRED');

  const required = effectiveObservations.filter(observation => observation.required === true);
  const requiredFailures = required.filter(observation => observation.outcome === 'ACQUISITION_FAILED');
  if (requiredFailures.length > 0) {
    const everyFailureConclusive = requiredFailures.every(isConclusiveExternalBlock);
    if (everyFailureConclusive) return summary('EXTERNALLY_BLOCKED');
    const everyFailureInfra = requiredFailures.every(
      observation => isInfrastructureFailureClass(observation.failureClass),
    );
    if (everyFailureInfra && !anyProcessed) return summary('RUNTIME_UNAVAILABLE');
    return summary('ACQUISITION_FAILED');
  }

  if (retryOwningObservations > 0 || partialObservations > 0) return summary('PARTIALLY_INSPECTED');

  if (inspectedNoMatchObservations > 0) {
    // Every clean no-match row needs its own direct processed evidence. One
    // processed row must never certify a different URL's empty attempt.
    const everyNoMatchProcessed = effectiveObservations
      .filter(observation => observation.outcome === 'INSPECTED_NO_MATCH')
      .every(hasDirectProcessedAcquisitionEvidence);
    return summary(everyNoMatchProcessed ? 'INSPECTED_NO_MATCH' : 'INCONCLUSIVE');
  }

  if (observations.length === 0) {
    return summary(inspection?.acquisitionStatus ? 'INCONCLUSIVE' : 'NEVER_EXECUTED');
  }

  // Any recorded observation — including a non-required failure with no
  // telemetry — is a work signal. NEVER_EXECUTED is reserved for no signal.
  return summary('INCONCLUSIVE');
}
