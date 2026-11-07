/**
 * Phase 0 community-acquisition URL work ledger.
 *
 * This module is pure: it turns durable acquisition observations into the work
 * rows that Phase 1 will materialize in
 * `community_acquisition_url_state`. Phase 0 uses it for a read-only
 * reconciliation report, so the derivation can be reviewed before any worker
 * writes the ledger.
 *
 * Truthfulness rules:
 *
 *   * Required, community-surface work belongs in this ledger. Production's
 *     narrow `STATIC_BUDGET_GAP` exception is included even when
 *     `required=false` because that gap owns a bounded retry in production.
 *     Other optional or borrowed observations never create a work row, but
 *     later optional evidence for an already-admitted URL can still resolve it.
 *   * `neverExecuted` clears only when direct processed evidence exists. A
 *     request that started, or a fetch that returned transport metadata, is
 *     not inspection evidence. Borrowed (`sharedEvidenceFrom`) rows are not
 *     direct execution of this URL.
 *   * `attempts` is the billable retry budget. Genuine transport/site failures
 *     consume it even without telemetry; capacity/browser-runtime parks and
 *     borrowed evidence do not.
 *   * `INSPECTED_NO_MATCH` resolves a URL only when the crawl actually
 *     processed pages. An unevidenced static result stays PENDING so an
 *     incomplete inspection can never become a false NOT_FOUND.
 *   * The effective observation is chosen from the latest inspection window
 *     using the production precedence: any `FOUND`, then required observations
 *     over optional notes, then an unevidenced clean only when nothing else
 *     remains, then rank (FOUND > INSPECTED_NO_MATCH > PARTIALLY_INSPECTED >
 *     ACQUISITION_FAILED), time, and observation id. Selecting the latest
 *     inspection first prevents an old success from hiding a current failure;
 *     required dominance prevents a later optional static clean from hiding a
 *     required browser failure for the same URL.
 */

import { createHash } from 'node:crypto';
import { isCommunityRetryableObservation } from './communityRetryPolicy';

export type CommunityWorkState =
  | 'PENDING'
  | 'RUNNING'
  | 'RESOLVED'
  | 'PARKED_INFRA'
  | 'PARKED_EXTERNAL'
  | 'EXHAUSTED';

export const COMMUNITY_WORK_STATES: readonly CommunityWorkState[] = [
  'PENDING',
  'RUNNING',
  'RESOLVED',
  'PARKED_INFRA',
  'PARKED_EXTERNAL',
  'EXHAUSTED',
];

/**
 * Surfaces that represent creator-owned community acquisition work. Upstream
 * YouTube surfaces (about page, recent video descriptions) stay in their own
 * lane and are not URL work rows for the backlog drain.
 */
export const COMMUNITY_ACQUISITION_WORK_SURFACES: ReadonlySet<string> = new Set([
  'CHANNEL_LINKS',
  'CHANNEL_EXTERNAL_LINKS',
  'EXTERNAL_LINKS',
  'LINKED_WEBSITES',
  'CUSTOM_DOMAINS',
  'SOCIAL_PROFILES',
  'SOCIAL_BIO',
  'CREATOR_WEBSITES',
]);

/**
 * Capacity/runtime failures park the URL without spending its attempt budget.
 * These are the observation-level classes actually persisted by the static and
 * rendered crawlers (browserCapability/browserCommunityFallback) plus the
 * coarse capacity names used by retry directives and shadow classification.
 */
const INFRA_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'BROWSER_RUNTIME',
  'BROWSER_RUNTIME_UNAVAILABLE',
  'BROWSER_BINARY_MISSING',
  'BROWSER_LINUX_DEPENDENCY_MISSING',
  'BROWSER_PERMISSION_DENIED',
  'BROWSER_LAUNCH_FAILED',
  'CAPACITY',
  'CAPACITY_ADMISSION_UNAVAILABLE',
  'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE',
  'QUOTA_ALLOCATION_EXHAUSTED',
  'BROWSER_GATE_SATURATION',
  'RENDERED_FALLBACK_SATURATED',
  'RATE_LIMIT',
  'RATE_LIMITED',
]);

export interface CommunityWorkObservation {
  channelId: string;
  requestedUrl: string;
  outcome: string;
  retryable: boolean;
  failureClass?: string | null;
  observedAt: string;
  /** Durable observation id. Used only for deterministic same-timestamp ties. */
  id?: string;
  provenance?: unknown;
}

