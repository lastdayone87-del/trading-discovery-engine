import type { ChannelRecord, DiscoverySource } from '../src/types';
import type { DiscoveredChannelRaw } from './youtube';
import type { FunnelOutcome } from './queryPerformance';

/**
 * Phase 3: search/classification decoupling.
 *
 * Search workers keep discovery cheap: they persist a nomination, apply the
 * existing preservation policy, and enqueue only candidates that genuinely
 * need country/trading classification. The durable
 * CLASSIFY_DISCOVERED_CHANNEL job runs the same unified ingestion pipeline in
 * the enrichment pool, so retrieval is no longer head-of-line blocked by
 * semantic provider waits.
 *
 * The durable admission path is the default. It never changes discovery
 * semantics: the pipeline, terminal projections, preservation rules, and
 * idempotency guards are shared with the inline path. Setting the flag to an
 * explicit false is the rollback switch and restores the legacy inline loop.
 */

export const CLASSIFICATION_JOB_TYPE = 'CLASSIFY_DISCOVERED_CHANNEL' as const;

/** Rollback switch. Explicit false restores the legacy inline channel loop. */
export const CLASSIFICATION_DECOUPLING_FLAG = 'SEARCH_CLASSIFICATION_DECOUPLING_ENABLED';

/** Global cap on PENDING/PROCESSING classification jobs. */
export const CLASSIFICATION_MAX_PENDING_DEFAULT = 500;

/** Per query-run/query scope cap on PENDING/PROCESSING classification jobs. */
export const CLASSIFICATION_MAX_PER_QUERY_DEFAULT = 50;

/**
 * New discoveries outrank the default ENRICH_CHANNEL priority (10) so the
 * classification lane drains promptly, but stays below search continuations
 * (20) and manual/operator work.
 */
export const CLASSIFICATION_JOB_PRIORITY_DEFAULT = 15;

/** Classification + first ENRICH attempt per classification job. */
export const CLASSIFICATION_JOB_MAX_ATTEMPTS_DEFAULT = 4;

/** Measured production search width; kept as a pure default for diagnostics. */
export const SEARCH_WORKER_CONCURRENCY_DEFAULT = 4;
/** Measured production enrichment width; Phase 3 preserves three workers. */
export const ENRICHMENT_WORKER_CONCURRENCY_DEFAULT = 3;

export interface ClassificationDecouplingConfig {
  enabled: boolean;
  maxPending: number;
  maxPerQuery: number;
  priority: number;
  maxAttempts: number;
}

function positiveInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

const warnedFlagValues = new Set<string>();

/**
 * Default-on feature switches still need an unambiguous rollback value.
 * Missing, empty, or unrecognized values keep the shipped default; only an
 * explicit falsey token disables the path. Unrecognized values are warned
 * about once per distinct token so a rollback written as `disabled` or `nope`
 * does not silently leave the queue active.
 */
function flagEnabled(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const raw = String(value).trim();
  const normalized = raw.toLowerCase();
  if (['false', '0', 'off', 'no'].includes(normalized)) return false;
  if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  if (!warnedFlagValues.has(normalized)) {
    warnedFlagValues.add(normalized);
    console.warn(
      `[Classification] Unrecognized ${CLASSIFICATION_DECOUPLING_FLAG} value "${raw}"; `
      + `keeping the default (${fallback ? 'enabled' : 'disabled'}). `
      + 'Use false/0/off to roll back.',
    );
  }
  return fallback;
}

/**
 * Worker-lane counts preserve the operator's historical validation: an
 * explicit zero or negative value still means "one worker", while a missing
 * or non-numeric value falls back to the measured default instead of letting
 * NaN collapse the pool to one worker by accident.
 */
function workerCount(value: unknown, fallback: number): number {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

export function resolveClassificationDecouplingConfig(
  env: NodeJS.ProcessEnv = process.env,
): ClassificationDecouplingConfig {
  return {
    enabled: flagEnabled(env[CLASSIFICATION_DECOUPLING_FLAG], true),
    maxPending: positiveInt(env.CLASSIFY_DISCOVERED_CHANNEL_MAX_PENDING, CLASSIFICATION_MAX_PENDING_DEFAULT, 100_000),
    maxPerQuery: positiveInt(env.CLASSIFY_DISCOVERED_CHANNEL_MAX_PER_QUERY, CLASSIFICATION_MAX_PER_QUERY_DEFAULT, 10_000),
    priority: positiveInt(env.CLASSIFY_DISCOVERED_CHANNEL_PRIORITY, CLASSIFICATION_JOB_PRIORITY_DEFAULT, 1_000),
    maxAttempts: positiveInt(env.CLASSIFY_DISCOVERED_CHANNEL_MAX_ATTEMPTS, CLASSIFICATION_JOB_MAX_ATTEMPTS_DEFAULT, 20),
  };
}

export function resolveSearchWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  return workerCount(env.SEARCH_WORKER_CONCURRENCY, SEARCH_WORKER_CONCURRENCY_DEFAULT);
}

