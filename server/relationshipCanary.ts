import { getAppSetting, getDb, getDailyYouTubeQuotaBudget, tryReserveQuota, finishQuotaReservation, type DurableJob } from './db';
import { getYouTubeQuotaDayStartAt } from './youtubeQuotaDay';
import { assertCountryAllowed } from './countryExclusion';
import { observeKeywordBaseline } from './candidateTriage';
import { FEATURED_CHANNEL_PROVIDER_COST } from './featuredChannelAdapter';
import { PLAYLIST_PROVIDER_COST } from './evidenceGraphAdapters';
import { fetchYouTubeFeaturedChannels, fetchYouTubePlaylistChannels, type DiscoveredChannelRaw, type RelationshipProvenance } from './youtube';
import { recordNomination } from './candidateAdmission/store';

/**
 * Bounded relationship-driven discovery canary (forensic report PR #439 §10).
 *
 * Experiment, not a rollout: proves whether traversing creator relationships
 * (featured sections, playlists) can uncover legitimate trading creators the
 * keyword-first funnel structurally misses. Uses existing machinery only —
 * provider fetchers, nomination ledger, ingest pipeline, quota reservation —
 * with explicit bounds (cohort, depth ≤ 2, fanout caps, channel cap, quota)
 * and kill switches. Default state is inert: nothing operates unless the
 * canary is explicitly enabled AND not killed.
 *
 * No new tables, no new worker architecture, no new acquisition systems.
 */

export const RELATIONSHIP_CANARY_VERSION = 'relationship-canary-v1';
export const RELATIONSHIP_CANARY_JOB_TYPE = 'RELATIONSHIP_CANARY_EXPANSION';
/** Hard bounds: cohort size, traversal depth, per-fetch fanout, depth-2 parents, channels/run. */
export const RELATIONSHIP_CANARY_MAX_SEEDS = 10;
export const RELATIONSHIP_CANARY_MAX_DEPTH = 2;
export const RELATIONSHIP_CANARY_MAX_FANOUT = 10;
export const RELATIONSHIP_CANARY_MAX_DEPTH2_PARENTS = 5;
export const RELATIONSHIP_CANARY_MAX_CHANNELS_PER_RUN = 150;
/**
 * Conservative downstream estimate (YouTube units) earmarked per admitted
 * candidate: max enrich reservation weight 202 (queueManager stage≥2) +
 * recent-video search 100 + video details 1 + channel metadata 1 + 1 headroom.
 * Deliberately worst-case: actual downstream is usually far cheaper, and
 * over-reserving only stops the canary earlier (safe direction). Without this
 * earmark the 1-unit traversal bound would be dishonest, because admitted
 * candidates trigger hydration and ENRICH_CHANNEL work outside traversal.
 */
export const RELATIONSHIP_CANARY_ESTIMATED_DOWNSTREAM_UNITS = 305;

export interface RelationshipCanarySeed {
  kind: 'channel' | 'playlist';
  id: string;
}

export interface RelationshipCanaryPayload {
  cohortId: string;
  targetCountry: string;
  seeds: RelationshipCanarySeed[];
  maxDepth: number;
  maxFanout: number;
  maxChannels: number;
}

export interface RelationshipCanarySettings {
  enabled: boolean;
  killSwitch: boolean;
  quotaPercent: number;
}

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** Pure payload validation: every bound enforced before any provider spend. */
export function validateRelationshipCanaryPayload(value: unknown): RelationshipCanaryPayload {
  if (!value || typeof value !== 'object') throw new Error('RELATIONSHIP_CANARY_PAYLOAD_REQUIRED');
  const payload = value as Record<string, unknown>;
  const cohortId = String(payload.cohortId || '').trim();
  if (!cohortId || cohortId.length > 80) throw new Error('RELATIONSHIP_CANARY_COHORT_REQUIRED');
  const targetCountry = String(payload.targetCountry || '').trim();
  if (!targetCountry) throw new Error('RELATIONSHIP_CANARY_TARGET_COUNTRY_REQUIRED');
  if (!Array.isArray(payload.seeds) || payload.seeds.length < 1 || payload.seeds.length > RELATIONSHIP_CANARY_MAX_SEEDS) {
    throw new Error('RELATIONSHIP_CANARY_SEEDS_OUT_OF_RANGE');
  }
  const seeds: RelationshipCanarySeed[] = payload.seeds.map((seed: unknown) => {
    const entry = (seed || {}) as Record<string, unknown>;
    if (entry.kind === 'channel') {
      if (!CHANNEL_ID.test(String(entry.id || ''))) throw new Error('RELATIONSHIP_CANARY_INVALID_CHANNEL_SEED');
      return { kind: 'channel' as const, id: String(entry.id) };
    }
    if (entry.kind === 'playlist') {
      const id = String(entry.id || '').trim();
      if (!id || id.length > 80) throw new Error('RELATIONSHIP_CANARY_INVALID_PLAYLIST_SEED');
      return { kind: 'playlist' as const, id };
    }
    throw new Error('RELATIONSHIP_CANARY_INVALID_SEED_KIND');
  });
  const maxDepth = Number(payload.maxDepth);
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > RELATIONSHIP_CANARY_MAX_DEPTH) {
    throw new Error('RELATIONSHIP_CANARY_DEPTH_EXCEEDED');
  }
  const maxFanout = Number(payload.maxFanout);
  if (!Number.isInteger(maxFanout) || maxFanout < 1 || maxFanout > RELATIONSHIP_CANARY_MAX_FANOUT) {
    throw new Error('RELATIONSHIP_CANARY_FANOUT_OUT_OF_RANGE');
  }
  const maxChannels = Number(payload.maxChannels);
  if (!Number.isInteger(maxChannels) || maxChannels < 1 || maxChannels > RELATIONSHIP_CANARY_MAX_CHANNELS_PER_RUN) {
    throw new Error('RELATIONSHIP_CANARY_CHANNEL_CAP_OUT_OF_RANGE');
  }
  return { cohortId, targetCountry, seeds, maxDepth, maxFanout, maxChannels };
}