/**
 * Production's current-inspection boundary. Observations from one inspector
 * run can be stamped minutes apart (static vs rendered), but older runs must
 * never outrank the latest one.
 */
export const COMMUNITY_INSPECTION_WINDOW_MS = 5 * 60 * 1000;

export interface CommunityWorkProjectionRow {
  workKey: string;
  channelId: string;
  url: string;
  normalizedUrl: string;
  surface: string;
  state: CommunityWorkState;
  neverExecuted: boolean;
  neverBrowserExecuted: boolean;
  attempts: number;
  maxAttempts: number;
  firstObservedAt: string;
  lastAttemptAt: string | null;
  lastFailureClass: string | null;
  lastOutcome: string;
  terminalReason: string | null;
  terminalEvidence: Record<string, unknown>;
  retryOwned: boolean;
  observations: number;
}

export interface CommunityWorkProjectionStats {
  observedRows: number;
  workRows: number;
  skippedRows: number;
  byState: Record<CommunityWorkState, number>;
  retryableRows: number;
  neverExecutedRows: number;
  neverBrowserExecutedRows: number;
  retryableNeverBrowserExecutedRows: number;
}

export interface CommunityWorkReconciliation {
  telemetryRetryableRows: number;
  projectionRetryableRows: number;
  retryableDelta: number;
  retryableDeltaPct: number;
  retryableWithinFivePercent: boolean;
  telemetryNeverBrowserExecutedRows: number;
  projectionRetryableNeverBrowserExecutedRows: number;
  neverExecutedDelta: number;
  neverExecutedDeltaPct: number;
  neverExecutedWithinFivePercent: boolean;
}

