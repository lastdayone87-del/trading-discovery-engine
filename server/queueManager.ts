import {
  getDb,
  saveDb,
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  recoverStaleJobs,
  getAllChannels,
  getChannelById,
  upsertChannel,
  getCountryVocabularies,
  getExcludedCountries,
  getQueueStatus,
  incrementQuota,
  getQuota,
  getQueryById,
  startQueryRun,
  completeQueryRun,
  failQueryRun,
  addQueryExecutionLog,
  tryReserveQuota,
  finishQuotaReservation,
  getAppSetting,
  heartbeatJob,
  recordQueryRunSightings
} from './db';
import { validateChannelCountry } from './countryValidator';
import { runChannelInspection, InspectionResult } from './inspector';
import { validateDiscordInvite } from './discordValidator';
import { searchYouTubeChannels, generateCountryQueries, fetchYouTubeChannelEnrichment, DiscoveredChannelRaw, RetrievalLane } from './youtube';
import { classifyTradingRelevance } from './tradingRelevanceClassifier';
import { evaluateQueryPerformance } from './queryIntelligence';
import { calculateQueryFunnel, type FunnelOutcome, type QueryObservation } from './queryPerformance';
import { processChannelThroughPipeline, isTerminalState } from './ingestionPipeline';
import { ChannelRecord, DiscoverySource, SearchJob, InspectionStep, DiscordStatus } from '../src/types';
import { assertCountryAllowed, ExcludedCountryError, getCountryExclusion } from './countryExclusion';
import { randomUUID } from 'node:crypto';

const WORKER_ID = `worker_${process.pid}`;

/**
 * Pushes a new search query job to the Search Jobs Queue.
 */
export async function addSearchJob(query: string, country: string, source: DiscoverySource): Promise<SearchJob> {
  await assertCountryAllowed(country, `queue:${source}`);
  const job = await enqueueJob(
    'SEARCH_YOUTUBE',
    { query, country, source },
    {
      idempotencyKey: `search:${source}:${country.toLowerCase()}:${query.toLowerCase()}`,
      priority: source === 'manual_search' ? 100 : 20
    }
  );
  return {
    id: job.id,
    query,
    country,
    source,
    status: job.status === 'PROCESSING' ? 'PROCESSING' : job.status === 'COMPLETED' ? 'COMPLETED' : job.status === 'FAILED' ? 'FAILED' : 'PENDING',
    attempts: job.attempts,
    createdAt: job.created_at
  };
}

/**
 * Enqueues a manual search query and expands it using the country vocabulary engine.
 */
export async function addManualCountrySearch(userQuery: string, countryName: string): Promise<{ baseJob: SearchJob; expandedQueries: string[] }> {
  await assertCountryAllowed(countryName, 'manual_search_queue_expansion');
  const baseJob = await addSearchJob(userQuery, countryName, 'manual_search');

  const expandedQueries: string[] = [userQuery];
  const vocabs = await getCountryVocabularies();
  const vocab = vocabs.find(v => v.country.toLowerCase() === countryName.toLowerCase());

  if (vocab) {
    const nativeTerms = vocab.native_trading_terminology || [];
    const formats = vocab.common_content_format_names || [];

    if (nativeTerms.length > 0) {
      const q1 = `${userQuery} ${nativeTerms[0]}`;
      await addSearchJob(q1, countryName, 'manual_search');
      expandedQueries.push(q1);
    }
    if (formats.length > 0) {
      const q2 = `${userQuery} ${formats[0]}`;
      await addSearchJob(q2, countryName, 'manual_search');
      expandedQueries.push(q2);
    }
  }

  return { baseJob, expandedQueries };
}

/**
 * Generates and enqueues country native queries for an automated discovery run.
 */
