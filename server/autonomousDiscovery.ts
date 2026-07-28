import { ChannelRecord, QueryExecutionLog, QueryRecord } from '../src/types';
import {
  getCountryVocabularies,
  getExcludedCountries,
  getChannelById,
  getAllChannels,
  getRecentQueryExecutionLogs,
  addQueryExecutionLog,
  upsertChannel,
  getAppSetting,
  setAppSetting,
  getSchedulerState,
  acquireSchedulerLock,
  releaseSchedulerLock,
  updateSchedulerState,
  recoverStaleJobs
} from './db';
import { searchYouTubeChannels } from './youtube';
import { processDiscoveredChannel, addSearchJob, ProcessDiscoveredChannelOutcome } from './queueManager';
import {
  selectNextQueryForCountry,
  calculateCreatorQualityScore,
  extractVocabularyFromCreator,
  evaluateQueryPerformance
} from './queryIntelligence';

export type DiscoveryScopeMode = 'GLOBAL' | 'SELECTED_COUNTRIES';

interface DiscoveryCycleStatus {
  isRunning: boolean;
  isPaused: boolean;
  scope: DiscoveryScopeMode;
  selectedCountries: string[];
  lastRunTime?: string;
  nextScheduledTime?: string;
  lastReport?: {
    country: string;
    query: string;
    strategy: string;
    discoveredCount: number;
    uniqueCount: number;
    qualityCreatorsCount: number;
    performanceScore: number;
    newCollection: string;
    summary: string;
  };
}

let schedulerHandle: NodeJS.Timeout | null = null;
let currentCountryIndex = 0;
let isCycleRunning = false;
let lastRunTime: string | undefined = undefined;
let nextScheduledTime: string | undefined = undefined;
let lastReport: DiscoveryCycleStatus['lastReport'] = undefined;

/**
 * Checks if Query Intelligence is currently paused.
 */
export async function isQueryIntelligencePaused(): Promise<boolean> {
  const val = await getAppSetting('query_intelligence_paused', 'false');
  return val === 'true';
}

/**
 * Pauses Query Intelligence safely.
 * Finishes processing the current creator, saves queue & progress, and halts further cycles.
 */
export async function pauseQueryIntelligence(): Promise<{ message: string; isPaused: boolean }> {
  await setAppSetting('query_intelligence_paused', 'true');
  console.log('[Query Intelligence] Engine PAUSED by user. Saved discovery state.');
  return { message: 'Query Intelligence safely paused. Current state and queue preserved.', isPaused: true };
}

/**
 * Resumes Query Intelligence from exact saved state.
 */
export async function resumeQueryIntelligence(): Promise<{ message: string; isPaused: boolean }> {
  await setAppSetting('query_intelligence_paused', 'false');
  console.log('[Query Intelligence] Engine RESUMED by user.');
  return { message: 'Query Intelligence resumed. Continuing from saved discovery state.', isPaused: false };
}

/**
 * Gets persistent Discovery Scope configuration from database.
 */
export async function getDiscoveryScope(): Promise<{ scope: DiscoveryScopeMode; selectedCountries: string[] }> {
  const scopeStr = await getAppSetting('query_intelligence_discovery_scope', 'GLOBAL');
  const scope: DiscoveryScopeMode = scopeStr === 'SELECTED_COUNTRIES' ? 'SELECTED_COUNTRIES' : 'GLOBAL';
  const countriesJson = await getAppSetting('query_intelligence_selected_countries', '[]');
  let selectedCountries: string[] = [];
  try {
    selectedCountries = JSON.parse(countriesJson);
    if (!Array.isArray(selectedCountries)) selectedCountries = [];
  } catch (e) {
    selectedCountries = [];
  }
  return { scope, selectedCountries };
}

/**
 * Updates persistent Discovery Scope configuration in database.
 */