interface TelemetryFacts {
  mode: string;
  pagesInspected: number;
  requestsStarted: number;
  requestsFinished: number;
  clicksSucceeded: number;
  clicksFailed: number;
  budgetExhausted: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Accept only JSON numbers. Booleans, arrays, and strings are malformed input. */
function nonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function telemetryFactsFromProvenance(provenance: unknown): TelemetryFacts {
  const root = asRecord(provenance);
  const telemetry = asRecord(root?.crawlerTelemetry);
  return {
    mode: typeof telemetry?.mode === 'string' ? telemetry.mode.toUpperCase() : '',
    pagesInspected: nonNegativeInt(telemetry?.pagesInspected),
    requestsStarted: nonNegativeInt(telemetry?.requestsStarted),
    requestsFinished: nonNegativeInt(telemetry?.requestsFinished),
    clicksSucceeded: nonNegativeInt(telemetry?.clicksSucceeded),
    clicksFailed: nonNegativeInt(telemetry?.clicksFailed),
    budgetExhausted: telemetry?.budgetExhausted === true,
  };
}

export function surfaceFromObservation(observation: CommunityWorkObservation): string {
  const provenance = asRecord(observation.provenance);
  return typeof provenance?.surface === 'string' ? provenance.surface.trim().toUpperCase() : '';
}

/** The production retry predicate owns required community observations. */
export function isRequiredCommunityWorkObservation(observation: CommunityWorkObservation): boolean {
  return asRecord(observation.provenance)?.required === true;
}

/**
 * Production's narrow static-budget-gap exception: a retryable
 * `PARTIALLY_INSPECTED` static seed owns bounded retry even though static
 * seeds run with `required=false`. It is genuine URL work, not optional
 * filler, so it belongs in the ledger.
 */
export function isStaticBudgetGapWorkObservation(observation: CommunityWorkObservation): boolean {
  return observation.outcome === 'PARTIALLY_INSPECTED'
    && failureClassOf(observation) === 'STATIC_BUDGET_GAP'
    && observation.retryable === true;
}

/** Work rows the ledger materializes: required work plus the static-gap exception. */
export function isCommunityLedgerWorkObservation(observation: CommunityWorkObservation): boolean {
  return isRequiredCommunityWorkObservation(observation)
    || isStaticBudgetGapWorkObservation(observation);
}

function relevanceTierOf(observation: CommunityWorkObservation): string | undefined {
  const value = asRecord(observation.provenance)?.relevanceTier;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Lender seed URL when this row only references another same-inspection fetch.
 * Such a row carries no page counters of its own, so it must never be charged
 * as this URL's attempt or browser execution.
 */
export function sharedEvidenceSource(observation: CommunityWorkObservation): string {
  const value = asRecord(observation.provenance)?.sharedEvidenceFrom;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A completed page/request/click is direct processed evidence. `requestsStarted`
 * alone is deliberately excluded: a request that starts and then hangs or is
 * killed has not executed the work. Borrowed evidence is never direct.
 */
export function hasDirectProcessedAcquisitionEvidence(observation: CommunityWorkObservation): boolean {
  if (sharedEvidenceSource(observation)) return false;
  const telemetry = telemetryFactsFromProvenance(observation.provenance);
  if (telemetry.pagesInspected > 0) return true;
  if (telemetry.requestsFinished > 0) return true;
  if (telemetry.clicksSucceeded > 0) return true;
  // A FOUND outcome is itself durable acquisition evidence; an
  // INSPECTED_NO_MATCH result still needs page/request evidence.
  return observation.outcome === 'FOUND';
}

/**
 * Ledger processed check: borrowed same-inspection evidence is genuine
 * inspection evidence for resolution, but it is not direct execution of this
 * URL (see `hasDirectProcessedAcquisitionEvidence`).
 *
 * This is deliberately stricter than the inspector's defense-in-depth check,
 * which also accepts `requestsStarted` and `redirectsFollowed`. A started
 * request or followed redirect alone never proves a page was inspected, so it
 * cannot turn absent evidence into a terminal NOT_FOUND. The divergence is
 * intentional and prevents false negatives.
 */
export function hasProcessedAcquisitionEvidence(observation: CommunityWorkObservation): boolean {
  if (sharedEvidenceSource(observation)) return true;
  return hasDirectProcessedAcquisitionEvidence(observation);
}

/** Browser execution requires rendered mode plus direct processed activity. */
export function hasBrowserExecution(observation: CommunityWorkObservation): boolean {
  if (sharedEvidenceSource(observation)) return false;
  const telemetry = telemetryFactsFromProvenance(observation.provenance);
  if (telemetry.mode !== 'RENDERED') return false;
  return telemetry.requestsFinished > 0
    || telemetry.pagesInspected > 0
    || telemetry.clicksSucceeded > 0;
}

export function failureClassOf(observation: CommunityWorkObservation): string {
  return String(observation.failureClass || '').trim().toUpperCase();
}

export function isInfrastructureFailure(observation: CommunityWorkObservation): boolean {
  return observation.outcome === 'ACQUISITION_FAILED'
    && INFRA_FAILURE_CLASSES.has(failureClassOf(observation));
}

/**
 * Billable attempt accounting:
 *   * direct processed work always counts (the URL executed, even if an infra
 *     failure interrupted it afterwards);
 *   * genuine transport/site failures count even with no telemetry;
 *   * infrastructure/capacity waits and borrowed evidence do not count.
 */
export function countsTowardAttemptBudget(observation: CommunityWorkObservation): boolean {
  if (sharedEvidenceSource(observation)) return false;
  if (hasDirectProcessedAcquisitionEvidence(observation)) return true;
  if (isInfrastructureFailure(observation)) return false;
  return observation.outcome === 'ACQUISITION_FAILED';
}

/**
 * Effective retry ownership. Delegate to the production predicate so the
 * ledger cannot drift from the worker:
 *
 *   * required retryable `ACQUISITION_FAILED` / `PARTIALLY_INSPECTED`;
 *   * required `FOUND` rows with an outstanding bounded gap class;
 *   * eligible `PARTIALLY_INSPECTED` `STATIC_BUDGET_GAP` rows even when
 *     `required=false`;
 *   * no deterministic permanent failure, BLOCK/DEMOTE tier, auxiliary URL,
 *     or borrowed shared evidence.
 */
export function observationOwnsRetry(observation: CommunityWorkObservation): boolean {
  if (sharedEvidenceSource(observation)) return false;
  if (!isCommunityLedgerWorkObservation(observation)) return false;
  return isCommunityRetryableObservation({
    required: isRequiredCommunityWorkObservation(observation),
    surface: surfaceFromObservation(observation),
    outcome: observation.outcome,
    retryable: observation.retryable,
    failureClass: observation.failureClass ?? undefined,
    requestedUrl: observation.requestedUrl,
    relevanceTier: relevanceTierOf(observation),
  });
}

/**
 * Canonical work identity. Host/scheme are case-insensitive; path case is
 * preserved because many sites route by case. Fragments never reach a server
 * and are dropped. Trailing path slashes are equivalent for this ledger.
 */
export function normalizeCommunityWorkUrl(raw: string): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'http:' && parsed.port === '80')
    || (parsed.protocol === 'https:' && parsed.port === '443')) {
    parsed.port = '';
  }
  let pathname = parsed.pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.replace(/\/+$/, '');
  parsed.pathname = pathname;
  return parsed.toString();
}