export async function addAutomatedCountrySearch(countryName: string): Promise<string[]> {
  await assertCountryAllowed(countryName, 'automated_search_generation');
  const vocabs = await getCountryVocabularies();
  const vocab = vocabs.find(v => v.country.toLowerCase() === countryName.toLowerCase());
  
  if (!vocab) {
    throw new Error(`Country '${countryName}' not found in allowed vocabulary database.`);
  }

  const generatedQueries = generateCountryQueries(vocab, 5);
  for (const q of generatedQueries) {
    await addSearchJob(q, countryName, 'automated_query');
  }

  return generatedQueries;
}

/**
 * Worker loop that processes one durable search or enrichment job.
 */
export async function processNextSearchJob(
  claimableOverride?: Array<'SEARCH_YOUTUBE' | 'ENRICH_CHANNEL'>,
  workerId = WORKER_ID
): Promise<boolean> {
  await recoverStaleJobs();
  const qStatus = await getQueueStatus();
  const claimableTypes: string[] = [];
  if (!qStatus.searchJobs.isPaused && (!claimableOverride || claimableOverride.includes('SEARCH_YOUTUBE'))) claimableTypes.push('SEARCH_YOUTUBE');
  if (!qStatus.channelProcessing.isPaused && (!claimableOverride || claimableOverride.includes('ENRICH_CHANNEL'))) claimableTypes.push('ENRICH_CHANNEL');
  if (claimableTypes.length === 0) return false;

  const job = await claimNextJob(workerId, claimableTypes);
  if (!job) return false;
  const heartbeat = setInterval(() => {
    heartbeatJob(job.id, workerId).catch(error => console.error(`[Queue Worker:${workerId}] Heartbeat failed:`, error));
  }, 60_000);
  heartbeat.unref?.();

  try {
    if (job.type === 'ENRICH_CHANNEL') {
      const { channelId, targetCountry, source, candidate } = job.payload as {
        channelId: string;
        targetCountry: string;
        source: DiscoverySource;
        candidate: DiscoveredChannelRaw;
      };
      await assertCountryAllowed(targetCountry, `enrichment_worker:${job.id}`);
      const channel = await getChannelById(channelId);
      if (!channel || isTerminalState(channel) || channel.trading_status !== 'UNCERTAIN') {
        await completeJob(job.id);
        return true;
      }

      channel.scan_status = 'ENRICHING';
      channel.scan_attempts = job.attempts;
      await upsertChannel(channel);
      const dailyBudget = Number(await getAppSetting('daily_youtube_quota_budget', process.env.DAILY_YOUTUBE_QUOTA_BUDGET || '9000'));
      const enrichmentPercent = Number(await getAppSetting('discovery_enrichment_quota_percent', process.env.DISCOVERY_ENRICHMENT_QUOTA_PERCENT || '20'));
      const quotaReserved = await tryReserveQuota({
        operationType: 'ENRICH_CHANNEL', operationId: job.id, allocation: 'ENRICHMENT',
        units: 101, dailyBudget, allocationPercent: enrichmentPercent
      });
      if (!quotaReserved) throw new Error('Enrichment quota allocation is currently exhausted.');
      try {
        const enriched = await fetchYouTubeChannelEnrichment(channelId, candidate);
        await processChannelThroughPipeline(enriched, targetCountry, source, false, true);
        await finishQuotaReservation('ENRICH_CHANNEL', job.id, true);
        await completeJob(job.id);
      } catch (error) {
        await finishQuotaReservation('ENRICH_CHANNEL', job.id, false);
        throw error;
      }
      return true;
    }

    const { query, country, source, queryRunId, queryId, retrievalLane = 'VIDEO' } = job.payload as {
      query: string; country: string; source: DiscoverySource; queryRunId?: string; queryId?: number; retrievalLane?: RetrievalLane;
    };
    // Defense in depth for jobs queued before a country was excluded.
    await assertCountryAllowed(country, `worker:${job.id}`);
    const vocabs = await getCountryVocabularies();
    const vocab = vocabs.find(v => v.country.toLowerCase() === country.toLowerCase());
    if (queryRunId) await startQueryRun(queryRunId);
    const extracted = await searchYouTubeChannels(query, country, vocab, retrievalLane);
    const distinctExtracted = [...new Map(extracted.map(channel => [channel.channelId, channel])).values()];
    const observations: QueryObservation[] = [];
    const sightings = [];
    for (const [index, raw] of distinctExtracted.entries()) {
      const outcome = await processDiscoveredChannel(raw, country, source);
      const funnelOutcome: FunnelOutcome = outcome.countryStatus === 'REJECTED'
        ? 'COUNTRY_REJECTED'
        : outcome.tradingStatus;
      const qualityScore = outcome.channelRecord?.quality_score || 0;
      const hasCommunity = outcome.discordStatus === 'ACTIVE' || outcome.discordStatus === 'ACTIVE_LOW_VOLUME';
      observations.push({ channelId: outcome.channelId, wasKnown: outcome.wasKnown, persisted: outcome.persisted, funnelOutcome, qualityScore, hasCommunity });
      sightings.push({
        channelId: outcome.channelId, resultRank: index + 1, searchLane: retrievalLane, wasKnown: outcome.wasKnown, persisted: outcome.persisted,
        countryOutcome: outcome.countryStatus, tradingOutcome: outcome.tradingStatus, funnelOutcome,
        metadata: { channelName: outcome.channelName, source, retrievalLane }
      });
    }
    if (queryRunId && queryId) {
      const queryRecord = await getQueryById(queryId);
      if (!queryRecord) throw new Error(`Query ${queryId} no longer exists for run ${queryRunId}.`);
      const metrics = calculateQueryFunnel(extracted.length, observations);
      await recordQueryRunSightings(queryRunId, queryId, sightings);
      const performance = await evaluateQueryPerformance(queryRecord, metrics);
      await completeQueryRun(queryRunId, {
        ...metrics,
        uniqueChannels: metrics.newChannels,
        qualityChannels: metrics.qualityChannels,
        communitiesDiscovered: metrics.communitiesDiscovered,
        quotaUsed: 100
      });
      await addQueryExecutionLog({
        query_id: queryId, query, country, executed_at: new Date().toISOString(),
        channels_discovered: metrics.distinctResults, unique_new_channels: metrics.newChannels,
        quality_creators_discovered: metrics.qualityChannels, communities_discovered: metrics.communitiesDiscovered,
        cycle_quality_score: performance.performanceScore,
        logs: [`Durable autonomous ${retrievalLane} lane run ${queryRunId} completed by ${workerId}.`, `Funnel: ${JSON.stringify(metrics)}`]
      });
    }
    await completeJob(job.id);
    return true;
  } catch (err: any) {
    if (err instanceof ExcludedCountryError) {
      // A policy change can make an already-persisted job ineligible. Consume it
      // without retrying so it can never spend external API quota.
      const runId = String(job.payload?.queryRunId || '');
      if (runId) await failQueryRun(runId, err, true);
      await completeJob(job.id);
      return true;
    }
    if (job.type === 'ENRICH_CHANNEL' && job.attempts >= job.max_attempts) {
      const channelId = String(job.payload?.channelId || '');
      const channel = channelId ? await getChannelById(channelId) : null;
      if (channel && channel.trading_status === 'UNCERTAIN') {
        channel.scan_status = 'NEEDS_REVIEW';
        channel.trading_status = 'NEEDS_REVIEW';
        channel.scan_attempts = job.attempts;
        channel.last_checked = new Date().toISOString();
        await upsertChannel(channel);
      }
    }
    await failJob(job.id, err);
    const runId = String(job.payload?.queryRunId || '');
    if (runId) await failQueryRun(runId, err, job.attempts >= job.max_attempts);
    return false;
  } finally {
    clearInterval(heartbeat);
  }
}