export async function setDiscoveryScope(scope: DiscoveryScopeMode, selectedCountries: string[]): Promise<{ scope: DiscoveryScopeMode; selectedCountries: string[] }> {
  const cleanCountries = Array.from(new Set(selectedCountries.map(c => c.trim()).filter(Boolean)));
  await setAppSetting('query_intelligence_discovery_scope', scope);
  await setAppSetting('query_intelligence_selected_countries', JSON.stringify(cleanCountries));
  console.log(`[Query Intelligence] Discovery Scope updated: ${scope} (${cleanCountries.join(', ') || 'None'})`);
  return { scope, selectedCountries: cleanCountries };
}

/**
 * Runs a single Query Intelligence discovery cycle for a given country or automatically selected next country.
 * Respects Pause state and Discovery Scope configuration.
 */
export async function runAutonomousDiscoveryCycle(targetCountry?: string): Promise<{
  country: string;
  query: string;
  strategy: string;
  discoveredCount: number;
  uniqueCount: number;
  qualityCreatorsCount: number;
  performanceScore: number;
  newCollection: string;
  summary: string;
  logs: string[];
  isPaused?: boolean;
}> {
  if (isCycleRunning) {
    throw new Error('An autonomous discovery cycle is already in progress.');
  }

  const schedulerWorkerId = `autonomous_${process.pid}`;
  const lockAcquired = await acquireSchedulerLock('autonomous_discovery', schedulerWorkerId);
  if (!lockAcquired) {
    throw new Error('Autonomous discovery scheduler lock is already held by another worker.');
  }

  // Check if paused
  const paused = await isQueryIntelligencePaused();
  if (paused && !targetCountry) {
    console.log('[Query Intelligence] Engine is currently PAUSED. Skipping discovery cycle.');
    return {
      country: 'N/A',
      query: 'N/A',
      strategy: 'PAUSED',
      discoveredCount: 0,
      uniqueCount: 0,
      qualityCreatorsCount: 0,
      performanceScore: 0,
      newCollection: 'NONE',
      summary: 'Query Intelligence is currently PAUSED. Resume engine to continue discovery.',
      logs: ['Engine is paused. State preserved.'],
      isPaused: true
    };
  }

  isCycleRunning = true;
  const cycleLogs: string[] = [];
  const log = (msg: string) => {
    console.log(`[Autonomous Intelligence] ${msg}`);
    cycleLogs.push(`${new Date().toISOString().split('T')[1].slice(0, 8)} - ${msg}`);
  };

  const executedAt = new Date().toISOString();
  let countryName = targetCountry || 'Unknown';
  let selectedQueryStr = 'None';
  let queryObj: QueryRecord | null = null;
  let selectionStrat = 'MANUAL';

  try {
    log('=== AUTONOMOUS DISCOVERY CYCLE TRIGGERED ===');

    // 1. Target Country Selection based on Discovery Scope
    const vocabs = await getCountryVocabularies();
    const excluded = await getExcludedCountries();
    const excludedNames = excluded.map(e => e.country_name.toLowerCase());

    const scopeConfig = await getDiscoveryScope();
    log(`Discovery Scope Config: Mode [${scopeConfig.scope}] | Selected Countries: [${scopeConfig.selectedCountries.join(', ') || 'All'}]`);

    let eligibleVocabs = vocabs.filter(v => !excludedNames.includes(v.country.toLowerCase()));

    // Filter by Selected Countries if scope is set to SELECTED_COUNTRIES
    if (scopeConfig.scope === 'SELECTED_COUNTRIES' && scopeConfig.selectedCountries.length > 0) {
      const selectedLower = scopeConfig.selectedCountries.map(c => c.toLowerCase());
      eligibleVocabs = eligibleVocabs.filter(v => selectedLower.includes(v.country.toLowerCase()));
      log(`Scoped Country Filter applied. Eligible countries in scope: ${eligibleVocabs.map(v => v.country).join(', ')}`);
    }

    if (eligibleVocabs.length === 0) {
      log('REJECTED: No eligible target countries available matching current Discovery Scope & Exclusion rules.');
      await addQueryExecutionLog({
        query: 'N/A',
        country: targetCountry || 'N/A',
        executed_at: executedAt,
        channels_discovered: 0,
        unique_new_channels: 0,
        quality_creators_discovered: 0,
        communities_discovered: 0,
        cycle_quality_score: 0,
        logs: cycleLogs
      });
      return {
        country: targetCountry || 'N/A',
        query: 'N/A',
        strategy: 'ABORTED',
        discoveredCount: 0,
        uniqueCount: 0,
        qualityCreatorsCount: 0,
        performanceScore: 0,
        newCollection: 'NONE',
        summary: 'No eligible target countries available matching current Discovery Scope.',
        logs: cycleLogs
      };
    }

    // Restore saved country index from SQLite
    const savedIdxStr = await getAppSetting('qi_current_country_index', '0');
    currentCountryIndex = parseInt(savedIdxStr, 10) || 0;

    if (!targetCountry) {
      countryName = eligibleVocabs[currentCountryIndex % eligibleVocabs.length].country;
      currentCountryIndex = (currentCountryIndex + 1) % eligibleVocabs.length;
      await setAppSetting('qi_current_country_index', currentCountryIndex.toString());
    } else {
      countryName = targetCountry;
    }

    log(`Step 1 (Target Selection): Selected country "${countryName}" (Active candidates in scope: ${eligibleVocabs.length}).`);

    // 2. Multi-Armed Bandit (UCB1) Query Selection
    const { queryRecord, selectionStrategy, reason } = await selectNextQueryForCountry(countryName);
    queryObj = queryRecord;
    selectedQueryStr = queryRecord.query;
    selectionStrat = selectionStrategy;

    log(`Step 2 (UCB1 Query Intelligence): Strategy [${selectionStrategy}] selected query "${selectedQueryStr}" (Query ID #${queryRecord.id}). Reason: ${reason}`);

    // 3. Search Job Creation in Queue
    const searchJob = await addSearchJob(selectedQueryStr, countryName, 'automated_query');
    log(`Step 3 (Queue Worker): Search Job created with ID '${searchJob.id}' in queue.`);

    // 4. YouTube API Search Execution
    log(`Step 4 (YouTube Crawler): Executing search for query "${selectedQueryStr}" in region "${countryName}"...`);

    const vocab = vocabs.find(v => v.country.toLowerCase() === countryName.toLowerCase());
    const rawChannels = await searchYouTubeChannels(selectedQueryStr, countryName, vocab);

    log(`Step 4 Results: YouTube search returned ${rawChannels.length} raw channel candidate(s).`);

    if (rawChannels.length === 0) {
      log(`REJECTED: YouTube search returned 0 results for query "${selectedQueryStr}".`);
      const emptyPerf = await evaluateQueryPerformance(queryRecord, [], 0);
      
      await addQueryExecutionLog({
        query_id: queryRecord.id,
        query: selectedQueryStr,
        country: countryName,
        executed_at: executedAt,
        channels_discovered: 0,
        unique_new_channels: 0,
        quality_creators_discovered: 0,
        communities_discovered: 0,
        cycle_quality_score: 0,
        logs: cycleLogs
      });

      lastRunTime = executedAt;
      lastReport = {
        country: countryName,
        query: selectedQueryStr,
        strategy: selectionStrategy,
        discoveredCount: 0,
        uniqueCount: 0,
        qualityCreatorsCount: 0,
        performanceScore: emptyPerf.performanceScore,
        newCollection: emptyPerf.newCollection,
        summary: emptyPerf.summary
      };
      await updateSchedulerState('autonomous_discovery', { last_run_at: executedAt, last_report: lastReport });

      return {
        country: countryName,
        query: selectedQueryStr,
        strategy: selectionStrategy,
        discoveredCount: 0,
        uniqueCount: 0,
        qualityCreatorsCount: 0,
        performanceScore: emptyPerf.performanceScore,
        newCollection: emptyPerf.newCollection,
        summary: emptyPerf.summary,
        logs: cycleLogs
      };
    }

    // 5. Channel Processing Pipeline (Country Validation -> Trading Classifier -> Discord Inspection)
    log(`Step 5 (Pipeline Processing): Routing ${rawChannels.length} channels through 2-Stage Gate pipeline & Discord Crawler...`);

    let uniqueCount = 0;
    let rejectedCountryCount = 0;
    let rejectedTradingCount = 0;
    let confirmedTradingCount = 0;
    let validatedCommunitiesCount = 0;
    const processedChannels: ChannelRecord[] = [];

    for (const raw of rawChannels) {
      // Safe Pause Check: finish current creator and stop safely if pause requested
      if (await isQueryIntelligencePaused()) {
        log(`PAUSE DETECTED: Pause was requested. Safely finished current creator "${raw.channelName}". Preserving remaining queue and discovery state.`);
        break;
      }

      const outcome = await processDiscoveredChannel(raw, countryName, 'automated_query');

      if (outcome.isNew) uniqueCount++;

      if (outcome.countryStatus === 'REJECTED') {
        rejectedCountryCount++;
        log(`  - Channel "${raw.channelName}": REJECTED by Country Validation Hard Gate.`);
        continue;
      }

      if (outcome.tradingStatus === 'NON_TRADING') {
        rejectedTradingCount++;
        log(`  - Channel "${raw.channelName}": REJECTED by Trading Classifier (Irrelevant niche / non-trading).`);
        continue;
      }

      confirmedTradingCount++;

      if (outcome.discordStatus === 'ACTIVE' || outcome.discordStatus === 'ACTIVE_LOW_VOLUME') {
        validatedCommunitiesCount++;
        log(`  - Channel "${raw.channelName}": CONFIRMED TRADING & DISCORD DISCOVERED [${outcome.discordStatus}] (Invite: ${outcome.discordInvite})`);
      } else {
        log(`  - Channel "${raw.channelName}": CONFIRMED TRADING (Discord status: ${outcome.discordStatus})`);
      }

      const channel = outcome.channelRecord || await getChannelById(raw.channelId);
      if (channel) {
        // Calculate Quality Score
        const qualityResult = calculateCreatorQualityScore(channel, raw.videoTitles, raw.description);
        channel.quality_score = qualityResult.score;
        channel.quality_breakdown = qualityResult.breakdown;
        await upsertChannel(channel);

        processedChannels.push(channel);

        // Vocabulary Extraction Loop
        if (qualityResult.score >= 55) {
          log(`  - Quality Creator Identified: "${channel.channel_name}" (Score: ${qualityResult.score}/100). Extracting native terms...`);
          await extractVocabularyFromCreator(channel, raw.videoTitles, raw.description);
        }
      }
    }

    log(`Step 5 Audit Summary:`);
    log(`  Total Processed: ${processedChannels.length} / ${rawChannels.length}`);
    log(`  Rejected by Country Validation: ${rejectedCountryCount}`);
    log(`  Rejected by Trading Classifier: ${rejectedTradingCount}`);
    log(`  Confirmed Trading Creators: ${confirmedTradingCount}`);
    log(`  Validated Discord Communities Discovered: ${validatedCommunitiesCount}`);

    // 6. Query Intelligence Performance & Collection Promotion
    const perfEval = await evaluateQueryPerformance(queryRecord, processedChannels, uniqueCount);
    log(`Step 6 (MAB Intelligence Update): ${perfEval.summary}`);

    const qualityCreatorsCount = processedChannels.filter(c => (c.quality_score || 0) >= 60).length;

    lastRunTime = executedAt;
    lastReport = {
      country: countryName,
      query: selectedQueryStr,
      strategy: selectionStrategy,
      discoveredCount: processedChannels.length,
      uniqueCount,
      qualityCreatorsCount,
      performanceScore: perfEval.performanceScore,
      newCollection: perfEval.newCollection,
      summary: perfEval.summary
    };
    await updateSchedulerState('autonomous_discovery', { last_run_at: executedAt, last_report: lastReport });

    // Save Execution Audit Trail to SQLite
    await addQueryExecutionLog({
      query_id: queryRecord.id,
      query: selectedQueryStr,
      country: countryName,
      executed_at: executedAt,
      channels_discovered: rawChannels.length,
      unique_new_channels: uniqueCount,
      quality_creators_discovered: qualityCreatorsCount,
      communities_discovered: validatedCommunitiesCount,
      cycle_quality_score: perfEval.performanceScore,
      logs: cycleLogs
    });

    log(`=== CYCLE COMPLETED SUCCESSFULLY ===`);

    return {
      country: countryName,
      query: selectedQueryStr,
      strategy: selectionStrategy,
      discoveredCount: processedChannels.length,
      uniqueCount,
      qualityCreatorsCount,
      performanceScore: perfEval.performanceScore,
      newCollection: perfEval.newCollection,
      summary: perfEval.summary,
      logs: cycleLogs
    };

  } catch (err: any) {
    log(`FATAL EXCEPTION in discovery cycle: ${err.message}`);
    
    await addQueryExecutionLog({
      query_id: queryObj?.id,
      query: selectedQueryStr,
      country: countryName,
      executed_at: executedAt,
      channels_discovered: 0,
      unique_new_channels: 0,
      quality_creators_discovered: 0,
      communities_discovered: 0,
      cycle_quality_score: 0,
      logs: cycleLogs
    });

    throw err;
  } finally {
    isCycleRunning = false;
    const nextRunAt = nextScheduledTime;
    await releaseSchedulerLock('autonomous_discovery', lastReport, nextRunAt);
  }
}