/**
 * Stable hash(channel_id, normalized_url, surface). Exported so Phase 1's
 * writer and the read-only report cannot drift.
 */
export function communityAcquisitionWorkKey(
  channelId: string,
  normalizedUrl: string,
  surface: string,
): string {
  return createHash('sha256')
    .update(`${channelId}\n${surface}\n${normalizedUrl}`)
    .digest('hex');
}

function observationRank(observation: CommunityWorkObservation): number {
  switch (observation.outcome) {
    case 'FOUND': return 4;
    case 'INSPECTED_NO_MATCH': return 3;
    case 'PARTIALLY_INSPECTED': return 2;
    case 'ACQUISITION_FAILED': return 1;
    default: return 0;
  }
}

function observedAtMs(observation: CommunityWorkObservation): number {
  const value = Date.parse(observation.observedAt);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/**
 * Latest-inspection candidates. Production evaluates retry ownership against
 * the current inspection (observations around `last_checked`), not against the
 * whole reporting window. Using the group's newest observation as the anchor
 * is equivalent for append-only URL history and keeps the pure projection
 * independent of `channels.last_checked`.
 */
export function latestInspectionObservations(
  observations: readonly CommunityWorkObservation[],
): CommunityWorkObservation[] {
  let latest = Number.NEGATIVE_INFINITY;
  for (const observation of observations) {
    latest = Math.max(latest, observedAtMs(observation));
  }
  if (latest === Number.NEGATIVE_INFINITY) return [...observations];
  const cutoff = latest - COMMUNITY_INSPECTION_WINDOW_MS;
  return observations.filter(observation => observedAtMs(observation) >= cutoff);
}

/**
 * Rank-first effective selection. Timestamps are a tie-breaker because the
 * inspector stamps rendered observations at inspection start while static
 * observations get a later timestamp. The observation id makes equal
 * timestamps deterministic and matches the SQL bound's `id DESC` ordering.
 */
function isPreferredObservation(
  candidate: CommunityWorkObservation,
  current: CommunityWorkObservation,
): boolean {
  const candidateRank = observationRank(candidate);
  const currentRank = observationRank(current);
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  const candidateAt = observedAtMs(candidate);
  const currentAt = observedAtMs(current);
  if (candidateAt !== currentAt) return candidateAt > currentAt;
  const candidateId = String(candidate.id || '');
  const currentId = String(current.id || '');
  return candidateId > currentId;
}

/**
 * Effective observation selection within one inspection, mirroring the
 * production `effectiveAcquisitionOutcomes` precedence:
 *
 *   1. Any `FOUND` wins outright: a discovered candidate must never be lost
 *      to an optional static note, so optional recovery can still resolve an
 *      admitted key.
 *   2. Otherwise required observations dominate optional notes: a required
 *      rendered failure outranks a later non-required static clean for the
 *      same URL. Falling back to optional rows only when no required result
 *      remains is what lets the completed static-gap case resolve.
 *   3. Within that pool an unevidenced `INSPECTED_NO_MATCH` never beats a
 *      real signal; it only wins when it is the sole pool.
 *   4. Rank, then latest time, then observation id.
 */
export function selectEffectiveInspectionObservation(
  observations: readonly CommunityWorkObservation[],
): CommunityWorkObservation | null {
  if (observations.length === 0) return null;
  const found = observations.filter(observation => observation.outcome === 'FOUND');
  let pool: readonly CommunityWorkObservation[];
  if (found.length > 0) {
    pool = found;
  } else {
    const required = observations.filter(isRequiredCommunityWorkObservation);
    pool = required.length > 0 ? required : observations;
  }
  const evidenced = pool.filter(
    observation => observation.outcome !== 'INSPECTED_NO_MATCH'
      || hasProcessedAcquisitionEvidence(observation),
  );
  const finalists = evidenced.length > 0 ? evidenced : pool;
  let best = finalists[0];
  for (const observation of finalists) {
    if (isPreferredObservation(observation, best)) best = observation;
  }
  return best;
}

export function resolveCommunityWorkState(
  latest: CommunityWorkObservation,
  attempts: number,
  maxAttempts: number,
): { state: CommunityWorkState; terminalReason: string | null } {
  const failureClass = failureClassOf(latest);
  // A FOUND row is terminal only when nothing bounded remains to recover. A
  // required FOUND carrying an outstanding gap class (multi-invite recall) is
  // still retry work, so it must stay claimable instead of resolving and
  // leaving the gap unscheduled behind PENDING/RUNNING-only claim indexes.
  if (latest.outcome === 'FOUND' && !observationOwnsRetry(latest)) {
    return { state: 'RESOLVED', terminalReason: 'FOUND' };
  }
  if (latest.outcome === 'INSPECTED_NO_MATCH') {
    if (hasProcessedAcquisitionEvidence(latest)) {
      return { state: 'RESOLVED', terminalReason: 'INSPECTED_NO_MATCH' };
    }
    // Unevidenced absence is inconclusive, never a terminal NOT_FOUND. It
    // still obeys the attempt cap so an exhausted URL cannot loop forever.
    if (attempts >= maxAttempts) {
      return { state: 'EXHAUSTED', terminalReason: 'MAX_ATTEMPTS' };
    }
    return { state: 'PENDING', terminalReason: null };
  }
  if (attempts >= maxAttempts) {
    return { state: 'EXHAUSTED', terminalReason: 'MAX_ATTEMPTS' };
  }
  if (latest.outcome === 'ACQUISITION_FAILED' && INFRA_FAILURE_CLASSES.has(failureClass)) {
    return { state: 'PARKED_INFRA', terminalReason: failureClass };
  }
  return { state: 'PENDING', terminalReason: null };
}

export interface ProjectCommunityWorkOptions {
  maxAttempts?: number;
  surfaces?: ReadonlySet<string>;
}

export function projectCommunityAcquisitionWork(
  observations: readonly CommunityWorkObservation[],
  options: ProjectCommunityWorkOptions = {},
): { rows: CommunityWorkProjectionRow[]; stats: CommunityWorkProjectionStats } {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const surfaces = options.surfaces ?? COMMUNITY_ACQUISITION_WORK_SURFACES;
  const grouped = new Map<string, {
    channelId: string;
    normalizedUrl: string;
    url: string;
    surface: string;
    observations: CommunityWorkObservation[];
  }>();
  let skippedRows = 0;
  const admittedKeys = new Set<string>();
  const candidates: Array<{
    workKey: string;
    channelId: string;
    normalizedUrl: string;
    url: string;
    surface: string;
    observation: CommunityWorkObservation;
  }> = [];

  // First pass: validate identity and decide which work keys exist. A key is
  // admitted by required work or the static-gap exception. Optional evidence
  // for a different URL never creates a row.
  for (const observation of observations) {
    const surface = surfaceFromObservation(observation);
    if (!surfaces.has(surface)) {
      skippedRows++;
      continue;
    }
    const normalizedUrl = normalizeCommunityWorkUrl(observation.requestedUrl);
    if (!normalizedUrl) {
      skippedRows++;
      continue;
    }
    const channelId = String(observation.channelId || '').trim();
    if (!channelId) {
      skippedRows++;
      continue;
    }
    const workKey = communityAcquisitionWorkKey(channelId, normalizedUrl, surface);
    if (isCommunityLedgerWorkObservation(observation)) admittedKeys.add(workKey);
    candidates.push({
      workKey,
      channelId,
      normalizedUrl,
      url: String(observation.requestedUrl),
      surface,
      observation,
    });
  }

  // Second pass: keep every observation for an admitted key, even optional
  // ones. Static seeds recover with required=false FOUND/INSPECTED_NO_MATCH
  // rows; dropping them would leave an old static gap looking retry-owned
  // forever. Shared-evidence counters remain non-billable inside the group.
  for (const candidate of candidates) {
    if (!admittedKeys.has(candidate.workKey)) {
      skippedRows++;
      continue;
    }
    const existing = grouped.get(candidate.workKey);
    if (existing) {
      existing.observations.push(candidate.observation);
    } else {
      grouped.set(candidate.workKey, {
        channelId: candidate.channelId,
        normalizedUrl: candidate.normalizedUrl,
        url: candidate.url,
        surface: candidate.surface,
        observations: [candidate.observation],
      });
    }
  }

  const rows: CommunityWorkProjectionRow[] = [];
  const byState = Object.fromEntries(
    COMMUNITY_WORK_STATES.map(state => [state, 0]),
  ) as Record<CommunityWorkState, number>;
  let retryableRows = 0;
  let neverExecutedRows = 0;
  let neverBrowserExecutedRows = 0;
  let retryableNeverBrowserExecutedRows = 0;

  for (const [workKey, group] of grouped) {
    const inspectionCandidates = latestInspectionObservations(group.observations);
    const latest = selectEffectiveInspectionObservation(inspectionCandidates);
    if (!latest) continue;
    let earliestAt = group.observations[0].observedAt;
    let attempts = 0;
    let directProcessedExecutions = 0;
    let browserExecutions = 0;
    let lastAttemptAt: string | null = null;

    for (const observation of group.observations) {
      if (Date.parse(observation.observedAt) < Date.parse(earliestAt)) {
        earliestAt = observation.observedAt;
      }
      if (hasDirectProcessedAcquisitionEvidence(observation)) directProcessedExecutions++;
      if (hasBrowserExecution(observation)) browserExecutions++;
      if (countsTowardAttemptBudget(observation)) {
        attempts++;
        if (!lastAttemptAt || Date.parse(observation.observedAt) > Date.parse(lastAttemptAt)) {
          lastAttemptAt = observation.observedAt;
        }
      }
    }

    const { state, terminalReason } = resolveCommunityWorkState(latest, attempts, maxAttempts);
    const neverExecuted = directProcessedExecutions === 0;
    const neverBrowserExecuted = browserExecutions === 0;
    const retryOwned = observationOwnsRetry(latest);
    byState[state]++;
    if (retryOwned) retryableRows++;
    if (neverExecuted) neverExecutedRows++;
    if (neverBrowserExecuted) neverBrowserExecutedRows++;
    if (retryOwned && neverBrowserExecuted) retryableNeverBrowserExecutedRows++;

    rows.push({
      workKey,
      channelId: group.channelId,
      url: group.url,
      normalizedUrl: group.normalizedUrl,
      surface: group.surface,
      state,
      neverExecuted,
      neverBrowserExecuted,
      attempts,
      maxAttempts,
      firstObservedAt: earliestAt,
      lastAttemptAt,
      lastFailureClass: latest.failureClass ? String(latest.failureClass) : null,
      lastOutcome: latest.outcome,
      terminalReason,
      terminalEvidence: {
        observationCount: group.observations.length,
        processedExecutions: directProcessedExecutions,
        billableAttempts: attempts,
        browserExecutions,
        latestOutcome: latest.outcome,
        latestObservedAt: latest.observedAt,
        latestFailureClass: latest.failureClass || null,
        retryOwned,
      },
      retryOwned,
      observations: group.observations.length,
    });
  }

  rows.sort((a, b) => a.channelId.localeCompare(b.channelId)
    || a.surface.localeCompare(b.surface)
    || a.normalizedUrl.localeCompare(b.normalizedUrl));

  return {
    rows,
    stats: {
      observedRows: observations.length,
      workRows: rows.length,
      skippedRows,
      byState,
      retryableRows,
      neverExecutedRows,
      neverBrowserExecutedRows,
      retryableNeverBrowserExecutedRows,
    },
  };
}

export function percentDelta(actual: number, expected: number): number {
  if (expected <= 0) return actual === 0 ? 0 : 100;
  return Math.abs(actual - expected) / expected * 100;
}

export function reconcileCommunityWorkProjection(
  projection: Pick<CommunityWorkProjectionStats,
    'retryableRows' | 'neverBrowserExecutedRows' | 'retryableNeverBrowserExecutedRows'>,
  telemetry: { retryableRows: number; neverBrowserExecutedRows: number },
  tolerancePct = 5,
): CommunityWorkReconciliation {
  const retryableDelta = projection.retryableRows - telemetry.retryableRows;
  const neverExecutedDelta = projection.retryableNeverBrowserExecutedRows - telemetry.neverBrowserExecutedRows;
  const retryableDeltaPct = percentDelta(projection.retryableRows, telemetry.retryableRows);
  const neverExecutedDeltaPct = percentDelta(
    projection.retryableNeverBrowserExecutedRows,
    telemetry.neverBrowserExecutedRows,
  );
  return {
    telemetryRetryableRows: telemetry.retryableRows,
    projectionRetryableRows: projection.retryableRows,
    retryableDelta,
    retryableDeltaPct,
    retryableWithinFivePercent: retryableDeltaPct <= tolerancePct,
    telemetryNeverBrowserExecutedRows: telemetry.neverBrowserExecutedRows,
    projectionRetryableNeverBrowserExecutedRows: projection.retryableNeverBrowserExecutedRows,
    neverExecutedDelta,
    neverExecutedDeltaPct,
    neverExecutedWithinFivePercent: neverExecutedDeltaPct <= tolerancePct,
  };
}