export interface ProcessDiscoveredChannelOutcome {
  channelId: string;
  channelName: string;
  isNew: boolean;
  wasKnown: boolean;
  persisted: boolean;
  countryStatus: 'CONFIRMED' | 'LIKELY' | 'UNCERTAIN' | 'REJECTED';
  tradingStatus: 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN' | 'NEEDS_REVIEW';
  discordStatus: DiscordStatus;
  discordInvite: string | null;
  channelRecord?: ChannelRecord;
}

/**
 * Handles newly discovered YouTube channel via the unified ingestion pipeline.
 */
export async function processDiscoveredChannel(
  raw: DiscoveredChannelRaw,
  targetCountry: string,
  source: DiscoverySource
): Promise<ProcessDiscoveredChannelOutcome> {
  return processChannelThroughPipeline(raw, targetCountry, source, false);
}

/**
 * Executes the inspection and Discord quality validation for a locked channel.
 */
export async function inspectAndValidateChannel(
  channel: ChannelRecord,
  rawDetails?: DiscoveredChannelRaw,
  isManualScan: boolean = false,
  enableDebug: boolean = false
): Promise<{ debugLog?: any } | void> {
  if (isTerminalState(channel) && !isManualScan) {
    console.log(`[Queue Manager] Channel '${channel.channel_name}' (${channel.channel_id}) is in terminal state '${channel.country_status}' / '${channel.trading_status}'. Aborting inspection.`);
    return;
  }

  const qStatus = await getQueueStatus();
  if (qStatus.channelProcessing.isPaused) {
    channel.scan_status = 'PENDING';
    await upsertChannel(channel);
    return;
  }

  const now = new Date().toISOString();

  let finalDebugLog: any = null;
  try {
    // 1. Re-check Country Validation before Discord scanning
    const valRes = await validateChannelCountry(
      {
        channelName: channel.channel_name,
        description: rawDetails?.description || channel.inspection_trail?.map(t => t.details || '').join(' ') || channel.channel_name,
        videoTitles: rawDetails?.videoTitles || [channel.channel_name],
        locationTag: rawDetails?.locationTag,
        externalLinks: rawDetails?.channelLinks || (channel.discord_invite ? [channel.discord_invite] : [])
      },
      channel.country
    );

    const countryStep: InspectionStep = {
      step: 'COUNTRY_VALIDATION',
      title: `Country Validation (${channel.country})`,
      status: valRes.status === 'REJECTED' ? 'REJECTED' : 'FOUND',
      details: valRes.decisionLogs,
      timestamp: now
    };

    if (valRes.status === 'REJECTED') {
      // Excluded country matched — Halt execution immediately! Never reach Discord crawler.
      channel.country_status = 'REJECTED';
      channel.confidence_score = valRes.score;
      channel.scan_status = 'COMPLETED';
      channel.last_checked = now;
      channel.inspection_trail = [countryStep];
      await upsertChannel(channel);
      console.log(`[Inspection Pipeline] Excluded country detected for '${channel.channel_name}'. Aborting Discord inspection.`);
      return;
    }

    // Update country status & decision trail
    channel.country_status = valRes.status;
    channel.confidence_score = valRes.score;
    if (valRes.detectedCountry) channel.country = valRes.detectedCountry;

    // 2. Step-by-step Channel Inspection Engine for Discord Invites (force live YouTube scrape on manual scan)
    const inspection = await runChannelInspection({
      enableDebug,
      channelId: channel.channel_id,
      channelBio: rawDetails?.description || channel.channel_name,
      channelLinks: rawDetails?.channelLinks || [],
      pinnedComment: rawDetails?.pinnedComment,
      videoDescriptions: rawDetails?.videoDescriptions || [],
      socialLinks: rawDetails?.channelLinks || [],
      youtubeUrl: channel.youtube_url,
      forceLiveFetch: isManualScan || !rawDetails?.description
    });

    // Combine Country Validation step as Step 1 with Discord Inspection steps
    channel.inspection_trail = [countryStep, ...inspection.steps];
    finalDebugLog = inspection.debugLog;

    if (inspection.extractedThumbnailUrl) {
      channel.channel_thumbnail_url = inspection.extractedThumbnailUrl;
    } else if (rawDetails?.channelThumbnailUrl) {
      channel.channel_thumbnail_url = rawDetails.channelThumbnailUrl;
    }

    if (inspection.foundInvite) {
      // Discord Found! Validate invite via Discord API with parent channel context
      const discordVal = await validateDiscordInvite(inspection.foundInvite, {
        parentChannelIsTrading: channel.trading_status === 'TRADING_CONFIRMED',
        channelName: channel.channel_name
      });

      channel.discord_status = discordVal.status;
      // ONLY persist invite URL if status is ACTIVE or ACTIVE_LOW_VOLUME (otherwise null)
      channel.discord_invite = discordVal.inviteUrl;
      channel.scan_status = 'COMPLETED';
      channel.scan_attempts = 0;
      channel.last_checked = now;
    } else {
      // Nothing Found After All Steps
      channel.discord_status = 'NOT_FOUND';
      channel.scan_status = 'COMPLETED';
      channel.scan_attempts = 0;
      channel.last_checked = now;
    }

  } catch (err) {
    channel.scan_attempts++;
    if (channel.scan_attempts >= 3) {
      channel.scan_status = 'FAILED_PERMANENT';
    } else {
      channel.scan_status = 'FAILED';
    }
  } finally {
    await upsertChannel(channel);
  }
  if (enableDebug) return { debugLog: finalDebugLog };
}