export function resolveEnrichmentWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  // startWorkerPool historically capped one enrichment pool at 20 workers.
  // Decoupling starts two pools, so enforce the same total here before the
  // split; otherwise a large env value could launch up to 40 workers.
  return Math.min(20, workerCount(env.ENRICHMENT_WORKER_CONCURRENCY, ENRICHMENT_WORKER_CONCURRENCY_DEFAULT));
}

/**
 * Split the measured enrichment pool without changing its total size.
 *
 * New classifications must not starve the pre-existing ENRICH backlog, so at
 * most `total - 1` workers are classification-capable once the pool has more
 * than one worker. The shared workers claim classifications first and fall
 * back to ENRICH; at least one worker always remains ENRICH-only. With a
 * single worker there is no second lane, so that worker handles both.
 *
 * After a rollback the flag is off but old PENDING classification jobs must
 * still drain, so one shared worker remains; the other workers stay dedicated
 * to the existing ENRICH backlog.
 */
export function resolveEnrichmentWorkerSplit(totalWorkers: number, decouplingEnabled = true): {
  classificationWorkers: number;
  enrichmentOnlyWorkers: number;
} {
  // Do not impose a second, lower cap here: the resolver owns the historical
  // 20-worker startup ceiling, and direct callers expect their total preserved
  // through the split rather than silently dropped.
  const total = positiveInt(totalWorkers, ENRICHMENT_WORKER_CONCURRENCY_DEFAULT);
  if (total === 1) return { classificationWorkers: 1, enrichmentOnlyWorkers: 0 };
  const classificationCap = decouplingEnabled ? 2 : 1;
  const classificationWorkers = Math.max(1, Math.min(classificationCap, total - 1));
  return {
    classificationWorkers,
    enrichmentOnlyWorkers: total - classificationWorkers,
  };
}