/** Pure kill-switch predicate: default state is inert. */
export function isRelationshipCanaryLive(settings: { enabled: boolean; killSwitch: boolean }): boolean {
  return settings.enabled === true && settings.killSwitch !== true;
}

/** Pure seed normalization: identical seeds expand exactly once. */
export function dedupeRelationshipSeeds(seeds: RelationshipCanarySeed[]): RelationshipCanarySeed[] {
  const seen = new Set<string>();
  return seeds.filter(seed => {
    const key = `${seed.kind}:${seed.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Pure canary quota allowance in provider units. The shared reservation layer
 * treats allocation percentages as scheduling preferences, not hard
 * partitions, so the canary enforces its own configured share on top:
 * allowance = floor(dailyBudget * percent / 100), clamped to [0, 100%].
 * A 0% configuration therefore allows zero spend.
 */
export function relationshipCanaryQuotaAllowance(dailyBudget: number, percent: number): number {
  const budget = Number.isFinite(dailyBudget) && dailyBudget > 0 ? Math.floor(dailyBudget) : 0;
  const share = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  return Math.floor((budget * share) / 100);
}

export async function readRelationshipCanarySettings(): Promise<RelationshipCanarySettings> {
  const [enabled, killSwitch, quotaPercent] = await Promise.all([
    getAppSetting('relationship_canary_enabled', 'false'),
    getAppSetting('relationship_canary_kill_switch', 'true'),
    getAppSetting('relationship_canary_quota_percent', '1'),
  ]);
  const percent = Math.min(10, Math.max(1, Math.floor(Number(quotaPercent) || 1)));
  return { enabled: enabled.trim().toLowerCase() === 'true', killSwitch: killSwitch.trim().toLowerCase() === 'true', quotaPercent: percent };
}

/** Pure provenance constructor: every relationship candidate carries its full path. */
export function buildRelationshipProvenance(input: {
  cohortId: string;
  kind: 'featured' | 'playlist';
  depth: number;
  parentChannelId?: string;
  path: string[];
}): RelationshipProvenance {
  return {
    cohortId: input.cohortId,
    kind: input.kind,
    depth: input.depth,
    parentChannelId: input.parentChannelId,
    path: [...input.path],
  };
}

export interface RelationshipExpansionTarget {
  kind: 'featured' | 'playlist';
  targetId: string;
  depth: number;
  parentChannelId?: string;
  path: string[];
}

/**
 * Pure expansion planner: flattens seeds + depth-1 results into a bounded,
 * deduplicated depth-2 fetch plan. Seeds are depth 0 (fetched directly);
 * their discovered channels are depth 1; featured expansion of at most
 * MAX_DEPTH2_PARENTS depth-1 channels yields depth 2. Never plans depth 3+.
 */
export function planRelationshipExpansion(input: {
  seeds: RelationshipCanarySeed[];
  maxDepth: number;
  maxFanout: number;
  depth1ChannelIds: string[];
  seedOf: Record<string, string>;
  maxDepth2Parents?: number;
}): RelationshipExpansionTarget[] {
  const maxDepth2Parents = Math.max(0, Math.min(RELATIONSHIP_CANARY_MAX_DEPTH2_PARENTS, input.maxDepth2Parents ?? RELATIONSHIP_CANARY_MAX_DEPTH2_PARENTS));
  const plan: RelationshipExpansionTarget[] = [];
  const seen = new Set<string>();
  // Authoritative identity is the raw channel ID: a channel seed and a
  // featured edge to the same channel must not expand twice under different
  // key representations. Playlist seeds address playlists, never channels.
  const seedChannelIds = new Set(
    input.seeds.filter(seed => seed.kind === 'channel').map(seed => seed.id),
  );
  for (const channelId of input.depth1ChannelIds) {
    if (plan.length >= maxDepth2Parents) break;
    if (seen.has(channelId) || seedChannelIds.has(channelId)) continue;
    seen.add(channelId);
    if (input.maxDepth < 2) break;
    plan.push({
      kind: 'featured',
      targetId: channelId,
      depth: 2,
      parentChannelId: channelId,
      path: [input.seedOf[channelId] || channelId, channelId],
    });
  }
  return plan.slice(0, Math.max(0, Math.trunc(input.maxFanout)));
}

export interface RelationshipCanarySummary {
  cohortId: string;
  status: 'COMPLETED' | 'KILLED' | 'QUOTA_EXHAUSTED';
  seedsAttempted: number;
  depth1Channels: number;
  depth2Fetches: number;
  nominations: number;
  ingested: number;
  channelsCapped: number;
  /** Admissions refused for lack of downstream budget (estimate exceeds remainder). */
  downstreamCapped: number;
  failures: string[];
  /**
   * Stable per-failure classification parallel to failures[] (same order).
   * Lets operators distinguish pre-dispatch provider configuration problems
   * (NO_YOUTUBE_API_KEY, PROVIDER_POOL_UNAVAILABLE, ...) from ordinary
   * provider call failures without exposing any secret material.
   */
  failureCodes: string[];
  quotaUnits: number;
}

/** Stable, non-secret classification for canary provider-side failures. */
export type RelationshipCanaryFailureCode =
  | 'NO_YOUTUBE_API_KEY'
  | 'PROVIDER_POOL_UNAVAILABLE'
  | 'QUOTA_EXHAUSTED'
  | 'INVALID_INPUT'
  | 'PROVIDER_CALL_FAILED';

/**
 * Pure classifier mapping raw errors to stable codes. Inspects message text
 * only — never keys, tokens, headers, or provider configuration values.
 */
export function classifyRelationshipCanaryFailure(error: unknown): RelationshipCanaryFailureCode {
  const message = String((error as Error)?.message || error || '');
  if (/api key/i.test(message) && /requir|missing|not configured|unavailable/i.test(message)) return 'NO_YOUTUBE_API_KEY';
  if (/cooling|cool-?down|pool (exhausted|unavailable)|no provider|backoff/i.test(message)) return 'PROVIDER_POOL_UNAVAILABLE';
  if (/quota|QUOTA_EXHAUSTED|429|rate.?limit/i.test(message)) return 'QUOTA_EXHAUSTED';
  if (/invalid|VALIDATION|out of range|exceeded|required/i.test(message)) return 'INVALID_INPUT';
  return 'PROVIDER_CALL_FAILED';
}

/**
 * Pure scrubber for log-bound strings. Redacts anything shaped like a
 * credential (query-param keys, api keys, bearer tokens) and caps length.
 * Quota counts, channel IDs, and reason codes pass through untouched.
 */
export function sanitizeCanaryLogText(value: string, maxLength = 200): string {
  return String(value || '')
    .replace(/([?&](?:key|api[_-]?key)=)[^&\s'"]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/g, 'Bearer [REDACTED]')
    .replace(/(token["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]')
    .slice(0, Math.max(1, maxLength));
}

/** Record one classified failure onto the run summary (message + code together). */
export function recordCanaryFailure(summary: Pick<RelationshipCanarySummary, 'failures' | 'failureCodes'>, context: string, error: unknown): void {
  summary.failures.push(sanitizeCanaryLogText(`${context}:${error instanceof Error ? error.message : String(error)}`));
  summary.failureCodes.push(classifyRelationshipCanaryFailure(error));
}

/**
 * Pure builder for the durable job-attempt log entry. Contains only counts,
 * statuses, sanitized failure messages/codes, and the cohort id — never keys,
 * secrets, headers, tokens, or provider configuration.
 */
export function relationshipCanaryAttemptLog(summary: RelationshipCanarySummary): Record<string, unknown> {
  return {
    canary: true,
    cohortId: summary.cohortId,
    status: summary.status,
    seedsAttempted: summary.seedsAttempted,
    depth1Channels: summary.depth1Channels,
    depth2Fetches: summary.depth2Fetches,
    nominations: summary.nominations,
    ingested: summary.ingested,
    channelsCapped: summary.channelsCapped,
    downstreamCapped: summary.downstreamCapped,
    failures: summary.failures.slice(0, 100),
    failureCodes: summary.failureCodes.slice(0, 100),
    quotaUnits: summary.quotaUnits,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Appends the run summary to the open job_attempts record (logs JSONB array)
 * so provider failures are visible instead of surfacing as COMPLETED with
 * empty logs. Targets only the unfinished attempt row; a missing row is a
 * no-op. Never throws: observability must not fail the canary job itself.
 */
export async function persistRelationshipCanarySummary(
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>,
  jobId: string,
  summary: RelationshipCanarySummary,
): Promise<void> {
  try {
    await query(
      `UPDATE job_attempts SET logs = logs || $2::jsonb WHERE job_id=$1 AND finished_at IS NULL`,
      [jobId, JSON.stringify(relationshipCanaryAttemptLog(summary))],
    );
  } catch (error) {
    console.warn(`[RelationshipCanary] attempt-log persistence failed for ${jobId}:`, error instanceof Error ? error.message : error);
  }
}

export interface RelationshipCanaryDeps {
  fetchFeaturedChannels?: (sourceChannelId: string, maximumFanout: number) => Promise<{ observations: Array<{ featuredChannelId: string; sectionId?: string }> }>;
  fetchPlaylistChannels?: (playlistId: string, limit: number) => Promise<Array<{ channelId: string; channelName: string; description: string; videoTitles: string[] }>>;
  nominate?: (input: {
    channelId: string; sourceType: string; jobId?: string; query: string;
    querySemanticClasses: string[]; country: string; retrievalLane: string; resultRank: number;
    matchedDocument: DiscoveredChannelRaw['matchedDocument']; rawObservation: Record<string, unknown>;
  }) => Promise<{ id?: string } | null>;
  ingest?: (raw: DiscoveredChannelRaw, country: string, source: 'automated_query') => Promise<unknown>;
  reserveQuota?: (operationId: string, units: number) => Promise<boolean>;
  finishQuota?: (operationId: string, consumed: boolean) => Promise<void>;
  /**
   * Test override for the atomic canary claim (production uses
   * claimRelationshipCanaryQuota against quota_reservations). Returning false
   * denies the spend (QUOTA_EXHAUSTED path) without touching shared state.
   */
  claimQuota?: (operationId: string, units: number, opts?: { consumeImmediately?: boolean }) => Promise<boolean>;
  /** Test override for the shared daily budget (production reads provider config). */
  dailyBudget?: number;
  /** Test override for the excluded-country gate (production uses assertCountryAllowed). */
  checkCountryAllowed?: (country: string) => Promise<void>;
  /** Test/operator override for the enabled/kill-switch settings (production reads app settings). */
  settings?: RelationshipCanarySettings;
  log?: (message: string) => void;
}

async function defaultReserveQuota(operationId: string, units: number): Promise<boolean> {
  const dailyBudget = getDailyYouTubeQuotaBudget();
  const settings = await readRelationshipCanarySettings();
  return tryReserveQuota({
    operationType: 'RELATIONSHIP_CANARY',
    operationId,
    allocation: 'AUTONOMOUS',
    units,
    dailyBudget,
    allocationPercent: settings.quotaPercent,
  });
}

/**
 * Atomic canary quota claim against the existing quota_reservations table
 * (no second quota system). One transaction: take the advisory lock for the
 * canary share, sum RESERVED plus same-quota-day CONSUMED units, and insert
 * the claim only when it fits the allowance. Concurrent workers serialize on
 * the lock, so two cohorts can never both spend the same remaining allowance.
 * The lock is held only for this short transaction — never across provider
 * or network calls. Single-status rows can never double-count; day-scoping
 * the CONSUMED leg prevents cross-day leakage.
 */
export async function claimRelationshipCanaryQuota(input: {
  db: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
  operationId: string;
  units: number;
  allowance: number;
  dayStartIso: string;
  consumeImmediately?: boolean;
}): Promise<{ allowed: boolean; used: number; allowance: number }> {
  const units = Math.max(1, Math.trunc(input.units) || 1);
  const allowance = Math.max(0, Math.trunc(input.allowance) || 0);
  const { db } = input;
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('relationship-canary-quota'))`);
    const spent = await db.query(
      `SELECT COALESCE(SUM(units),0)::int AS spent FROM quota_reservations
        WHERE operation_type='RELATIONSHIP_CANARY'
          AND (status='RESERVED'
               OR (status='CONSUMED' AND COALESCE(consumed_at, reserved_at) >= $1::timestamptz))`,
      [input.dayStartIso],
    );
    const used = Math.max(0, Number(spent.rows[0]?.spent || 0));
    // Upsert semantics: re-claiming the same operation replaces its row
    // rather than adding spend, so the row's current units do not count
    // against the allowance (crash-recovery retries must not block on their
    // own prior claims) — but ONLY when that row actually contributed to the
    // aggregate above. A previous-day row is invisible to `used`, so it must
    // not be subtracted either; otherwise a stale row becomes a bypass.
    const own = await db.query(
      `SELECT COALESCE(units,0)::int AS own FROM quota_reservations
        WHERE operation_type='RELATIONSHIP_CANARY' AND operation_id=$1
          AND (status='RESERVED'
               OR (status='CONSUMED' AND COALESCE(consumed_at, reserved_at) >= $2::timestamptz))`,
      [input.operationId, input.dayStartIso],
    );
    const ownUnits = Math.max(0, Number(own.rows[0]?.own || 0));
    if (used - ownUnits + units > allowance) {
      await db.query('ROLLBACK');
      return { allowed: false, used, allowance };
    }
    const status = input.consumeImmediately ? 'CONSUMED' : 'RESERVED';
    await db.query(
      `INSERT INTO quota_reservations(operation_type, operation_id, allocation, units, status, reserved_at, expires_at, consumed_at)
        VALUES('RELATIONSHIP_CANARY', $1, 'AUTONOMOUS', $2, '${status}', now(), now() + interval '20 minutes', ${input.consumeImmediately ? 'now()' : 'NULL'})
        ON CONFLICT(operation_type, operation_id) DO UPDATE
          SET units=excluded.units, status='${status}',
              reserved_at=CASE WHEN '${status}'='RESERVED' THEN now() ELSE quota_reservations.reserved_at END,
              expires_at=now() + interval '20 minutes',
              consumed_at=CASE WHEN '${status}'='CONSUMED' THEN now() ELSE quota_reservations.consumed_at END`,
      [input.operationId, units],
    );
    await db.query('COMMIT');
    return { allowed: true, used, allowance };
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {}
    throw error;
  }
}

