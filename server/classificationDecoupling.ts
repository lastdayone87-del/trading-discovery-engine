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
 * Defaults are deliberately inert. Enabling the flag never changes discovery
 * semantics: the pipeline, terminal projections, preservation rules, and
 * idempotency guards are shared with the inline path.
 */

export const CLASSIFICATION_JOB_TYPE = 'CLASSIFY_DISCOVERED_CHANNEL' as const;

/** Feature flag. Disabled means the legacy inline channel loop is unchanged. */
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

export function resolveClassificationDecouplingConfig(
  env: NodeJS.ProcessEnv = process.env,
): ClassificationDecouplingConfig {
  return {
    enabled: String(env[CLASSIFICATION_DECOUPLING_FLAG] || '').toLowerCase() === 'true',
    maxPending: positiveInt(env.CLASSIFY_DISCOVERED_CHANNEL_MAX_PENDING, CLASSIFICATION_MAX_PENDING_DEFAULT, 100_000),
    maxPerQuery: positiveInt(env.CLASSIFY_DISCOVERED_CHANNEL_MAX_PER_QUERY, CLASSIFICATION_MAX_PER_QUERY_DEFAULT, 10_000),
    priority: positiveInt(env.CLASSIFY_DISCOVERED_CHANNEL_PRIORITY, CLASSIFICATION_JOB_PRIORITY_DEFAULT, 1_000),
    maxAttempts: positiveInt(env.CLASSIFY_DISCOVERED_CHANNEL_MAX_ATTEMPTS, CLASSIFICATION_JOB_MAX_ATTEMPTS_DEFAULT, 20),
  };
}

export function resolveSearchWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Number(env.SEARCH_WORKER_CONCURRENCY || SEARCH_WORKER_CONCURRENCY_DEFAULT));
}

export function resolveEnrichmentWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Number(env.ENRICHMENT_WORKER_CONCURRENCY || ENRICHMENT_WORKER_CONCURRENCY_DEFAULT));
}

/**
 * 2/1 split for the measured three-worker pool: two workers claim new
 * classifications and fall back to ENRICH when no classification is due; one
 * worker claims only ENRICH so the pre-existing backlog cannot starve behind
 * new discoveries. The split scales without changing total worker count:
 * min(2, total) shared workers and the remainder dedicated to ENRICH.
 *
 * After a rollback the flag is off but old PENDING classification jobs must
 * still drain, so one shared worker remains; the other workers stay dedicated
 * to the existing ENRICH backlog.
 */
export function resolveEnrichmentWorkerSplit(totalWorkers: number, decouplingEnabled = true): {
  classificationWorkers: number;
  enrichmentOnlyWorkers: number;
} {
  const total = positiveInt(totalWorkers, ENRICHMENT_WORKER_CONCURRENCY_DEFAULT, 100);
  const classificationWorkers = Math.min(decouplingEnabled ? 2 : 1, total);
  return {
    classificationWorkers,
    enrichmentOnlyWorkers: Math.max(0, total - classificationWorkers),
  };
}

/** Stable UTC day bucket: a channel may be retried on the next day, not forever. */
export function classificationDayBucket(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
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
