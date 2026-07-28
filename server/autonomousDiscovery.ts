import {
  acquireSchedulerLock,
  getAppSetting,
  getAutonomousSchedulingSnapshot,
  getCountryVocabularies,
  getExcludedCountries,
  getSchedulerState,
  releaseSchedulerLock,
  scheduleAutonomousQueryRuns,
  setAppSetting,
  updateSchedulerState
} from './db';
import { assertCountryAllowed } from './countryExclusion';
import { selectNextQueryForCountry } from './queryIntelligence';
import { calculateDiscoveryCapacity } from './discoverySchedulerPolicy';

export type DiscoveryScopeMode = 'GLOBAL' | 'SELECTED_COUNTRIES';

interface DiscoveryProducerReport {
  country: string;
  query: string;
  strategy: string;
  discoveredCount: number;
  uniqueCount: number;
  qualityCreatorsCount: number;
  performanceScore: number;
  newCollection: string;
  summary: string;
  queuedCount?: number;
  queueDepth?: number;
  remainingAutonomousQuota?: number;
}

interface DiscoveryCycleStatus {
  isRunning: boolean;
  isPaused: boolean;
  scope: DiscoveryScopeMode;
  selectedCountries: string[];
  lastRunTime?: string;
  nextScheduledTime?: string;
  lastReport?: DiscoveryProducerReport;
  schedulerIntervalMinutes: number;
  batchSize: number;
  targetQueueDepth: number;
  dailyQuotaBudget: number;
}

interface DiscoveryConfig {
  intervalMinutes: number;
  batchSize: number;
  targetQueueDepth: number;
  dailyQuotaBudget: number;
  autonomousQuotaPercent: number;
}

let schedulerHandle: NodeJS.Timeout | null = null;
let currentCountryIndex = 0;
let isCycleRunning = false;
let lastRunTime: string | undefined;
let nextScheduledTime: string | undefined;
let lastReport: DiscoveryProducerReport | undefined;

async function numericSetting(key: string, envKey: string, fallback: number, min: number, max: number): Promise<number> {
  const value = Number(await getAppSetting(key, process.env[envKey] || String(fallback)));
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback));
}

async function getDiscoveryConfig(): Promise<DiscoveryConfig> {
  return {
    intervalMinutes: await numericSetting('discovery_interval_minutes', 'DISCOVERY_INTERVAL_MINUTES', 5, 1, 60),
    batchSize: await numericSetting('discovery_batch_size', 'DISCOVERY_BATCH_SIZE', 5, 1, 50),
    targetQueueDepth: await numericSetting('discovery_target_queue_depth', 'DISCOVERY_TARGET_QUEUE_DEPTH', 15, 1, 500),
    dailyQuotaBudget: await numericSetting('daily_youtube_quota_budget', 'DAILY_YOUTUBE_QUOTA_BUDGET', 9000, 100, 1_000_000),
    autonomousQuotaPercent: await numericSetting('discovery_autonomous_quota_percent', 'DISCOVERY_AUTONOMOUS_QUOTA_PERCENT', 70, 1, 100)
  };
}

export async function isQueryIntelligencePaused(): Promise<boolean> {
  return await getAppSetting('query_intelligence_paused', 'false') === 'true';
}

export async function pauseQueryIntelligence(): Promise<{ message: string; isPaused: boolean }> {
  await setAppSetting('query_intelligence_paused', 'true');
  return { message: 'Query Intelligence safely paused. Current state and queue preserved.', isPaused: true };
}

export async function resumeQueryIntelligence(): Promise<{ message: string; isPaused: boolean }> {
  await setAppSetting('query_intelligence_paused', 'false');
  return { message: 'Query Intelligence resumed. Continuing from saved discovery state.', isPaused: false };
}

export async function getDiscoveryScope(): Promise<{ scope: DiscoveryScopeMode; selectedCountries: string[] }> {
  const scopeValue = await getAppSetting('query_intelligence_discovery_scope', 'GLOBAL');
  const scope: DiscoveryScopeMode = scopeValue === 'SELECTED_COUNTRIES' ? 'SELECTED_COUNTRIES' : 'GLOBAL';
  try {
    const selectedCountries = JSON.parse(await getAppSetting('query_intelligence_selected_countries', '[]'));
    return { scope, selectedCountries: Array.isArray(selectedCountries) ? selectedCountries : [] };
  } catch {
    return { scope, selectedCountries: [] };
  }
}

