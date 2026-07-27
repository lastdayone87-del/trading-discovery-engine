import { ChannelRecord, DiscoverySource, DiscordStatus } from '../src/types';
import { DiscoveredChannelRaw } from './youtube';
import { validateChannelCountry } from './countryValidator';
import { classifyTradingRelevance } from './tradingRelevanceClassifier';
import { inspectAndValidateChannel } from './queueManager';
import {
  getChannelById,
  upsertChannel
} from './db';
import { calculateCreatorQualityScore, extractVocabularyFromCreator } from './queryIntelligence';

export interface IngestionCandidate extends DiscoveredChannelRaw {
  // Option for additional candidate details if provided
}

export interface IngestionPipelineOutcome {
  channelId: string;
  channelName: string;
  isNew: boolean;
  countryStatus: 'CONFIRMED' | 'LIKELY' | 'UNCERTAIN' | 'REJECTED';
  tradingStatus: 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN';
  discordStatus: DiscordStatus;
  discordInvite: string | null;
  channelRecord?: ChannelRecord;
  skippedTerminalState?: boolean;
}

/**
 * Check if a channel record is in a true terminal state.
 * REJECTED and NON_TRADING channels must never be automatically crawled or rescanned again.
 */
export function isTerminalState(channel: ChannelRecord): boolean {
  return (
    channel.country_status === 'REJECTED' ||
    channel.trading_status === 'NON_TRADING' ||
    channel.scan_status === 'SKIPPED_EXCLUDED' ||
    channel.scan_status === 'SKIPPED_NON_TRADING'
  );
}

/**
 * SINGLE UNIFIED INGESTION PIPELINE
 * Centralized, modular validation flow for ALL discovery sources (YouTube search, manual search, automated query, future sources).
 * 
 * Pipeline Flow:
 * 0. Terminal State & Deduplication Check (True terminal states: REJECTED & NON_TRADING are NEVER rescanned)
 * 1. Gate 1: Country Validation Hard Gate (Rejects excluded countries immediately)
 * 2. Gate 2: Trading Relevance Classifier (Fast Heuristic -> Gemini AI Semantic Classifier for UNCERTAIN)
 * 3. Gate 3: Channel Inspection, Discord Crawler & Creator Quality Analysis
 */
