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
 *   * Only required, community-surface work belongs in this ledger. Optional
 *     or borrowed observations never inflate the backlog.
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
 *   * The effective observation is chosen rank-first (FOUND >
 *     INSPECTED_NO_MATCH > PARTIALLY_INSPECTED > ACQUISITION_FAILED), then by
 *     time. This mirrors the production retry predicate and tolerates
 *     inspection-start timestamp skew between static and rendered rows.
 */

import { createHash } from 'node:crypto';

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
  provenance?: unknown;
}

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

/** The production retry predicate only owns required community observations. */
export function isRequiredCommunityWorkObservation(observation: CommunityWorkObservation): boolean {
  return asRecord(observation.provenance)?.required === true;
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
 * Production-compatible processed check: borrowed same-inspection evidence is
 * genuine inspection evidence for resolution, but it is not direct execution
 * of this URL (see `hasDirectProcessedAcquisitionEvidence`).
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
 * Effective retry ownership, matching the production predicate: the chosen
 * observation is a required ACQUISITION_FAILED row that is retryable and is
 * not the deterministic REDIRECT_LIMIT case.
 */
export function observationOwnsRetry(observation: CommunityWorkObservation): boolean {
  if (!isRequiredCommunityWorkObservation(observation)) return false;
  if (sharedEvidenceSource(observation)) return false;
  if (failureClassOf(observation) === 'REDIRECT_LIMIT') return false;
  return observation.outcome === 'ACQUISITION_FAILED' && observation.retryable === true;
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

/**
 * Rank-first effective selection. Timestamps are only a tie-breaker: the
 * inspector stamps rendered observations at inspection start while static
 * observations get a later timestamp, so pure time ordering can prefer an
 * older failure over a newer successful rendered run.
 */
function isPreferredObservation(
  candidate: CommunityWorkObservation,
  current: CommunityWorkObservation,
): boolean {
  const candidateRank = observationRank(candidate);
  const currentRank = observationRank(current);
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  const candidateAt = Date.parse(candidate.observedAt);
  const currentAt = Date.parse(current.observedAt);
  if (Number.isFinite(candidateAt) && Number.isFinite(currentAt) && candidateAt !== currentAt) {
    return candidateAt > currentAt;
  }
  return false;
}

export function resolveCommunityWorkState(
  latest: CommunityWorkObservation,
  attempts: number,
  maxAttempts: number,
): { state: CommunityWorkState; terminalReason: string | null } {
  const failureClass = failureClassOf(latest);
  if (latest.outcome === 'FOUND') {
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

  for (const observation of observations) {
    const surface = surfaceFromObservation(observation);
    if (!surfaces.has(surface)) {
      skippedRows++;
      continue;
    }
    // Optional/auxiliary observations are not backlog work. Shared-evidence
    // rows still describe real work (and may carry a FOUND outcome), but their
    // borrowed counters never count as this URL's execution or attempt.
    if (!isRequiredCommunityWorkObservation(observation)) {
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
    const existing = grouped.get(workKey);
    if (existing) {
      existing.observations.push(observation);
    } else {
      grouped.set(workKey, {
        channelId,
        normalizedUrl,
        url: String(observation.requestedUrl),
        surface,
        observations: [observation],
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
    let latest = group.observations[0];
    let earliestAt = latest.observedAt;
    let attempts = 0;
    let directProcessedExecutions = 0;
    let browserExecutions = 0;
    let lastAttemptAt: string | null = null;

    for (const observation of group.observations) {
      if (isPreferredObservation(observation, latest)) latest = observation;
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