export async function setDiscoveryScope(scope: DiscoveryScopeMode, selectedCountries: string[]): Promise<{ scope: DiscoveryScopeMode; selectedCountries: string[] }> {
  const cleanCountries = Array.from(new Set(selectedCountries.map(country => country.trim()).filter(Boolean)));
  await setAppSetting('query_intelligence_discovery_scope', scope);
  await setAppSetting('query_intelligence_selected_countries', JSON.stringify(cleanCountries));
  return { scope, selectedCountries: cleanCountries };
}

/**
 * Produces a quota-paced batch of durable work. It deliberately performs no
 * YouTube or channel processing; workers are the only autonomous executors.
 */
export async function runAutonomousDiscoveryCycle(targetCountry?: string): Promise<DiscoveryProducerReport & { logs: string[]; isPaused?: boolean }> {
  if (targetCountry) await assertCountryAllowed(targetCountry, 'autonomous_cycle');
  if (isCycleRunning) throw new Error('An autonomous discovery producer cycle is already in progress.');

  const workerId = `autonomous_producer_${process.pid}`;
  if (!await acquireSchedulerLock('autonomous_discovery', workerId)) {
    throw new Error('Autonomous discovery scheduler lock is already held by another producer.');
  }

  isCycleRunning = true;
  const logs: string[] = [];
  const log = (message: string) => {
    logs.push(message);
    console.log(`[Autonomous Producer] ${message}`);
  };

  try {
    if (await isQueryIntelligencePaused() && !targetCountry) {
      return {
        country: 'N/A', query: 'N/A', strategy: 'PAUSED', discoveredCount: 0,
        uniqueCount: 0, qualityCreatorsCount: 0, performanceScore: 0,
        newCollection: 'NONE', summary: 'Query Intelligence is paused.', logs, isPaused: true
      };
    }

    const config = await getDiscoveryConfig();
    const snapshot = await getAutonomousSchedulingSnapshot();
    const now = new Date();
    const minutesSinceUtcMidnight = now.getUTCHours() * 60 + now.getUTCMinutes();
    const capacity = calculateDiscoveryCapacity({
      batchSize: config.batchSize,
      targetQueueDepth: config.targetQueueDepth,
      currentQueueDepth: snapshot.queueDepth,
      dailyBudget: config.dailyQuotaBudget,
      allocationPercent: config.autonomousQuotaPercent,
      unitsUsed: snapshot.autonomousUnitsUsed,
      unitsReserved: snapshot.autonomousUnitsReserved,
      minutesSinceUtcMidnight
    });

    if (capacity === 0) {
      lastReport = {
        country: 'MULTI', query: 'NONE', strategy: 'QUOTA_OR_QUEUE_GUARD', discoveredCount: 0,
        uniqueCount: 0, qualityCreatorsCount: 0, performanceScore: 0, newCollection: 'NONE',
        queuedCount: 0, queueDepth: snapshot.queueDepth,
        remainingAutonomousQuota: Math.max(0, Math.floor(config.dailyQuotaBudget * config.autonomousQuotaPercent / 100) - snapshot.autonomousUnitsUsed - snapshot.autonomousUnitsReserved),
        summary: 'No work scheduled: queue target or paced autonomous quota capacity is exhausted.'
      };
      return { ...lastReport, logs };
    }

    const [vocabs, exclusions, scope] = await Promise.all([
      getCountryVocabularies(), getExcludedCountries(), getDiscoveryScope()
    ]);
    const excluded = new Set(exclusions.map(item => item.country_name.toLowerCase()));
    const selectedScope = new Set(scope.selectedCountries.map(country => country.toLowerCase()));
    let countries = vocabs.map(item => item.country).filter(country => !excluded.has(country.toLowerCase()));
    if (scope.scope === 'SELECTED_COUNTRIES' && selectedScope.size > 0) {
      countries = countries.filter(country => selectedScope.has(country.toLowerCase()));
    }
    if (targetCountry) countries = [targetCountry];
    if (countries.length === 0) throw new Error('No eligible countries are available for autonomous discovery.');

    currentCountryIndex = Number(await getAppSetting('qi_current_country_index', '0')) || 0;
    const cooldownMinutes = await numericSetting('query_intelligence_query_cooldown_minutes', 'QUERY_INTELLIGENCE_COOLDOWN_MINUTES', 360, 1, 10080);
    const scheduled = [];
    const usedIntents = new Set<string>();
    const usedPrimaryTerms = new Set<string>();
    let attempts = 0;

    while (scheduled.length < capacity && attempts < capacity * Math.max(3, countries.length)) {
      const country = countries[(currentCountryIndex + attempts) % countries.length];
      attempts++;
      const selected = await selectNextQueryForCountry(country);
      const intent = selected.queryRecord.intent;
      const primaryTerm = selected.queryRecord.primary_term || selected.queryRecord.query;
      if ((usedIntents.has(intent) || usedPrimaryTerms.has(primaryTerm)) && attempts < countries.length * 2) continue;
      const created = await scheduleAutonomousQueryRuns([{
        query: selected.queryRecord,
        strategy: selected.selectionStrategy,
        reason: selected.reason
      }], workerId, cooldownMinutes);
      if (created.length) {
        scheduled.push(...created);
        usedIntents.add(intent);
        usedPrimaryTerms.add(primaryTerm);
      }
    }

    currentCountryIndex = (currentCountryIndex + Math.max(1, scheduled.length)) % countries.length;
    await setAppSetting('qi_current_country_index', String(currentCountryIndex));
    lastRunTime = now.toISOString();
    lastReport = {
      country: scheduled.length === 1 ? scheduled[0].query.country : 'MULTI',
      query: scheduled.map(item => item.query.query).join(' | ') || 'NONE',
      strategy: 'DURABLE_BATCH_PRODUCER', discoveredCount: 0, uniqueCount: 0,
      qualityCreatorsCount: 0, performanceScore: 0, newCollection: 'PENDING',
      queuedCount: scheduled.length, queueDepth: snapshot.queueDepth + scheduled.length,
      remainingAutonomousQuota: Math.max(0, Math.floor(config.dailyQuotaBudget * config.autonomousQuotaPercent / 100) - snapshot.autonomousUnitsUsed - snapshot.autonomousUnitsReserved - scheduled.length * 100),
      summary: `Scheduled ${scheduled.length} diverse durable search job(s); workers own all YouTube execution.`
    };
    log(lastReport.summary);
    await updateSchedulerState('autonomous_discovery', { last_run_at: lastRunTime, last_report: lastReport });
    return { ...lastReport, logs };
  } finally {
    isCycleRunning = false;
    await releaseSchedulerLock('autonomous_discovery', lastReport, nextScheduledTime);
  }
}