/**
 * Gets current autonomous discovery engine status.
 */
export async function getAutonomousDiscoveryStatus(): Promise<DiscoveryCycleStatus> {
  const isPaused = await isQueryIntelligencePaused();
  const scopeInfo = await getDiscoveryScope();
  const persisted = await getSchedulerState('autonomous_discovery');
  return {
    isRunning: isCycleRunning || !!persisted?.is_running,
    isPaused,
    scope: scopeInfo.scope,
    selectedCountries: scopeInfo.selectedCountries,
    lastRunTime: lastRunTime || persisted?.last_run_at?.toISOString?.() || persisted?.last_run_at,
    nextScheduledTime: nextScheduledTime || persisted?.next_run_at?.toISOString?.() || persisted?.next_run_at,
    lastReport: lastReport || persisted?.last_report
  };
}

/**
 * Starts the 30-minute autonomous discovery background scheduler.
 */
export function startAutonomousDiscoveryScheduler(intervalMs = 30 * 60 * 1000): void {
  if (schedulerHandle) return;
  recoverStaleJobs().catch(err => console.error('[Autonomous Intelligence Scheduler] Stale job recovery failed:', err));

  const scheduleNext = () => {
    nextScheduledTime = new Date(Date.now() + intervalMs).toISOString();
    updateSchedulerState('autonomous_discovery', { next_run_at: nextScheduledTime }).catch(() => {});
  };

  scheduleNext();

  schedulerHandle = setInterval(async () => {
    try {
      if (await isQueryIntelligencePaused()) {
        console.log('[Autonomous Intelligence Scheduler] Query Intelligence is PAUSED. Skipping scheduled 30-minute cycle.');
        return;
      }
      console.log('[Autonomous Intelligence Scheduler] Triggering 30-minute discovery cycle...');
      await runAutonomousDiscoveryCycle();
    } catch (err) {
      console.error('[Autonomous Intelligence Scheduler] Error during cycle:', err);
    } finally {
      scheduleNext();
    }
  }, intervalMs);

  console.log(`[Autonomous Intelligence Scheduler] Started background cycle every ${intervalMs / 1000 / 60} minutes.`);
}

/**
 * Stops the autonomous scheduler.
 */
export function stopAutonomousDiscoveryScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    nextScheduledTime = undefined;
    console.log('[Autonomous Intelligence Scheduler] Stopped background scheduler.');
  }
}