/**
 * Re-tests all existing channels in the database against the updated Hard Exclusion Engine.
 * Removes / marks previously accepted excluded-country channels as REJECTED.
 */
export async function auditExistingChannelsWithExclusionEngine(): Promise<{ total: number; rejected: number }> {
  try {
    const allChannels = await getAllChannels();
    let rejectedCount = 0;

    for (const channel of allChannels) {
      const trailDetails = (channel.inspection_trail || []).map(t => t.details || '').join(' ') || channel.channel_name;
      const valRes = await validateChannelCountry(
        {
          channelName: channel.channel_name,
          description: trailDetails,
          videoTitles: [channel.channel_name],
          externalLinks: channel.discord_invite ? [channel.discord_invite] : []
        },
        channel.country
      );

      if (valRes.status === 'REJECTED') {
        rejectedCount++;
        channel.country_status = 'REJECTED';
        channel.confidence_score = valRes.score;
        channel.scan_status = 'COMPLETED';

        const countryStep: InspectionStep = {
          step: 'COUNTRY_VALIDATION',
          title: `Database Country Exclusion Audit (${channel.country})`,
          status: 'REJECTED',
          details: valRes.decisionLogs,
          timestamp: new Date().toISOString()
        };

        const otherSteps = (channel.inspection_trail || []).filter(s => s.step !== 'COUNTRY_VALIDATION');
        channel.inspection_trail = [countryStep, ...otherSteps];

        await upsertChannel(channel);
      } else if (channel.discord_status === 'DEAD' || channel.discord_status === 'NON_TRADING' || channel.discord_status === 'UNCERTAIN') {
        // Enforce persistence rule: never store invite URLs for DEAD, NON_TRADING, or UNCERTAIN channels
        if (channel.discord_invite !== null) {
          channel.discord_invite = null;
          await upsertChannel(channel);
        }
      }
    }

    console.log(`[Database Audit] Re-tested ${allChannels.length} stored channels: ${rejectedCount} excluded channels marked REJECTED.`);
    return { total: allChannels.length, rejected: rejectedCount };
  } catch (err) {
    console.error('Error during database channel exclusion audit:', err);
    return { total: 0, rejected: 0 };
  }
}