export async function getAutonomousDiscoveryStatus(): Promise<DiscoveryCycleStatus> {
  const [isPaused, scopeInfo, persisted, config] = await Promise.all([
    isQueryIntelligencePaused(), getDiscoveryScope(), getSchedulerState('autonomous_discovery'), getDiscoveryConfig()
  ]);
  return {
    isRunning: isCycleRunning || !!persisted?.is_running,
    isPaused,
    scope: scopeInfo.scope,
    selectedCountries: scopeInfo.selectedCountries,
    lastRunTime: lastRunTime || persisted?.last_run_at?.toISOString?.() || persisted?.last_run_at,
    nextScheduledTime: nextScheduledTime || persisted?.next_run_at?.toISOString?.() || persisted?.next_run_at,
    lastReport: lastReport || persisted?.last_report,
    schedulerIntervalMinutes: config.intervalMinutes,
    batchSize: config.batchSize,
    targetQueueDepth: config.targetQueueDepth,
    dailyQuotaBudget: config.dailyQuotaBudget
  };
}

export function startAutonomousDiscoveryScheduler(): void {
  if (schedulerHandle) return;
  const schedule = async (delayMs: number) => {
    nextScheduledTime = new Date(Date.now() + delayMs).toISOString();
    await updateSchedulerState('autonomous_discovery', { next_run_at: nextScheduledTime }).catch(() => undefined);
    schedulerHandle = setTimeout(async () => {
      try {
        await runAutonomousDiscoveryCycle();
      } catch (error) {
        console.error('[Autonomous Producer] Cycle failed:', error);
      } finally {
        const config = await getDiscoveryConfig();
        console.log(`[Autonomous Producer] Next wake scheduled in ${config.intervalMinutes} minute(s).`);
        void schedule(config.intervalMinutes * 60_000);
      }
    }, delayMs);
  };
  void schedule(0);
}

export function stopAutonomousDiscoveryScheduler(): void {
  if (schedulerHandle) clearTimeout(schedulerHandle);
  schedulerHandle = null;
  nextScheduledTime = undefined;
}
