import { getAppSetting, getDb, getDailyYouTubeQuotaBudget, tryReserveQuota, finishQuotaReservation, type DurableJob } from './db';
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
  const seedIds = new Set(input.seeds.map(seed => `${seed.kind}:${seed.id}`));
  for (const channelId of input.depth1ChannelIds) {
    if (plan.length >= maxDepth2Parents) break;
    const key = `featured:${channelId}`;
    if (seen.has(key) || seedIds.has(key)) continue;
    seen.add(key);
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
  failures: string[];
  quotaUnits: number;
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
    failures: [],
    quotaUnits: 0,
  };
  const log = deps.log || ((message: string) => console.info(message));
  if (!isRelationshipCanaryLive(settings)) {
    summary.status = 'KILLED';
    log(`[RelationshipCanary] cohort=${payload.cohortId} killed (enabled=${settings.enabled}); no provider spend.`);
    return summary;
  }
  const fetchFeatured = deps.fetchFeaturedChannels || fetchYouTubeFeaturedChannels;
  const fetchPlaylist = deps.fetchPlaylistChannels || fetchYouTubePlaylistChannels;
  // Effective ingest: explicit dep override wins (tests), otherwise the live
  // pipeline callback passed positionally (featured/playlist worker pattern).
  const ingestFn = deps.ingest || ingest;
  const nominate = deps.nominate || (async (input) => recordNomination({ ...input, queryGenerationMode: 'RELATIONSHIP_CANARY' } as never));
  const reserve = deps.reserveQuota || defaultReserveQuota;
  const finish = deps.finishQuota || (async (operationId: string, consumed: boolean) => { await finishQuotaReservation('RELATIONSHIP_CANARY', operationId, consumed); });
  const visited = new Set<string>();
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
        rawObservation: nomination.rawObservation,
      });
      raw.nominationId = record?.id || undefined;
      await ingestFn(raw, payload.targetCountry, 'automated_query');
      summary.nominations++;
      summary.ingested++;
    } catch (error) {
      summary.failures.push(`${raw.channelId}:${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
    }
  };

  const expandFeatured = async (sourceChannelId: string, provenance: Omit<RelationshipProvenance, 'kind'> & { kind: 'featured' }): Promise<string[]> => {
    const operationId = `relationship-canary:${payload.cohortId}:${provenance.depth}:${sourceChannelId}`;
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

  // Depth 1: seeds.
  for (const seed of payload.seeds) {
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
      summary.failures.push(`${seed.kind}:${seed.id}:${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
    }
    if (quotaExhausted) break;
  }

  // Depth 2: featured expansion of capped depth-1 parents (never deeper).
  if (payload.maxDepth >= 2 && !quotaExhausted) {
    const plan = planRelationshipExpansion({
      seeds: payload.seeds.map(seed => ({ kind: seed.kind, id: seed.id })),
      maxDepth: payload.maxDepth,
      maxFanout: payload.maxFanout,
      depth1ChannelIds: depth1.map(entry => entry.channelId),
      seedOf,
    });
    for (const target of plan) {
      if (visited.has(`featured:${target.targetId}`)) continue;
      visited.add(`featured:${target.targetId}`);
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
        summary.failures.push(`featured:${target.targetId}:${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
      }
      if (quotaExhausted) break;
    }
  }

  log(`[RelationshipCanary] cohort=${payload.cohortId} status=${summary.status} seeds=${summary.seedsAttempted} depth1=${summary.depth1Channels} depth2fetches=${summary.depth2Fetches} nominations=${summary.nominations} ingested=${summary.ingested} capped=${summary.channelsCapped} failures=${summary.failures.length} quotaUnits=${summary.quotaUnits}`);
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
  rejectedOrUncertain: number;
  duplicationRate: number;
  quotaUnits: number;
  costPerConfirm: number | null;
}

/**
 *Aggregate one canary cohort. "Relationship-only confirms" (confirmed
 * creators with zero non-cohort nominations) is the experiment's primary
 * would-keyword-have-found-it proxy: the keyword path never nominated them.
 * Coincidental keyword text on the retrieval document is not separately
 * measured here; confirm it by manual sampling before claiming yield.
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
  // Any nomination WITHOUT this cohort marker counts as keyword-path (or
  // otherwise non-relationship) evidence for overlap measurement.
  const keywordNominated = new Set(
    nominations.filter(row => row.cohortId !== cohortId).map(row => row.channelId),
  );
  const cohortChannels = channels.filter(row => channelIds.has(row.channelId));
  const confirmed = cohortChannels.filter(row => row.tradingStatus === 'TRADING_CONFIRMED');
  const relationshipOnlyConfirms = confirmed.filter(row => !keywordNominated.has(row.channelId)).length;
  const keywordOverlapConfirms = confirmed.length - relationshipOnlyConfirms;
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
    rejectedOrUncertain,
    duplicationRate: channelIds.size ? cohort.length / channelIds.size : 0,
    quotaUnits,
    costPerConfirm: confirmed.length ? quotaUnits / confirmed.length : null,
  };
}