/**
 * Bounded canary worker. Per-seed and per-candidate isolation: any single
 * failure is recorded and skipped, never aborting siblings. Quota exhaustion
 * stops further fetches without failing the job. Never throws on
 * per-seed/per-candidate errors; unexpected infrastructure failures propagate
 * to existing job retry semantics. Retry ownership for discovered candidates
 * flows through the normal pipeline (existing directives), never invented here.
 */
export async function processRelationshipCanaryJob(
  job: { id: string; payload: unknown },
  ingest: (raw: DiscoveredChannelRaw, country: string, source: 'automated_query') => Promise<unknown>,
  deps: RelationshipCanaryDeps = {},
): Promise<RelationshipCanarySummary> {
  const payload = validateRelationshipCanaryPayload(job.payload);
  const settings = deps.settings || await readRelationshipCanarySettings();
  const summary: RelationshipCanarySummary = {
    cohortId: payload.cohortId,
    status: 'COMPLETED',
    seedsAttempted: 0,
    depth1Channels: 0,
    depth2Fetches: 0,
    nominations: 0,
    ingested: 0,
    channelsCapped: 0,
    downstreamCapped: 0,
    failures: [],
    failureCodes: [],
    quotaUnits: 0,
  };
  const log = deps.log || ((message: string) => console.info(message));
  if (!isRelationshipCanaryLive(settings)) {
    summary.status = 'KILLED';
    log(`[RelationshipCanary] cohort=${payload.cohortId} killed (enabled=${settings.enabled}); no provider spend.`);
    return summary;
  }
  // Execution-time exclusion boundary (mirrors enqueue-time): countries
  // excluded after queuing must not spend provider quota or enter ingestion.
  const checkAllowed = deps.checkCountryAllowed || (async (country: string) => { await assertCountryAllowed(country, 'relationship-canary:execution'); });
  await checkAllowed(payload.targetCountry);
  const fetchFeatured = deps.fetchFeaturedChannels || fetchYouTubeFeaturedChannels;
  const fetchPlaylist = deps.fetchPlaylistChannels || fetchYouTubePlaylistChannels;
  // Effective ingest: explicit dep override wins (tests), otherwise the live
  // pipeline callback passed positionally (featured/playlist worker pattern).
  const ingestFn = deps.ingest || ingest;
  const nominate = deps.nominate || (async (input) => recordNomination({ ...input, queryGenerationMode: 'RELATIONSHIP_CANARY' } as never));
  const reserve = deps.reserveQuota || defaultReserveQuota;
  const finish = deps.finishQuota || (async (operationId: string, consumed: boolean) => { await finishQuotaReservation('RELATIONSHIP_CANARY', operationId, consumed); });
  // Channel-ID-normalized visited set: seeds pre-registered so a seed reached
  // again as a depth-1 discovery is not re-admitted under a different key
  // representation. Provenance per nomination is unaffected.
  const visited = new Set<string>();
  // Expansion identity is tracked separately from admission: a channel that
  // was already expanded (seed fetch or depth-2 fetch) is never fetched
  // again, while admission dedupe stays purely channel-ID based.
  const expandedTargets = new Set<string>();
  const seeds = dedupeRelationshipSeeds(payload.seeds);
  for (const seed of seeds) {
    if (seed.kind === 'channel') {
      visited.add(seed.id);
      expandedTargets.add(seed.id);
    }
  }
  // Real canary allocation: configured percent of the shared daily budget.
  // Every spend — traversal fetches AND estimated downstream per admission —
  // goes through one atomic claim (advisory-locked check+insert, day-scoped),
  // so concurrent and sequential cohorts share a single hard aggregate bound.
  // tryReserveQuota still guards the global budget on every fetch.
  const dailyBudget = deps.dailyBudget ?? getDailyYouTubeQuotaBudget();
  const allowance = relationshipCanaryQuotaAllowance(dailyBudget, settings.quotaPercent);
  const dayStartIso = new Date(getYouTubeQuotaDayStartAt()).toISOString();
  const claimQuota = deps.claimQuota || (async (operationId: string, units: number, opts?: { consumeImmediately?: boolean }): Promise<boolean> => {
    const db = await getDb();
    const claim = await claimRelationshipCanaryQuota({ db, operationId, units, allowance, dayStartIso, consumeImmediately: opts?.consumeImmediately });
    return claim.allowed;
  });
  const depth1: Array<{ channelId: string; seedId: string }> = [];
  const seedOf: Record<string, string> = {};
  let channelsAccepted = 0;
  let quotaExhausted = false;
  const acceptChannel = (): boolean => {
    if (channelsAccepted >= payload.maxChannels) {
      summary.channelsCapped++;
      return false;
    }
    channelsAccepted++;
    return true;
  };

  const admitCandidate = async (raw: DiscoveredChannelRaw, nomination: {
    sourceType: string; query: string; resultRank: number;
    matchedDocument: DiscoveredChannelRaw['matchedDocument']; rawObservation: Record<string, unknown>;
  }): Promise<void> => {
    if (!acceptChannel()) return;
    // Truthful downstream bound: admitting a candidate is expected to trigger
    // hydration and enrichment work outside traversal. Earmark the
    // conservative downstream estimate from the same atomic allowance BEFORE
    // nominating or ingesting; if it does not fit, the candidate is not
    // admitted at all (counted separately from the channel cap).
    if (!await claimQuota(`relationship-canary:${payload.cohortId}:downstream:${raw.channelId}`, RELATIONSHIP_CANARY_ESTIMATED_DOWNSTREAM_UNITS, { consumeImmediately: true })) {
      summary.downstreamCapped++;
      return;
    }
    // Observational keyword baseline (metrics only): would the old funnel
    // have admitted this candidate? Never influences admission or authority.
    const keywordBaseline = observeKeywordBaseline(raw);
    const observedRawObservation: Record<string, unknown> = {
      ...nomination.rawObservation,
      keywordBaseline: keywordBaseline.baseline,
      keywordBaselineReasons: keywordBaseline.reasonCodes,
    };
    try {
      const record = await nominate({
        channelId: raw.channelId,
        sourceType: nomination.sourceType,
        jobId: job.id,
        query: nomination.query,
        querySemanticClasses: ['RELATIONSHIP_CANARY', nomination.sourceType],
        country: payload.targetCountry,
        retrievalLane: nomination.sourceType === 'PLAYLIST' ? 'PLAYLIST' : 'FEATURED_CHANNEL',
        resultRank: nomination.resultRank,
        matchedDocument: nomination.matchedDocument,
        rawObservation: observedRawObservation,
      });
      raw.nominationId = record?.id || undefined;
      await ingestFn(raw, payload.targetCountry, 'automated_query');
      summary.nominations++;
      summary.ingested++;
    } catch (error) {
      recordCanaryFailure(summary, raw.channelId, error);
    }
  };

  const expandFeatured = async (sourceChannelId: string, provenance: Omit<RelationshipProvenance, 'kind'> & { kind: 'featured' }): Promise<string[]> => {
    const operationId = `relationship-canary:${payload.cohortId}:${provenance.depth}:${sourceChannelId}`;
    // Atomic canary-share claim first (serializes concurrent cohorts), then
    // the existing global reservation guard. Either denial stops the fetch.
    if (!await claimQuota(operationId, FEATURED_CHANNEL_PROVIDER_COST)) {
      summary.status = 'QUOTA_EXHAUSTED';
      quotaExhausted = true;
      return [];
    }
    if (!await reserve(operationId, FEATURED_CHANNEL_PROVIDER_COST)) {
      summary.status = 'QUOTA_EXHAUSTED';
      quotaExhausted = true;
      return [];
    }
    try {
      const provider = await fetchFeatured(sourceChannelId, payload.maxFanout);
      summary.quotaUnits += FEATURED_CHANNEL_PROVIDER_COST;
      await finish(operationId, true);
      return provider.observations.map(item => item.featuredChannelId);
    } catch (error) {
      await finish(operationId, false).catch(() => {});
      throw error;
    }
  };

  // Depth 1: seeds. Channel/traversal limits bound actual provider work, not
  // just admission: once channel capacity is exhausted, remaining seeds are
  // not fetched at all.
  const capacityRemains = (): boolean => channelsAccepted < payload.maxChannels;
  for (const seed of seeds) {
    if (!capacityRemains()) break;
    summary.seedsAttempted++;
    try {
      if (seed.kind === 'channel') {
        const ids = await expandFeatured(seed.id, { cohortId: payload.cohortId, kind: 'featured', depth: 1, parentChannelId: seed.id, path: [seed.id] });
        for (const [index, channelId] of ids.entries()) {
          if (visited.has(channelId)) continue;
          visited.add(channelId);
          summary.depth1Channels++;
          depth1.push({ channelId, seedId: seed.id });
          seedOf[channelId] = seed.id;
          const provenance = buildRelationshipProvenance({ cohortId: payload.cohortId, kind: 'featured', depth: 1, parentChannelId: seed.id, path: [seed.id] });
          await admitCandidate({
            channelId,
            channelName: channelId,
            youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
            description: '',
            videoTitles: [],
            videoDescriptions: [],
            matchedDocument: { type: 'EXTERNAL', providerNativeId: channelId, locator: `youtube:relationship-canary:${payload.cohortId}:featured:${seed.id}` },
            relationshipProvenance: provenance,
            discoveryJobId: job.id,
          }, {
            sourceType: 'FEATURED_CHANNEL',
            query: seed.id,
            resultRank: index + 1,
            matchedDocument: { type: 'EXTERNAL', providerNativeId: channelId, locator: `youtube:relationship-canary:${payload.cohortId}:featured:${seed.id}` },
            rawObservation: { sourceChannelId: seed.id, relationshipDepth: 1, relationshipKind: 'featured', cohortId: payload.cohortId, relationshipPath: [seed.id] },
          });
        }
      } else {
        const operationId = `relationship-canary:${payload.cohortId}:playlist:${seed.id}`;
        if (!await claimQuota(operationId, PLAYLIST_PROVIDER_COST)) {
          summary.status = 'QUOTA_EXHAUSTED';
          quotaExhausted = true;
          continue;
        }
        if (!await reserve(operationId, PLAYLIST_PROVIDER_COST)) {
          summary.status = 'QUOTA_EXHAUSTED';
          quotaExhausted = true;
          continue;
        }
        try {
          const observations = await fetchPlaylist(seed.id, payload.maxFanout);
          summary.quotaUnits += PLAYLIST_PROVIDER_COST;
          await finish(operationId, true);
          for (const [index, item] of observations.entries()) {
            if (visited.has(item.channelId)) continue;
            visited.add(item.channelId);
            summary.depth1Channels++;
            depth1.push({ channelId: item.channelId, seedId: seed.id });
            seedOf[item.channelId] = seed.id;
            const provenance = buildRelationshipProvenance({ cohortId: payload.cohortId, kind: 'playlist', depth: 1, parentChannelId: seed.id, path: [seed.id] });
            await admitCandidate({
              channelId: item.channelId,
              channelName: item.channelName,
              youtubeUrl: `https://www.youtube.com/channel/${item.channelId}`,
              description: '',
              videoTitles: item.videoTitles,
              videoDescriptions: [item.description],
              matchedDocument: { type: 'PLAYLIST', providerNativeId: seed.id, title: item.videoTitles[0], description: item.description, locator: `youtube:relationship-canary:${payload.cohortId}:playlist:${seed.id}` },
              relationshipProvenance: provenance,
              discoveryJobId: job.id,
            }, {
              sourceType: 'PLAYLIST',
              query: seed.id,
              resultRank: index + 1,
              matchedDocument: { type: 'PLAYLIST', providerNativeId: seed.id, title: item.videoTitles[0], description: item.description, locator: `youtube:relationship-canary:${payload.cohortId}:playlist:${seed.id}` },
              rawObservation: { playlistId: seed.id, relationshipDepth: 1, relationshipKind: 'playlist', cohortId: payload.cohortId, relationshipPath: [seed.id] },
            });
          }
        } catch (error) {
          await finish(operationId, false).catch(() => {});
          throw error;
        }
      }
    } catch (error) {
      recordCanaryFailure(summary, `${seed.kind}:${seed.id}`, error);
    }
    if (quotaExhausted) break;
  }

  // Depth 2: featured expansion of capped depth-1 parents (never deeper).
  if (payload.maxDepth >= 2 && !quotaExhausted) {
    const plan = planRelationshipExpansion({
      seeds: seeds.map(seed => ({ kind: seed.kind, id: seed.id })),
      maxDepth: payload.maxDepth,
      maxFanout: payload.maxFanout,
      depth1ChannelIds: depth1.map(entry => entry.channelId),
      seedOf,
    });
    for (const target of plan) {
      // Expansion identity is channel-ID based and independent of admission:
      // seeds and already-expanded channels are never fetched twice, while
      // every admitted candidate keeps its own full provenance.
      if (expandedTargets.has(target.targetId)) continue;
      expandedTargets.add(target.targetId);
      // No admissible capacity left: stop traversal before spending fetches
      // whose results could not be admitted.
      if (!capacityRemains()) break;
      summary.depth2Fetches++;
      try {
        const ids = await expandFeatured(target.targetId, {
          cohortId: payload.cohortId,
          kind: 'featured',
          depth: 2,
          parentChannelId: target.parentChannelId,
          path: target.path,
        });
        for (const [index, channelId] of ids.entries()) {
          if (visited.has(channelId)) continue;
          visited.add(channelId);
          const provenance = buildRelationshipProvenance({ cohortId: payload.cohortId, kind: 'featured', depth: 2, parentChannelId: target.parentChannelId, path: target.path });
          await admitCandidate({
            channelId,
            channelName: channelId,
            youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
            description: '',
            videoTitles: [],
            videoDescriptions: [],
            matchedDocument: { type: 'EXTERNAL', providerNativeId: channelId, locator: `youtube:relationship-canary:${payload.cohortId}:featured:${target.parentChannelId}` },
            relationshipProvenance: provenance,
            discoveryJobId: job.id,
          }, {
            sourceType: 'FEATURED_CHANNEL',
            query: target.parentChannelId || target.targetId,
            resultRank: index + 1,
            matchedDocument: { type: 'EXTERNAL', providerNativeId: channelId, locator: `youtube:relationship-canary:${payload.cohortId}:featured:${target.parentChannelId}` },
            rawObservation: { sourceChannelId: target.parentChannelId, relationshipDepth: 2, relationshipKind: 'featured', cohortId: payload.cohortId, relationshipPath: target.path },
          });
        }
      } catch (error) {
        recordCanaryFailure(summary, `featured:${target.targetId}`, error);
      }
      if (quotaExhausted) break;
    }
  }

  log(`[RelationshipCanary] cohort=${payload.cohortId} status=${summary.status} seeds=${summary.seedsAttempted} depth1=${summary.depth1Channels} depth2fetches=${summary.depth2Fetches} nominations=${summary.nominations} ingested=${summary.ingested} capped=${summary.channelsCapped} downstreamCapped=${summary.downstreamCapped} failures=${summary.failures.length} quotaUnits=${summary.quotaUnits}`);
  return summary;
}