/** Stable UTC day bucket: a channel may be retried on the next day, not forever. */
export function classificationDayBucket(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Enrichment identity is stage- and day-scoped. A completed pass must not be
 * reopened by ordinary rediscovery later the same day, while a new day can
 * legitimately request fresh evidence. Failed work keeps its normal retry path.
 * Ordinary discovery pairs this key with preventCompletedReopen; an explicit
 * operator recheck uses a fresh recheck key instead.
 */
export function enrichmentJobIdempotencyKey(
  channelId: string,
  stage: number,
  now: number = Date.now(),
  options: { explicitRecheck?: boolean; recheckNonce?: number } = {},
): string {
  const base = `enrich:${channelId}:stage:${Math.max(1, Math.floor(stage) || 1)}`;
  return options.explicitRecheck
    ? `${base}:recheck:${Math.floor(options.recheckNonce ?? now)}`
    : `${base}:${classificationDayBucket(now)}`;
}

/**
 * Durable idempotency key. `preventReopen: true` must accompany this key so a
 * COMPLETED/FAILED job from the same day is never silently reopened; a later
 * day or an explicit operator recheck earns a new classification attempt.
 */
export function classificationJobIdempotencyKey(channelId: string, now: number = Date.now()): string {
  return `classify:${channelId}:${classificationDayBucket(now)}`;
}

/**
 * Scope for the per-query backpressure cap. A query-run is the closest unit
 * to "one query execution" when present; otherwise the query identity plus
 * country prevents two countries that share a phrase from sharing one cap.
 */
export function classificationQueryScopeKey(input: {
  queryRunId?: string | null;
  queryId?: number | null;
  query: string;
  country: string;
}): string {
  if (input.queryRunId) return `run:${input.queryRunId}`;
  if (typeof input.queryId === 'number' && Number.isFinite(input.queryId)) return `query:${input.queryId}:${input.country.trim().toUpperCase()}`;
  const normalizedQuery = input.query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return `text:${normalizedQuery}:${input.country.trim().toUpperCase()}`;
}

export interface ClassificationBackpressureState {
  globalPending: number;
  scopedPending: number;
  maxPending: number;
  maxPerQuery: number;
}

export type ClassificationAdmission = 'ENQUEUE' | 'INLINE';

/**
 * Pure cap decision. At the cap the caller must process the candidate inline:
 * dropping the observation would lose a real discovery, while exceeding the
 * cap would let search outrun classification indefinitely. WORKING-style
 * slight overrun under concurrent search workers is acceptable and bounded by
 * one page per worker.
 */
export function classificationAdmission(
  state: ClassificationBackpressureState,
): ClassificationAdmission {
  if (state.globalPending >= state.maxPending) return 'INLINE';
  if (state.scopedPending >= state.maxPerQuery) return 'INLINE';
  return 'ENQUEUE';
}

/**
 * Per-channel routing for one search-page result. Extracted so the flag-off
 * and decoupled branches have an executable unit contract instead of relying
 * only on source-text assertions: flag off calls only the legacy containment
 * path; flag on delegates to durable admission (which may itself fall back
 * inline at a cap).
 */
export async function routeSearchPageChannel<T>(input: {
  decouplingEnabled: boolean;
  inline: () => Promise<T>;
  admit: () => Promise<{ outcome: T; pending: boolean }>;
}): Promise<{ outcome: T; pending: boolean }> {
  if (!input.decouplingEnabled) return { outcome: await input.inline(), pending: false };
  return input.admit();
}

export interface ClassificationJobPayload {
  channelId: string;
  candidate: DiscoveredChannelRaw;
  targetCountry: string;
  source: DiscoverySource;
  queryRunId?: string;
  queryId?: number;
  queryScopeKey: string;
  discoveryJobId: string;
  nominationId?: string;
  catalogPin?: unknown;
  quotaOrigin: 'NORMAL' | 'PROBE';
  forceExtraction: boolean;
}

export function buildClassificationJobPayload(input: {
  candidate: DiscoveredChannelRaw;
  targetCountry: string;
  source: DiscoverySource;
  queryRunId?: string;
  queryId?: number;
  queryScopeKey: string;
  discoveryJobId: string;
  nominationId?: string;
  catalogPin?: unknown;
  quotaOrigin: 'NORMAL' | 'PROBE';
  forceExtraction: boolean;
}): ClassificationJobPayload {
  return {
    channelId: input.candidate.channelId,
    candidate: input.candidate,
    targetCountry: input.targetCountry,
    source: input.source,
    ...(input.queryRunId ? { queryRunId: input.queryRunId } : {}),
    ...(typeof input.queryId === 'number' ? { queryId: input.queryId } : {}),
    queryScopeKey: input.queryScopeKey,
    discoveryJobId: input.discoveryJobId,
    ...(input.nominationId ? { nominationId: input.nominationId } : {}),
    ...(input.catalogPin !== undefined ? { catalogPin: input.catalogPin } : {}),
    quotaOrigin: input.quotaOrigin,
    forceExtraction: input.forceExtraction,
  };
}

/**
 * Provisional row so page/query accounting can count the creator as new
 * without waiting for semantics. `insertChannelIfAbsent` is mandatory: a
 * classification that completed between the search worker's read and this
 * write must never be overwritten by a stale placeholder.
 *
 * Country is `UNKNOWN` with country_status UNCERTAIN. Retrieval context is
 * never creator evidence; the classification pipeline replaces it with the
 * creator-attributed country before any eligibility decision.
 */
export function buildProvisionalClassificationChannel(
  candidate: Pick<DiscoveredChannelRaw, 'channelId' | 'channelName' | 'youtubeUrl' | 'subscriberCount' | 'channelThumbnailUrl'>,
  source: DiscoverySource,
  now: string = new Date().toISOString(),
): ChannelRecord {
  return {
    channel_id: candidate.channelId,
    channel_name: candidate.channelName,
    youtube_url: candidate.youtubeUrl,
    // Retrieval context is not creator evidence. The pipeline is the only
    // writer allowed to assert channels.country; UNKNOWN keeps the placeholder
    // honest even if it is inspected before classification runs.
    country: 'UNKNOWN',
    country_status: 'UNCERTAIN',
    confidence_score: 0,
    discord_status: 'UNCERTAIN',
    discord_invite: null,
    scan_status: 'CLASSIFICATION_PENDING',
    scan_attempts: 0,
    discovery_source: source,
    first_seen: now,
    last_checked: null,
    inspection_trail: [{
      step: 'BIO',
      title: 'Classification Pending',
      status: 'SKIPPED',
      details: 'Discovered by a search worker; country/trading classification is queued durably.',
      timestamp: now,
    }],
    subscriber_count: candidate.subscriberCount,
    channel_thumbnail_url: candidate.channelThumbnailUrl
      || `https://ui-avatars.com/api/?name=${encodeURIComponent(candidate.channelName)}&background=0f172a&color=38bdf8&bold=true`,
    trading_status: 'UNCERTAIN',
    trading_confidence_score: 0,
    trading_category: 'General Trading',
  };
}

export function mapClassificationOutcomeToFunnelOutcome(outcome: {
  countryStatus: ChannelRecord['country_status'];
  tradingStatus: NonNullable<ChannelRecord['trading_status']>;
}): FunnelOutcome {
  if (outcome.countryStatus === 'REJECTED') return 'COUNTRY_REJECTED';
  if (outcome.tradingStatus === 'HUMAN_REJECTED') return 'NON_TRADING';
  return outcome.tradingStatus;
}
