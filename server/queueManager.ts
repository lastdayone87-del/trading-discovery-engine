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
  getQuota
} from './db';
import { validateChannelCountry } from './countryValidator';
import { runChannelInspection, InspectionResult } from './inspector';
import { validateDiscordInvite } from './discordValidator';
import { searchYouTubeChannels, generateCountryQueries, DiscoveredChannelRaw } from './youtube';
import { classifyTradingRelevance } from './tradingRelevanceClassifier';
import { processChannelThroughPipeline, isTerminalState } from './ingestionPipeline';
import { ChannelRecord, DiscoverySource, SearchJob, InspectionStep, DiscordStatus } from '../src/types';

const WORKER_ID = `worker_${process.pid}`;

/**
 * Pushes a new search query job to the Search Jobs Queue.
 */
export async function addSearchJob(query: string, country: string, source: DiscoverySource): Promise<SearchJob> {
  const job = await enqueueJob(
    'SEARCH_YOUTUBE',
    { query, country, source },
    { idempotencyKey: `search:${source}:${country.toLowerCase()}:${query.toLowerCase()}` }
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
 * Worker loop that processes 1 Search Job from queue.
 */
export async function processNextSearchJob(): Promise<boolean> {
  await recoverStaleJobs();
  const qStatus = await getQueueStatus();
  if (qStatus.searchJobs.isPaused) return false;

  const job = await claimNextJob(WORKER_ID, ['SEARCH_YOUTUBE']);
  if (!job) return false;

  try {
    const { query, country, source } = job.payload as { query: string; country: string; source: DiscoverySource };
    const vocabs = await getCountryVocabularies();
    const vocab = vocabs.find(v => v.country.toLowerCase() === country.toLowerCase());
    const extracted = await searchYouTubeChannels(query, country, vocab);
    for (const raw of extracted) {
      await processDiscoveredChannel(raw, country, source);
    }
    await completeJob(job.id);
    return true;
  } catch (err: any) {
    await failJob(job.id, err);
    return false;
  }
}

export interface ProcessDiscoveredChannelOutcome {
  channelId: string;
  channelName: string;
  isNew: boolean;
  countryStatus: 'CONFIRMED' | 'LIKELY' | 'UNCERTAIN' | 'REJECTED';
  tradingStatus: 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN';
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
        locationTag: rawDetails?.locationTag || channel.country,
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
          locationTag: channel.country,
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
      locationTag: channel.country,
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
  const excludedCountries = await getExcludedCountries();
  const isExcluded = excludedCountries.some(e => e.country_name.toLowerCase() === countryName.toLowerCase());
  if (isExcluded) {
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

  let allDiscoveredRaw: DiscoveredChannelRaw[] = [];
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

// Background Worker Timer
setInterval(async () => {
  try {
    await processNextSearchJob();
  } catch (e) {
    // Ignore worker tick error
  }
}, 4000); // Ticks every 4 seconds