// ---------------------------------------------------------------------------
// Cohort metrics: pure aggregation over nomination + channel rows (no DB here;
// production measurement joins discovery_nominations.rawObservation->>'cohortId'
// with channels by channel_id — read-only SELECTs, no schema changes).
// ---------------------------------------------------------------------------

export interface RelationshipCohortNominationRow {
  channelId: string;
  sourceType: string;
  cohortId: string | null;
  kind: string | null;
  depth: number | null;
  /** Observational keyword baseline recorded at nomination time (metrics only). */
  keywordBaseline?: 'WOULD_ADMIT' | 'WOULD_WITHHOLD' | null;
}

export interface RelationshipCohortChannelRow {
  channelId: string;
  tradingStatus: string;
  scanStatus?: string;
}

export interface RelationshipCohortMetrics {
  cohortId: string;
  nominations: number;
  uniqueChannels: number;
  byKind: Record<string, number>;
  byDepth: Record<string, number>;
  confirmed: number;
  relationshipOnlyConfirms: number;
  keywordOverlapConfirms: number;
  /**
   * Confirmed cohort channels whose cohort nominations unanimously record a
   * WOULD_WITHHOLD keyword baseline: the old funnel would not have admitted
   * them. Stronger than nomination-absence alone; still an observational
   * proxy (manual sampling required before yield claims).
   */
  zeroKeywordConfirms: number;
  /** Cohort channels with no explicit keyword baseline (never counted either way). */
  unknownBaselineChannels: number;
  rejectedOrUncertain: number;
  /**
   * True duplication rate: the proportion of nominations that are duplicates
   * (0 = every nomination unique, approaching 1 = heavily re-nominated).
   * Safe on empty cohorts (0, not NaN).
   */
  duplicationRate: number;
  quotaUnits: number;
  costPerConfirm: number | null;
}