// Run database channel audit asynchronously on module load
auditExistingChannelsWithExclusionEngine().catch(e => console.error('Database exclusion audit startup error:', e));

/**
 * Triggers a manual re-scan for a specific channel.
 * Runs 4-step inspection synchronously with force live YouTube scraping.
 * Does NOT schedule any automatic future rechecks.
 */
export async function triggerManualRecheck(channelId: string, enableDebug?: boolean): Promise<{ success: boolean; message: string; channel?: ChannelRecord; debugLog?: any }> {
  const channel = await getChannelById(channelId);
  if (!channel) {
    return { success: false, message: 'Channel not found in database.' };
  }

  const exclusion = await getCountryExclusion(channel.country);
  if (exclusion) {
    console.warn(JSON.stringify({ event: 'excluded_country_blocked', country: exclusion.country, reason: exclusion.reason, context: 'manual_recheck', channelId, timestamp: new Date().toISOString() }));
    return { success: false, message: `Manual re-scan blocked because ${exclusion.country} is excluded: ${exclusion.reason}`, channel };
  }

  // Acquire Lock and Reset Attempt Counter
  channel.scan_status = 'LOCKED';
  channel.scan_attempts = 0;
  channel.discovery_source = 'recheck';
  await upsertChannel(channel);

  console.log(`[Manual Scan Started] Channel: ${channel.channel_name} (${channel.channel_id})`);

  // Run inspection synchronously with force live YouTube page scrape
  const inspectRes = await inspectAndValidateChannel(
    channel,
    {
      channelId: channel.channel_id,
      channelName: channel.channel_name,
      youtubeUrl: channel.youtube_url,
      description: channel.channel_name,
      videoTitles: [channel.channel_name],
      channelLinks: channel.discord_invite ? [channel.discord_invite] : [],
      channelThumbnailUrl: channel.channel_thumbnail_url
    },
    true, // isManualScan = true (force live YouTube scraping & quota increment)
    enableDebug
  );

  const updatedChannel = await getChannelById(channelId);
  console.log(`[Manual Scan Completed] Channel: ${channel.channel_name}, Discord Status: ${updatedChannel?.discord_status || 'NOT_FOUND'}`);

  return {
    success: true,
    message: `Manual re-scan completed for ${channel.channel_name}.`,
    channel: updatedChannel || undefined,
    debugLog: inspectRes ? (inspectRes as any).debugLog : undefined
  };
}

