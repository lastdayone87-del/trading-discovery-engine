/**
 * Phase 0 community-acquisition URL work ledger.
 *
 * This module is pure: it turns durable acquisition observations into the work
 * rows that Phase 1 will materialize in
 * `community_acquisition_url_state`. Phase 0 uses it for a read-only
 * reconciliation report, so the derivation can be reviewed before any worker
 * writes the ledger.
 *
 * Two distinctions matter for truthfulness:
 *
 *   * `neverExecuted` clears only when processed evidence exists. A request
 *     that started, or a fetch that returned transport metadata, is not
 *     inspection evidence.
 *   * `INSPECTED_NO_MATCH` resolves a URL only when the crawl actually
 *     processed pages. An unevidenced static result stays PENDING so an
 *     incomplete inspection can never become a false NOT_FOUND.
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

/** Capacity/runtime failures park the URL without spending its attempt budget. */
const INFRA_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'BROWSER_RUNTIME_UNAVAILABLE',
  'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE',
  'RENDERED_FALLBACK_SATURATED',
  'RATE_LIMITED',
  'QUOTA_ALLOCATION_EXHAUSTED',
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
  anyRetryable: boolean;
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
  projectionNeverBrowserExecutedRows: number;
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

function nonNegativeInt(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
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

/**
 * A completed page/request/click is processed evidence. `requestsStarted`
 * alone is deliberately excluded: a request that starts and then hangs or is
 * killed has not executed the work.
 */
export function hasProcessedAcquisitionEvidence(observation: CommunityWorkObservation): boolean {
  const telemetry = telemetryFactsFromProvenance(observation.provenance);
  if (telemetry.pagesInspected > 0) return true;
  if (telemetry.requestsFinished > 0) return true;
  if (telemetry.clicksSucceeded > 0) return true;
  // A FOUND outcome is itself durable acquisition evidence; an
  // INSPECTED_NO_MATCH result still needs page/request evidence.
  return observation.outcome === 'FOUND';
}

/** Browser execution requires rendered mode plus processed browser activity. */
export function hasBrowserExecution(observation: CommunityWorkObservation): boolean {
  const telemetry = telemetryFactsFromProvenance(observation.provenance);
  if (telemetry.mode !== 'RENDERED') return false;
  return telemetry.requestsFinished > 0
    || telemetry.pagesInspected > 0
    || telemetry.clicksSucceeded > 0;
}

/**
 * Canonical work identity. Host/scheme are case-insensitive; path case is
 * preserved because many sites route by case. Fragments never reach a server
 * and are dropped. Trailing slashes are equivalent for this ledger.
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

function isLaterObservation(
  candidate: CommunityWorkObservation,
  current: CommunityWorkObservation,
): boolean {
  const candidateAt = Date.parse(candidate.observedAt);
  const currentAt = Date.parse(current.observedAt);
  if (Number.isFinite(candidateAt) && Number.isFinite(currentAt) && candidateAt !== currentAt) {
    return candidateAt > currentAt;
  }
  return observationRank(candidate) > observationRank(current);
}

export function resolveCommunityWorkState(
  latest: CommunityWorkObservation,
  attempts: number,
  maxAttempts: number,
): { state: CommunityWorkState; terminalReason: string | null } {
  const failureClass = String(latest.failureClass || '').trim().toUpperCase();
  if (latest.outcome === 'FOUND') {
    return { state: 'RESOLVED', terminalReason: 'FOUND' };
  }
  if (latest.outcome === 'INSPECTED_NO_MATCH') {
    if (hasProcessedAcquisitionEvidence(latest)) {
      return { state: 'RESOLVED', terminalReason: 'INSPECTED_NO_MATCH' };
    }
    // Unevidenced absence is inconclusive, never a terminal NOT_FOUND.
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
    let anyRetryable = false;
    let anyBrowserExecution = false;
    let lastAttemptAt: string | null = null;

    for (const observation of group.observations) {
      if (isLaterObservation(observation, latest)) latest = observation;
      if (Date.parse(observation.observedAt) < Date.parse(earliestAt)) {
        earliestAt = observation.observedAt;
      }
      if (observation.retryable) anyRetryable = true;
      if (hasProcessedAcquisitionEvidence(observation)) {
        attempts++;
        if (!lastAttemptAt || Date.parse(observation.observedAt) > Date.parse(lastAttemptAt)) {
          lastAttemptAt = observation.observedAt;
        }
      }
      if (hasBrowserExecution(observation)) anyBrowserExecution = true;
    }

    const { state, terminalReason } = resolveCommunityWorkState(latest, attempts, maxAttempts);
    const neverExecuted = attempts === 0;
    const neverBrowserExecuted = !anyBrowserExecution;
    if (state !== 'RESOLVED') {
      byState[state]++;
    } else {
      byState.RESOLVED++;
    }
    if (anyRetryable) retryableRows++;
    if (neverExecuted) neverExecutedRows++;
    if (neverBrowserExecuted) neverBrowserExecutedRows++;
    if (anyRetryable && neverBrowserExecuted) retryableNeverBrowserExecutedRows++;

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
        processedExecutions: attempts,
        browserExecutions: anyBrowserExecution ? 1 : 0,
        latestOutcome: latest.outcome,
        latestObservedAt: latest.observedAt,
        latestFailureClass: latest.failureClass || null,
      },
      anyRetryable,
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
    projectionNeverBrowserExecutedRows: projection.retryableNeverBrowserExecutedRows,
    neverExecutedDelta,
    neverExecutedDeltaPct,
    neverExecutedWithinFivePercent: neverExecutedDeltaPct <= tolerancePct,
  };
}