/**
 * Aggregate one canary cohort. Overlap with the keyword-first funnel is
 * measured ONLY through the observational keyword baseline (recorded per
 * nomination by the existing keyword predicate): other relationship cohorts
 * or adapter paths are still relationship discovery, never keyword proof.
 * A missing/null/malformed baseline is UNKNOWN — never a definitive result.
 */
export function aggregateRelationshipCohort(
  cohortId: string,
  nominations: RelationshipCohortNominationRow[],
  channels: RelationshipCohortChannelRow[],
  quotaUnits = 0,
): RelationshipCohortMetrics {
  const cohort = nominations.filter(row => row.cohortId === cohortId);
  const channelIds = new Set(cohort.map(row => row.channelId));
  const byKind: Record<string, number> = {};
  const byDepth: Record<string, number> = {};
  for (const row of cohort) {
    byKind[row.kind || 'unknown'] = (byKind[row.kind || 'unknown'] || 0) + 1;
    byDepth[String(row.depth ?? 'unknown')] = (byDepth[String(row.depth ?? 'unknown')] || 0) + 1;
  }
  // Nomination-source overlap (provenance dimension only): confirmed creators
  // with zero nominations outside this cohort. This is NOT keyword proof —
  // another relationship cohort is still relationship discovery.
  const externallyNominated = new Set(
    nominations.filter(row => row.cohortId !== cohortId).map(row => row.channelId),
  );
  const cohortChannels = channels.filter(row => channelIds.has(row.channelId));
  const confirmed = cohortChannels.filter(row => row.tradingStatus === 'TRADING_CONFIRMED');
  const relationshipOnlyConfirms = confirmed.filter(row => !externallyNominated.has(row.channelId)).length;
  // Keyword baseline per channel, from explicit observations only. Conservative
  // toward the baseline: any WOULD_ADMIT means the old funnel might have found
  // it. Missing/null/malformed baselines are UNKNOWN, never WOULD_WITHHOLD.
  const baselineByChannel = new Map<string, 'WOULD_ADMIT' | 'WOULD_WITHHOLD' | 'UNKNOWN'>();
  for (const row of cohort) {
    const current = baselineByChannel.get(row.channelId);
    if (current === 'WOULD_ADMIT') continue;
    if (row.keywordBaseline === 'WOULD_ADMIT') baselineByChannel.set(row.channelId, 'WOULD_ADMIT');
    else if (row.keywordBaseline === 'WOULD_WITHHOLD') baselineByChannel.set(row.channelId, current || 'WOULD_WITHHOLD');
    else if (!baselineByChannel.has(row.channelId)) baselineByChannel.set(row.channelId, 'UNKNOWN');
  }
  // Keyword overlap is authoritative ONLY from explicit WOULD_ADMIT baselines.
  const keywordOverlapConfirms = confirmed.filter(
    row => baselineByChannel.get(row.channelId) === 'WOULD_ADMIT',
  ).length;
  // Zero-keyword confirms require an explicit WOULD_WITHHOLD baseline AND
  // downstream confirmation. Unknown baselines are counted separately below.
  const zeroKeywordConfirms = confirmed.filter(
    row => baselineByChannel.get(row.channelId) === 'WOULD_WITHHOLD',
  ).length;
  const unknownBaselineChannels = [...channelIds].filter(id => (baselineByChannel.get(id) || 'UNKNOWN') === 'UNKNOWN').length;
  const rejectedOrUncertain = cohortChannels.filter(
    row => row.tradingStatus === 'NON_TRADING' || row.tradingStatus === 'UNCERTAIN' || row.tradingStatus === 'NEEDS_REVIEW',
  ).length;
  return {
    cohortId,
    nominations: cohort.length,
    uniqueChannels: channelIds.size,
    byKind,
    byDepth,
    confirmed: confirmed.length,
    relationshipOnlyConfirms,
    keywordOverlapConfirms,
    zeroKeywordConfirms,
    unknownBaselineChannels,
    rejectedOrUncertain,
    duplicationRate: cohort.length ? (cohort.length - channelIds.size) / cohort.length : 0,
    quotaUnits,
    costPerConfirm: confirmed.length ? quotaUnits / confirmed.length : null,
  };
}