export interface SearchExecutionResult {
  statusFlow: string[];
  summary: {
    query: string;
    country: string;
    returnedFromYouTube: number;
    extracted: number;
    newChannels: number;
    duplicatesUpdated: number;
    acceptedCountry: number;
    rejectedCountry: number;
    insertedOrUpdatedInDb: number;
  };
  logs: string[];
  channels: ChannelRecord[];
}

/**
 * Synchronous Full Manual Search Execution Engine.
 * Traces and logs full execution status flow:
 * QUEUED -> SEARCHING -> PROCESSING CHANNELS -> VALIDATING COUNTRY -> INSPECTING -> COMPLETED
 */
export async function executeFullManualSearch(
  userQuery: string,
  countryName: string
): Promise<SearchExecutionResult> {
  const logs: string[] = [];
  const statusFlow = ['QUEUED', 'SEARCHING', 'PROCESSING CHANNELS', 'VALIDATING COUNTRY', 'INSPECTING', 'COMPLETED'];

  // Stage 1: QUEUED
  logs.push(`[Stage 1: QUEUED]`);
  logs.push(`Search Started:`);
  logs.push(`  Query: ${userQuery}`);
  logs.push(`  Country: ${countryName}`);

  // Hard Exclusion Pre-Check
  const exclusion = await getCountryExclusion(countryName);
  if (exclusion) {
    console.warn(JSON.stringify({ event: 'excluded_country_blocked', country: exclusion.country, reason: exclusion.reason, context: 'manual_search', timestamp: new Date().toISOString() }));
    logs.push(`\n[HARD EXCLUSION GATE: REJECTED IMMEDIATELY]`);
    logs.push(`Target region '${countryName}' is explicitly configured in the Hard Exclusion List.`);
    logs.push(`Exiting pipeline immediately with SKIPPED_EXCLUDED before:`);
    logs.push(`  - YouTube Search API is invoked (0 API units spent)`);
    logs.push(`  - Evidence Providers execute (0 web crawls)`);
    logs.push(`  - Gemini Classifier is called (0 AI tokens used)`);
    logs.push(`  - Database records are created (0 DB mutations)`);

    logs.push(`\n[Stage 6: COMPLETED - SKIPPED_EXCLUDED]`);
    return {
      statusFlow: ['QUEUED', 'HARD_EXCLUSION_CHECK', 'SKIPPED_EXCLUDED'],
      summary: {
        query: userQuery,
        country: countryName,
        returnedFromYouTube: 0,
        extracted: 0,
        newChannels: 0,
        duplicatesUpdated: 0,
        acceptedCountry: 0,
        rejectedCountry: 1,
        insertedOrUpdatedInDb: 0
      },
      logs,
      channels: []
    };
  }

  // Stage 2: SEARCHING
  logs.push(`\n[Stage 2: SEARCHING]`);
  const vocabs = await getCountryVocabularies();
  const vocab = vocabs.find(v => v.country.toLowerCase() === countryName.toLowerCase());

  const queriesToRun: string[] = [userQuery];
  if (vocab && vocab.native_trading_terminology?.[0]) {
    queriesToRun.push(`${userQuery} ${vocab.native_trading_terminology[0]}`);
  }

  const manualOperationId = randomUUID();
  const manualQuotaReserved = await tryReserveQuota({
    operationType: 'MANUAL_SEARCH', operationId: manualOperationId, allocation: 'MANUAL',
    units: queriesToRun.length * 100,
    dailyBudget: Number(await getAppSetting('daily_youtube_quota_budget', process.env.DAILY_YOUTUBE_QUOTA_BUDGET || '9000')),
    allocationPercent: Number(await getAppSetting('discovery_manual_quota_percent', process.env.DISCOVERY_MANUAL_QUOTA_PERCENT || '10'))
  });
  if (!manualQuotaReserved) throw new Error('Manual YouTube quota allocation is currently exhausted.');

  let allDiscoveredRaw: DiscoveredChannelRaw[] = [];
  try {
    for (const q of queriesToRun) {
      try {
        logs.push(`Executing YouTube Search for: '${q}'...`);
        const results = await searchYouTubeChannels(q, countryName, vocab);
        logs.push(`YouTube API: Response received. Channels returned: ${results.length}`);
        allDiscoveredRaw.push(...results);
      } catch (e: any) {
        logs.push(`YouTube API Call Error for '${q}': ${e.message}`);
      }
    }
    await finishQuotaReservation('MANUAL_SEARCH', manualOperationId, true);
  } catch (error) {
    await finishQuotaReservation('MANUAL_SEARCH', manualOperationId, false);
    throw error;
  }

  // Stage 3: PROCESSING CHANNELS
  logs.push(`\n[Stage 3: PROCESSING CHANNELS]`);
  logs.push(`Extraction: Channels extracted from API responses: ${allDiscoveredRaw.length}`);

  // Deduplicate raw channels list by channelId
  const uniqueRawMap = new Map<string, DiscoveredChannelRaw>();
  for (const raw of allDiscoveredRaw) {
    if (!uniqueRawMap.has(raw.channelId)) {
      uniqueRawMap.set(raw.channelId, raw);
    }
  }
  const uniqueRawList = Array.from(uniqueRawMap.values());

  let newChannelsCount = 0;
  let duplicatesUpdatedCount = 0;
  let acceptedCountryCount = 0;
  let rejectedCountryCount = 0;
  let insertedOrUpdatedCount = 0;
  const processedChannels: ChannelRecord[] = [];

  // Stage 4: UNIFIED INGESTION PIPELINE (Gate 1 Country -> Gate 2 Trading Classifier -> Gate 3 Discord Inspection)
  logs.push(`\n[Stage 4 & 5: UNIFIED INGESTION PIPELINE]`);
  for (const raw of uniqueRawList) {
    logs.push(`\nProcessing candidate '${raw.channelName}' (${raw.channelId}) through unified pipeline...`);
    const outcome = await processChannelThroughPipeline(raw, countryName, 'manual_search', true);

    if (outcome.isNew) {
      newChannelsCount++;
    } else {
      duplicatesUpdatedCount++;
    }

    if (outcome.countryStatus === 'REJECTED') {
      rejectedCountryCount++;
      logs.push(`  └─ Gate 1 Country Validation: REJECTED (Hard Exclusion Engine)`);
    } else {
      acceptedCountryCount++;
      logs.push(`  ├─ Gate 1 Country Validation: ${outcome.countryStatus}`);
      logs.push(`  ├─ Gate 2 Trading Relevance: ${outcome.tradingStatus}`);
      logs.push(`  └─ Gate 3 Discord Inspection: ${outcome.discordStatus} (${outcome.discordInvite ? `Invite: ${outcome.discordInvite}` : 'No invite found'})`);
    }

    if (outcome.channelRecord) {
      insertedOrUpdatedCount++;
      processedChannels.push(outcome.channelRecord);
    }
  }

  saveDb();

  // Stage 6: COMPLETED
  logs.push(`\n[Stage 6: COMPLETED]`);
  logs.push(`Workflow execution finished.`);
  logs.push(`Summary:`);
  logs.push(`  Query: ${userQuery}`);
  logs.push(`  Country: ${countryName}`);
  logs.push(`  YouTube API Channels Returned: ${allDiscoveredRaw.length}`);
  logs.push(`  Channels Extracted: ${uniqueRawList.length}`);
  logs.push(`  New Channels Discovered: ${newChannelsCount}`);
  logs.push(`  Duplicates Updated: ${duplicatesUpdatedCount}`);
  logs.push(`  Country Validation Accepted: ${acceptedCountryCount}`);
  logs.push(`  Country Validation Rejected: ${rejectedCountryCount}`);
  logs.push(`  Database Inserts/Updates: ${insertedOrUpdatedCount}`);

  return {
    statusFlow,
    summary: {
      query: userQuery,
      country: countryName,
      returnedFromYouTube: allDiscoveredRaw.length,
      extracted: uniqueRawList.length,
      newChannels: newChannelsCount,
      duplicatesUpdated: duplicatesUpdatedCount,
      acceptedCountry: acceptedCountryCount,
      rejectedCountry: rejectedCountryCount,
      insertedOrUpdatedInDb: insertedOrUpdatedCount
    },
    logs,
    channels: processedChannels
  };
}

function startWorkerPool(type: 'SEARCH_YOUTUBE' | 'ENRICH_CHANNEL', concurrency: number): void {
  const safeConcurrency = Math.min(20, Math.max(1, Math.floor(concurrency) || 1));
  for (let index = 0; index < safeConcurrency; index++) {
    const workerId = `${type.toLowerCase()}_${process.pid}_${index}`;
    const tick = async () => {
      try {
        await processNextSearchJob([type], workerId);
      } catch (error) {
        console.error(`[Queue Worker:${workerId}] Worker tick failed:`, error);
      } finally {
        const timer = setTimeout(tick, 1000);
        timer.unref?.();
      }
    };
    void tick();
  }
}

startWorkerPool('SEARCH_YOUTUBE', Math.max(1, Number(process.env.SEARCH_WORKER_CONCURRENCY || 1)));
startWorkerPool('ENRICH_CHANNEL', Math.max(1, Number(process.env.ENRICHMENT_WORKER_CONCURRENCY || 1)));
