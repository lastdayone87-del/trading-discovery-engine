import {
  acquireSchedulerLock,
  getAppSetting,
  getCountryVocabularies,
  getExcludedCountries,
  getSchedulerState,
  recoverStaleJobs,
  releaseSchedulerLock,
  scheduleAutonomousQueryRuns,
  setAppSetting,
  setQueryCollection,
  updateSchedulerState,
  getDailyYouTubeQuotaBudget
} from './db';
import { assertCountryAllowed } from './countryExclusion';
import { constructCountryNativeAllocationQuery, selectNextQueryForCountry } from './queryIntelligence';
import { calculateDiscoveryCapacity } from './discoverySchedulerPolicy';
import { getAllocatedResearchQuery, markResearchActionQueued } from './persistentResearch';
import { runPersistentResearchCycle } from './persistentResearchController';
import { creatorIntelligenceChecksum } from './creatorIntelligence/contracts';
import { bindCreatorCanaryQueryRun, type CreatorCanaryAssignment } from './creatorIntelligence/canary';
import { allocateCreatorSearchAuthority } from './creatorIntelligence/authority';
import { evaluateAutonomousQueryAuthority } from './autonomousQueryAuthority';
import {
  evaluateShadowFrontierAllocation,
  commitAllocationQueryRun,
  releaseAllocationDecision,
  quarantineUnexecutableAllocation,
  markAllocationDecisionDeferred
} from './discoveryFrontierAllocator';
import { reconcileYouTubeQuotaRolloverAndGetAutonomousSnapshot } from './quotaRolloverReconciliation';
import { materializeBoundedCountryNativeProposals } from './discoveryProposalGenerators';
import { materializeStoredExternalOsintProposals } from './externalOsint';

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
    dailyQuotaBudget: getDailyYouTubeQuotaBudget(),
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
export async function runAutonomousDiscoveryCycle(targetCountry?: string, providerTarget?: { targetProviderKey?: string; requiredCapability?: string; maxRuns?: number; allowShadowProvider?: boolean }): Promise<DiscoveryProducerReport & { logs: string[]; isPaused?: boolean }> {
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

    // The research controller is an isolated observer/planner. Failure never
    // delays the proven query scheduler, and serving remains separately gated.
    await runPersistentResearchCycle(`autonomous-research:${process.pid}`)
      .catch(error => console.warn('[PersistentResearch] Planning cycle failed; legacy query scheduling continues:', error));

    const config = await getDiscoveryConfig();
    const now = new Date();
    const snapshot = await reconcileYouTubeQuotaRolloverAndGetAutonomousSnapshot(now);
    if (snapshot.awakenedQuotaDeferredJobs > 0) {
      log(`Pacific quota-day rollover reactivated ${snapshot.awakenedQuotaDeferredJobs} quota-deferred job(s).`);
    }
    const calculatedCapacity = calculateDiscoveryCapacity({
      batchSize: config.batchSize,
      targetQueueDepth: config.targetQueueDepth,
      currentQueueDepth: snapshot.queueDepth,
      dailyBudget: config.dailyQuotaBudget,
      allocationPercent: config.autonomousQuotaPercent,
      unitsUsed: snapshot.autonomousUnitsUsed,
      unitsReserved: snapshot.autonomousUnitsReserved,
      minutesSinceUtcMidnight: snapshot.minutesSinceQuotaDayStart
    });
    const capacity = providerTarget?.maxRuns ? Math.min(calculatedCapacity, Math.max(1, Math.floor(providerTarget.maxRuns))) : calculatedCapacity;

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

    // Materialize proposal-only evidence inside the existing producer cycle.
    // Phase 8 remains the sole allocation authority; generation failures cannot
    // block the legacy Query Intelligence scheduler.
    const nativeFairnessCursor = Math.max(0, Number(await getAppSetting('country_native_materialization_cursor', '0')) || 0);
    await materializeBoundedCountryNativeProposals(countries, {
      globalCap: 25,
      perCountryCap: 5,
      fairnessCursor: nativeFairnessCursor
    }).then(() => setAppSetting('country_native_materialization_cursor', String(nativeFairnessCursor + 25)))
      .catch(error => console.warn('[FrontierProposals] Country-native generation warning:', error));
    const osintEnabled = await getAppSetting('external_osint_materialization_enabled', 'false') === 'true';
    await materializeStoredExternalOsintProposals({ enabled: osintEnabled, deadlineMs: 2_500 })
      .catch(error => console.warn('[FrontierProposals] External OSINT degradation; legacy discovery continues:', error));

    currentCountryIndex = Number(await getAppSetting('qi_current_country_index', '0')) || 0;
    const cooldownMinutes = await numericSetting('query_intelligence_query_cooldown_minutes', 'QUERY_INTELLIGENCE_COOLDOWN_MINUTES', 360, 1, 10080);
    const scheduled = [];
    const usedIntents = new Set<string>();
    const usedPrimaryTerms = new Set<string>();
    let attempts = 0;

    while (scheduled.length < capacity && attempts < capacity * Math.max(3, countries.length)) {
      const legacyCountry = countries[(currentCountryIndex + attempts) % countries.length];
      attempts++;
      const opportunityKey = creatorIntelligenceChecksum({ scheduler: 'autonomous_discovery', workerId, cycleStartedAt: now.toISOString(), country: legacyCountry, attempt: attempts });

        // Shadow frontier evaluation (zero scheduling authority)
        await evaluateShadowFrontierAllocation({ opportunityKey, legacyCountry, now })
          .catch(err => console.warn('[FrontierAllocator] Shadow allocation evaluation warning:', err));

      let creatorAllocation: CreatorCanaryAssignment | undefined;
        let frontierAllocationInfo: any;
      let country = legacyCountry;
      try {
          const authority = await allocateCreatorSearchAuthority({
            opportunityKey,
            legacyCountry,
            allowedCountries: countries,
            assignedAt: now.toISOString(),
            estimatedQuotaUnits: 100,
            availableAutonomousCapacity: capacity - scheduled.length,
            targetProviderKey: providerTarget?.targetProviderKey,
            requiredCapability: providerTarget?.requiredCapability,
            allowShadowProvider: providerTarget?.allowShadowProvider
          });
        creatorAllocation = authority.assignment;
        country = authority.country;
          frontierAllocationInfo = authority.frontierAllocation;
      } catch (error) {
        console.warn('[CreatorIntelligence] Search allocation authority unavailable; legacy Query Intelligence fallback continues:', error instanceof Error ? error.message : error);
      }

      let research: { actionId: string; queryRecord: any } | null = null;
      // Persistent Research runs ONLY on the control/legacy path when frontier allocation is NOT authorized
      if (!frontierAllocationInfo?.authorized) {
        research = await getAllocatedResearchQuery(country);
      }

      let selected: { queryRecord: any; selectionStrategy: any; reason: string };
      const nativeSnapshot = frontierAllocationInfo?.decision?.proposalEvidenceSnapshot;
      const governedConceptProposal = ['COUNTRY_NATIVE', 'EXTERNAL_OSINT'].includes(nativeSnapshot?.proposalFamily);

      if (research) {
        selected = {
          queryRecord: research.queryRecord,
          selectionStrategy: 'UCB1_EXPLORATION' as const,
          reason: 'Governed persistent-research portfolio allocation with recorded propensity and immutable provenance.'
        };
      } else if (frontierAllocationInfo?.authorized && frontierAllocationInfo.targetNeighborhoodDimensions) {
        const nativeQuery = governedConceptProposal
          ? await constructCountryNativeAllocationQuery({
              country,
              decisionId: frontierAllocationInfo.decision.decisionId,
              proposalId: frontierAllocationInfo.decision.proposalId,
              targetNeighborhoodDimensions: frontierAllocationInfo.targetNeighborhoodDimensions,
              proposalEvidenceSnapshot: nativeSnapshot
            })
          : null;
        const targeted = governedConceptProposal
          ? null
          : await selectNextQueryForCountry(country, { targetNeighborhoodDimensions: frontierAllocationInfo.targetNeighborhoodDimensions });
        if (nativeQuery) {
          selected = {
            queryRecord: nativeQuery,
            selectionStrategy: 'NEIGHBORHOOD_TARGETED',
            reason: 'Query Intelligence constructed the selected immutable COUNTRY_NATIVE proposal through governed retrieval policy.'
          };
        } else if (targeted?.selectionStrategy === 'NEIGHBORHOOD_TARGETED') {
          selected = targeted;
        } else {
          // Query Intelligence could not construct/find a targeted action for this neighborhood; defer decision and revert to legacy control
          if (frontierAllocationInfo.decision?.decisionId) {
            await quarantineUnexecutableAllocation(
              frontierAllocationInfo.decision.decisionId,
              'Query Intelligence could not authorize a query for the selected immutable proposal/neighborhood evidence'
            );
          }
          frontierAllocationInfo.authorized = false;
          if (governedConceptProposal) {
            // Fail closed for the selected proposal. Do not spend this opportunity
            // on an unrelated generic query after releasing its reservation.
            continue;
          }
          country = legacyCountry;
          selected = await selectNextQueryForCountry(legacyCountry);
        }
      } else {
        selected = await selectNextQueryForCountry(country);
      }

      // Every query source is revalidated immediately before scheduling. Stored
      // PROVEN/EXPERIMENTAL queries and research allocations are not grandfathered
      // across retrieval-policy upgrades.
      const queryAuthority = evaluateAutonomousQueryAuthority(selected.queryRecord);
      if (!queryAuthority.eligible) {
        log(`Withheld autonomous query #${selected.queryRecord.id} "${selected.queryRecord.query}" (${selected.queryRecord.country}) before YouTube: ${queryAuthority.reasonCodes.join(', ')}.`);
        if (frontierAllocationInfo?.authorized && frontierAllocationInfo.decision?.decisionId) {
          const reason = `Query authority rejected query: ${queryAuthority.reasonCodes.join(', ')}`;
          if (['COUNTRY_NATIVE', 'EXTERNAL_OSINT'].includes(frontierAllocationInfo.decision?.proposalEvidenceSnapshot?.proposalFamily)) {
            await quarantineUnexecutableAllocation(frontierAllocationInfo.decision.decisionId, reason);
          } else await releaseAllocationDecision(frontierAllocationInfo.decision.decisionId, reason);
          frontierAllocationInfo.authorized = false;
        }
        await setQueryCollection(selected.queryRecord.id, 'REJECTED')
          .catch(error => console.warn('[Autonomous Producer] Failed to quarantine unsafe query:', error));
        continue;
      }

      const intent = selected.queryRecord.intent;
      const primaryTerm = selected.queryRecord.primary_term || selected.queryRecord.query;
      if ((usedIntents.has(intent) || usedPrimaryTerms.has(primaryTerm)) && attempts < countries.length * 2) {
        if (frontierAllocationInfo?.authorized && frontierAllocationInfo.decision?.decisionId) {
          await releaseAllocationDecision(frontierAllocationInfo.decision.decisionId, 'Batch diversity guard skipped reserved allocation');
          frontierAllocationInfo.authorized = false;
        }
        continue;
      }
      const created = await scheduleAutonomousQueryRuns([{
        query: selected.queryRecord,
        strategy: selected.selectionStrategy,
        reason: `${selected.reason} Execution authority: ${queryAuthority.reasonCodes.join(', ')}.`,
        allocationOrigin: frontierAllocationInfo?.authorized ? 'FRONTIER_CANARY' : 'LEGACY',
        frontierDecisionId: frontierAllocationInfo?.authorized ? frontierAllocationInfo.decision?.decisionId : undefined,
        targetNeighborhoodDimensions: frontierAllocationInfo?.authorized ? frontierAllocationInfo.targetNeighborhoodDimensions : undefined,
        allowShadowProvider: providerTarget?.allowShadowProvider,
        allocationProvenance: creatorAllocation ? {
          assignmentId: creatorAllocation.assignmentId,
          assignmentKey: creatorAllocation.assignmentKey,
          arm: creatorAllocation.arm,
          status: creatorAllocation.assignmentStatus,
          programId: creatorAllocation.programId,
          objectiveKey: creatorAllocation.objectiveKey,
          hypothesisId: creatorAllocation.hypothesisId,
          behaviorPropensityBasisPoints: creatorAllocation.behaviorPropensityBasisPoints,
          treatmentPropensityBasisPoints: creatorAllocation.treatmentPropensityBasisPoints,
          policyVersion: creatorAllocation.policyVersion,
          queryAuthority: 'QUERY_INTELLIGENCE'
        } : { status: 'LEGACY_FALLBACK', reason: 'CANARY_ALLOCATION_UNAVAILABLE', queryAuthority: 'QUERY_INTELLIGENCE' }
      }], workerId, cooldownMinutes).catch(async error => {
        if (frontierAllocationInfo?.authorized && frontierAllocationInfo.decision?.decisionId) {
          const detail = error instanceof Error ? error.message : String(error);
          const deterministicNativeMismatch = governedConceptProposal &&
            /PHASE9_TREATMENT_CHANGED_PHASE8_NEIGHBORHOOD|FRONTIER_ALLOCATION_NEIGHBORHOOD_LINEAGE_MISMATCH/.test(detail);
          const disposition = deterministicNativeMismatch ? quarantineUnexecutableAllocation : releaseAllocationDecision;
          await disposition(frontierAllocationInfo.decision.decisionId, `Scheduling transaction failed: ${detail}`);
          frontierAllocationInfo.authorized = false;
        }
        return [];
      });

      if (created.length) {
        scheduled.push(...created);
        if (creatorAllocation?.assignmentId) await bindCreatorCanaryQueryRun({ assignmentId: creatorAllocation.assignmentId, assignmentKey: creatorAllocation.assignmentKey, queryRunId: created[0].runId, queryId: created[0].query.id, selectionStrategy: selected.selectionStrategy, boundAt: now.toISOString() })
          .catch(error => console.warn('[CreatorIntelligence] Assignment binding failed without affecting scheduled query:', error instanceof Error ? error.message : error));
        if (research) await markResearchActionQueued(research.actionId, created[0].runId);
        usedIntents.add(intent);
        usedPrimaryTerms.add(primaryTerm);
      } else if (frontierAllocationInfo?.authorized && frontierAllocationInfo.decision?.decisionId) {
        await releaseAllocationDecision(
          frontierAllocationInfo.decision.decisionId,
          'Query scheduling returned zero created runs'
        );
        frontierAllocationInfo.authorized = false;
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
        const intervalMinutes = await getDiscoveryConfig()
          .then(config => config.intervalMinutes)
          .catch(error => {
            console.error('[Autonomous Producer] Configuration unavailable; using retry interval:', error);
            return 5;
          });
        console.log(`[Autonomous Producer] Next wake scheduled in ${intervalMinutes} minute(s).`);
        void schedule(intervalMinutes * 60_000);
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