export async function processChannelThroughPipeline(
  candidate: IngestionCandidate,
  targetCountry: string,
  source: DiscoverySource,
  isManualScan: boolean = false
): Promise<IngestionPipelineOutcome> {
  const now = new Date().toISOString();

  // Step 0: Terminal State & Existing Channel Check
  const existing = await getChannelById(candidate.channelId);
  if (existing) {
    // Check for TRUE TERMINAL STATES or ALREADY PROCESSED STABLE STATES
    if ((isTerminalState(existing) || existing.trading_status === 'TRADING_CONFIRMED' || existing.scan_status === 'COMPLETED') && !isManualScan) {
      console.log(
        `[Unified Ingestion Pipeline] Channel '${candidate.channelName}' (${candidate.channelId}) is already in database (Country: ${existing.country_status}, Trading: ${existing.trading_status}, Scan: ${existing.scan_status}). Preserving existing record.`
      );
      // Update basic existing metadata if changed
      let updated = false;
      if (candidate.subscriberCount && candidate.subscriberCount !== existing.subscriber_count) {
        existing.subscriber_count = candidate.subscriberCount;
        updated = true;
      }
      if (candidate.channelThumbnailUrl && candidate.channelThumbnailUrl !== existing.channel_thumbnail_url) {
        existing.channel_thumbnail_url = candidate.channelThumbnailUrl;
        updated = true;
      }
      if (updated) {
        await upsertChannel(existing);
      }

      return {
        channelId: candidate.channelId,
        channelName: candidate.channelName,
        isNew: false,
        countryStatus: existing.country_status,
        tradingStatus: existing.trading_status || 'UNCERTAIN',
        discordStatus: existing.discord_status,
        discordInvite: existing.discord_invite || null,
        channelRecord: existing,
        skippedTerminalState: true
      };
    }
  }

  // Step 1: GATE 1 - Country Validation Hard Gate
  const countryVal = await validateChannelCountry(
    {
      channelName: candidate.channelName,
      description: candidate.description,
      videoTitles: candidate.videoTitles,
      locationTag: candidate.locationTag,
      externalLinks: candidate.channelLinks
    },
    targetCountry
  );

  const countryValidationStep = {
    step: 'COUNTRY_VALIDATION' as const,
    title: `Country Validation (${targetCountry})`,
    status: countryVal.status === 'REJECTED' ? ('REJECTED' as const) : ('FOUND' as const),
    details: countryVal.decisionLogs,
    timestamp: now
  };

  if (countryVal.status === 'REJECTED') {
    console.log(
      `[Unified Ingestion Pipeline - Gate 1] Channel '${candidate.channelName}' REJECTED by Hard Exclusion Engine (${targetCountry}). Halting pipeline immediately.`
    );
    const rejectedChannel: ChannelRecord = existing || {
      channel_id: candidate.channelId,
      channel_name: candidate.channelName,
      youtube_url: candidate.youtubeUrl,
      country: targetCountry,
      country_status: 'REJECTED',
      confidence_score: countryVal.score,
      discord_status: 'NOT_FOUND',
      discord_invite: null,
      scan_status: 'SKIPPED_EXCLUDED',
      scan_attempts: 0,
      discovery_source: source,
      first_seen: now,
      last_checked: now,
      inspection_trail: [countryValidationStep],
      subscriber_count: candidate.subscriberCount,
      channel_thumbnail_url: candidate.channelThumbnailUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(candidate.channelName)}&background=0f172a&color=38bdf8&bold=true`,
      trading_status: 'UNCERTAIN',
      trading_confidence_score: 0,
      trading_category: 'General Trading'
    };

    rejectedChannel.country_status = 'REJECTED';
    rejectedChannel.confidence_score = countryVal.score;
    rejectedChannel.scan_status = 'SKIPPED_EXCLUDED';
    rejectedChannel.last_checked = now;
    rejectedChannel.inspection_trail = [countryValidationStep];

    await upsertChannel(rejectedChannel);

    return {
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      isNew: !existing,
      countryStatus: 'REJECTED',
      tradingStatus: 'UNCERTAIN',
      discordStatus: 'NOT_FOUND',
      discordInvite: null,
      channelRecord: rejectedChannel
    };
  }

  // Step 2: GATE 2 - Evidence-Based Trading Verification Engine
  const tradingVal = await classifyTradingRelevance(
    candidate.channelName,
    candidate.description,
    candidate.videoTitles,
    candidate.videoDescriptions?.join(' ') || '',
    targetCountry,
    candidate.channelLinks,
    undefined
  );

  if (tradingVal.status === 'NON_TRADING') {
    console.log(
      `[Unified Ingestion Pipeline - Gate 2] Channel '${candidate.channelName}' REJECTED as VERIFIED_NON_TRADING (${tradingVal.breakdown.classification_method || 'EVIDENCE'}, Score: ${tradingVal.confidenceScore}/100). Halting pipeline (Skipping Discord crawler).`
    );

    const nonTradingChannel: ChannelRecord = existing || {
      channel_id: candidate.channelId,
      channel_name: candidate.channelName,
      youtube_url: candidate.youtubeUrl,
      country: targetCountry,
      country_status: countryVal.status,
      confidence_score: countryVal.score,
      discord_status: 'NON_TRADING',
      discord_invite: null,
      scan_status: 'SKIPPED_NON_TRADING',
      scan_attempts: 0,
      discovery_source: source,
      first_seen: now,
      last_checked: now,
      inspection_trail: [countryValidationStep],
      subscriber_count: candidate.subscriberCount,
      channel_thumbnail_url: candidate.channelThumbnailUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(candidate.channelName)}&background=0f172a&color=38bdf8&bold=true`,
      trading_status: 'NON_TRADING',
      trading_confidence_score: tradingVal.confidenceScore,
      trading_category: tradingVal.category,
      trading_relevance_breakdown: tradingVal.breakdown
    };

    nonTradingChannel.country_status = countryVal.status;
    nonTradingChannel.confidence_score = countryVal.score;
    nonTradingChannel.trading_status = 'NON_TRADING';
    nonTradingChannel.trading_confidence_score = tradingVal.confidenceScore;
    nonTradingChannel.trading_category = tradingVal.category;
    nonTradingChannel.trading_relevance_breakdown = tradingVal.breakdown;
    nonTradingChannel.scan_status = 'SKIPPED_NON_TRADING';
    nonTradingChannel.discord_status = 'NON_TRADING';
    nonTradingChannel.discord_invite = null;
    nonTradingChannel.last_checked = now;

    await upsertChannel(nonTradingChannel);

    return {
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      isNew: !existing,
      countryStatus: countryVal.status,
      tradingStatus: 'NON_TRADING',
      discordStatus: 'NON_TRADING',
      discordInvite: null,
      channelRecord: nonTradingChannel
    };
  }

  if (tradingVal.status === 'UNCERTAIN') {
    console.log(
      `[Unified Ingestion Pipeline - Gate 2] Channel '${candidate.channelName}' classified as UNCERTAIN (${tradingVal.confidenceScore}/100). Preserving in dormant state. Skipping Discord discovery.`
    );

    const uncertainChannel: ChannelRecord = existing || {
      channel_id: candidate.channelId,
      channel_name: candidate.channelName,
      youtube_url: candidate.youtubeUrl,
      country: targetCountry,
      country_status: countryVal.status,
      confidence_score: countryVal.score,
      discord_status: 'UNCERTAIN',
      discord_invite: null,
      scan_status: 'COMPLETED',
      scan_attempts: 0,
      discovery_source: source,
      first_seen: now,
      last_checked: now,
      inspection_trail: [countryValidationStep],
      subscriber_count: candidate.subscriberCount,
      channel_thumbnail_url: candidate.channelThumbnailUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(candidate.channelName)}&background=0f172a&color=38bdf8&bold=true`,
      trading_status: 'UNCERTAIN',
      trading_confidence_score: tradingVal.confidenceScore,
      trading_category: tradingVal.category,
      trading_relevance_breakdown: tradingVal.breakdown
    };

    uncertainChannel.country_status = countryVal.status;
    uncertainChannel.confidence_score = countryVal.score;
    uncertainChannel.trading_status = 'UNCERTAIN';
    uncertainChannel.trading_confidence_score = tradingVal.confidenceScore;
    uncertainChannel.trading_category = tradingVal.category;
    uncertainChannel.trading_relevance_breakdown = tradingVal.breakdown;
    uncertainChannel.scan_status = 'COMPLETED';
    uncertainChannel.discord_status = 'UNCERTAIN';
    uncertainChannel.last_checked = now;

    await upsertChannel(uncertainChannel);

    return {
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      isNew: !existing,
      countryStatus: countryVal.status,
      tradingStatus: 'UNCERTAIN',
      discordStatus: 'UNCERTAIN',
      discordInvite: null,
      channelRecord: uncertainChannel
    };
  }

  // Step 3: GATE 3 - Deep Inspection, Discord Crawler & Quality Analysis
  console.log(
    `[Unified Ingestion Pipeline - Gate 3] Channel '${candidate.channelName}' [Status: ${tradingVal.status}] (${tradingVal.category}, ${tradingVal.breakdown.classification_method || 'CONFIRMED'}). Executing Discord crawler...`
  );

  const activeChannel: ChannelRecord = existing || {
    channel_id: candidate.channelId,
    channel_name: candidate.channelName,
    youtube_url: candidate.youtubeUrl,
    country: targetCountry,
    country_status: countryVal.status,
    confidence_score: countryVal.score,
    discord_status: 'PENDING',
    discord_invite: null,
    scan_status: 'LOCKED',
    scan_attempts: 0,
    discovery_source: source,
    first_seen: now,
    last_checked: null,
    inspection_trail: [countryValidationStep],
    subscriber_count: candidate.subscriberCount,
    channel_thumbnail_url: candidate.channelThumbnailUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(candidate.channelName)}&background=0f172a&color=38bdf8&bold=true`,
    trading_status: tradingVal.status,
    trading_confidence_score: tradingVal.confidenceScore,
    trading_category: tradingVal.category,
    trading_relevance_breakdown: tradingVal.breakdown
  };

  activeChannel.country_status = countryVal.status;
  activeChannel.confidence_score = countryVal.score;
  activeChannel.trading_status = tradingVal.status;
  activeChannel.trading_confidence_score = tradingVal.confidenceScore;
  activeChannel.trading_category = tradingVal.category;
  activeChannel.trading_relevance_breakdown = tradingVal.breakdown;
  activeChannel.scan_status = 'LOCKED';

  await upsertChannel(activeChannel);

  // Run Discord Inspection Engine
  await inspectAndValidateChannel(activeChannel, candidate, isManualScan);

  const finalChannel = (await getChannelById(candidate.channelId)) || activeChannel;

  // Compute Quality Score & Extract Vocabulary if Quality >= 55
  const qualityResult = calculateCreatorQualityScore(finalChannel, candidate.videoTitles, candidate.description);
  finalChannel.quality_score = qualityResult.score;
  finalChannel.quality_breakdown = qualityResult.breakdown;
  await upsertChannel(finalChannel);

  if (qualityResult.score >= 55) {
    await extractVocabularyFromCreator(finalChannel, candidate.videoTitles, candidate.description);
  }

  return {
    channelId: candidate.channelId,
    channelName: candidate.channelName,
    isNew: !existing,
    countryStatus: countryVal.status,
    tradingStatus: finalChannel.trading_status || tradingVal.status,
    discordStatus: finalChannel.discord_status,
    discordInvite: finalChannel.discord_invite || null,
    channelRecord: finalChannel
  };
}
