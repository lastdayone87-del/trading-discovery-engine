import { browserCapabilityIsUnavailable } from './browserCapability';
import {
  getDb,
  enqueueJob,
  claimNextJob,
  type ClaimBudgetGuard,
  completeJob,
  failJob,
  recoverStaleJobs,
  getChannelById,
  getQueriesByCountry,
  upsertChannel,
  getCountryVocabularies,
  getQueueStatus,
  getQueryById,
  startQueryRun,
  completeQueryRun,
  failQueryRun,
  addQueryExecutionLog,
  tryReserveQuota,
  finishQuotaReservation,
  topUpQuotaReservation,
  reserveProviderRequest,
  settleProviderRequest,
  getAppSetting,
  setAppSetting,
  heartbeatJob,
  recordQueryRunSightings,
  getDailyYouTubeQuotaBudget,
  getYouTubeKeyPool,
  appendDiscordCheckAttempts,
  persistDiscordCandidates,
  claimDiscordInvites,
  deleteDiscordCandidates,
  getDbStatementNow,
  listOrphanDiscordCandidates,
  deleteOrphanDiscordCandidates,
  selectDiscordCandidate,
  countDiscordInvalidObservations,
  countDiscordProviderFailureObservations,
  appendExternalAcquisitionObservations,
  getNeighborhoodForQueryRun,
  getExcludedCountries,
  getAutonomousQuotaAvailability,
  getQueryRunProgress,
  updateQueryRunProgress,
  markQueryRunDeferred,
  markQueryRunResumeUnavailable,
  createContinuationRunSegment,
  markCommunityInspectionStarted,
  markSiteInspectionsClaimed,
  markSiteInspectionsDiscarded,
  markSiteInspectionsRejected,
  type DiscordAttemptCandidate,
  type DiscordInviteClaim,
  type OrphanDiscordCandidateRow,
} from './db';
import { recomputeNeighborhoodRetrievalEvidence } from './retrievalPolicyEvidence';
import { reserveIncrementalTreatmentPageQuota, enqueueChildAndCommitPageReservation } from './retrievalPolicyCanary';
import { resolveExecutionSearchWindow } from './retrievalExperiment';
import { trialContinuationCap } from './discoveryFrontierTrials';
import { aggregatedLanguageCandidateSet, mergeCountryValidationResults, validateChannelCountry } from './countryValidator';
import { runChannelInspection, hasProcessedAcquisitionEvidence } from './inspector';
import { hasRetryableCommunityAcquisitionFailure } from './communityRetryPolicy';
import { applyCommunityIntentEvidence } from './communityIntent';
import { validateDiscordInvite } from './discordValidator';
import {canProjectDiscordValidation,hasEstablishedValidatedDiscordSelection,projectDiscordValidation,reconcileDiscordDiscoveryFromInspection} from './discordProjection';
import { searchYouTubeChannels, searchYouTubeChannelPage, generateCountryQueries, fetchYouTubeChannelEnrichment, fetchYouTubeChannelCountryMetadata, DiscoveredChannelRaw, RetrievalLane } from './youtube';
import {buildProviderRequestBaseId,executeAllocatedRetrievalPage,providerSnapshot,YOUTUBE_SEARCH_PROVIDER,type ProviderAllocation} from './providerAwareRetrieval';
import './braveSearch';
import './youtubeInnertubeProvider';
import { calculateCreatorQualityScore, evaluateQueryPerformance, extractVocabularyFromCreator, replayVocabularyForRetry } from './queryIntelligence';
import { calculateQueryFunnel, countDeferredRawResults, manualSearchContinuationMetrics, type FunnelOutcome, type QueryObservation } from './queryPerformance';
import { resolveScopeEligibility } from './scopeEligibility';
import { processChannelThroughPipeline, isTerminalState, applyGate1CountryRejectionToExisting, type PipelineExecutionOptions } from './ingestionPipeline';
import { evaluateLowAudienceGate } from './lowAudienceGate';
import { resolveTerminalEnrichmentFailure } from './enrichmentLifecycle';
import { recordEvidenceActionOutcome } from './voiEvidenceController';
import { completeInvestigationStep, failInvestigationStep, heartbeatInvestigationStep, startInvestigationStep } from './investigationWorkflow';
import { ChannelRecord, CountryStatus, DiscoverySource, SearchJob, InspectionStep, DiscordStatus } from '../src/types';
import {
  OfficialYouTubeQuotaFenceError,
  currentOfficialYouTubeQuotaOrigin,
  runWithOfficialYouTubeQuotaOrigin,
} from './officialYouTubeQuotaFence';
import { resolveJobQuotaOrigin } from './quotaOrigin';
import { isProbeQuotaControlError } from './quotaKeyCapShadow';
import { assertCountryAllowed, ExcludedCountryError, getCountryExclusion, shouldBlockEnrichClaimForCountry } from './countryExclusion';
import { randomUUID } from 'node:crypto';
import { createManualSearchSession, getManualSearchSession, recordManualSearchPage, failManualSearch, cancelManualSearch } from './manualSearchStore';
import { computeEffectivePageBudget, evaluateContinuation, evaluateContinuationV2, resumeModeForProvider, shouldCreateContinuationSegment, type ContinuationDecisionV2 } from './continuationPolicy';
import { evaluateAutonomousQueryAuthority, isScopePromotedRecord } from './autonomousQueryAuthority';
import { getDiscoveryScope, resolveAutonomousCountries, resolveScopePromotionForScope } from './autonomousDiscovery';
import { YOUTUBE_INNERTUBE_MAX_PAGES, INNERTUBE_TIMEOUT_CODE } from './youtubeInnertubeProvider';
import { getNextYouTubeQuotaResetAt } from './youtubeQuotaDay';
import { shouldReactivateCommunityRecovery, reactivateCommunityRecovery, projectTerminalCommunityRetryFailure } from './communityRecovery';
import { isProviderDeferredEnrichmentError } from './enrichmentOperationalFailure';
import {
  autonomousPageExists,
  countNovelCandidateTermsForPage,
  getAutonomousContinuationState,
  getAutonomousPageMarginalMetrics,
  getAutonomousRunMetrics,
  listPendingAutonomousRuns,
  recordAutonomousPage,
} from './autonomousPageStore';
import { recordPassivePage, recordShadowFailure } from './passiveExploration';
import { enqueueTermHarvest, processTermHarvestJob, readCorpusBudgetForUpdate } from './candidateCorpus';
import { selectExplicitTerminologyLanguageContext, type ExplicitTerminologyLanguageContext } from './terminologyLanguageContext';
import { processAiAdjudicationJob, processCandidateScoringJob } from './candidateScoring';
import { processConceptResolutionJob } from './conceptGraph';
import { processOfflineEvaluationJob } from './offlineEvaluation';
import { getActiveCatalogPin } from './catalogPublication';
import { processStructuredProviderJob } from './persistentResearchPhase5';
import { recordExternalNominations } from './persistentResearchController';
import { processPlaylistInspectionJob } from './playlistAdapterWorker';
import { processFeaturedChannelInspectionJob } from './featuredChannelAdapterWorker';
import { processCountryBoundaryReprocessJob } from './countryBoundaryRecovery';
import { QuotaAllocationExhaustedError } from './quotaCapacity';
import { isGeminiSemanticCooldownActive, isGeminiOrgCooldownActive, isGroqSemanticCooldownActive, isGroqOrgCooldownActive, isGeminiFreeSemanticCooldownActive } from './providerResilience';
import { shouldUseGroqSemantic, configuredGroqRoutes, groqOrgCooldownRemainingMs, groqRouteOrg } from './evidenceEngine/providers/GroqSemanticProvider';
import { configuredGeminiRoutes, geminiRouteOrg } from './evidenceEngine/providers/GeminiSemanticProvider';
import { shouldUseGeminiFreeSemantic } from './evidenceEngine/providers/GeminiFreeSemanticProvider';
import { recordExecutionStage, withExecutionTrace } from './executionTrace';
import { recordNomination } from './candidateAdmission/store';
import {recordAdmissionShadow} from './candidateAdmission/shadowEvaluator';
import { bumpCommunitySaturationDeferral } from './operationsTelemetry';
import { canContinueCommunityInspectionAfterDegradedManualClassification } from './manualRecheckPolicy';
import {COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE, COMMUNITY_ACQUISITION_REQUIRED, COMMUNITY_RETRY_REASON, FOUND_GAP_RETRYABLE_FAILURE_CLASSES, buildCommunityRetryJobMetadata, isAttemptFreeCommunityFailure, attemptFreeDiscordValidation, retryAtFromUnknown, retryReasonFromError, type CommunityRetryDirective} from './communityRetryPolicy';
import { classifyProviderRunOutcome, type ProviderRunOutcome } from './providerCapacityDiagnostics';
import { discordCandidateCompositeRank } from './discordOwnershipSelection';
import { admitDiscordCandidates, buildLegacyDiscordCandidate, canonicalDiscordInviteId, discordInviteCodeOf, extractDiscordInviteCodeRaw, inferDiscordOwnership, mergeDiscordCandidates, type DiscordCandidate } from './discordCandidates';
import { processPendingStagedCandidates } from './candidateStaging';

const WORKER_ID = `worker_${process.pid}`;

/**
 * Continuation-first scheduling priority. Deferred page continuations are
 * already-admitted work for a country that earned a slot; they must be
 * claimed before a brand-new query for another country. Job claiming orders
 * by priority DESC, so the continuation priority is strictly higher than the
 * new-query priority (20, see addSearchJob) while staying below operator
 * manual searches (100).
 */
export const AUTONOMOUS_NEW_QUERY_JOB_PRIORITY = 20;
export const AUTONOMOUS_CONTINUATION_JOB_PRIORITY = 25;

/**
 * Pushes a new search query job to the Search Jobs Queue.
 */
export interface JobProvenance { actorId: string; requestId?: string }
export async function addSearchJob(query: string, country: string, source: DiscoverySource, provenance: JobProvenance = {actorId:'system:scheduler'}, queryId?: number): Promise<SearchJob> {
  await assertCountryAllowed(country, `queue:${source}`);
  const catalogPin=await getActiveCatalogPin(country);
  await recordExecutionStage('JOB_CREATION','REACHED',{type:'SEARCH_YOUTUBE',source},provenance.requestId);
  const job = await enqueueJob(
    'SEARCH_YOUTUBE',
    { query, country, source, provenance, catalogPin, traceId:provenance.requestId, queryId },
    {
      idempotencyKey: `search:${source}:${country.toLowerCase()}:${query.toLowerCase()}`,
      priority: source === 'manual_search' ? 100 : AUTONOMOUS_NEW_QUERY_JOB_PRIORITY
    }
  );
  await recordExecutionStage('QUEUE_PERSISTENCE','REACHED',{jobId:job.id,type:'SEARCH_YOUTUBE',source},provenance.requestId);
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

export function preferredLanguageFromQueryMetadata(metadata: Record<string, unknown>): string | undefined {
  return [metadata.preferredLanguage, metadata.language, metadata.locale, metadata.dominantLocale]
    .find(value => typeof value === 'string' && value.trim().length > 0) as string | undefined;
}

/**
 * InnerTube run-outcome resolution from ledger counts plus observed results.
 * Success-event emission is best-effort (a dropped DB write resolves to a
 * no-op), so the ledger can show zero successes for a run that actually
 * returned results. A provider that returned valid results necessarily
 * responded successfully: in exactly that case (rawResults > 0 with zero
 * ledger successes and a failure outcome) the derived outcome is repaired to
 * SUCCESS_NON_EMPTY. Everything else is untouched — ledger counts stay
 * exact (nothing fabricated), genuine failures with no results keep their
 * failure outcome, and consistent ledgers flow through the shared
 * classifier unchanged.
 */
export function resolveInnertubeRunOutcome(input: {
  rawResults: number;
  providerRequestsAttempted: number;
  providerRequestsSucceeded: number;
  providerRequestsFailed: number;
  providerRateLimited: number;
}): ProviderRunOutcome {
  const outcome = classifyProviderRunOutcome({
    rawResults: input.rawResults,
    providerRequestsAttempted: input.providerRequestsAttempted,
    providerRequestsSucceeded: input.providerRequestsSucceeded,
    providerRequestsFailed: input.providerRequestsFailed,
    providerRateLimited: input.providerRateLimited,
  });
  if (
    input.rawResults > 0 &&
    input.providerRequestsSucceeded === 0 &&
    (outcome === 'FAILED_PROVIDER_RESPONSE' || outcome === 'FAILED_ALL_PROVIDERS')
  ) {
    return 'SUCCESS_NON_EMPTY';
  }
  return outcome;
}

/**
 * Pure ENRICH_CHANNEL claim gate over the active semantic route's cooldown.
 * Each route consults only its own provider's cooldown: Groq-selected claims
 * pause while the Groq cooldown is active, free-Gemini-selected claims pause
 * while the free-Gemini cooldown is active, and paid-Gemini claims pause
 * while the paid cooldown is active — a stale cooldown on any idle route
 * never stalls the serving one. When paid Gemini is primary but cooling down,
 * a configured and healthy Groq fallback route still allows the claim so the
 * job can reach the already-working fallback instead of stalling in queue.
 * Unit-testable without a database; the async cooldown reads stay at the
 * call site.
 */
export function enrichChannelClaimableDuringCooldown(input: {
  groqSelected: boolean;
  geminiFreeSelected?: boolean;
  geminiCooldownActive: boolean;
  groqCooldownActive: boolean;
  geminiFreeCooldownActive?: boolean;
  groqFallbackConfigured?: boolean;
  groqFallbackCooldownActive?: boolean;
}): boolean {
  if (input.groqSelected) return !input.groqCooldownActive;
  if (input.geminiFreeSelected) return !(input.geminiFreeCooldownActive ?? false);
  if (!input.geminiCooldownActive) return true;
  if (input.groqFallbackConfigured && !input.groqFallbackCooldownActive) return true;
  return false;
}

/**
 * Groq fallback cooldown composition for the ENRICH claim gate.
 * Groq is usable as a fallback only when BOTH cooldown mechanisms are clear:
 * the persisted shared cooldown (cross-replica ledger) AND the current
 * process's local in-process cooldown. Either one alone blocks the fallback
 * claim so a 429 whose ledger write failed cannot recreate a claim/defer loop.
 * Pure and unit-testable; callers pass the two existing mechanism reads.
 */
export function groqFallbackCoolingDown(persistedCooldownActive: boolean, localCooldownRemainingMs: number): boolean {
  return persistedCooldownActive || localCooldownRemainingMs > 0;
}

/**
 * Pool-level cooling composition over independent routes/orgs: the pool is
 * cooling only when every known route is cooling (fail-closed on an empty
 * list). One healthy account keeps enrichment claimable while the others
 * cool. Pure and unit-testable; async ledger reads stay at the call site.
 */
export function allRoutesCoolingDown(perRouteCooling: boolean[]): boolean {
  return perRouteCooling.length === 0 || perRouteCooling.every(Boolean);
}

/**
 * Maps a worker execution marker to the coverage-borrow bypass flag. Only an
 * explicit retry-owned reacquisition marker bypasses borrowed coverage; every
 * other path (absent marker, false flag) borrows normally. Strict equality
 * keeps unknown marker shapes fail-safe toward borrowing.
 */
export function resolveBorrowBypassForInspectionMarker(marker?: { isRetryOwnedReacquire?: boolean }): boolean {
  return marker?.isRetryOwnedReacquire === true;
}

/**
 * Choke-point orchestration for global canonical Discord discard. Crash-safe
 * ordering per call: persist provisional rows (idempotent upsert), claim all
 * codes, delete losers. Deletion is execution-scoped by exact candidate id AND
 * a DB-clock watermark captured before persisting, so pre-existing rows for the
 * same channel are never collateral. Dependencies are injectable so invocation
 * order, payloads, and admission outcomes are unit-testable without a database;
 * production passes the real persist/claim/delete implementations.
 */
export interface DiscordChokeDeps {
  persist(channelId: string, candidates: DiscordAttemptCandidate[]): Promise<void>;
  claim(items: Array<{ code: string; sourceSurface?: string | null; sourceUrl?: string | null }>, channelId: string): Promise<DiscordInviteClaim[]>;
  removeLosers(channelId: string, codes: string[], candidateIds: string[], onlyNewerThan: string): Promise<number>;
  /** Execution clock seam (E10). Production reads the DB statement clock so
   * the deletion watermark shares the clock that wrote `discovered_at`. */
  executionNow(): Promise<string>;
}
export async function admitInspectionDiscordCandidates(
  structuredCandidates: DiscordCandidate[],
  foundInvite: string | null | undefined,
  channelId: string,
  deps: DiscordChokeDeps = {
    persist: (targetChannelId, candidates) => persistDiscordCandidates(targetChannelId, candidates),
    claim: (items, targetChannelId) => claimDiscordInvites(items, targetChannelId),
    removeLosers: (targetChannelId, codes, candidateIds, onlyNewerThan) => deleteDiscordCandidates(targetChannelId, codes, candidateIds, onlyNewerThan),
    executionNow: () => getDbStatementNow(),
  },
): Promise<{ candidates: DiscordCandidate[]; discoveredInvite: string | null; discardedCount: number; discardedOwnerChannelIds: string[] }> {
  const toPersist = (list: DiscordCandidate[]) => list.map(candidate => ({
    candidateId: candidate.candidateId,
    rawLocator: candidate.rawLocator,
    locatorType: candidate.locatorType,
    resolvedLocator: candidate.normalizedLocator,
    sourceSurface: candidate.sourceSurface,
    sourceUrl: candidate.sourceUrl,
    observations: candidate.observations,
  }));
  // Provisional watermark: loser cleanup only removes rows created by this
  // execution (discovered_at at/after the DB statement clock read below).
  // DB-side time keeps the window consistent with persisted discovered_at.
  const provisionalSince = await deps.executionNow();
  const preLegacy = !structuredCandidates.length && foundInvite
    ? buildLegacyDiscordCandidate(foundInvite, discordInviteCodeOf(foundInvite))
    : null;
  const provisional = [...structuredCandidates, ...(preLegacy ? [preLegacy] : [])];
  if (provisional.length) await deps.persist(channelId, toPersist(provisional));
  const provisionalIdsForCode = (want: Set<string>) => [...new Set(provisional
    .filter(candidate => { const code = discordInviteCodeOf(candidate.nativeInviteCode); return !!code && want.has(code); })
    .map(candidate => candidate.candidateId)
    .filter(Boolean))];
  const claimSources = new Map<string, { surface: string | null; url: string | null }>();
  for (const candidate of provisional) {
    const code = discordInviteCodeOf(candidate.nativeInviteCode);
    if (code && !claimSources.has(code)) claimSources.set(code, { surface: candidate.sourceSurface || null, url: candidate.sourceUrl || null });
  }
  const inviteClaims = await deps.claim([...claimSources.entries()].map(([code, src]) => ({ code, sourceSurface: src.surface, sourceUrl: src.url })), channelId);
  // Provenance only: owner ids of codes this inspection found but could not
  // claim. The code itself is deliberately not persisted on the affected
  // channel (no invite assignment, no candidate row).
  const discardedOwnerChannelIds = inviteClaims
    .filter(claim => !claim.admitted && claim.firstChannelId && claim.firstChannelId !== channelId)
    .map(claim => String(claim.firstChannelId));
  let admittedCodes = new Set(inviteClaims.filter(claim => claim.admitted).map(claim => claim.code));
  let admission = admitDiscordCandidates(structuredCandidates, foundInvite, admittedCodes);
  // A trail-level foundInvite naming a code outside the structured set is
  // claimed only when nothing was admitted: claiming it unconditionally
  // would park codes that are never processed, blackholing later channels.
  const foundCode = discordInviteCodeOf(foundInvite);
  if (!admission.candidates.length && foundCode && !claimSources.has(foundCode)) {
    // Persist-before-claim (crash-safe ordering) also applies here: the
    // legacy row must exist before its code can be claimed.
    const legacyFallback = buildLegacyDiscordCandidate(foundInvite, foundCode);
    if (legacyFallback) {
      await deps.persist(channelId, toPersist([legacyFallback]));
      const [legacyClaim] = await deps.claim([{ code: foundCode, sourceSurface: null, sourceUrl: null }], channelId);
      if (legacyClaim.admitted) {
        admittedCodes = new Set([...admittedCodes, foundCode]);
        admission = admitDiscordCandidates(structuredCandidates, foundInvite, admittedCodes);
      } else {
        if (legacyClaim.firstChannelId && legacyClaim.firstChannelId !== channelId) discardedOwnerChannelIds.push(String(legacyClaim.firstChannelId));
        await deps.removeLosers(channelId, [foundCode], [legacyFallback.candidateId], provisionalSince);
      }
    }
  }
  const loserCodes = [...claimSources.keys()].filter(code => !admittedCodes.has(code));
  if (loserCodes.length) await deps.removeLosers(channelId, loserCodes, provisionalIdsForCode(new Set(loserCodes)), provisionalSince);
  return { candidates: admission.candidates, discoveredInvite: admission.discoveredInvite, discardedCount: admission.discardedCount, discardedOwnerChannelIds: [...new Set(discardedOwnerChannelIds)] };
}
/**
 * Duplicate-owner provenance projection (E8/E9 follow-up). A fresh duplicate
 * claim always replaces the saved owner id. When no duplicate was observed,
 * only complete, fresh website/social coverage can prove the prior duplicate
 * disappeared. Absence needs aggregate completeness, not one successful seed:
 *  - cache-only borrows are never proof (they return no candidates);
 *  - any failed, partial, or unprocessed seed leaves the prior owner intact
 *    because that seed could still contain the duplicate;
 *  - the owner clears only when every relevant observation is a fresh
 *    processed negative or a FOUND row from this execution.
 * A single FOUND alongside a failed seed therefore preserves provenance.
 * Pure and unit-tested.
 */
export function nextDiscordDuplicateOwnerChannelId(input: {
  discardedOwnerChannelIds: string[];
  previousOwnerChannelId?: string | null;
  observations: Array<{
    surface?: string;
    outcome?: string;
    telemetry?: { pagesInspected?: number; requestsStarted?: number; redirectsFollowed?: number };
    sharedEvidenceFrom?: string;
    siteCacheHit?: unknown;
  }>;
}): string | null {
  const replacement = input.discardedOwnerChannelIds.find(Boolean);
  if (replacement) return replacement;
  const relevant = (input.observations || []).filter(observation =>
    observation && (observation.surface === 'CREATOR_WEBSITES' || observation.surface === 'SOCIAL_PROFILES'));
  if (!relevant.length) return input.previousOwnerChannelId || null;
  const completeAbsenceEvidence = relevant.every(observation => {
    if (observation.siteCacheHit === true) return false;
    if (observation.outcome === 'FOUND') return true;
    return observation.outcome === 'INSPECTED_NO_MATCH'
      && hasProcessedAcquisitionEvidence(observation as Parameters<typeof hasProcessedAcquisitionEvidence>[0]);
  });
  return completeAbsenceEvidence ? null : (input.previousOwnerChannelId || null);
}
/**
 * Orphan drain (E6). Candidates persisted by an execution that never reached
 * validation (crash window between persist and claim) sit as
 * candidate_status='DISCOVERED'/validation_status='NOT_STARTED' forever unless
 * the exact code is rediscovered. The next inspection of the owning channel
 * re-admits them through the same global claim: codes still available (or
 * already owned by this channel) join the normal validation set; codes owned
 * by another channel are residue and are removed by exact candidate id.
 */
export async function drainOrphanDiscordCandidates(
  channelId: string,
  deps: Pick<DiscordChokeDeps, 'claim'> & {
    list(channelId: string, limit?: number): Promise<OrphanDiscordCandidateRow[]>;
    removeOrphans(channelId: string, candidateIds: string[]): Promise<number>;
  } = {
    claim: (items, targetChannelId) => claimDiscordInvites(items, targetChannelId),
    list: (targetChannelId, limit) => listOrphanDiscordCandidates(targetChannelId, limit),
    removeOrphans: (targetChannelId, candidateIds) => deleteOrphanDiscordCandidates(targetChannelId, candidateIds),
  },
  limit = 5,
): Promise<{ candidates: DiscordCandidate[]; removed: number; discardedOwnerChannelIds: string[] }> {
  const rows = await deps.list(channelId, limit);
  if (!rows.length) return { candidates: [], removed: 0, discardedOwnerChannelIds: [] };
  // Orphan rows are matched by exact candidate id and the same
  // DISCOVERED/NOT_STARTED predicate that listed them; their discovered_at
  // predates this execution, so no time watermark applies.
  const sources = new Map<string, { surface: string | null; url: string | null }>();
  for (const row of rows) {
    const code = discordInviteCodeOf(row.canonicalCode || row.normalizedLocator);
    if (code && !sources.has(code)) sources.set(code, { surface: row.sourceSurface, url: row.sourceUrl });
  }
  const claims = await deps.claim([...sources.entries()].map(([code, src]) => ({ code, sourceSurface: src.surface, sourceUrl: src.url })), channelId);
  const admitted = new Set(claims.filter(claim => claim.admitted).map(claim => claim.code));
  // A discarded orphan is still positive evidence that the channel publishes
  // this invite, so retain the foreign owner for dashboard provenance even
  // though the code and candidate row are deleted below.
  const foreignOwnerByCode = new Map<string, string>();
  for (const claim of claims) {
    if (!claim.admitted && claim.firstChannelId && claim.firstChannelId !== channelId) {
      foreignOwnerByCode.set(claim.code, claim.firstChannelId);
    }
  }
  const discardedOwnerChannelIds = new Set<string>();
  const loserIds: string[] = [];
  const candidates: DiscordCandidate[] = [];
  for (const row of rows) {
    const code = discordInviteCodeOf(row.canonicalCode || row.normalizedLocator);
    if (!code || !admitted.has(code)) {
      const owner = code ? foreignOwnerByCode.get(code) : undefined;
      if (owner) discardedOwnerChannelIds.add(owner);
      if (row.candidateId) loserIds.push(row.candidateId);
      continue;
    }
    // Preserve the original-case invite code for validation (Discord codes are
    // case-sensitive) and re-derive ownership from the persisted observations.
    // The registry claim above intentionally uses the lowercase key only.
    const nativeInviteCode = extractDiscordInviteCodeRaw(row.rawLocator)
      || extractDiscordInviteCodeRaw(row.normalizedLocator)
      || code;
    const recovered: DiscordCandidate = {
      candidateId: row.candidateId,
      canonicalInviteId: canonicalDiscordInviteId(code),
      locatorType: (row.locatorType as DiscordCandidate['locatorType']) || 'NATIVE_INVITE',
      sourceSurface: (row.sourceSurface as DiscordCandidate['sourceSurface']) || 'CHANNEL_EXTERNAL_LINKS',
      rawLocator: row.rawLocator || row.normalizedLocator,
      normalizedLocator: row.normalizedLocator,
      nativeInviteCode,
      sourceUrl: row.sourceUrl || undefined,
      extractionConfidence: 'EXPLICIT',
      observations: row.observations as DiscordCandidate['observations'],
    };
    candidates.push({...recovered,...inferDiscordOwnership(recovered)});
  }
  const removed = loserIds.length ? await deps.removeOrphans(channelId, loserIds) : 0;
  return { candidates, removed, discardedOwnerChannelIds: [...discardedOwnerChannelIds] };
}
/**
 * Pure SEARCH worker wall-time split (observability only): quota-wait vs
 * retrieval vs per-channel processing vs total worker time. Persisted in
 * query-run performance_details; never affects scoring or behavior.
 */
export function buildSearchLatencyBreakdownMs(searchWorkerStartMs: number, searchQuotaWaitMs: number, searchRetrievalGrossMs: number, searchTopUpWaitMs: number, channelLoopStartMs: number, channelLoopEndMs: number, nowMs = Date.now()): { workerTotalMs: number; quotaWaitMs: number; retrievalMs: number; channelProcessingMs: number } {
  return {
    workerTotalMs: nowMs - searchWorkerStartMs,
    quotaWaitMs: searchQuotaWaitMs + searchTopUpWaitMs,
    retrievalMs: Math.max(0, searchRetrievalGrossMs - searchTopUpWaitMs),
    channelProcessingMs: channelLoopEndMs - channelLoopStartMs,
  };
}

/**
 * Durable job types claimable through processNextSearchJob overrides.
 * RELATIONSHIP_CANARY_EXPANSION rides the existing SEARCH pool (same YouTube
 * provider profile, same tick lifecycle) behind its own settings gate, so no
 * new worker architecture is required for continuous canary consumption.
 */
export type ClaimableSearchJobType = 'SEARCH_YOUTUBE' | 'ENRICH_CHANNEL' | 'RESOLVE_STAGED_CANDIDATE' | 'MANUAL_SEARCH_PAGE' | 'POST_APPROVAL_ENRICH' | 'FORCE_REVIEW_RESCAN' | 'RETRY_COMMUNITY_ACQUISITION' | 'TERM_HARVEST' | 'SCORE_CANDIDATES' | 'AI_ADJUDICATE_CANDIDATE' | 'PROPOSE_CONCEPT_RESOLUTION' | 'OFFLINE_CANDIDATE_EVALUATION' | 'INSPECT_PLAYLIST' | 'INSPECT_FEATURED_CHANNELS' | 'PERSISTENT_RESEARCH_EXTERNAL_PROVIDER' | 'COUNTRY_BOUNDARY_REPROCESS' | 'RELATIONSHIP_CANARY_EXPANSION';

const AUTONOMOUS_TIME_DEFER_MS = 5 * 60_000;
let lastAutonomousResumeSweepAt = 0;

/** Persist a resumable quota deferral. The run is not completed and the
 * next-page cursor is retained on the run/page rows. */
async function deferAutonomousRunForQuota(runId: string, reason: string): Promise<void> {
  const deferredUntil = new Date(getNextYouTubeQuotaResetAt()).toISOString();
  await markQueryRunDeferred(runId, 'DEFERRED_QUOTA', deferredUntil);
  console.log(JSON.stringify({
    event: 'autonomous_run_deferred_quota',
    runId,
    deferredUntil,
    reason: reason.slice(0, 300),
    timestamp: new Date().toISOString(),
  }));
}

async function deferAutonomousRunForTime(runId: string, reason: string): Promise<void> {
  const deferredUntil = new Date(Date.now() + AUTONOMOUS_TIME_DEFER_MS).toISOString();
  await markQueryRunDeferred(runId, 'DEFERRED_TIME', deferredUntil);
  console.log(JSON.stringify({
    event: 'autonomous_run_deferred_time',
    runId,
    deferredUntil,
    reason: reason.slice(0, 300),
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Normalized keys for the configured active autonomous sweep scope. The
 * reconciler uses this to enforce report §6.7: it never resumes a run whose
 * country left the active scope (scope narrowing, dormancy, or exclusion), even
 * when the run still carries a valid provider cursor.
 */
async function resolveActiveAutonomousCountryKeys(): Promise<Set<string>> {
  const [vocabs, excluded, scope] = await Promise.all([
    getCountryVocabularies(),
    getExcludedCountries(),
    getDiscoveryScope(),
  ]);
  const countries = resolveAutonomousCountries(
    vocabs.map(vocab => vocab.country),
    excluded.map(item => item.country_name),
    scope.selectedCountries,
    scope.scope,
  );
  return new Set(countries.map(country => country.normalize('NFKC').trim().toLocaleLowerCase('en')));
}

function autonomousCountryKey(country: string): string {
  return country.normalize('NFKC').trim().toLocaleLowerCase('en');
}

/** Count the configured active countries for fair-share quota budgeting. */
async function countActiveAutonomousCountries(): Promise<number> {
  return Math.max(1, (await resolveActiveAutonomousCountryKeys()).size);
}

function providerPageCap(providerKey: string, safetyMaxPages: number): number {
  if (providerKey === 'youtube-innertube') return YOUTUBE_INNERTUBE_MAX_PAGES;
  if (providerKey === 'brave-search') return Math.max(1, Number(process.env.BRAVE_MAX_OFFSET || 9) + 1);
  return safetyMaxPages;
}


/**
 * Atomic daily-budget guards evaluated inside the claim transaction (see
 * claimNextJob): each takes its control row FOR UPDATE — serializing
 * check-then-claim across replicas/processes — then admits only with
 * remaining headroom counting both completed units and in-flight claims
 * made today. Denial filters the guarded types out of the claim (jobs stay
 * queued); pause/kill-switch semantics are unchanged and evaluated first by
 * the claim builder. No other caller is affected: guards apply only when the
 * claim filter overlaps their types.
 */
export const TERM_HARVEST_BUDGET_GUARD: ClaimBudgetGuard = {
  types: ['TERM_HARVEST'],
  lockSql: `SELECT * FROM corpus_controls WHERE singleton=true FOR UPDATE`,
  isAdmitted: async (client) => {
    // Shared authoritative budget: same control row, same consumed ledger,
    // same decision helper as the processors and persistent research.
    // Harvest always costs exactly one unit (one extraction run per job), so
    // denial always means global exhaustion: no smaller request exists.
    const state = await readCorpusBudgetForUpdate(client);
    if (!state || state.paused) return { admitted: false, exhausted: true };
    const inFlight = await client.query(`SELECT count(*)::int AS n FROM jobs WHERE type='TERM_HARVEST' AND status='PROCESSING' AND locked_at>=date_trunc('day',now())`);
    const remaining = state.dailyBudget - state.consumedToday - Number(inFlight.rows[0]?.n || 0);
    if (!Number.isFinite(remaining)) return { admitted: false, exhausted: true };
    return { admitted: remaining >= 1, exhausted: remaining < 1 };
  },
};

export const SCORE_CANDIDATES_BUDGET_GUARD: ClaimBudgetGuard = {
  types: ['SCORE_CANDIDATES'],
  lockSql: `SELECT * FROM candidate_scoring_controls WHERE singleton=true FOR UPDATE`,
  isAdmitted: async (client, job) => {
    // Reservation unit is the job's normalized-span group count: one job can
    // create multiple snapshots, so per-job admission would overshoot the cap.
    // Mirrors the processor exactly (spent check first, then per-job units):
    // a zero-group job with no remaining headroom is denied rather than
    // routed into the processor's budget throw.
    const documentId = job?.payload?.documentId;
    if (typeof documentId !== 'string' || !documentId) return { admitted: false, exhausted: false };
    const control = await client.query(`SELECT scoring_paused AS paused,daily_scoring_candidates AS budget FROM candidate_scoring_controls WHERE singleton=true FOR UPDATE`);
    if (!control.rows.length) return { admitted: false, exhausted: true };
    const budget = Number(control.rows[0].budget);
    if (Boolean(control.rows[0].paused) || !Number.isFinite(budget)) {
      return { admitted: false, exhausted: true };
    }
    const groups = await client.query(`SELECT count(DISTINCT normalized_span)::int AS n FROM corpus_candidate_occurrences WHERE document_id=$1::uuid`, [documentId]);
    const spent = await client.query(`SELECT count(*)::int AS n FROM candidate_feature_snapshots WHERE computed_at>=date_trunc('day',now())`);
    const inFlight = await client.query(
      `SELECT COALESCE(sum(g.n),0)::int AS u FROM jobs p LEFT JOIN LATERAL
       (SELECT count(DISTINCT o.normalized_span)::int AS n FROM corpus_candidate_occurrences o
        WHERE o.document_id::text=(p.payload->>'documentId')) g ON true
       WHERE p.type='SCORE_CANDIDATES' AND p.status='PROCESSING' AND p.locked_at>=date_trunc('day',now())`
    );
    const remaining = budget - Number(spent.rows[0]?.n || 0) - Number(inFlight.rows[0]?.u || 0);
    if (remaining < 1) return { admitted: false, exhausted: true };
    return { admitted: Number(groups.rows[0]?.n || 0) <= remaining, exhausted: false };
  },
};

export const CORPUS_CLAIM_BUDGET_GUARDS: ClaimBudgetGuard[] = [TERM_HARVEST_BUDGET_GUARD, SCORE_CANDIDATES_BUDGET_GUARD];

/**
 * Concept-resolution daily budget guard: one admitted job costs exactly one
 * unit (at most one proposal row per job, idempotent by proposal_key), mirroring
 * the processor which inserts a single surface + proposal pair. Counts today's
 * completed proposals plus in-flight PROCESSING resolution claims under the
 * same control-row lock; denial leaves jobs queued without consuming attempts.
 */
export const RESOLUTION_BUDGET_GUARD: ClaimBudgetGuard = {
  types: ['PROPOSE_CONCEPT_RESOLUTION'],
  lockSql: `SELECT * FROM concept_graph_controls WHERE singleton=true FOR UPDATE`,
  isAdmitted: async (client, job) => {
    const control = await client.query(
      `SELECT resolution_paused AS paused,daily_resolution_documents AS budget FROM concept_graph_controls WHERE singleton=true FOR UPDATE`
    );
    if (!control.rows.length) return { admitted: false, exhausted: true };
    const budget = Number(control.rows[0].budget);
    if (Boolean(control.rows[0].paused) || !Number.isFinite(budget)) {
      return { admitted: false, exhausted: true };
    }
    const done = await client.query(
      `SELECT count(*)::int AS n FROM concept_resolution_proposals WHERE created_at>=date_trunc('day',now())`
    );
    // In-flight counts every live PROCESSING claim with no date bound: a unit
    // stays reserved until the job completes or fails, so a pre-midnight
    // claim cannot silently drop out of today's accounting at rollover.
    // Stale locks are recovered to PENDING by recoverStaleJobs on every tick,
    // so only genuinely live claims hold units here.
    const inFlight = await client.query(
      `SELECT count(*)::int AS n FROM jobs WHERE type='PROPOSE_CONCEPT_RESOLUTION' AND status='PROCESSING'`
    );
    const remaining = budget - Number(done.rows[0]?.n || 0) - Number(inFlight.rows[0]?.n || 0);
    if (remaining < 1) {
      // Idempotent-retry escape hatch: if this exact job's proposal is already
      // recorded (persist succeeded but completion never landed, e.g. crash
      // between the insert and completeJob), re-running creates nothing new
      // (proposal_key is idempotent), so admit with zero additional units and
      // let the job reach its terminal state instead of stranding it forever
      // behind a budget its own prior persistence consumed. New literals still
      // require headroom because they would create new proposal rows.
      const candidateKey = job?.payload?.candidateKey;
      if (typeof candidateKey === 'string' && candidateKey) {
        const prior = await client.query(
          `SELECT 1 FROM concept_resolution_proposals WHERE candidate_key=$1 LIMIT 1`,
          [candidateKey]
        );
        if (prior.rows.length) return { admitted: true, exhausted: true };
      }
      return { admitted: false, exhausted: true };
    }
    return { admitted: true, exhausted: false };
  },
};

export const RESOLUTION_CLAIM_BUDGET_GUARDS: ClaimBudgetGuard[] = [RESOLUTION_BUDGET_GUARD];

/**
 * Worker loop that processes one durable search or enrichment job.
 */
export async function processNextSearchJob(
  claimableOverride?: Array<ClaimableSearchJobType>,
  workerId = WORKER_ID
): Promise<boolean> {
  // Claim-critical recovery: release stale PROCESSING locks before attempting
  // a claim. Every other sweep (channel locks, investigation/community
  // recovery, provider-deferred projection, operational enrichment recovery,
  // Phase B reconciliation) runs on the dedicated scheduler interval in
  // operationalMaintenanceScheduler.ts, so it cannot serialize ahead of every
  // claim in every pool.
  await recoverStaleJobs();
  const qStatus = await getQueueStatus();
  const claimableTypes: string[] = [];
  if (!qStatus.searchJobs.isPaused && (!claimableOverride || claimableOverride.includes('SEARCH_YOUTUBE'))) claimableTypes.push('SEARCH_YOUTUBE');
  if (!qStatus.searchJobs.isPaused && (!claimableOverride || claimableOverride.includes('MANUAL_SEARCH_PAGE'))) claimableTypes.push('MANUAL_SEARCH_PAGE');
  // ENRICH_CHANNEL: every such job runs the full evidence pipeline. Under the
  // default Gemini route, availability() returns AVAILABLE for
  // enrichment_stage >= 1, so when Gemini is rate-limited every claimed
  // ENRICH_CHANNEL job immediately defers via SEMANTIC_DEFERRED_RATE_PRESSURE,
  // creating a ~1Hz DEFER storm. This gate pauses ENRICH_CHANNEL claims
  // while the serving pool is cooling. Each provider account cools
  // independently: paid-Gemini claims consult every configured Gemini
  // account, Groq-selected claims consult every Groq organization, and a
  // stale cooldown on any idle route or exhausted account never stalls the
  // healthy ones. When paid Gemini is cooling on all accounts, a configured
  // Groq organization that is clear of BOTH its persisted cooldown and its
  // process-local cooldown still allows the claim so jobs can reach the
  // already-working fallback.
  if (!qStatus.channelProcessing.isPaused && (!claimableOverride || claimableOverride.includes('ENRICH_CHANNEL'))) {
    const groqSelected = shouldUseGroqSemantic();
    const geminiFreeSelected = !groqSelected && shouldUseGeminiFreeSemantic();
    const geminiRoutes = !groqSelected && !geminiFreeSelected ? configuredGeminiRoutes() : [];
    const geminiCooldownActive = geminiRoutes.length > 0
      ? allRoutesCoolingDown(await Promise.all(geminiRoutes.map(route => isGeminiOrgCooldownActive(geminiRouteOrg(route)))))
      : (!groqSelected && !geminiFreeSelected ? await isGeminiSemanticCooldownActive() : false);
    const groqRoutes = groqSelected ? configuredGroqRoutes() : [];
    const groqCooldownActive = groqRoutes.length > 0
      ? allRoutesCoolingDown(await Promise.all(groqRoutes.map(async route => groqFallbackCoolingDown(await isGroqOrgCooldownActive(groqRouteOrg(route)), groqOrgCooldownRemainingMs(groqRouteOrg(route))))))
      : (groqSelected ? await isGroqSemanticCooldownActive() : false);
    const geminiFreeCooldownActive = geminiFreeSelected ? await isGeminiFreeSemanticCooldownActive() : false;
    let groqFallbackConfigured = false;
    let groqFallbackCooldownActive = false;
    if (!groqSelected && !geminiFreeSelected && geminiCooldownActive) {
      const fallbackRoutes = configuredGroqRoutes();
      groqFallbackConfigured = fallbackRoutes.length > 0 && process.env.SEMANTIC_PROVIDER_FORCE_GEMINI !== 'true';
      if (groqFallbackConfigured) groqFallbackCooldownActive = allRoutesCoolingDown(await Promise.all(fallbackRoutes.map(async route => groqFallbackCoolingDown(await isGroqOrgCooldownActive(groqRouteOrg(route)), groqOrgCooldownRemainingMs(groqRouteOrg(route))))));
    }
    if (enrichChannelClaimableDuringCooldown({ groqSelected, geminiFreeSelected, geminiCooldownActive, groqCooldownActive, geminiFreeCooldownActive, groqFallbackConfigured, groqFallbackCooldownActive })) claimableTypes.push('ENRICH_CHANNEL');
  }
  if (!qStatus.channelProcessing.isPaused && (!claimableOverride || claimableOverride.includes('RESOLVE_STAGED_CANDIDATE'))) claimableTypes.push('RESOLVE_STAGED_CANDIDATE');
  if (!qStatus.channelProcessing.isPaused && claimableOverride?.includes('POST_APPROVAL_ENRICH')) claimableTypes.push('POST_APPROVAL_ENRICH');
  if (!qStatus.channelProcessing.isPaused && claimableOverride?.includes('FORCE_REVIEW_RESCAN')) claimableTypes.push('FORCE_REVIEW_RESCAN');
  if (!qStatus.discordValidation.isPaused && (!claimableOverride || claimableOverride.includes('RETRY_COMMUNITY_ACQUISITION'))) claimableTypes.push('RETRY_COMMUNITY_ACQUISITION');
  if(!claimableOverride||claimableOverride.includes('PERSISTENT_RESEARCH_EXTERNAL_PROVIDER')){const db=await getDb();const c=await db.query(`SELECT 1 FROM external_provider_adapter_controls WHERE mode IN('CANARY','ACTIVE') AND NOT paused AND NOT kill_switch LIMIT 1`);if(c.rowCount)claimableTypes.push('PERSISTENT_RESEARCH_EXTERNAL_PROVIDER');}
  if(!claimableOverride||claimableOverride.includes('INSPECT_PLAYLIST')){const db=await getDb();const c=await db.query(`SELECT mode,paused,kill_switch FROM acquisition_adapter_controls WHERE adapter_type='INSPECT_PLAYLIST'`);if(c.rows[0]?.mode==='CANARY'&&!c.rows[0].paused&&!c.rows[0].kill_switch)claimableTypes.push('INSPECT_PLAYLIST');}
  if(!claimableOverride||claimableOverride.includes('INSPECT_FEATURED_CHANNELS')){const db=await getDb();const c=await db.query(`SELECT 1 FROM acquisition_adapter_controls adapter JOIN creator_search_canary_control authority ON authority.singleton=true WHERE adapter.adapter_type='INSPECT_FEATURED_CHANNELS' AND adapter.mode='CANARY' AND NOT adapter.paused AND NOT adapter.kill_switch AND authority.enabled AND NOT authority.kill_switch AND authority.serving_authority_enabled AND authority.featured_channel_authority_enabled AND authority.featured_channel_rollout_basis_points>0`);if(c.rowCount)claimableTypes.push('INSPECT_FEATURED_CHANNELS');}
  // Relationship-canary expansion is always claimable so queued runs drain:
  // the worker itself returns KILLED with zero spend when the canary is
  // disabled or killed, which completes stale queued runs inertly instead of
  // leaving them pending to fire on a later re-enable. No new worker pool:
  // the type rides the existing tick lifecycle like the adapter canaries.
  // Default inertness is preserved because only explicitly queued
  // relationship jobs match this type — nothing else is claimed by it.
  if(!claimableOverride||claimableOverride.includes('RELATIONSHIP_CANARY_EXPANSION')){
    claimableTypes.push('RELATIONSHIP_CANARY_EXPANSION');
  }
  if (!claimableOverride || claimableOverride.includes('TERM_HARVEST')) {
    const db=await getDb();const control=await db.query(`SELECT paused FROM corpus_controls WHERE singleton=true`);
    if(control.rowCount&&!control.rows[0].paused)claimableTypes.push('TERM_HARVEST');
  }
  if(!claimableOverride||claimableOverride.includes('PROPOSE_CONCEPT_RESOLUTION')){const db=await getDb();const control=await db.query('SELECT resolution_paused FROM concept_graph_controls WHERE singleton=true');if(control.rowCount&&!control.rows[0].resolution_paused)claimableTypes.push('PROPOSE_CONCEPT_RESOLUTION');}
  if(!claimableOverride||claimableOverride.includes('OFFLINE_CANDIDATE_EVALUATION')){const db=await getDb();const control=await db.query('SELECT evaluation_paused,provider_access_allowed FROM offline_evaluation_controls WHERE singleton=true');if(control.rowCount&&!control.rows[0].evaluation_paused&&!control.rows[0].provider_access_allowed)claimableTypes.push('OFFLINE_CANDIDATE_EVALUATION');}
  if (!claimableOverride || claimableOverride.includes('SCORE_CANDIDATES') || claimableOverride.includes('AI_ADJUDICATE_CANDIDATE')) {
    const db=await getDb();const control=await db.query(`SELECT scoring_paused,ai_paused FROM candidate_scoring_controls WHERE singleton=true`);
    if(control.rowCount&&!control.rows[0].scoring_paused&&(!claimableOverride||claimableOverride.includes('SCORE_CANDIDATES')))claimableTypes.push('SCORE_CANDIDATES');
    if(control.rowCount&&!control.rows[0].ai_paused&&(!claimableOverride||claimableOverride.includes('AI_ADJUDICATE_CANDIDATE')))claimableTypes.push('AI_ADJUDICATE_CANDIDATE');
  }
  if (claimableTypes.length === 0) return false;

  const browserBlockedRetryPatterns = browserCapabilityIsUnavailable() ? ['%BROWSER_RUNTIME_UNAVAILABLE%'] : undefined;
  const job = await claimNextJob(workerId, claimableTypes, browserBlockedRetryPatterns, ['RECONCILIATION_REQUIRED'], [...CORPUS_CLAIM_BUDGET_GUARDS, ...RESOLUTION_CLAIM_BUDGET_GUARDS]);
  if (!job) return false;
  const investigationId=String(job.payload?.investigationId||''),investigationStepId=String(job.payload?.investigationStepId||'');
  const traceId=String(job.payload?.traceId||'');
  return withExecutionTrace(traceId, async()=>{
  const heartbeat = setInterval(() => {
    heartbeatJob(job.id, workerId).catch(error => console.error(`[Queue Worker:${workerId}] Heartbeat failed:`, error));
    if(investigationId&&investigationStepId)heartbeatInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,workerId}).catch(error=>console.error(`[Investigation:${investigationId}] Heartbeat failed:`,error));
  }, 60_000);
  heartbeat.unref?.();

  try {
    // Establish durable provenance before any handler can reserve quota,
    // hydrate metadata, or open a provider request. Probe-origin jobs run
    // normally but every official call reserves from the independent probe
    // allocation. Resolve inside this try so a provenance read failure follows
    // the same failure lifecycle and job-specific cleanup as handler errors.
    const quotaOrigin = await resolveJobQuotaOrigin(job);
    if (quotaOrigin === 'UNKNOWN') {
      throw new OfficialYouTubeQuotaFenceError(
        quotaOrigin,
        `queueJob:${job.type}`,
        `job ${job.id} has no durable quota provenance`,
      );
    }
    return await runWithOfficialYouTubeQuotaOrigin(quotaOrigin, `queueJob:${job.type}`, async () => {
    if(investigationId&&investigationStepId&&!await startInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,attempt:job.attempts,workerId})){await completeJob(job.id);return true;}
    await recordExecutionStage('DISPATCHER','REACHED',{jobId:job.id,type:job.type});
    if(job.type==='RETRY_COMMUNITY_ACQUISITION'){
      const channel=await getChannelById(String(job.payload.channelId||''));
      if(!channel){await completeJob(job.id);return true;}
      // job.attempts is the post-claim number matching this attempt's
      // job_attempts row; the marker call throws on a stale/recovered claim so
      // inspection never starts unmarked.
      // A RETRY_COMMUNITY_ACQUISITION job exists precisely to continue an
      // unresolved acquisition for the same channel: its inspection must
      // re-acquire rather than borrow its own incomplete coverage in a loop.
      // First-time inspections leave the flag unset and borrow normally.
      const inspectionResult=await inspectAndValidateChannel(channel,undefined,false,false,false,{jobId:job.id,attemptNumber:job.attempts,isRetryOwnedReacquire:true,clickOffsets:resolveInspectionClickOffsets(job.payload.clickOffsets)});
      // Attempt-free deferral is reserved for capacity/browser signals where no
      // real acquisition was attempted (browser runtime unavailable). Genuine
      // acquisition failures (COMMUNITY_REQUIRED) consumed a real inspection
      // run and must consume one durable attempt via the normal failure path
      // below, so retries progress and eventually terminate instead of looping
      // forever at attempts=0 with ever-growing execution counts.
      const directive=inspectionResult?inspectionResult.retryDirective:undefined;
      if(directive?.attemptFree&&directive.retryReason===COMMUNITY_RETRY_REASON.BROWSER_RUNTIME_UNAVAILABLE){
        const deferred=Object.assign(new Error(`Community acquisition deferred: ${directive.reason}`),{code:directive.code,retryable:true,retryAt:directive.retryAt});
        // Observability for the dominant saturation-deferral path: the
        // RENDERED_FALLBACK_SATURATED class rejects before admission, so this
        // deferral proves no acquisition work started and stays attempt-free.
        if(String(directive.reason||'').includes('RENDERED_FALLBACK_SATURATED'))bumpCommunitySaturationDeferral();
        throw deferred;
      }
      const refreshed=await getChannelById(channel.channel_id);
      // Suppression-owned completion: no active retry directive exists
      // because deterministic-tail suppression deliberately took retry
      // ownership away. Completing normally instead of re-entering the same
      // work through the generic unresolved-failure path below.
      // Browser-capacity attempt-free deferral throws above and is untouched.
      if(shouldCompleteSuppressedRetryJob(inspectionResult,refreshed?.scan_status)){await completeJob(job.id);return true;}
      if(refreshed?.scan_status==='FAILED'||refreshed?.scan_status==='FAILED_PERMANENT')throw new Error('Retryable community acquisition remains unresolved');
      await completeJob(job.id);return true;
    }
    if(job.type==='TERM_HARVEST'){await processTermHarvestJob(job);return true;}
    if(job.type==='SCORE_CANDIDATES'){await processCandidateScoringJob(job);return true;}
    if(job.type==='AI_ADJUDICATE_CANDIDATE'){await processAiAdjudicationJob(job);return true;}
    if(job.type==='PROPOSE_CONCEPT_RESOLUTION'){await processConceptResolutionJob(job);return true;}
    if(job.type==='OFFLINE_CANDIDATE_EVALUATION'){await processOfflineEvaluationJob(job);return true;}
    if(job.type==='PERSISTENT_RESEARCH_EXTERNAL_PROVIDER'){await processStructuredProviderJob(job,recordExternalNominations);return true;}
    if(job.type==='RESOLVE_STAGED_CANDIDATE'){
      await processPendingStagedCandidates();
      await completeJob(job.id);
      return true;
    }
    if(job.type==='COUNTRY_BOUNDARY_REPROCESS'){
      await processCountryBoundaryReprocessJob(job);
      await completeJob(job.id);
      return true;
    }
    if(job.type==='INSPECT_PLAYLIST'){await processPlaylistInspectionJob(job,processDiscoveredChannelContained);return true;}
    if(job.type==='INSPECT_FEATURED_CHANNELS'){await processFeaturedChannelInspectionJob(job,processDiscoveredChannelContained);return true;}
    if(job.type==='RELATIONSHIP_CANARY_EXPANSION'){
      await handleRelationshipCanaryExpansionJob(job, undefined, { workerId, attemptNumber: job.attempts });return true;
    }
    if (job.type === 'POST_APPROVAL_ENRICH' || job.type === 'FORCE_REVIEW_RESCAN') {
      const channelId=String(job.payload.channelId||'');
      const before=await getChannelById(channelId);
      if(!before) { await completeJob(job.id); return true; }
      const result=await triggerManualRecheck(channelId, true, true);
      if(!result.success){
        // A policy skip is a handled outcome, not a failure: complete the job
        // instead of consuming bounded retry attempts. Other policy refusals
        // (e.g. country exclusion) keep the existing failure taxonomy.
        if(result.code==='MANUAL_RESCAN_LOW_AUDIENCE_SKIP'){await completeJob(job.id);return true;}
        // Preserve the provider/admission taxonomy so capacity/transient
        // failures defer attempt-free with their retry schedule, while genuine
        // failures consume one bounded attempt and eventually project a
        // truthful terminal state. A plain Error would erase that distinction.
        const probeControl=result.probeQuotaExceeded===true||result.probeQuotaDisabled===true||result.probeQuotaUnavailable===true;
        const typedTransient=result.retryable===true
          &&(probeControl||['TIMEOUT','CANCELLED','RATE_LIMIT','TRANSIENT','CREDENTIALS_EXHAUSTED'].includes(String(result.errorClass||'')));
        throw Object.assign(new Error(result.message),{
          code:result.code,
          retryable:typedTransient,
          errorClass:typedTransient?result.errorClass:undefined,
          retryAt:typedTransient?result.retryAt:undefined,
          retryAfterMs:typedTransient?result.retryAfterMs:undefined,
          ...(result.probeQuotaExceeded===true?{probeQuotaExceeded:true}:{}),
          ...(result.probeQuotaDisabled===true?{probeQuotaDisabled:true}:{}),
          ...(result.probeQuotaUnavailable===true?{probeQuotaUnavailable:true}:{})
        });
      }
      const refreshed=await getChannelById(channelId);
      if(refreshed && job.type==='POST_APPROVAL_ENRICH') {
        // Human approval remains authoritative; learning is delayed until this
        // post-approval metadata/Discord inspection has completed successfully.
        refreshed.trading_status='TRADING_CONFIRMED';
        const text=refreshed.inspection_trail?.map(step=>step.details||'').join(' ')||'';
        const quality=calculateCreatorQualityScore(refreshed,[refreshed.channel_name],text);
        refreshed.quality_score=quality.score; refreshed.quality_breakdown=quality.breakdown;
        await upsertChannel(refreshed);
        if(quality.score>=55) {
          // Provenance: titles here are the channel name (already a CHANNEL_NAME
          // source) and the description is inspection-trail prose — neither is
          // YouTube metadata, so both are excluded from provenance evidence.
          await extractVocabularyFromCreator(refreshed,[refreshed.channel_name],text,true,result.languageContext,undefined,{ videoTitlesAreMetadata: false, descriptionIsMetadata: false });
          const db=await getDb();
          await db.query(`UPDATE extracted_vocabulary_sources SET provenance='HUMAN_APPROVED',eligible_after_enrichment=true WHERE channel_id=$1`,[channelId]);
          await enqueueTermHarvest({channelId,text,lineage:'HUMAN_APPROVED',approved:true});
        }
      }
      await completeJob(job.id); return true;
    }
    if (job.type === 'MANUAL_SEARCH_PAGE') {
      const sessionId = String(job.payload.sessionId || '');
      try {
        const session = await getManualSearchSession(sessionId);
        if (!session) throw new Error(`Manual search session ${sessionId} no longer exists.`);
        if (session.status === 'CANCEL_REQUESTED') { await cancelManualSearch(sessionId); await completeJob(job.id); return true; }
        if (session.status !== 'RUNNING') { await completeJob(job.id); return true; }
        await executeManualSearchPage(sessionId, Number(job.payload.pageNumber), String(job.payload.pageToken || '') || null, Number(job.payload.variantIndex || 0), job.id);
        await completeJob(job.id);
      } catch (error) {
        throw error;
      }
      return true;
    }
    if (job.type === 'ENRICH_CHANNEL') {
      const evidenceStartedAt=Date.now(),evidenceDecisionId=String(job.payload.evidenceAcquisitionDecisionId||'');
      const { channelId, targetCountry, source, candidate } = job.payload as {
        channelId: string;
        targetCountry: string;
        source: DiscoverySource;
        candidate: DiscoveredChannelRaw;
        enrichmentStage?:number;
        queryRunId?:string;
      };
      const enrichmentStage=Math.min(3,Math.max(1,Number(job.payload.enrichmentStage||1))) as 1|2|3;
      if(investigationId)candidate.investigationId=investigationId;
      await assertCountryAllowed(targetCountry, `enrichment_worker:${job.id}`);
      // A contained probe refusal defers the original discovery pipeline, not
      // an enrichment-only retry. Replay discovery before the enrichment
      // eligibility gate: discovery may revisit an existing TRADING_CONFIRMED
      // row with UNCERTAIN country evidence, or an aged machine NON_TRADING
      // row, and those rows would otherwise complete here without doing the
      // deferred work.
      if (job.payload.probeDeferredDiscovery === true) {
        await processDiscoveredChannel(candidate, targetCountry, source, {
          forceExtraction: job.payload.forceExtraction === true || isRepairEligibleRetry(job),
          jobId: job.id,
          runId: typeof job.payload.queryRunId === 'string' ? job.payload.queryRunId : undefined,
        });
        await completeJob(job.id);
        return true;
      }
      const channel = await getChannelById(channelId);
      // REJECTED rows are terminal for every pipeline (isTerminalState) and
      // are additionally guarded explicitly here (P2) so a future terminal
      // state change can never let an excluded creator spend enrichment quota.
      if (!channel || channel.country_status === 'REJECTED' || isTerminalState(channel) || channel.trading_status !== 'UNCERTAIN') {
        // Retry repair: a retried ENRICH job replays vocabulary extraction so a
        // save that failed after its observation committed cannot strand rows
        // behind this early completion (same bars as the ingestion helper).
        // Repair failures propagate to failJob (bounded retry) rather than
        // completing with rows still missing.
        if (channel && isRepairEligibleRetry(job)) {
          await replayVocabularyForRetry(channel, candidate, source, true);
        }
        if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'SKIPPED',resultingStatus:channel?.trading_status,providerCost:0,latencyMs:Date.now()-evidenceStartedAt,reasonCode:'CASE_NO_LONGER_ELIGIBLE'}).catch(()=>undefined);
        if(investigationId&&investigationStepId)await completeInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,resultingStatus:channel?.trading_status||'POLICY_REJECTED',output:{reason:channel?'CASE_NO_LONGER_ELIGIBLE':'CHANNEL_MISSING'}});
        await completeJob(job.id);
        return true;
      }

      // Creator-country claim gate: a stored CONFIRMED creator country that is
      // excluded must stop enrichment before ENRICHING is stamped and before
      // quota is reserved. LIKELY and below stay fail-open, matching the
      // existing Gate-1 authority semantics (only confirmed-level evidence
      // rejects). The claim-time assertCountryAllowed above covers only the
      // discovery target country, never the creator country.
      if (channel.country_status === 'CONFIRMED' && channel.country) {
        const creatorExclusion = await getCountryExclusion(channel.country);
        const claimBlock = shouldBlockEnrichClaimForCountry(channel.country_status, channel.country, creatorExclusion);
        if (claimBlock) {
          const claimNow = new Date().toISOString();
          applyGate1CountryRejectionToExisting(
            channel,
            {
              creatorCountry: channel.country,
              score: channel.confidence_score,
              validationStep: {
                step: 'COUNTRY_VALIDATION',
                title: `Country Validation (${channel.country})`,
                status: 'REJECTED',
                details: `${channel.country} is excluded by policy: ${claimBlock.reason}. Detected at ENRICH_CHANNEL claim for job ${job.id}; enrichment cancelled before quota spend.`,
                timestamp: claimNow,
              },
              now: claimNow,
            },
            candidate
          );
          await upsertChannel(channel);
          console.warn(JSON.stringify({event:'excluded_channel_blocked',channelId,targetCountry,detectedCountry:channel.country,reason:claimBlock.reason,context:`enrichment_claim:${job.id}`,timestamp:claimNow}));
          if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'SKIPPED',resultingStatus:channel.trading_status,providerCost:0,latencyMs:Date.now()-evidenceStartedAt,reasonCode:'COUNTRY_POLICY_CHANGED'}).catch(()=>undefined);
          if(investigationId&&investigationStepId)await completeInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,resultingStatus:'POLICY_REJECTED',output:{reason:'COUNTRY_POLICY_CHANGED'}});else await completeJob(job.id);
          return true;
        }
      }

      channel.scan_status = 'ENRICHING';
      channel.scan_attempts = job.attempts;
      await upsertChannel(channel);
      // Reserve before the claim-time hydration below so a quota-exhausted
      // claim throws here without spending the 1-unit metadata fetch.
      // Reservation is not consumption: skip paths below release it.
      const dailyBudget = getDailyYouTubeQuotaBudget();
      const enrichmentPercent = Number(await getAppSetting('discovery_enrichment_quota_percent', process.env.DISCOVERY_ENRICHMENT_QUOTA_PERCENT || '10'));
      const candidateAlreadyEnriched=Number(candidate.enrichmentStage||0)>=enrichmentStage;
      // Actual request costs after the uploads-playlist optimization (1 unit
      // per list call): stage 1 = channels.list (1) + playlistItems.list (1);
      // stage 2 adds playlist search (100) + videos.list (1). Checkpoints are
      // per-invocation locals, so every stage-2 job re-runs the stage-1
      // requests first: reserve the true maximum (2 / 103), never the
      // pre-optimization 101/202 totals that could reject a 2-unit job.
      const enrichmentQuotaUnits=candidateAlreadyEnriched?0:(enrichmentStage>=2?103:2);
      let quotaReserved=false;
      let acquisitionPersisted=candidateAlreadyEnriched;
      if(!candidateAlreadyEnriched){
        quotaReserved=await tryReserveQuota({
          operationType:'ENRICH_CHANNEL',operationId:job.id,allocation:'ENRICHMENT',
          units:enrichmentQuotaUnits,dailyBudget,allocationPercent:enrichmentPercent
        });
        if(!quotaReserved)throw new QuotaAllocationExhaustedError('ENRICHMENT');
      }
      // Claim-time low-audience gate: the scheduler may have queued enrichment
      // before a numeric count was available (handle-shaped or missing stored
      // values fail open at schedule time). The enrichment allocation is
      // already reserved above, so a quota-exhausted claim never reaches the
      // 1-unit metadata fetch below. A hydrated known-low count skips
      // enrichment with the same SKIPPED_LOW_AUDIENCE projection as the
      // Phase-7 gate and releases the reservation unconsumed.
      // A stale queued candidate must not override the stored row: skip when
      // EITHER the candidate or the stored count is known-low. Hydration runs
      // only when both are unavailable.
      const claimCandidateGate = evaluateLowAudienceGate(candidate.subscriberCount ?? undefined);
      const claimStoredGate = evaluateLowAudienceGate(channel.subscriber_count ?? undefined);
      let claimAudienceGate = claimCandidateGate.shouldSkipDeepEnrichment ? claimCandidateGate : claimStoredGate;
      let claimHydrationUnits = 0;
      let claimHydrationChanged = false;
      if (claimAudienceGate.reasonCode === 'SUBSCRIBER_COUNT_UNAVAILABLE' && claimCandidateGate.reasonCode === 'SUBSCRIBER_COUNT_UNAVAILABLE') {
        const beforeSub = candidate.subscriberCount;
        const beforeDesc = candidate.description;
        const beforeLoc = candidate.locationTag;
        try {
          const hydrated = await fetchYouTubeChannelCountryMetadata(channelId, candidate);
          if (hydrated.subscriberCount && hydrated.subscriberCount !== candidate.subscriberCount) {
            candidate.subscriberCount = hydrated.subscriberCount;
            claimAudienceGate = evaluateLowAudienceGate(hydrated.subscriberCount);
          }
          if (hydrated.description) candidate.description = hydrated.description;
          if (hydrated.locationTag) candidate.locationTag = hydrated.locationTag;
          candidate.countryMetadataStatus = hydrated.countryMetadataStatus;
          candidate.countryMetadataCheckedAt = hydrated.countryMetadataCheckedAt;
          // A successful official metadata call spends 1 quota unit: attribute
          // it on skip outcomes below instead of reporting zero cost.
          if (hydrated.countryMetadataStatus === 'AVAILABLE_DECLARED' || hydrated.countryMetadataStatus === 'AVAILABLE_NOT_DECLARED') claimHydrationUnits = 1;
          // Country revalidation triggers only on creator-evidence changes
          // (hidden-subscriber hydration can still deliver new country
          // evidence via description/location); a bare metadata-status flip
          // carries no country evidence and must not trigger it.
          claimHydrationChanged =
            candidate.subscriberCount !== beforeSub ||
            candidate.description !== beforeDesc ||
            candidate.locationTag !== beforeLoc;
        } catch {
          // Hydration unavailable (no keys, quota, network): proceed fail-open.
        }
      }
      // Hydration may have upgraded an UNCERTAIN creator into a CONFIRMED
      // excluded country. Re-run the existing Gate-1 validation on the
      // hydrated candidate: a REJECTED result projects onto the row, releases
      // the reservation unconsumed, and consumes the job with zero quota
      // spend. Non-rejected results fall through unchanged (fail-open).
      if (claimHydrationChanged) {
        const claimCountryVal = await validateChannelCountry({
          channelName: candidate.channelName,
          description: candidate.description,
          videoTitles: candidate.videoTitles,
          locationTag: candidate.locationTag,
          externalLinks: candidate.channelLinks,
          metadataStatus: candidate.countryMetadataStatus,
          videoDescriptions: candidate.videoDescriptions,
          videoDescriptionsAuthoritative: candidate.videoDescriptionsAuthoritative,
          playlists: candidate.playlists,
        }, targetCountry);
        const claimCreatorCountry = claimCountryVal.detectedCreatorCountry || null;
        if (claimCountryVal.status === 'REJECTED' && claimCreatorCountry) {
          const claimNow = new Date().toISOString();
          applyGate1CountryRejectionToExisting(
            channel,
            {
              creatorCountry: claimCreatorCountry,
              score: claimCountryVal.score,
              validationStep: {
                step: 'COUNTRY_VALIDATION',
                title: `Country Validation (${claimCreatorCountry})`,
                status: 'REJECTED',
                details: `${claimCountryVal.decisionLogs}\nDetected at ENRICH_CHANNEL claim after hydration for job ${job.id}; enrichment cancelled before quota spend.`,
                timestamp: claimNow,
              },
              now: claimNow,
            },
            candidate
          );
          await upsertChannel(channel);
          if(candidateAlreadyEnriched)await finishQuotaReservation('ENRICH_CHANNEL',job.id,true);
          else if(quotaReserved)await finishQuotaReservation('ENRICH_CHANNEL',job.id,false);
          console.warn(JSON.stringify({event:'excluded_channel_blocked',channelId,targetCountry,detectedCountry:claimCreatorCountry,reason:claimCountryVal.rejectionReason,context:`enrichment_claim_hydrated:${job.id}`,timestamp:claimNow}));
          if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'SKIPPED',resultingStatus:channel.trading_status,providerCost:claimHydrationUnits,latencyMs:Date.now()-evidenceStartedAt,reasonCode:'COUNTRY_POLICY_CHANGED'}).catch(()=>undefined);
          if(investigationId&&investigationStepId)await completeInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,resultingStatus:'POLICY_REJECTED',output:{reason:'COUNTRY_POLICY_CHANGED'}});else await completeJob(job.id);
          return true;
        }
      }
      if (claimAudienceGate.shouldSkipDeepEnrichment) {
        const claimNow = new Date().toISOString();
        const claimCountText = (claimAudienceGate === claimStoredGate ? channel.subscriber_count : candidate.subscriberCount) ?? channel.subscriber_count ?? candidate.subscriberCount;
        channel.subscriber_count = claimCountText;
        channel.scan_status = 'SKIPPED_LOW_AUDIENCE';
        channel.last_checked = claimNow;
        channel.inspection_trail = [...(channel.inspection_trail || []), {
          step: 'BIO',
          title: 'Low-Audience Budget Gate',
          status: 'SKIPPED',
          details: `Subscribers: ${claimCountText} (< 30). Stored and skipped deep enrichment.`,
          timestamp: claimNow,
        }];
        await upsertChannel(channel);
        if(candidateAlreadyEnriched)await finishQuotaReservation('ENRICH_CHANNEL',job.id,true);
        else if(quotaReserved)await finishQuotaReservation('ENRICH_CHANNEL',job.id,false);
        if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'SKIPPED',resultingStatus:channel.trading_status,providerCost:claimHydrationUnits,latencyMs:Date.now()-evidenceStartedAt,reasonCode:'LOW_AUDIENCE_SKIP'}).catch(()=>undefined);
        if(investigationId&&investigationStepId)await completeInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,resultingStatus:channel.trading_status,output:{reason:'LOW_AUDIENCE_SKIP'}});else await completeJob(job.id);
        return true;
      }
      try {
        const enriched=candidateAlreadyEnriched?candidate:await fetchYouTubeChannelEnrichment(channelId,candidate,enrichmentStage,async additionalUnits=>{
          const toppedUp=await topUpQuotaReservation({
            operationType:'ENRICH_CHANNEL',operationId:job.id,allocation:'ENRICHMENT',
            additionalUnits,dailyBudget,allocationPercent:enrichmentPercent
          });
          if(!toppedUp)throw new QuotaAllocationExhaustedError('ENRICHMENT');
        });
        if(!candidateAlreadyEnriched){
          const db=await getDb();
          await db.query(`UPDATE jobs SET payload=jsonb_set(payload,'{candidate}',$2::jsonb,true),updated_at=now() WHERE id=$1`,[job.id,JSON.stringify(enriched)]);
          acquisitionPersisted=true;
          await finishQuotaReservation('ENRICH_CHANNEL',job.id,true);
          quotaReserved=false;
        } else {
          // Idempotently reconcile a reservation left RESERVED if a prior worker
          // crashed after persisting the paid enrichment payload.
          await finishQuotaReservation('ENRICH_CHANNEL',job.id,true);
        }
        const pipelineOutcome=await processChannelThroughPipeline(enriched,targetCountry,source,false,true,{forceExtraction:isRepairEligibleRetry(job),jobId:job.id,runId:typeof job.payload.queryRunId==='string'?job.payload.queryRunId:undefined});
        if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'SUCCEEDED',resultingStatus:pipelineOutcome.tradingStatus,providerCost:enrichmentQuotaUnits,latencyMs:Date.now()-evidenceStartedAt,reasonCode:pipelineOutcome.tradingStatus==='UNCERTAIN'||pipelineOutcome.tradingStatus==='NEEDS_REVIEW'?'EVIDENCE_DID_NOT_RESOLVE':'DECISION_RESOLVED'}).catch(()=>undefined);
        if(quotaReserved)await finishQuotaReservation('ENRICH_CHANNEL',job.id,true);
        if(investigationId&&investigationStepId)await completeInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,resultingStatus:pipelineOutcome.tradingStatus,output:{channelId:pipelineOutcome.channelId,tradingStatus:pipelineOutcome.tradingStatus,countryStatus:pipelineOutcome.countryStatus}});else await completeJob(job.id);
      } catch (error) {
        if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'FAILED',providerCost:0,latencyMs:Date.now()-evidenceStartedAt,reasonCode:'PROVIDER_OR_PIPELINE_FAILURE'}).catch(()=>undefined);
        if(quotaReserved)await finishQuotaReservation('ENRICH_CHANNEL',job.id,acquisitionPersisted);
        throw error;
      }
      return true;
    }

    const { query, country, source, queryRunId, queryId, retrievalLane = 'VIDEO', searchOrdering = 'RELEVANCE', pageNumber = 1, pageToken = null, retrievalConfigKey = null, retrievalTreatmentOrigin = 'CONTROL', requestedPageDepth = 1, trial = null, searchWindow = null } = job.payload as {
      query: string; country: string; source: DiscoverySource; queryRunId?: string; queryId?: number; retrievalLane?: RetrievalLane; searchOrdering?: import('./searchOrdering').SearchOrdering; pageNumber?:number; pageToken?:string|null; retrievalConfigKey?: string | null; retrievalTreatmentOrigin?: string; requestedPageDepth?: number;provider?:ProviderAllocation;
      trial?: { trialId?: string; trialKey?: string; proposalId?: string; quotaReserved?: number; status?: string } | null;
      searchWindow?: { publishedAfter?: string; publishedBefore?: string; experimentId?: string } | null;
    };
    // Defense in depth for jobs queued before a country was excluded.
    await assertCountryAllowed(country, `worker:${job.id}`);
    // Latency attribution (observability only): split worker wall time into
    // quota-wait vs retrieval vs per-channel processing so slowdown triage
    // reads queue/quota waiting apart from actual processing latency.
    const searchWorkerStartMs = Date.now();
    let searchQuotaWaitMs = 0;
    let searchRetrievalGrossMs = 0;
    let searchTopUpWaitMs = 0;

    // Execution-time query authority revalidation: every non-manual search job
    // must satisfy the current retrieval-policy before YouTube quota is spent.
    let authorityQueryRecord: Awaited<ReturnType<typeof getQueryById>> = null;
    if (source !== 'manual_search') {
      authorityQueryRecord = queryId
        ? await getQueryById(queryId)
        : (await getQueriesByCountry(country)).find(q => q.query.toLowerCase() === query.toLowerCase()) || null;
      if (authorityQueryRecord) {
        // Persistent-scope promotion is re-resolved live: a stored
        // PERSISTENT_SCOPE_SELECTION marker authorizes only while the country
        // is still selected (deselection restores dormant behavior, and
        // reselection restores sweeping without burning stored queries).
        // DIRECT_TARGET markers authorize their explicitly ordered one-shot
        // work for its lifetime so in-flight manual jobs can complete. The
        // live scope read happens only for scope-promoted jobs (either basis,
        // including legacy markers without a basis): ordinary jobs skip the
        // settings read entirely, so a malformed/unavailable scope
        // configuration can never burn their attempts before retrieval. A
        // scope-read failure for a promoted job errors the attempt (fail
        // closed, retryable) rather than spending quota on a stale assumption.
        const recordMetadata = (authorityQueryRecord as { generation_metadata?: unknown }).generation_metadata;
        let scopePromotionActive: boolean | undefined;
        if (isScopePromotedRecord(recordMetadata)) {
          const liveScope = await getDiscoveryScope();
          scopePromotionActive =
            resolveScopePromotionForScope(liveScope, country) != null;
        }
        const queryAuthority = evaluateAutonomousQueryAuthority(authorityQueryRecord, {
          scopePromotionActive,
        });
        if (!queryAuthority.eligible) {
          console.log(`[Unified Query Authority] Withheld automated search job ${job.id} for "${query}" (${country}) before spending YouTube quota: ${queryAuthority.reasonCodes.join(', ')}.`);
          if (queryRunId) await failQueryRun(queryRunId, new Error(`Query authority withheld: ${queryAuthority.reasonCodes.join(', ')}`), true);
          await completeJob(job.id);
          return true;
        }
      } else {
        console.log(`[Unified Query Authority] Withheld automated search job ${job.id} for "${query}" (${country}) before spending YouTube quota: QUERY_PROVENANCE_RECORD_MISSING.`);
        if (queryRunId) await failQueryRun(queryRunId, new Error('Query authority missing: QUERY_PROVENANCE_RECORD_MISSING'), true);
        await completeJob(job.id);
        return true;
      }
    }
    const vocabs = await getCountryVocabularies();
    const vocab = vocabs.find(v => v.country.toLowerCase() === country.toLowerCase());
    if (queryRunId) {
      const started = await startQueryRun(queryRunId);
      if (!started) { await completeJob(job.id); return true; }
    }
    if (queryRunId && pageNumber > 1 && await autonomousPageExists(queryRunId,pageNumber)) { await completeJob(job.id); return true; }

    const autonomousOperationId=queryRunId?`${queryRunId}:${pageNumber}`:'';
    let providerQuotaUnits = 0;
    let providerCostUsd = 0;
    let providerPricingVersion = 'UNVERSIONED';
    let providerRequestsAttempted = 0;
    let providerRequestsSucceeded = 0;
    let providerRequestsFailed = 0;
    let providerRateLimited = 0;
    let providerPagesRetrieved = 0;
    let searchPage: { channels: DiscoveredChannelRaw[]; rawResultCount: number; nextPageToken?: string | null; providerCostUsd?: number; providerRequestId?: string } | null = null;
    let allocatedProvider: ProviderAllocation = YOUTUBE_SEARCH_PROVIDER;
    let braveProvider = false;
    let quotaFreeInnertubeProvider = false;
    if (queryRunId) {
      allocatedProvider=providerSnapshot(job.payload.provider||YOUTUBE_SEARCH_PROVIDER);
      const lineage=await (await getDb()).query(`SELECT provider_allocation_snapshot FROM query_runs WHERE id=$1`,[queryRunId]);
      if(!lineage.rowCount)throw new Error('PHASE9_PROVIDER_LINEAGE_MISSING');
      const dbProvider=providerSnapshot(lineage.rows[0].provider_allocation_snapshot);
      if(dbProvider.providerKey!==allocatedProvider.providerKey||dbProvider.retrievalSurface!==allocatedProvider.retrievalSurface||dbProvider.capability!==allocatedProvider.capability||dbProvider.costDomain!==allocatedProvider.costDomain||dbProvider.continuationOwner!==allocatedProvider.continuationOwner)throw new Error('PHASE9_PROVIDER_LINEAGE_MISMATCH');
      braveProvider=allocatedProvider.costDomain==='BRAVE_SEARCH_API';
      // YouTube.js (InnerTube) is quota-free and cost-free: it must never
      // reserve official YouTube quota units nor accrue USD ledger spend.
      // It shares the quota-free execution path with Brave but keeps its own
      // provider key, cost domain, cooldown, and telemetry throughout.
      quotaFreeInnertubeProvider=allocatedProvider.costDomain==='YOUTUBE_INNERTUBE_FREE';
      let providerRequestId: string | null = null;
      const quotaWaitStartMs = Date.now();
      if(braveProvider){
        providerRequestId=`${autonomousOperationId}:provider-request`;
        const reservation = await reserveProviderRequest({provider:allocatedProvider,requestId:providerRequestId,queryRunId});
        providerPricingVersion = reservation.pricingVersion;
        providerRequestsAttempted=1;
      } else if(!quotaFreeInnertubeProvider){
        providerQuotaUnits=100;
        const budget=getDailyYouTubeQuotaBudget();
        const percent=Number(await getAppSetting('discovery_autonomous_quota_percent','70'));
        if(!await tryReserveQuota({operationType:'AUTONOMOUS_QUERY_PAGE',operationId:autonomousOperationId,allocation:'AUTONOMOUS',units:providerQuotaUnits,dailyBudget:budget,allocationPercent:percent})){
          // A denied page is deferred, never completed or failed: the run keeps
          // its page number and next-page cursor for the reconciler. Persist
          // the provider's resume mode first, otherwise a page-1 deferral has
          // no cursor mode and the reconciler cannot recover it.
          await updateQueryRunProgress(queryRunId, { resumeMode: resumeModeForProvider(allocatedProvider.providerKey) }).catch(() => undefined);
          await deferAutonomousRunForQuota(queryRunId, 'AUTONOMOUS_QUERY_PAGE quota reservation denied');
          await completeJob(job.id);
          return true;
        }
      }
      searchQuotaWaitMs += Date.now() - quotaWaitStartMs;
      try {
        const providerRequestBaseId = buildProviderRequestBaseId({queryRunId,jobId:job.id,jobAttempt:job.attempts,pageNumber});
        const queryMetadata = authorityQueryRecord?.generation_metadata || {};
        const preferredLanguage = preferredLanguageFromQueryMetadata(queryMetadata);
        const retrievalStartMs = Date.now();
        try {
          searchPage=await executeAllocatedRetrievalPage({provider:allocatedProvider,query,country,vocabulary:vocab,queryRunId,requestId:providerRequestBaseId,jobId:job.id,preferredLanguage,lane:retrievalLane,cursor:pageToken,ordering:searchOrdering,searchWindow:resolveExecutionSearchWindow(searchWindow),reserveAdditionalUnits:async additionalUnits=>{
            if(braveProvider||quotaFreeInnertubeProvider) return;
            const topUpStartMs = Date.now();
            const budget=getDailyYouTubeQuotaBudget();
            const percent=Number(await getAppSetting('discovery_autonomous_quota_percent','70'));
            const toppedUp=await topUpQuotaReservation({operationType:'AUTONOMOUS_QUERY_PAGE',operationId:autonomousOperationId,allocation:'AUTONOMOUS',additionalUnits,dailyBudget:budget,allocationPercent:percent});
            searchTopUpWaitMs += Date.now() - topUpStartMs;
            if(!toppedUp)throw new QuotaAllocationExhaustedError('AUTONOMOUS');
          },priority:'autonomous'});
        } finally {
          // Failed retrieval attempts are retrieval wall time too: attribute
          // them even when the call throws into the handler below.
          searchRetrievalGrossMs += Date.now() - retrievalStartMs;
        }
        if(braveProvider){
          providerRequestsSucceeded=1; providerPagesRetrieved=1; providerCostUsd=Number(searchPage.providerCostUsd ?? 0);
          await settleProviderRequest(providerRequestId!, 'SUCCEEDED', providerCostUsd);
          await (await getDb()).query(`UPDATE query_runs SET provider_cost_usd=provider_cost_usd+$2,provider_pricing_version=$3,provider_requests_attempted=provider_requests_attempted+1,provider_requests_succeeded=provider_requests_succeeded+1,provider_pages_retrieved=provider_pages_retrieved+1 WHERE id=$1`,[queryRunId,providerCostUsd,providerPricingVersion]);
        } else if(!quotaFreeInnertubeProvider) await finishQuotaReservation('AUTONOMOUS_QUERY_PAGE',autonomousOperationId,true);
      } catch (error:any) {
        if (queryRunId && String(error?.code || '').toUpperCase() === INNERTUBE_TIMEOUT_CODE) {
          // The page deadline is resumable: no page observation is written,
          // the run keeps its page number/token, and the reconciler retries
          // after the short time deferral instead of failing the whole run.
          // APPROVED LIMITATION (P14): youtubei.js exposes no partial feed, so
          // a timed-out page-N cannot be persisted; earlier pages remain
          // durable and the run resumes via REWALK. Never write a fabricated
          // empty observation for the timed-out page.
          if (!braveProvider && !quotaFreeInnertubeProvider) {
            await finishQuotaReservation('AUTONOMOUS_QUERY_PAGE', autonomousOperationId, false);
          }
          await updateQueryRunProgress(queryRunId, { resumeMode: resumeModeForProvider(allocatedProvider.providerKey) }).catch(() => undefined);
          await deferAutonomousRunForTime(queryRunId, String(error?.message || INNERTUBE_TIMEOUT_CODE));
          await completeJob(job.id);
          return true;
        }
        if (queryRunId && error instanceof QuotaAllocationExhaustedError) {
          if (!braveProvider && !quotaFreeInnertubeProvider) {
            await finishQuotaReservation('AUTONOMOUS_QUERY_PAGE', autonomousOperationId, false);
          }
          await updateQueryRunProgress(queryRunId, { resumeMode: resumeModeForProvider(allocatedProvider.providerKey) }).catch(() => undefined);
          await deferAutonomousRunForQuota(queryRunId, String(error?.message || 'QUOTA_ALLOCATION_EXHAUSTED'));
          await completeJob(job.id);
          return true;
        }
        if(braveProvider){
          const rateLimited=String(error?.code||'').toUpperCase()==='BRAVE_API_RATE_LIMIT_429';
          if(rateLimited)providerRateLimited=1; else providerRequestsFailed=1;
          await settleProviderRequest(providerRequestId!, rateLimited?'RATE_LIMITED':'FAILED', 0, String(error?.code||error?.message||'PROVIDER_FAILURE'));
          await (await getDb()).query(`UPDATE query_runs SET provider_requests_attempted=provider_requests_attempted+1,provider_requests_failed=provider_requests_failed+$2,provider_rate_limited=provider_rate_limited+$3 WHERE id=$1`,[queryRunId,rateLimited?0:1,rateLimited?1:0]);
          if(rateLimited&&Number(error?.retryAfterMs)>0) await setAppSetting('brave_cooldown_until',new Date(Date.now()+Number(error.retryAfterMs)).toISOString()).catch(()=>undefined);
        } else if(!quotaFreeInnertubeProvider) await finishQuotaReservation('AUTONOMOUS_QUERY_PAGE',autonomousOperationId,false);
        throw error;
      }
    }
    // Quota-free providers never fall back to the official YouTube API: an
    // empty InnerTube page is an honest empty result, not a trigger to spend
    // official quota. (The legacy official path keeps its existing behavior.)
    // The legacy official fallback is retrieval wall time like any provider.
    const fallbackStartMs = Date.now();
    let extracted: DiscoveredChannelRaw[] = [];
    try {
      extracted = searchPage?.channels || (quotaFreeInnertubeProvider ? [] : await searchYouTubeChannels(query, country, vocab, retrievalLane));
    } finally {
      searchRetrievalGrossMs += Date.now() - fallbackStartMs;
    }
    const distinctExtracted = [...new Map(extracted.map(channel => [channel.channelId, channel])).values()];
    const queryRecord=queryId?await getQueryById(queryId):null;
    const observations: QueryObservation[] = [];
    const sightings = [];
    const deferredChannelIds = new Set<string>();
    const channelLoopStartMs = Date.now();
    for (const [index, raw] of distinctExtracted.entries()) {
      // A durable nomination is written before channel processing. When the
      // ledger is OFF, legacy channel_sightings remain the compatibility path.
      const nomination=await recordNomination({channelId:raw.channelId,sourceType:source,queryId,queryRunId,jobId:job.id,
        queryCatalogVersion:typeof job.payload.catalogPin?.checksum==='string'?job.payload.catalogPin.checksum:undefined,
        query,querySemanticClasses:queryRecord?.intent?[queryRecord.intent]:[],queryGenerationMode:queryRecord?.generation_mode,
        country,declaredLanguage:raw.detectedLanguages?.[0]?.language,retrievalLane,searchOrdering,pageNumber,resultRank:index+1,
        matchedDocument:raw.matchedDocument||{type:'UNKNOWN'},rawObservation:{channelName:raw.channelName,youtubeUrl:raw.youtubeUrl,locationTag:raw.locationTag||null}},'INVESTIGATION_QUEUED');
      raw.nominationId=nomination.id||undefined;raw.queryRunId=queryRunId;raw.queryPageNumber=pageNumber;raw.discoveryJobId=job.id;
      const outcome = await processDiscoveredChannelContained(raw, country, source, { forceExtraction: isRepairEligibleRetry(job) });
      // A sticky-PROBE channel refused by its own allocation is deferred for
      // this run; the rest of the NORMAL page must still be processed. Keep it
      // out of yield/duplicate math: it was not evaluated, and counting it as
      // a duplicate can stop pagination before later normal results.
      if (!outcome) { deferredChannelIds.add(raw.channelId); continue; }
      const funnelOutcome: FunnelOutcome = outcome.countryStatus === 'REJECTED'
        ? 'COUNTRY_REJECTED'
        : outcome.tradingStatus === 'HUMAN_REJECTED' ? 'NON_TRADING' : outcome.tradingStatus;
      const qualityScore = outcome.channelRecord?.quality_score || 0;
      const hasCommunity = outcome.discordStatus === 'ACTIVE' || outcome.discordStatus === 'ACTIVE_LOW_VOLUME';
      observations.push({ channelId: outcome.channelId, wasKnown: outcome.wasKnown, persisted: outcome.persisted, funnelOutcome, qualityScore, hasCommunity, scopeEligibility: resolveScopeEligibility(outcome.channelRecord?.country ?? outcome.detectedCountry ?? null) });
      sightings.push({
        channelId: outcome.channelId, resultRank: index + 1, searchLane: retrievalLane, wasKnown: outcome.wasKnown, persisted: outcome.persisted,
        countryOutcome: outcome.countryStatus, tradingOutcome: outcome.tradingStatus, funnelOutcome,
        metadata: {
          channelName: outcome.channelName,
          source,
          country,
          targetCountry: country,
          detectedCountry: outcome.detectedCountry || outcome.channelRecord?.country || raw.locationTag || null,
          rejectionReason: outcome.countryStatus === 'REJECTED' ? (outcome.rejectionReason || outcome.channelRecord?.inspection_trail?.find(t => t.step === 'COUNTRY_VALIDATION')?.details || undefined) : undefined,
          retrievalLane,
          searchOrdering
        }
      });
    }
    const channelLoopEndMs = Date.now();
    const deferredResults = countDeferredRawResults(
      extracted.map(channel => channel.channelId),
      deferredChannelIds,
    );
    if (queryRunId && queryId) {
      const queryRecord = await getQueryById(queryId);
      if (!queryRecord) throw new Error(`Query ${queryId} no longer exists for run ${queryRunId}.`);
      const metrics = calculateQueryFunnel(searchPage?.rawResultCount ?? extracted.length, observations, deferredResults);
      await recordQueryRunSightings(queryRunId, queryId, sightings.map(s=>({...s,pageNumber})));
      const safetyMaxPages = Math.max(1, Number(await getAppSetting('autonomous_pagination_max_pages', '50')));
      const maxLow = Math.max(1, Number(await getAppSetting('autonomous_pagination_max_low_yield_pages', '2')));
      const maxDuplicate = Math.max(1, Number(await getAppSetting('autonomous_pagination_max_duplicate_pages', '2')));
      const maxWrongCountry = Math.max(1, Number(await getAppSetting('autonomous_pagination_max_wrong_country_pages', '2')));
      const explorationSetting = Math.max(0, Number(await getAppSetting('autonomous_pagination_exploration_pages', '1')));
      const minRunPages = Math.max(0, Number(await getAppSetting('autonomous_pagination_min_run_pages', '1')));
      const v2Enabled = await getAppSetting('autonomous_pagination_v2_enabled', 'true') === 'true';
      const enabled = await getAppSetting('autonomous_pagination_enabled', 'true') === 'true';
      // CDL master switch: turning it off must stop new continuation work
      // without requiring every pagination sub-flag to be flipped too.
      const cdlEnabled = await getAppSetting('country_discovery_loop_enabled', 'true') === 'true';
      const continuationEnabled = enabled && cdlEnabled;
      const providerKey = allocatedProvider.providerKey;
      const providerMaxPages = providerPageCap(providerKey, safetyMaxPages);
      const pageCostUnits = providerQuotaUnits;
      const treatmentCapPages = retrievalTreatmentOrigin === 'CANARY_TREATMENT'
        ? Math.min(requestedPageDepth ?? 1, safetyMaxPages)
        : null;
      // Opt-in trial budget bound: trial-linked execution cannot outspend
      // its reservation (100 units/page official methodology unchanged).
      // Free providers spend nothing and need no bound. Absent on legacy.
      const trialQuotaReserved = typeof trial?.quotaReserved === 'number' ? trial.quotaReserved : null;
      const trialCapPages = trial?.trialId && trialQuotaReserved !== null && pageCostUnits > 0
        ? trialContinuationCap(safetyMaxPages, trialQuotaReserved)
        : null;
      const progress = await getQueryRunProgress(queryRunId);
      const activeCountries = await countActiveAutonomousCountries();
      const quotaAvailability = await getAutonomousQuotaAvailability();
      const budget = computeEffectivePageBudget({
        safetyMaxPages,
        providerMaxPages,
        pageCostUnits,
        // getAutonomousQuotaAvailability subtracts this run's scheduled page
        // reservation. The run budget below includes the current page in
        // consumedAfterPage, so add the current page back; otherwise page one
        // is charged twice and the continuation is underfunded by one page.
        remainingAutonomousQuota: quotaAvailability.remainingAutonomousQuota + pageCostUnits,
        pendingCountries: activeCountries,
        minRunPages,
        treatmentCapPages,
        trialContinuationCap: trialCapPages,
      });
      const storedEffectiveMaxPages = progress?.effectiveMaxPages || 0;
      const effectiveMaxPages = storedEffectiveMaxPages || budget.effectiveMaxPages;
      const runQuotaBudgetUnits = progress?.runQuotaBudgetUnits || budget.runQuotaBudgetUnits;
      const explorationPagesRemaining = storedEffectiveMaxPages
        ? Math.max(0, progress?.explorationPagesRemaining || 0)
        : explorationSetting;
      // The first-page bound is authoritative for the run. Recomputing it from
      // live quota would let a mid-run quota change mislabel a stored safety
      // ceiling as RUN_BUDGET (and skip the linked continuation segment).
      const bindingBound = storedEffectiveMaxPages
        ? (progress?.effectiveBindingBound || budget.bindingBound)
        : budget.bindingBound;
      if (!storedEffectiveMaxPages) {
        await updateQueryRunProgress(queryRunId, {
          effectiveMaxPages,
          effectiveBindingBound: bindingBound,
          runQuotaBudgetUnits,
          explorationPagesRemaining,
          resumeMode: resumeModeForProvider(providerKey),
        });
      }
      const prior = await getAutonomousContinuationState(queryRunId, pageNumber);
      const marginal = await getAutonomousPageMarginalMetrics(queryRunId, pageNumber);
      const novelCandidateTerms = await countNovelCandidateTermsForPage(
        queryRunId,
        pageNumber,
        new Date(searchWorkerStartMs),
      );
      const evaluatedRawResults = metrics.evaluatedRawResults ?? metrics.rawResults;
      const duplicateRatio = evaluatedRawResults > 0
        ? metrics.duplicateResults / evaluatedRawResults
        : metrics.deferredResults ? 0 : 1;
      const consumedAfterPage = (progress?.runQuotaConsumedUnits || 0) + providerQuotaUnits;
      const nextPageQuotaAdmitted = pageCostUnits === 0
        ? true
        : runQuotaBudgetUnits > 0 && consumedAfterPage + pageCostUnits <= runQuotaBudgetUnits;
      const runBudgetExhausted = pageCostUnits > 0
        && (runQuotaBudgetUnits <= 0 || consumedAfterPage + pageCostUnits > runQuotaBudgetUnits);
      const decisionV2 = evaluateContinuationV2({
        pageNumber,
        effectiveMaxPages,
        ceilingBound: bindingBound,
        hasNextPage: !!searchPage?.nextPageToken,
        providerExhausted: (providerKey === 'youtube-innertube' || providerKey === 'brave-search')
          && !searchPage?.nextPageToken
          && pageNumber >= providerMaxPages,
        distinctCreators: metrics.distinctResults,
        cumulativeDistinctCreators: marginal.cumulativeUniqueCreators,
        newCreators: marginal.marginalNewCreators,
        pageConfirmedCreators: marginal.marginalConfirmedCreators,
        pageQualityCreators: marginal.marginalQualityCreators,
        pageNonTradingCreators: marginal.marginalNonTradingCreators,
        novelCandidateTerms,
        countryPrecision: metrics.countryPrecision,
        communityDiversity: metrics.tradingConfirmed ? metrics.communitiesDiscovered / metrics.tradingConfirmed : 0,
        duplicateRatio,
        priorLowValueStreak: prior.v2Streaks.lowValue,
        priorDuplicateHeavyStreak: prior.v2Streaks.duplicateHeavy,
        priorWrongCountryStreak: prior.v2Streaks.wrongCountry,
        maxLowValuePages: maxLow,
        maxDuplicateHeavyPages: maxDuplicate,
        maxWrongCountryPages: maxWrongCountry,
        explorationPagesRemaining,
        queryMode: (queryRecord as { generation_mode?: 'EXPLORATION' | 'EXPLOITATION' | 'COLD_START' }).generation_mode,
        deferredOnly: observations.length === 0 && deferredResults > 0,
        nextPageQuotaAdmitted,
        runBudgetExhausted,
      });
      const legacyDecision = v2Enabled ? null : evaluateContinuation({
        pageNumber, maxPages: Math.min(effectiveMaxPages, treatmentCapPages ?? effectiveMaxPages, trialCapPages ?? effectiveMaxPages),
        hasNextPage: !!searchPage?.nextPageToken,
        distinctCreators: metrics.distinctResults,
        cumulativeDistinctCreators: prior.cumulativeDistinctCreators,
        newCreators: metrics.newChannels, confirmedCreators: metrics.tradingConfirmed,
        qualityConfirmedCreators: metrics.qualityChannels,
        delayedConfirmedCreators: prior.delayedConfirmedCreators,
        delayedNonTradingCreators: prior.delayedNonTradingCreators,
        delayedQualityCreators: prior.delayedQualityCreators,
        countryPrecision: metrics.countryPrecision,
        communityDiversity: metrics.tradingConfirmed ? metrics.communitiesDiscovered / metrics.tradingConfirmed : 0,
        duplicateRatio,
        consecutiveLowYieldPages: prior.consecutiveLowYieldPages,
        maxConsecutiveLowYieldPages: maxLow,
        deferredOnly: observations.length === 0 && deferredResults > 0,
      });
      const decision = v2Enabled ? decisionV2 : legacyDecision!;
      const usingV2 = v2Enabled;
      const deferDecision = usingV2 && decisionV2.defer;
      const stoppingReason = deferDecision
        ? decisionV2.primaryReason
        : decision.shouldContinue ? null : decision.primaryReason;
      const pageObservation = {
        queryRunId, pageNumber, inputPageToken: pageToken, nextPageToken: searchPage?.nextPageToken || null,
        retrievalLane, searchOrdering, rawResultCount: metrics.rawResults,
        distinctCreatorCount: metrics.distinctResults, knownCreators: metrics.knownChannels,
        newCreators: metrics.newChannels, confirmedCreators: metrics.tradingConfirmed,
        qualityConfirmedCreators: metrics.qualityChannels, averageQualityScore: metrics.averageQualityScore,
        countryPrecision: metrics.countryPrecision,
        communityDiversity: metrics.tradingConfirmed ? metrics.communitiesDiscovered / metrics.tradingConfirmed : 0,
        noveltyRatio: metrics.noveltyRatio,
        duplicateRatio,
        quotaUnits: providerQuotaUnits, decision, stoppingReason,
        pageMetrics: { ...metrics, cumulativeCountryRejected: marginal.cumulativeCountryRejected },
        retrievalConfigKey, retrievalTreatmentOrigin,
        elapsedMs: Date.now() - searchWorkerStartMs,
        retrievalMs: searchRetrievalGrossMs,
        processingMs: channelLoopEndMs - channelLoopStartMs,
        marginalNewCreators: marginal.marginalNewCreators,
        marginalConfirmedCreators: marginal.marginalConfirmedCreators,
        marginalQualityCreators: marginal.marginalQualityCreators,
        marginalNonTradingCreators: marginal.marginalNonTradingCreators,
        novelCandidateTerms,
        crossPageRepeatCreators: marginal.crossPageRepeatCreators,
        cumulativeUniqueCreators: marginal.cumulativeUniqueCreators,
        providerPageCostUnits: providerQuotaUnits,
        providerPageCostUsd: providerCostUsd,
        relevance: {
          countryPrecision: metrics.countryPrecision,
          tradingPrecision: metrics.tradingPrecision,
          qualityShare: metrics.distinctResults ? metrics.qualityChannels / metrics.distinctResults : 0,
        },
        marginalUtilityV2: usingV2 ? decisionV2.marginalUtility : decision.marginalUtility,
        continuationDecisionV2: usingV2 ? decisionV2 : null,
        resumeMode: resumeModeForProvider(providerKey),
        deferredReason: usingV2 ? decisionV2.deferReason : null,
      };
      await recordAutonomousPage(pageObservation);
      try{await recordPassivePage({query,jobId:job.id,observation:pageObservation});}catch(shadowError){console.error('[Phase 5 shadow] Passive page write failed.',shadowError);await recordShadowFailure({queryRunId,jobId:job.id,stage:'PAGE_OUTCOME',error:shadowError}).catch(()=>undefined);}
      if (deferDecision) {
        if (decisionV2.deferReason === 'QUOTA') await deferAutonomousRunForQuota(queryRunId, decisionV2.primaryReason);
        else await deferAutonomousRunForTime(queryRunId, decisionV2.primaryReason);
        await completeJob(job.id);
        return true;
      }
      if (continuationEnabled && decision.shouldContinue && searchPage?.nextPageToken) {
        let incPageReservationId: string | undefined;

        // Incremental Treatment Page Quota Reservation Boundary
        if (retrievalTreatmentOrigin === 'CANARY_TREATMENT' && pageNumber >= 1) {
          const incRes = await reserveIncrementalTreatmentPageQuota({ queryRunId, pageNumber: pageNumber + 1, providerQuotaUnits: allocatedProvider.costDomain==='YOUTUBE_INNERTUBE_FREE' ? 0 : 100 });
          if (!incRes.authorized) {
            console.log(`[Phase 9 Continuation] Incremental page continuation denied by treatment quota caps for run ${queryRunId}: ${incRes.reason}`);
            await completeJob(job.id);
            return true;
          }
          incPageReservationId = incRes.pageReservationId;
        }

        await updateQueryRunProgress(queryRunId, {
          nextPageToken: searchPage.nextPageToken,
          resumeMode: resumeModeForProvider(providerKey),
          continuationStatus: 'RUNNING',
          lastPageAt: new Date().toISOString(),
          explorationPagesRemaining: usingV2 ? decisionV2.explorationPagesRemaining : explorationPagesRemaining,
        });

        // Atomic child job enqueue + page reservation commit
        await enqueueChildAndCommitPageReservation({
          pageReservationId: incPageReservationId,
          queryRunId,
          jobType: 'SEARCH_YOUTUBE',
          jobPayload: {
            ...job.payload,
            pageNumber: pageNumber + 1,
            pageToken: searchPage.nextPageToken
          },
          priority: AUTONOMOUS_CONTINUATION_JOB_PRIORITY,
          maxAttempts: 3,
          idempotencyKey: `search-run:${queryRunId}:page:${pageNumber + 1}`
        });

        await completeJob(job.id);
        return true;
      }
      const finalMetrics=await getAutonomousRunMetrics(queryRunId);
      if (job.payload.provider?.costDomain === 'BRAVE_SEARCH_API') {
        const providerTotals = await (await getDb()).query(`SELECT provider_cost_usd,provider_requests_attempted,provider_requests_succeeded,provider_requests_failed,provider_rate_limited,provider_pages_retrieved FROM query_runs WHERE id=$1`, [queryRunId]);
        const totals = providerTotals.rows[0] || {};
        providerCostUsd = Number(totals.provider_cost_usd || providerCostUsd);
        providerRequestsAttempted = Number(totals.provider_requests_attempted || providerRequestsAttempted);
        providerRequestsSucceeded = Number(totals.provider_requests_succeeded || providerRequestsSucceeded);
        providerRequestsFailed = Number(totals.provider_requests_failed || providerRequestsFailed);
        providerRateLimited = Number(totals.provider_rate_limited || providerRateLimited);
        providerPagesRetrieved = Number(totals.provider_pages_retrieved || providerPagesRetrieved);
      }
      let providerRunOutcome: ProviderRunOutcome | undefined;
      if (allocatedProvider.providerKey === 'youtube-innertube' && queryRunId) {
        // InnerTube telemetry lives under its own provider name so the
        // official provider's run stats stay pure; same outcome math.
        // Checked BEFORE the official branch: the official predicate below
        // (`!== 'brave-search'`) also matches innertube and would otherwise
        // shadow this branch and zero out real InnerTube counts.
        const providerCounts = await (await getDb()).query(`SELECT COUNT(*)::int AS attempted, COUNT(*) FILTER (WHERE status='SUCCESS')::int AS succeeded, COUNT(*) FILTER (WHERE status NOT IN ('SUCCESS','RATE_LIMITED'))::int AS failed, COUNT(*) FILTER (WHERE status='RATE_LIMITED')::int AS rate_limited FROM provider_call_events WHERE run_id=$1::text AND provider='youtube-innertube' AND operation='search'`, [queryRunId]);
        const counts = providerCounts.rows[0] || {};
        providerRequestsAttempted = Number(counts.attempted || 0);
        providerRequestsSucceeded = Number(counts.succeeded || 0);
        providerRequestsFailed = Number(counts.failed || 0);
        providerRateLimited = Number(counts.rate_limited || 0);
        providerPagesRetrieved = providerRequestsSucceeded;
        providerRunOutcome = resolveInnertubeRunOutcome({
          rawResults: finalMetrics.rawResults,
          providerRequestsAttempted,
          providerRequestsSucceeded,
          providerRequestsFailed,
          providerRateLimited
        });
      } else if (allocatedProvider.providerKey !== 'brave-search' && queryRunId) {
        const providerCounts = await (await getDb()).query(`SELECT COUNT(*)::int AS attempted, COUNT(*) FILTER (WHERE status='SUCCESS')::int AS succeeded, COUNT(*) FILTER (WHERE status NOT IN ('SUCCESS','RATE_LIMITED'))::int AS failed, COUNT(*) FILTER (WHERE status='RATE_LIMITED')::int AS rate_limited FROM provider_call_events WHERE run_id=$1::text AND provider='youtube' AND operation='search'`, [queryRunId]);
        const counts = providerCounts.rows[0] || {};
        providerRequestsAttempted = Number(counts.attempted || 0);
        providerRequestsSucceeded = Number(counts.succeeded || 0);
        providerRequestsFailed = Number(counts.failed || 0);
        providerRateLimited = Number(counts.rate_limited || 0);
        providerPagesRetrieved = providerRequestsSucceeded;
        providerRunOutcome = classifyProviderRunOutcome({
          rawResults: finalMetrics.rawResults,
          providerRequestsAttempted,
          providerRequestsSucceeded,
          providerRequestsFailed,
          providerRateLimited
        });
      } else if (allocatedProvider.providerKey === 'brave-search') {
        providerRunOutcome = classifyProviderRunOutcome({
          rawResults: finalMetrics.rawResults,
          providerRequestsAttempted,
          providerRequestsSucceeded,
          providerRequestsFailed,
          providerRateLimited
        });
      }
      const quotaConsumed=providerCostUsd>0||allocatedProvider.costDomain==='YOUTUBE_INNERTUBE_FREE'?0:pageNumber*100;
      const performance = await evaluateQueryPerformance(queryRecord, finalMetrics, { retrievalLane, searchOrdering, quotaConsumed, persist: false });
      // Worker wall-time split (observability only, persisted in
      // performance_details): quota-wait vs retrieval vs per-channel
      // processing vs total worker time. Never affects scoring or behavior.
      const latencyBreakdownMs = buildSearchLatencyBreakdownMs(searchWorkerStartMs, searchQuotaWaitMs, searchRetrievalGrossMs, searchTopUpWaitMs, channelLoopStartMs, channelLoopEndMs, Date.now());
      await completeQueryRun(queryRunId, {
        ...finalMetrics,
        uniqueChannels: finalMetrics.newChannels,
        qualityChannels: finalMetrics.qualityChannels,
        communitiesDiscovered: finalMetrics.communitiesDiscovered,
        quotaUsed: quotaConsumed,
        providerCostUsd,
        providerRequestsAttempted,
        providerRequestsSucceeded,
        providerRequestsFailed,
        providerRateLimited,
        providerPagesRetrieved,
        providerRunOutcome,
        averageQualityScore: finalMetrics.averageQualityScore,
        performanceScore: performance.performanceScore,
        newCollection: performance.newCollection,
        latencyBreakdownMs,
        // Opt-in trial linkage recorded on the job payload at schedule time.
        // Absent on every legacy run.
        ...(typeof trial?.trialId === 'string' && trial.trialId ? { trialCompletion: { trialId: trial.trialId } } : {})
      });
      await addQueryExecutionLog({
        query_run_id: queryRunId,
        query_id: queryId, query, country, executed_at: new Date().toISOString(),
        channels_discovered: finalMetrics.distinctResults, unique_new_channels: finalMetrics.newChannels,
        quality_creators_discovered: finalMetrics.qualityChannels, communities_discovered: finalMetrics.communitiesDiscovered,
        cycle_quality_score: performance.performanceScore,
        logs: [`Durable autonomous ${retrievalLane} lane run ${queryRunId} completed by ${workerId} via ${allocatedProvider.costDomain==='YOUTUBE_INNERTUBE_FREE'?'YOUTUBE_INNERTUBE_FREE':'YOUTUBE_DATA_API'}.`, `Provider outcome: ${providerRunOutcome || 'UNAVAILABLE'}`, `Funnel: ${JSON.stringify(metrics)}`]
      });

      // Post-run idempotent recomputation of derived evidence aggregate
      const neighborhoodInfo = await getNeighborhoodForQueryRun(queryRunId);
      if (neighborhoodInfo && retrievalConfigKey) {
        await recomputeNeighborhoodRetrievalEvidence(neighborhoodInfo.neighborhood_key, retrievalConfigKey)
          .catch(err => console.warn('[RetrievalPolicyEvidence] Post-run evidence recomputation error:', err));
      }

      // The page ceiling is a safety boundary, not a dead end. When the safety
      // ceiling (never a provider/treatment/trial cap) is reached while the
      // provider still exposes a next page, preserve the cursor in a linked
      // continuation run segment so the remaining work stays eligible.
      if (
        shouldCreateContinuationSegment({
          paginationEnabled: continuationEnabled,
          usingV2,
          primaryReason: decision.primaryReason,
          bindingBound,
          hasNextPage: Boolean(searchPage?.nextPageToken),
        })
      ) {
        // The child is a new run: it computes and persists its own fair-share
        // quota budget on its first page. Passing the parent's full budget here
        // would let the segment spend the same fair-share allocation twice.
        const segment = await createContinuationRunSegment({
          parentRunId: queryRunId,
          nextPageToken: searchPage!.nextPageToken!,
          resumeMode: resumeModeForProvider(providerKey),
          explorationPagesRemaining: decisionV2.explorationPagesRemaining,
        });
        await enqueueJob('SEARCH_YOUTUBE', {
          ...job.payload,
          queryRunId: segment.childRunId,
          pageNumber: 1,
          pageToken: searchPage!.nextPageToken!,
        }, {
          priority: AUTONOMOUS_CONTINUATION_JOB_PRIORITY,
          maxAttempts: 3,
          idempotencyKey: `search-run:${segment.childRunId}:page:1`,
        });
        console.log(JSON.stringify({
          event: 'autonomous_page_ceiling_continuation',
          parentRunId: queryRunId,
          childRunId: segment.childRunId,
          segment: segment.segment,
          pageNumber,
          resumeMode: segment.resumeMode,
          timestamp: new Date().toISOString(),
        }));
      }
    }
    await completeJob(job.id);
    return true;
    });
  } catch (err: any) {
    if (err instanceof ExcludedCountryError) {
      // A policy change can make an already-persisted job ineligible. Consume it
      // without retrying so it can never spend external API quota.
      const runId = String(job.payload?.queryRunId || '');
      if (runId) await failQueryRun(runId, err, true);
      if(investigationId&&investigationStepId)await completeInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,resultingStatus:'POLICY_REJECTED',output:{reason:'COUNTRY_POLICY_CHANGED'}});else await completeJob(job.id);
      return true;
    }
    const disposition=await failJob(job.id, err);
    const terminal=disposition==='FAILED';
    if(investigationId&&investigationStepId)await failInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,attempt:job.attempts,terminal,failureClass:String(err?.code||err?.name||'WORKER_FAILURE')}).catch(error=>console.error(`[Investigation:${investigationId}] Failure transition failed:`,error));
    if (job.type === 'MANUAL_SEARCH_PAGE' && terminal) await failManualSearch(String(job.payload.sessionId||''), err);
    if (job.type === 'POST_APPROVAL_ENRICH' && terminal) {
      const channelId = String(job.payload?.channelId || '');
      const channel = channelId ? await getChannelById(channelId) : null;
      if (channel) {
        const projection = resolveTerminalEnrichmentFailure(channel, terminal);
        if (projection.shouldProject) {
          channel.scan_status = projection.scanStatus;
          channel.trading_status = projection.tradingStatus;
          channel.discord_status = projection.discordStatus;
          channel.discord_validation_status = projection.discordValidationStatus;
          channel.scan_attempts = Math.max(channel.scan_attempts || 0, job.attempts);
          channel.last_checked = new Date().toISOString();
          await upsertChannel(channel);
        }
      }
    }
    if (job.type === 'ENRICH_CHANNEL' && terminal) {
      const channelId = String(job.payload?.channelId || '');
      const channel = channelId ? await getChannelById(channelId) : null;
      if (channel && channel.trading_status === 'UNCERTAIN') {
        channel.scan_status = isProviderDeferredEnrichmentError(err) ? 'PROVIDER_DEFERRED' : 'FAILED';
        channel.trading_status = 'UNCERTAIN';
        channel.scan_attempts = job.attempts;
        channel.last_checked = new Date().toISOString();
        await upsertChannel(channel);
        void recordAdmissionShadow({channelId,priorState:'NOT_EVALUATED',classificationStatus:'UNCERTAIN',investigationState:'OPERATIONALLY_BLOCKED',operationalFailure:true,candidateHypothesis:{},evidenceCoverage:{failureClass:String(err?.code||err?.name||'WORKER_FAILURE')}})
          .catch(error=>console.warn(`[CandidateAdmission] operational-failure shadow write failed for ${channelId}:`,error instanceof Error?error.message:error));
      }
    }
    if (job.type === 'RETRY_COMMUNITY_ACQUISITION' && terminal) {
      const channelId=String(job.payload?.channelId||'');
      const channel=channelId?await getChannelById(channelId):null;
      if(channel)await upsertChannel(projectTerminalCommunityRetryFailure(channel,job.attempts,new Date().toISOString()));
    }
    const runId = String(job.payload?.queryRunId || '');
    if (runId) await failQueryRun(runId, err, terminal);
    return false;
  } finally {
    clearInterval(heartbeat);
  }
  });
}

export interface ContinuationResumePlan<T extends { country: string; runId: string; marginalUtility?: number; lastPageAt?: string | null }> {
  /** At most one run per country, in rotated country order. */
  selected: T[];
  /** Pending runs that stay deferred to a later sweep; never dropped. */
  deferred: T[];
  /** ceil(totalPendingContinuations / activeCountries) + 1. */
  perCountryCap: number;
  rotation: number;
  nextFairnessCursor: number;
  countryOrder: string[];
}

/**
 * Pure continuation fairness policy (CDL §6.9): rotate countries by the
 * persisted continuation cursor, then give each country one slot ordered by
 * marginal utility descending, oldest pending age, then run ID. One slot per
 * country per sweep is the stronger form of "no country gets a second before
 * every country gets a first"; the per-country cap remains the hard bound for
 * the deferred backlog.
 *
 * `maxCountries` bounds how many countries one sweep may schedule. The cursor
 * advances by the number selected, so when pending countries exceed the sweep
 * limit every country is still reached within a bounded number of sweeps.
 * Exported for deterministic tests.
 */
export function planContinuationResume<T extends { country: string; runId: string; marginalUtility?: number; lastPageAt?: string | null }>(
  runs: T[],
  fairnessCursor: number,
  activeCountries: number,
  maxCountries = Number.POSITIVE_INFINITY,
): ContinuationResumePlan<T> {
  const byCountry = new Map<string, T[]>();
  for (const run of runs) {
    const key = run.country.toLowerCase();
    const bucket = byCountry.get(key);
    if (bucket) bucket.push(run);
    else byCountry.set(key, [run]);
  }
  const countryOrder = [...byCountry.keys()].sort((a, b) => a.localeCompare(b));
  if (!countryOrder.length) {
    return { selected: [], deferred: [], perCountryCap: 0, rotation: 0, nextFairnessCursor: 0, countryOrder: [] };
  }
  const cursor = Number.isFinite(fairnessCursor) ? Math.max(0, Math.floor(fairnessCursor)) : 0;
  const rotation = cursor % countryOrder.length;
  const rotatedCountries = [...countryOrder.slice(rotation), ...countryOrder.slice(0, rotation)];
  const countryBudget = Number.isFinite(maxCountries)
    ? Math.max(0, Math.min(rotatedCountries.length, Math.trunc(maxCountries)))
    : rotatedCountries.length;
  const selectedCountries = rotatedCountries.slice(0, countryBudget);
  const age = (run: T) => {
    const parsed = run.lastPageAt ? Date.parse(run.lastPageAt) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  const selected: T[] = [];
  const selectedIds = new Set<string>();
  for (const country of selectedCountries) {
    const candidates = [...(byCountry.get(country) || [])].sort((a, b) =>
      Number(b.marginalUtility || 0) - Number(a.marginalUtility || 0)
      || age(a) - age(b)
      || a.runId.localeCompare(b.runId));
    const pick = candidates[0];
    if (pick) {
      selected.push(pick);
      selectedIds.add(pick.runId);
    }
  }
  const deferred = runs.filter(run => !selectedIds.has(run.runId));
  // A partial sweep advances by the number of countries it covered; a full
  // sweep keeps the original one-country rotation so ordering still varies.
  const advance = selectedCountries.length >= countryOrder.length
    ? 1
    : Math.max(1, selectedCountries.length);
  return {
    selected,
    deferred,
    perCountryCap: Math.ceil(runs.length / Math.max(1, activeCountries)) + 1,
    rotation,
    nextFairnessCursor: (rotation + advance) % countryOrder.length,
    countryOrder: rotatedCountries,
  };
}

/**
 * Orphan reconciler for resumable autonomous runs. Enqueues exactly one
 * missing next-page job per eligible run, at most one continuation per country
 * per sweep, under a per-run advisory lock. Never bypasses quota admission:
 * the worker's normal reservation gate still applies to the resumed page.
 */
export async function resumeOrphanedAutonomousPages(options: {
  force?: boolean;
  limit?: number;
  now?: Date;
} = {}): Promise<{ swept: boolean; enqueued: number; skipped: number; unavailable: number }> {
  const nowMs = (options.now || new Date()).getTime();
  if (!options.force && nowMs - lastAutonomousResumeSweepAt < 5 * 60_000) {
    return { swept: false, enqueued: 0, skipped: 0, unavailable: 0 };
  }
  lastAutonomousResumeSweepAt = nowMs;
  const enabled = await getAppSetting('autonomous_pagination_enabled', 'true') === 'true';
  const v2Enabled = await getAppSetting('autonomous_pagination_v2_enabled', 'true') === 'true';
  // The CDL master switch stops new continuation work as well as the worker
  // paths; operators must not need to flip several independent settings.
  const cdlEnabled = await getAppSetting('country_discovery_loop_enabled', 'true') === 'true';
  if (!enabled || !v2Enabled || !cdlEnabled) {
    return { swept: true, enqueued: 0, skipped: 0, unavailable: 0 };
  }
  // The store returns one best candidate per pending country, without a
  // global row limit, so the fairness cursor can rotate across every country.
  const runs = await listPendingAutonomousRuns();
  if (!runs.length) return { swept: true, enqueued: 0, skipped: 0, unavailable: 0 };
  // Continuation fairness cursor: rotate countries every sweep so a low-yield
  // country cannot be starved by older high-yield pages. The cursor is
  // independent of the new-query country cursor. `limit` bounds countries per
  // sweep, not rows; the cursor advances by the number covered.
  const fairnessCursor = Math.max(0, Number(await getAppSetting('autonomous_continuation_fairness_cursor', '0')) || 0);
  const activeCountryKeys = await resolveActiveAutonomousCountryKeys();
  const activeCountries = Math.max(1, activeCountryKeys.size);
  const sweepCountryLimit = Math.max(1, Math.min(500, Math.trunc(options.limit || 50) || 50));
  const plan = planContinuationResume(runs, fairnessCursor, activeCountries, sweepCountryLimit);
  await setAppSetting('autonomous_continuation_fairness_cursor', String(plan.nextFairnessCursor)).catch(() => undefined);
  const orderedRuns = plan.selected;
  const perCountryCap = plan.perCountryCap;
  const grantsByCountry = new Map<string, number>();
  const countriesThisSweep = new Set<string>();
  const db = await getDb();
  let enqueued = 0;
  let skipped = 0;
  let unavailable = 0;

  for (const run of orderedRuns) {
    const countryKey = autonomousCountryKey(run.country);
    if (countriesThisSweep.has(countryKey)) {
      skipped++;
      continue;
    }
    const grants = grantsByCountry.get(countryKey) || 0;
    if (grants >= perCountryCap) {
      skipped++;
      continue;
    }
    const exclusion = await getCountryExclusion(run.country);
    if (exclusion) {
      await markQueryRunResumeUnavailable(run.runId, `COUNTRY_EXCLUDED:${exclusion.reason}`);
      unavailable++;
      continue;
    }
    if (!activeCountryKeys.has(countryKey)) {
      // Report §6.7: never resume a run whose country left the active scope,
      // even when its provider cursor is still valid. Marking it unavailable
      // is truthful and keeps it out of pending-continuation metrics.
      await markQueryRunResumeUnavailable(run.runId, 'COUNTRY_INACTIVE');
      unavailable++;
      continue;
    }
    const nextPage = Math.max(1, run.pagesCompleted + 1);
    const firstPage = run.pagesCompleted <= 0;
    // A fresh run uses the scheduling key (search-run:<id>); a continuation
    // segment child's first page was scheduled under :page:1. Either way page
    // 1 is recoverable even when no resume mode was persisted yet.
    const idempotencyKey = firstPage
      ? (run.nextPageToken ? `search-run:${run.runId}:page:1` : `search-run:${run.runId}`)
      : `search-run:${run.runId}:page:${nextPage}`;
    if (await autonomousPageExists(run.runId, nextPage)) {
      skipped++;
      continue;
    }
    // Live work always wins: a queued or in-flight page must never be failed
    // by the sweep. Completed/failed jobs without an observation fall through
    // to enqueueJob, which reopens them for the deferred page.
    const liveKeys = firstPage
      ? [`search-run:${run.runId}`, `search-run:${run.runId}:page:1`]
      : [idempotencyKey];
    const existingJob = await db.query(
      `SELECT 1 FROM jobs WHERE idempotency_key = ANY($1) AND status IN ('PENDING','PROCESSING')`,
      [liveKeys],
    );
    if (existingJob.rowCount) {
      skipped++;
      continue;
    }
    if (!firstPage && run.resumeMode === 'NONE') {
      await markQueryRunResumeUnavailable(run.runId, 'RESUME_MODE_NONE');
      unavailable++;
      continue;
    }
    if (!firstPage && (run.resumeMode === 'TOKEN' || run.resumeMode === 'OFFSET') && !run.nextPageToken) {
      await markQueryRunResumeUnavailable(run.runId, `RESUME_${run.resumeMode}_TOKEN_MISSING`);
      unavailable++;
      continue;
    }

    const client = await db.connect();
    let locked = false;
    try {
      const lock = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [`autonomous-resume:${run.runId}`]);
      locked = lock.rows[0]?.locked === true;
      if (!locked) {
        skipped++;
        continue;
      }
      // REWALK has no serializable provider cursor: next_page_token stores the
      // absolute provider page (for example "11" on a segment child whose first
      // page is page 1). Prefer it over the run-local page number, otherwise an
      // orphaned segment child would rewalk from page 1 and re-record pages the
      // parent already consumed. Fall back to the run-local number only when a
      // legacy row has no stored token.
      const pageToken = run.resumeMode === 'REWALK'
        ? (run.nextPageToken || String(nextPage))
        : run.nextPageToken;
      const provider = run.providerAllocationSnapshot
        ? providerSnapshot(run.providerAllocationSnapshot as ProviderAllocation)
        : undefined;
      // A treatment run's continuation pages were authorized by the worker's
      // incremental reservation. Recovery must apply the same boundary: a
      // direct enqueue would bypass a prior cap denial and execute an
      // unreserved treatment page. Page 1 remains covered by the scheduling
      // treatment reservation, so only later pages need a new reservation.
      let incPageReservationId: string | undefined;
      if (!firstPage && run.retrievalTreatmentOrigin === 'CANARY_TREATMENT') {
        const incRes = await reserveIncrementalTreatmentPageQuota({
          queryRunId: run.runId,
          pageNumber: nextPage,
          providerQuotaUnits: provider?.costDomain === 'YOUTUBE_INNERTUBE_FREE' ? 0 : 100,
        });
        if (!incRes.authorized) {
          // Stay pending for a later sweep; do not fail the run or bypass caps.
          skipped++;
          continue;
        }
        incPageReservationId = incRes.pageReservationId;
      }
      // Trial linkage and frozen experiment windows are scheduling-time
      // payloads. Rehydrate them from run metadata so a resumed page keeps its
      // trial reservation cap, completes its trial, and retrieves the same
      // published-date window as the original run.
      const metadata = run.runMetadata || {};
      const trial = metadata.trial && typeof metadata.trial === 'object'
        ? metadata.trial as { trialId?: string; trialKey?: string; proposalId?: string; quotaReserved?: number; status?: string }
        : null;
      const selectionExperiment = metadata.selectionExperiment && typeof metadata.selectionExperiment === 'object'
        ? metadata.selectionExperiment
        : null;
      const searchWindow = metadata.searchWindow && typeof metadata.searchWindow === 'object'
        ? metadata.searchWindow
        : null;
      await enqueueChildAndCommitPageReservation({
        pageReservationId: incPageReservationId,
        queryRunId: run.runId,
        jobType: 'SEARCH_YOUTUBE',
        jobPayload: {
          query: run.query,
          country: run.country,
          source: run.source as DiscoverySource,
          queryRunId: run.runId,
          queryId: run.queryId,
          retrievalLane: (run.retrievalLane || 'VIDEO') as RetrievalLane,
          searchOrdering: (run.searchOrdering || 'RELEVANCE') as import('./searchOrdering').SearchOrdering,
          pageNumber: nextPage,
          pageToken,
          retrievalConfigKey: run.retrievalConfigKey,
          retrievalTreatmentOrigin: run.retrievalTreatmentOrigin || 'CONTROL',
          // Preserve the run's original treatment depth. Replacing it with the
          // run-local page number would shrink a CANARY_TREATMENT cap on resume.
          requestedPageDepth: run.requestedPageDepth ?? nextPage,
          ...(provider ? { provider } : {}),
          ...(trial ? { trial } : {}),
          ...(selectionExperiment ? { selectionExperiment } : {}),
          ...(searchWindow ? { searchWindow } : {}),
        },
        priority: AUTONOMOUS_CONTINUATION_JOB_PRIORITY,
        maxAttempts: 3,
        idempotencyKey,
        // A deferred page whose previous job is COMPLETED/FAILED without a
        // page observation must be reopened, not silently skipped.
        reopenTerminal: true,
      });
      const progress = await getQueryRunProgress(run.runId);
      await updateQueryRunProgress(run.runId, {
        nextPageToken: run.nextPageToken,
        resumeMode: run.resumeMode,
        continuationStatus: 'RUNNING',
        lastPageAt: new Date(nowMs).toISOString(),
        resumeCount: (progress?.resumeCount || 0) + 1,
        resumeRewalkCount: (progress?.resumeRewalkCount || 0) + (run.resumeMode === 'REWALK' ? 1 : 0),
      });
      enqueued++;
      grantsByCountry.set(countryKey, grants + 1);
      countriesThisSweep.add(countryKey);
      console.log(JSON.stringify({
        event: 'autonomous_orphan_resumed',
        runId: run.runId,
        country: run.country,
        pageNumber: nextPage,
        resumeMode: run.resumeMode,
        timestamp: new Date(nowMs).toISOString(),
      }));
    } finally {
      if (locked) {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`autonomous-resume:${run.runId}`]).catch(() => undefined);
      }
      client.release();
    }
  }
  return { swept: true, enqueued, skipped, unavailable };
}

export interface ProcessDiscoveredChannelOutcome {
  channelId: string;
  channelName: string;
  isNew: boolean;
  wasKnown: boolean;
  persisted: boolean;
  countryStatus: 'CONFIRMED' | 'LIKELY' | 'UNCERTAIN' | 'REJECTED';
  detectedCountry?: string | null;
  rejectionReason?: string;
  tradingStatus: 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN' | 'NEEDS_REVIEW' | 'HUMAN_REJECTED';
  discordStatus: DiscordStatus;
  discordInvite: string | null;
  channelRecord?: ChannelRecord;
}

/** Channel attempts count lifecycle executions. Provider/candidate attempts are
 * independently durable in discord_check_attempts and must not inflate this. */
export function nextChannelScanAttempts(current:number,terminalSemanticOrSuccess:boolean):number{
  return terminalSemanticOrSuccess?0:Math.max(0,current)+1;
}

/** Click-window offset default for an inspection. Initial scans keep the
 * channel's legacy attempt offset; a durable retry starts every newly seen
 * seed at zero and reads per-seed progress from the retry payload. Job attempt
 * numbers deliberately never advance this value: a retry that failed before
 * clicking any control must reuse the same window. */
export function inspectionClickOffsetForRetry(
  channelAttempts: number | undefined,
  executionMarker?: { isRetryOwnedReacquire?: boolean },
): number {
  const channelOffset = Math.max(0, Math.trunc(Number(channelAttempts)) || 0);
  return executionMarker?.isRetryOwnedReacquire ? 0 : channelOffset;
}

/** Defensive projection of durable retry click offsets from JSON payloads.
 * Invalid entries are dropped; a retry then restarts that seed at zero rather
 * than trusting a non-numeric offset. */
export function resolveInspectionClickOffsets(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const offsets: Record<string, number> = {};
  for (const [url, raw] of Object.entries(value as Record<string, unknown>)) {
    const offset = Math.trunc(Number(raw));
    if (!url || !Number.isFinite(offset) || offset <= 0) continue;
    offsets[url] = offset;
  }
  return Object.keys(offsets).length ? offsets : undefined;
}

/** Persist per-seed click progress on the currently processing retry job.
 * Without this write the same durable attempt would reload its pre-run payload
 * on failJob and re-click the same window; progress is attempt state, not only
 * next-enqueue state. Best-effort and non-empty only: an empty map must never
 * erase previously recorded progress. */
export async function persistCommunityRetryClickOffsets(
  jobId: string,
  offsets: Record<string, number> | undefined,
  clientOverride?: { query(sql: string, params?: unknown[]): Promise<unknown> },
): Promise<void> {
  const safe = resolveInspectionClickOffsets(offsets);
  if (!jobId || !safe) return;
  const db = clientOverride || await getDb();
  // Deep-merge per-seed offsets: a partial map (manual retry, one seed
  // re-inspected) must never erase progress recorded for other seeds on the
  // same durable job. Incoming values win for keys they contain.
  await db.query(
    `UPDATE jobs SET payload=(payload - 'clickOffsets') || jsonb_build_object('clickOffsets',COALESCE(payload->'clickOffsets','{}'::jsonb) || $2::jsonb),updated_at=now() WHERE id=$1 AND status='PROCESSING'`,
    [jobId, JSON.stringify(safe)]
  );
}

/**
 * Projects a live post-inspection country rejection onto the channel row.
 * Mutates and returns the same row: country_status REJECTED, detected
 * creator country, fresh live score, terminal scan status, and last_checked.
 * Trading/Discord ownership and the inspection trail are never touched here —
 * the caller owns Discord projections and trail assembly. Persistence stays
 * with the caller's existing finally-block upsert; this helper performs no
 * writes, mirroring applyGate1CountryRejectionToExisting ownership rules.
 */
export function applyLiveCountryRejectionToInspected(
  channel: ChannelRecord,
  liveCountry: { detectedCreatorCountry?: string | null; score: number },
  now: string
): ChannelRecord {
  channel.country_status = 'REJECTED';
  channel.country = liveCountry.detectedCreatorCountry || null;
  channel.scope_eligibility = resolveScopeEligibility(channel.country);
  channel.confidence_score = liveCountry.score;
  channel.scan_status = 'COMPLETED';
  channel.last_checked = now;
  return channel;
}

/**
 * Projects a live (non-terminal) country revalidation onto the in-memory
 * channel: factual country, status, confidence AND scope eligibility move
 * together, so the row can never hold a new country with a stale scope
 * (e.g. Germany -> Brazil retaining IN_SCOPE). The persisted write follows
 * in the caller's finally-block upsert, which re-derives scope identically.
 */
export function projectLiveCountryAttribution(
  channel: ChannelRecord,
  liveCountry: { detectedCreatorCountry?: string | null; status: CountryStatus; score: number },
): ChannelRecord {
  if (liveCountry.detectedCreatorCountry !== undefined) {
    channel.country = liveCountry.detectedCreatorCountry || null;
    channel.scope_eligibility = resolveScopeEligibility(channel.country);
    channel.country_status = liveCountry.status;
    channel.confidence_score = liveCountry.score;
  }
  return channel;
}

/**
 * Whether a claimed job may be retrying a previously failed attempt, for
 * vocabulary-repair purposes. attempts increments at claim time (first
 * execution already sees 1), but RETRYING_WITHOUT_ATTEMPT decrements on
 * infrastructure failures and stale-lock reclaim stamps last_error — so a
 * genuine retry can arrive with attempts===1. last_error is set on every
 * failure path, cleared on re-enqueue, and present after crash recovery;
 * either signal therefore marks a retry without false-flagging first runs.
 */
export function isRepairEligibleRetry(job: { attempts: number; last_error?: string | null }): boolean {
  return job.attempts > 1 || job.last_error != null;
}

/**
 * Handles newly discovered YouTube channel via the unified ingestion pipeline.
 */
export async function processDiscoveredChannel(
  raw: DiscoveredChannelRaw,
  targetCountry: string,
  source: DiscoverySource,
  options?: PipelineExecutionOptions
): Promise<ProcessDiscoveredChannelOutcome> {
  return processChannelThroughPipeline(raw, targetCountry, source, false, false, options);
}

/**
 * Contains a probe-origin quota refusal inside a normal-origin batch.
 *
 * Search, manual-search, playlist and featured-channel workers process a page
 * serially. A sticky-PROBE channel may be refused before dispatch when the
 * probe allocation is disabled/exhausted; that policy wait must not abort the
 * remaining NORMAL channels or make the page retry and spend its quota again.
 * Probe-origin jobs still propagate the refusal so the queue can defer them.
 */
export function shouldContainProbeQuotaRefusal(
  error: unknown,
  jobOrigin: 'NORMAL' | 'PROBE' | 'UNKNOWN' = currentOfficialYouTubeQuotaOrigin(),
): boolean {
  return jobOrigin === 'NORMAL' && probeQuotaControlInChain(error) !== null;
}

/**
 * Pure payload/key builder for the per-channel retry created when a NORMAL
 * batch contains a sticky-PROBE channel whose own allocation refuses it.
 * A page-level retry would spend the whole page again, so the deferral is
 * persisted as one PROBE-origin discovery-replay job per channel and quota
 * day. ENRICH_CHANNEL is only the queue carrier type; the handler replays the
 * original discovery pipeline so revisitable rows are not skipped by the
 * enrichment-only eligibility gate. `enqueueJob`'s idempotency key collapses
 * repeated sightings to one job.
 */
export function probeDeferredDiscoveryJob(
  raw: DiscoveredChannelRaw,
  targetCountry: string,
  source: DiscoverySource,
  control: unknown,
  now: number = Date.now(),
  forceExtraction: boolean = false,
): { payload: Record<string, unknown>; opts: { priority: number; maxAttempts: number; runAfter: string; idempotencyKey: string } } {
  const quotaDay = String((control as any)?.quotaDay || (control as any)?.details?.quotaDay || '');
  const retryAt = Number((control as any)?.retryAt);
  const runAfter = new Date(Number.isFinite(retryAt) && retryAt > now ? retryAt : now + 60_000).toISOString();
  return {
    payload: {
      channelId: raw.channelId,
      targetCountry,
      source,
      candidate: raw,
      enrichmentStage: 1,
      forceExtraction,
      quotaOrigin: 'PROBE',
      probeDeferredDiscovery: true,
    },
    opts: {
      priority: 5,
      maxAttempts: 4,
      runAfter,
      idempotencyKey: `probe-deferred-discovery:${raw.channelId}:${quotaDay || runAfter.slice(0, 10)}`,
    },
  };
}

export async function processDiscoveredChannelContained(
  raw: DiscoveredChannelRaw,
  targetCountry: string,
  source: DiscoverySource,
  options?: PipelineExecutionOptions,
): Promise<ProcessDiscoveredChannelOutcome | null> {
  try {
    return await processDiscoveredChannel(raw, targetCountry, source, options);
  } catch (error) {
    if (!shouldContainProbeQuotaRefusal(error)) throw error;
    const control = probeQuotaControlInChain(error);
    try {
      const deferred = probeDeferredDiscoveryJob(
        raw,
        targetCountry,
        source,
        control,
        Date.now(),
        options?.forceExtraction === true,
      );
      await enqueueJob('ENRICH_CHANNEL', deferred.payload, deferred.opts);
    } catch (scheduleError) {
      // Without a durable retry this channel would be lost, and the nomination
      // ledger may be disabled. Propagate the refusal instead of completing the
      // page: the queue then defers/retries the NORMAL job rather than silently
      // discarding the deferred channel.
      console.warn(JSON.stringify({
        event: 'probe_quota_channel_retry_schedule_failed',
        channelId: raw.channelId,
        source,
        targetCountry,
        code: String((control as any)?.code || 'PROBE_QUOTA_DEFERRED'),
        reason: String(scheduleError instanceof Error ? scheduleError.message : scheduleError).slice(0, 300),
        timestamp: new Date().toISOString(),
      }));
      throw error;
    }
    console.warn(JSON.stringify({
      event: 'probe_quota_channel_deferred',
      channelId: raw.channelId,
      source,
      targetCountry,
      code: String((control as any)?.code || 'PROBE_QUOTA_DEFERRED'),
      reason: String((control as any)?.message || control).slice(0, 300),
      retryScheduled: true,
      jobOrigin: currentOfficialYouTubeQuotaOrigin(),
      timestamp: new Date().toISOString(),
    }));
    return null;
  }
}

/**
 * Executes the inspection and Discord quality validation for a locked channel.
 */
export async function inspectAndValidateChannel(
  channel: ChannelRecord,
  rawDetails?: DiscoveredChannelRaw,
  isManualScan: boolean = false,
  enableDebug: boolean = false,
  scheduleRetry: boolean = true,
  executionMarker?: { jobId: string; attemptNumber: number; isRetryOwnedReacquire?: boolean; clickOffsets?: Record<string, number> }
): Promise<{ debugLog?: any; inspection?: Awaited<ReturnType<typeof runChannelInspection>>; retryDirective?: CommunityRetryDirective } | void> {
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

  // Retry-owned stored-country pre-check (P2): a durable retry must not spend
  // a crawl/persist/claim cycle on a creator whose stored country evidence
  // already resolves excluded under the current policy. The live revalidation
  // below runs with whatever metadata the retry carries (often none), so
  // without this check a policy-updated exclusion list could let the retry
  // claim invites that a metadata-complete run would reject before any claim.
  // Only proven evidence blocks (CONFIRMED stored country + exclusion-list
  // match), exactly like the ENRICH claim gate; LIKELY and below stay
  // fail-open.
  if (executionMarker?.isRetryOwnedReacquire && channel.country_status === 'CONFIRMED' && channel.country) {
    const storedExclusion = await getCountryExclusion(channel.country);
    const storedBlock = shouldBlockEnrichClaimForCountry(channel.country_status, channel.country, storedExclusion);
    if (storedBlock) {
      const rejectionNow = new Date().toISOString();
      channel.country_status = 'REJECTED';
      channel.scope_eligibility = resolveScopeEligibility(channel.country);
      channel.scan_status = 'COMPLETED';
      channel.last_checked = rejectionNow;
      channel.inspection_trail = [...(channel.inspection_trail || []), {
        step: 'COUNTRY_VALIDATION',
        title: `Country Validation (${channel.country})`,
        status: 'REJECTED',
        details: `${channel.country} is excluded by policy: ${storedBlock.reason}. Blocked retry-owned reacquisition before crawl/claim.`,
        timestamp: rejectionNow,
      }];
      await upsertChannel(channel);
      console.warn(JSON.stringify({event:'excluded_channel_blocked',channelId:channel.channel_id,detectedCountry:channel.country,reason:storedBlock.reason,context:'retry_owned_reacquire',timestamp:rejectionNow}));
      return;
    }
  }

  // Durable proof that community inspection genuinely began. Both early
  // returns above (terminal state, processing pause) skip inspection without
  // marking, so they can never count as executed. The marker is bound to the
  // exact claimed attempt: a zero-row update means the claim was already
  // recovered or completed, and inspection must not start on a stale claim.
  if (executionMarker) await markCommunityInspectionStarted(executionMarker.jobId, executionMarker.attemptNumber);

  const now = new Date().toISOString();

  let finalDebugLog: any = null;
  let inspection: Awaited<ReturnType<typeof runChannelInspection>> | null = null;
  let retryDirective: CommunityRetryDirective | undefined;
  let attemptFree = false;
  let admittedInspection: typeof inspection;
  try {
    // 1. Re-check Country Validation before Discord scanning
    // Provenance boundary: only creator-level fields may enter P2 matching.
    // Inspection-trail prose must never stand in for the About/Bio text: the
    // trail quotes exchange/market references and prior validation logs that
    // mention country names (e.g. "Vietnam", "South Africa"), which would
    // manufacture false P2 creator-country evidence. Unknown bio stays empty
    // (UNCERTAIN → PROCESS), never contaminated.
    const valRes = await validateChannelCountry(
      {
        channelName: channel.channel_name,
        description: rawDetails?.description || '',
        videoTitles: rawDetails?.videoTitles || [channel.channel_name],
        locationTag: rawDetails?.locationTag,
        externalLinks: rawDetails?.channelLinks || (channel.discord_invite ? [channel.discord_invite] : []),
        metadataStatus: rawDetails?.countryMetadataStatus || channel.country_metadata_status,
        videoDescriptions: rawDetails?.videoDescriptions,
        videoDescriptionsAuthoritative: rawDetails?.videoDescriptionsAuthoritative,
        playlists: rawDetails?.playlists
      },
      // Enrichment revalidation is unscoped: no genuine query target country
      // exists here. locationTag already enters above as creator-level
      // official metadata; passing it again as the discovery target would
      // manufacture false discovery-country context (e.g. 'BR').
      null
    );

    const preInspectionLanguageSet = aggregatedLanguageCandidateSet(valRes.evidence);
    const countryStep: InspectionStep = {
      step: 'COUNTRY_VALIDATION',
      title: `Country Validation (${channel.country || 'Unknown'})`,
      status: valRes.status === 'REJECTED'
        ? 'REJECTED'
        : (valRes.status === 'CONFIRMED' || valRes.status === 'LIKELY')
        ? 'FOUND'
        : 'NOT_FOUND',
      details: valRes.decisionLogs,
      // Structured candidate set for recovery reconciliation (no prose parsing).
      ...(preInspectionLanguageSet ? { candidateCountries: preInspectionLanguageSet } : {}),
      timestamp: now
    };

    if (valRes.status === 'REJECTED') {
      // Excluded country matched — Halt execution immediately! Never reach Discord crawler.
      channel.country_status = 'REJECTED';
      // Re-attribute the detected country (never retain the previous one) and
      // re-derive scope from it, so an unsupported-country rejection flips a
      // stale IN_SCOPE to OUT_OF_SCOPE instead of preserving it.
      channel.country = valRes.detectedCreatorCountry || null;
      channel.scope_eligibility = resolveScopeEligibility(channel.country);
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
    if (valRes.detectedCreatorCountry !== undefined) {
      channel.country = valRes.detectedCreatorCountry || null;
      channel.scope_eligibility = resolveScopeEligibility(channel.country);
    }

    // 2. Step-by-step Channel Inspection Engine for Discord Invites (force live YouTube scrape on manual scan)
    inspection = await runChannelInspection({
      enableDebug,
      channelId: channel.channel_id,
      channelBio: rawDetails?.description || channel.channel_name,
      channelLinks: rawDetails?.channelLinks || [],
      pinnedComment: rawDetails?.pinnedComment,
      videoDescriptions: rawDetails?.videoDescriptions || [],
      // Enrichment already acquired the authoritative recent-upload sample.
      // Carry its provenance and video IDs so Gate 3 can reuse it instead of
      // repeating the 100-unit recent-videos search.
      videoDescriptionsAuthoritative: rawDetails?.videoDescriptionsAuthoritative,
      recentVideoDescriptions: rawDetails?.videoDescriptionsAuthoritative
        ? (rawDetails.videos?.length
            ? rawDetails.videos.map(video => ({ videoId: video.id, description: video.description }))
            : rawDetails.videoDescriptions)
        : undefined,
      socialLinks: rawDetails?.channelLinks || [],
      youtubeUrl: channel.youtube_url,
      forceLiveFetch: isManualScan || !rawDetails?.description,
      scanAttempts: inspectionClickOffsetForRetry(channel.scan_attempts, executionMarker),
      clickOffsets: executionMarker?.isRetryOwnedReacquire ? resolveInspectionClickOffsets(executionMarker.clickOffsets) : undefined,
      bypassBorrowedCoverage: resolveBorrowBypassForInspectionMarker(executionMarker)
    });
    // Carry only controls this run actually examined into any retry directive.
    // A pre-click failure leaves the previous per-seed offsets unchanged, so
    // the next attempt reuses the same window instead of skipping it. The
    // current retry job's payload is updated too: its remaining durable
    // attempts reload that payload rather than going through enqueue again.
    if(inspection.retryDirective)inspection.retryDirective={...inspection.retryDirective,clickOffsets:inspection.nextClickOffsets};
    if(executionMarker?.jobId&&inspection.nextClickOffsets&&Object.keys(inspection.nextClickOffsets).length){
      await persistCommunityRetryClickOffsets(executionMarker.jobId,inspection.nextClickOffsets).catch(error=>{
        console.warn(JSON.stringify({event:'community_retry_click_offsets_persist_failed',jobId:executionMarker.jobId,channelId:channel.channel_id,error:error instanceof Error?error.message:String(error),timestamp:new Date().toISOString()}));
      });
    }
    if(inspection.acquisitionOutcomes?.length)await appendExternalAcquisitionObservations(channel.channel_id,inspection.acquisitionOutcomes)
      .catch(error=>console.warn(`[ExternalAcquisition] observational write failed for ${channel.channel_id}:`,error instanceof Error?error.message:error));

    // Live About-page hydration can reveal stronger country evidence than the
    // search snippet. Re-evaluate BEFORE the authoritative claim (P2/E5): a
    // policy-rejected creator must never persist, claim, or validate an
    // invite — a rejected tenant winning a registry entry permanently blocks
    // the real creator (the registry has no release/reassignment path). The
    // country voter receives the FRESH channel-sampled descriptions acquired
    // during this inspection (authoritative provenance) — never the stale
    // pre-inspection rawDetails sample, which may be search-selected or
    // absent on retries. When inspection acquired nothing fresh, the voter
    // abstains on descriptions rather than evaluating stale input.
    const rawLiveCountry = await validateChannelCountry({channelName:channel.channel_name,
      description:inspection.observedAboutBio, videoTitles:rawDetails?.videoTitles || [channel.channel_name],
      locationTag:rawDetails?.locationTag, externalLinks:inspection.observedChannelLinks,
      metadataStatus:rawDetails?.countryMetadataStatus || channel.country_metadata_status,
      videoDescriptions:inspection.observedVideoDescriptions || [], videoDescriptionsAuthoritative:inspection.observedVideoDescriptionsAuthoritative || false, playlists:rawDetails?.playlists},
      // Unscoped live revalidation (see above): locationTag is creator-level
      // input, never the discovery target.
      null);
    const liveCountry = mergeCountryValidationResults(valRes, rawLiveCountry);
    const liveLanguageSet = aggregatedLanguageCandidateSet(liveCountry.evidence);
    const liveCountryStep: InspectionStep = {
      step: 'COUNTRY_VALIDATION',
      title: `Country Validation (${rawLiveCountry.detectedCreatorCountry || 'Unknown'}) — Live About`,
      status: rawLiveCountry.status === 'REJECTED' && liveCountry.status === 'REJECTED'
        ? 'REJECTED'
        : (liveCountry.status === 'CONFIRMED' || liveCountry.status === 'LIKELY')
        ? 'FOUND'
        : 'NOT_FOUND',
      details: `${rawLiveCountry.decisionLogs}${liveCountry !== rawLiveCountry ? '\\nEffective decision: earlier stronger/conflicting evidence preserved.' : ''}`,
      // Structured candidate set for recovery reconciliation (no prose parsing).
      ...(liveLanguageSet ? { candidateCountries: liveLanguageSet } : {}),
      timestamp: now
    };
    if (liveCountry.status === 'REJECTED') {
      // Terminal live rejection decided BEFORE the authoritative claim: no
      // candidate row is persisted, no registry entry is claimed, and no
      // validation runs for a rejected creator. The live verdict and the real
      // inspection steps are recorded; the existing Discord/discovery state is
      // preserved exactly as it was (nothing was admitted this run).
      //
      // The crawl already wrote this channel's candidate-bearing site-cache
      // rows as PENDING. Those rows are never reusable while pending, and a
      // rejected creator is terminal, so without finalizing them the same site
      // would be recrawled forever by later creators. Discard only this
      // channel's examined candidates; other channels' pending entries stay.
      const rejectedCandidateIds=[...new Set((inspection.discordCandidates||[])
        .map(candidate=>candidate.candidateId).filter(Boolean))];
      if(rejectedCandidateIds.length)await markSiteInspectionsRejected(channel.channel_id,rejectedCandidateIds).catch(()=>undefined);
      applyLiveCountryRejectionToInspected(channel, liveCountry, now);
      channel.inspection_trail=[countryStep, ...inspection.steps, liveCountryStep];
      console.warn(JSON.stringify({event:'live_country_rejected_before_claim',channelId:channel.channel_id,detectedCountry:liveCountry.detectedCreatorCountry||null,timestamp:now}));
      return;
    }

    // Global canonical discard (single authoritative claim for this
    // inspection). Crash-safe ordering: persist provisional rows first
    // (idempotent upsert), then claim, then delete losers. A crash between
    // steps always converges on retry, and the registry can never name a
    // code whose candidate row was never written in the same execution.
    // Codes owned by other channels are discarded completely here (row
    // deleted, no check record, no validation, no projection); same-channel
    // and unknown codes proceed exactly as before.
    // Structured candidates are authoritative for discovery; foundInvite is a
    // compatibility fallback for older inspection results without the
    // structured collection. The admitted view below preserves that
    // precedence while enforcing the global canonical discard. The choke
    // orchestration (persist, claim, delete losers) is injectable for tests;
    // production passes the real implementations below.
    const structuredCandidates=(inspection.discordCandidates||[]).filter(candidate=>!!discordInviteCodeOf(candidate.nativeInviteCode));
    const executedCandidateIds=[...new Set(structuredCandidates.map(candidate=>candidate.candidateId).filter(Boolean))];
    let chokeAdmission=await admitInspectionDiscordCandidates(structuredCandidates,inspection.foundInvite,channel.channel_id);
    if(chokeAdmission.discardedCount)console.info(JSON.stringify({event:'discord_duplicate_discarded',channelId:channel.channel_id,discardedCount:chokeAdmission.discardedCount,discardedOwnerChannelIds:chokeAdmission.discardedOwnerChannelIds,timestamp:new Date().toISOString()}));
    admittedInspection={...inspection,discordCandidates:chokeAdmission.candidates,foundInvite:chokeAdmission.discoveredInvite};

    // Durable cache handshake (E2): this execution is final for every
    // candidate it examined. If at least one candidate reached admission the
    // rows become reusable CLAIMED coverage; when every candidate lost the
    // global claim (foreign-owned duplicates) they become terminal DISCARDED
    // instead of staying PENDING and forcing an endless recrawl. Only this
    // channel's pending ids are finalized, so another channel's unclaimed
    // discoveries survive. Best-effort by design — a failure leaves rows
    // PENDING, which only forces an idempotent recrawl/re-admission, never a
    // silent loss.
    if(executedCandidateIds.length){
      if(chokeAdmission.candidates.length)await markSiteInspectionsClaimed(channel.channel_id,executedCandidateIds).catch(()=>undefined);
      else await markSiteInspectionsDiscarded(channel.channel_id,executedCandidateIds).catch(()=>undefined);
    }

    // Orphan drain (E6): a candidate persisted by an execution that crashed
    // before its claim has no validation attempt and no path back into
    // discovery. Re-admit those rows through the same global claim now, so a
    // discovery is never permanently stranded. Codes owned by another channel
    // are residue and are removed by exact candidate id; codes still
    // available (or already owned here) join the validation set below.
    const orphanDrain=await drainOrphanDiscordCandidates(channel.channel_id).catch(error=>{
      console.warn(JSON.stringify({event:'orphan_candidate_drain_failed',channelId:channel.channel_id,error:error instanceof Error?error.message:String(error),timestamp:new Date().toISOString()}));
      return {candidates:[] as DiscordCandidate[],removed:0,discardedOwnerChannelIds:[] as string[]};
    });
    // An orphan row can be the same candidate this execution just persisted
    // (and already admitted). Merge by canonical invite rather than appending
    // it, so one invite is never validated twice and the original-case code
    // cannot be replaced by the orphan's lowercase value.
    const admittedIds=new Set(chokeAdmission.candidates.map(candidate=>candidate.candidateId));
    const freshOrphans=orphanDrain.candidates.filter(candidate=>!admittedIds.has(candidate.candidateId));
    if(freshOrphans.length){
      const merged=mergeDiscordCandidates([...chokeAdmission.candidates,...freshOrphans],{creatorName:channel.channel_name});
      chokeAdmission={...chokeAdmission,candidates:merged,discoveredInvite:chokeAdmission.discoveredInvite||merged[0]?.nativeInviteCode||null};
      admittedInspection={...inspection,discordCandidates:chokeAdmission.candidates,foundInvite:chokeAdmission.discoveredInvite};
      console.info(JSON.stringify({event:'orphan_candidates_drained',channelId:channel.channel_id,count:freshOrphans.length,removed:orphanDrain.removed,timestamp:new Date().toISOString()}));
    } else if(orphanDrain.removed){
      console.info(JSON.stringify({event:'orphan_candidate_residue_removed',channelId:channel.channel_id,removed:orphanDrain.removed,timestamp:new Date().toISOString()}));
    }
    // Orphan residue is provenance too: the row is deleted, but its foreign
    // owner must still drive the dashboard's duplicate-owned state.
    if(orphanDrain.discardedOwnerChannelIds.length){
      chokeAdmission={...chokeAdmission,discardedOwnerChannelIds:[...new Set([...chokeAdmission.discardedOwnerChannelIds,...orphanDrain.discardedOwnerChannelIds])]};
      console.info(JSON.stringify({event:'orphan_duplicate_provenance_retained',channelId:channel.channel_id,discardedOwnerChannelIds:orphanDrain.discardedOwnerChannelIds,timestamp:new Date().toISOString()}));
    }
    // Provenance-only duplicate record: owner channel id, never the invite
    // code. A fresh processed inspection clears stale duplicate evidence; a
    // cache-only scan preserves it because borrowed coverage cannot establish
    // that the duplicate disappeared. Computed after the orphan drain so
    // foreign-owned residue contributes its owner before the row is deleted.
    channel.discord_duplicate_owner_channel_id = nextDiscordDuplicateOwnerChannelId({
      discardedOwnerChannelIds: chokeAdmission.discardedOwnerChannelIds,
      previousOwnerChannelId: channel.discord_duplicate_owner_channel_id,
      observations: inspection.acquisitionOutcomes || [],
    });

    // The admitted inspection view (computed once at the authoritative claim
    // above) shapes every downstream gate, so a duplicate-only inspection
    // can neither reconcile nor project a discarded invite.

    if (liveCountry.detectedCreatorCountry !== undefined) {
      projectLiveCountryAttribution(channel, {
        detectedCreatorCountry: liveCountry.detectedCreatorCountry,
        status: liveCountry.status,
        score: liveCountry.score,
      });
    }

    // Combine Country Validation step as Step 1 with Discord Inspection steps
    channel.inspection_trail = [countryStep, ...inspection.steps];
    finalDebugLog = inspection.debugLog;

    if (inspection.extractedThumbnailUrl) {
      channel.channel_thumbnail_url = inspection.extractedThumbnailUrl;
    } else if (rawDetails?.channelThumbnailUrl) {
      channel.channel_thumbnail_url = rawDetails.channelThumbnailUrl;
    }

    // Structured candidates are authoritative for discovery; foundInvite is a
    // compatibility fallback for older inspection results without the
    // structured collection. Admission was decided once at the authoritative
    // claim above; this block validates the admitted winners only.
    const candidates=chokeAdmission.candidates;
    const discoveredInvite=chokeAdmission.discoveredInvite;
    if (discoveredInvite) {
      // Validate bounded native candidates until a high-confidence trading
      // community is found. A live-but-ambiguous or live-but-non-trading first
      // invite is a fallback, not a reason to suppress a stronger later invite.
      let selected:Awaited<ReturnType<typeof validateDiscordInvite>>|null=null,selectedCandidate= candidates[0],selectedRank=-1;
      const terminalInvalid:Array<Awaited<ReturnType<typeof validateDiscordInvite>>>=[];
      for(const candidate of candidates){
        if(!candidate.nativeInviteCode)continue;
        const locator=candidate.normalizedLocator||`https://discord.gg/${candidate.nativeInviteCode}`;
        const priorInvalidObservations=await countDiscordInvalidObservations(channel.channel_id,candidate.candidateId,locator);
        // Bounded unexpected-404 budget (e.g. provider error 50270): after the
        // durable observation ceiling the lookup is terminal instead of
        // re-arming RETRY_PENDING forever.
        const priorProviderFailureObservations=await countDiscordProviderFailureObservations(channel.channel_id,candidate.candidateId,locator);
        const validation=await validateDiscordInvite(candidate.nativeInviteCode,{
          parentContext:{
            tradingStatus:channel.trading_status,
            tradingConfidence:Number(channel.trading_confidence_score||0),
            tradingCategory:channel.trading_category,
            creatorName:channel.channel_name,
            country:channel.country,
            sourceSurface:candidate.sourceSurface,
            ownershipStatus:candidate.ownershipStatus,
            ownershipConfidence:candidate.ownershipConfidence
          },
          priorInvalidObservations,
          priorProviderFailureObservations
        });
        await appendDiscordCheckAttempts(channel.channel_id,validation.candidateInviteUrl,validation.status,validation.attempts,{candidateId:candidate.candidateId,rawLocator:candidate.rawLocator,locatorType:candidate.locatorType,resolvedLocator:validation.candidateInviteUrl,sourceSurface:candidate.sourceSurface,sourceUrl:candidate.sourceUrl});
        if(validation.operationalOutcome==='CONFIRMED_INVALID'){terminalInvalid.push(validation);continue;}
        const rank=discordCandidateCompositeRank(candidate,validation);
        if(rank>selectedRank){selected=validation;selectedCandidate=candidate;selectedRank=rank;}
      }
      if(!selected&&terminalInvalid.length===candidates.filter(candidate=>candidate.nativeInviteCode).length){selected=terminalInvalid[0];selectedCandidate=candidates[0];}
      if(!selected)throw new Error('No resolvable native Discord candidate was available for validation');
      const shouldProjectValidation=canProjectDiscordValidation(channel,selected,selectedCandidate);
      if(shouldProjectValidation){Object.assign(channel,projectDiscordValidation(channel,selected,selectedCandidate));await selectDiscordCandidate(channel.channel_id,selectedCandidate.candidateId);}
      attemptFree=attemptFreeDiscordValidation(selected.operationalOutcome,selected.retryable);
      channel.scan_status=selected.operationalOutcome==='SUCCEEDED'||selected.operationalOutcome==='CONFIRMED_INVALID'?'COMPLETED':'FAILED';
      channel.scan_attempts=selected.operationalOutcome==='SUCCEEDED'||selected.operationalOutcome==='CONFIRMED_INVALID'?0:attemptFree?Math.max(0,channel.scan_attempts):nextChannelScanAttempts(channel.scan_attempts,false);
      channel.last_checked=now;
      reconcileDiscordDiscoveryFromInspection(channel,admittedInspection,{validationProjected:true});
      retryDirective=attemptFree?{attemptFree:true,code:COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE,reason:`Discord validation remained ${selected.operationalOutcome}`,retryAt:undefined,retryReason:'COMMUNITY_REQUIRED_ACQUISITION_FAILURE'}:undefined;
      if(retryDirective&&inspection.nextClickOffsets&&Object.keys(inspection.nextClickOffsets).length)retryDirective={...retryDirective,clickOffsets:inspection.nextClickOffsets};
      if(selected.retryable&&scheduleRetry)await enqueueCommunityAcquisitionRetry(channel.channel_id,retryDirective);
      if(scheduleRetry&&shouldScheduleFoundGapAcquisitionRetry(inspection))await enqueueCommunityAcquisitionRetry(channel.channel_id,inspection.retryDirective);
    } else if(inspection.acquisitionStatus==='ACQUISITION_FAILED'||inspection.acquisitionStatus==='PARTIALLY_INSPECTED'||
      // Raw FOUND with zero admitted candidates: every retained candidate was
      // discarded by the global canonical claim, so the raw aggregate cannot
      // resolve this channel (E8). Branch on admitted state instead — the
      // failure/partial path re-derives required-work ownership (retryable
      // observations, FOUND+gap directives) without projecting a
      // candidate-free "not found".
      (inspection.acquisitionStatus==='FOUND'&&!discoveredInvite&&!candidates.some(candidate=>candidate.nativeInviteCode))) {
      // A failed or partial crawl is operational uncertainty, not confirmed absence.
      const alreadyValidatedSuccess=hasEstablishedValidatedDiscordSelection(channel);
      // Shared predicate (not a local outcome check): required retryable FAILED
      // and required retryable PARTIALLY_INSPECTED both own the RETRY_PENDING
      // path, so partial-only acquisitions never strand in FAILED_OPERATIONAL.
      const hasRetryableAcquisitionFailure=hasRetryableCommunityAcquisitionFailure(inspection.acquisitionOutcomes||[],inspection.retrySuppressedUrls);
      if(!alreadyValidatedSuccess){
        channel.discord_status='UNCERTAIN';
        channel.discord_liveness_status=channel.discord_candidate_locator?channel.discord_liveness_status||'UNCERTAIN':'NOT_CHECKED';
        channel.discord_validation_status=hasRetryableAcquisitionFailure?'RETRY_PENDING':'FAILED_OPERATIONAL';
        channel.discord_resolution_status=channel.discord_resolution_status||'RESOLVED';
        channel.discord_discovery_status=channel.discord_candidate_locator?'DISCOVERED_VALIDATION_FAILED':'NOT_DISCOVERED';
      }
      reconcileDiscordDiscoveryFromInspection(channel,admittedInspection,{validationProjected:false});
      retryDirective=inspection.retryDirective;
      attemptFree=Boolean(retryDirective?.attemptFree);
      channel.scan_status='FAILED';
      if(!retryDirective?.attemptFree)channel.scan_attempts++;
      // An incomplete rescan cannot erase an earlier discovered locator. The
      // append-only checks remain authoritative until a new validation replaces
      // this compatibility projection.
      channel.last_checked=now;
      if(retryDirective?.attemptFree&&scheduleRetry)await enqueueCommunityAcquisitionRetry(channel.channel_id,retryDirective);
      // Retained-invite FOUND gap (multi-invite recall): the validation branch
      // owns this for admitted invites; discarded/unadmitted FOUND aggregates
      // reach this branch instead (E8) and must not lose the outstanding
      // bounded recovery.
      if(scheduleRetry&&shouldScheduleFoundGapAcquisitionRetry(inspection))await enqueueCommunityAcquisitionRetry(channel.channel_id,inspection.retryDirective);
    } else {
      // Final NOT_FOUND projection after all steps (no admitted/discovered
      // invite and no FAILED/PARTIAL acquisition status). Extracted for
      // direct runtime testing without changing behavior.
      await projectNotFoundAfterInspection(channel,inspection,admittedInspection,scheduleRetry);
    }

    // P4: platform-community evidence (Whop/Skool/Circle/Patreon) observed by
    // this inspection is projected as first-class channel state, never
    // collapsed into "no community found". A confirmed paywall yields PAID;
    // any other observed surface yields COMMUNITY_INDICATED_NO_INVITE.
    // Evidence merges with existing rows by community URL and keeps the
    // strongest classification (never downgraded by a later weak observation).
    applyCommunityIntentEvidence(channel, inspection.communityIntent);

  } catch (err) {
    // Preserve any structured discovery even when validation or later
    // processing throws. If the choke-point claim itself failed, fall back to
    // the raw inspection (pre-existing behavior): this must run before catch
    // persistence and retry. Community intent is independent evidence and is
    // merged here too, otherwise a failure after inspection would erase a
    // Whop/Skool/Circle/Patreon surface from the persisted channel.
    applyCommunityIntentEvidence(channel, inspection?.communityIntent);
    reconcileDiscordDiscoveryFromInspection(channel,admittedInspection??inspection,{validationProjected:false});
    attemptFree=isAttemptFreeCommunityFailure(err);
    retryDirective=attemptFree?{attemptFree:true,code:COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE,reason:String(err?.message||err),retryAt:retryAtFromUnknown(err),retryReason:retryReasonFromError(err)}:undefined;
    if(retryDirective&&inspection?.nextClickOffsets&&Object.keys(inspection.nextClickOffsets).length)retryDirective={...retryDirective,clickOffsets:inspection.nextClickOffsets};
    if(!attemptFree)channel.scan_attempts++;
    // Durable RETRY_COMMUNITY_ACQUISITION owns the retry budget. Keep channel
    // state retryable here so an internal scan counter cannot prematurely stop
    // a job that still has durable attempts remaining.
    channel.scan_status = 'FAILED';
    if(scheduleRetry)await enqueueCommunityAcquisitionRetry(channel.channel_id,retryDirective).catch(error=>console.warn(`[CommunityAcquisition] retry scheduling failed for ${channel.channel_id}:`,error instanceof Error?error.message:error));
  } finally {
    await upsertChannel(channel);
  }
  return { debugLog: enableDebug ? finalDebugLog : undefined, inspection, retryDirective };
}

export function communityAcquisitionRetryKey(channelId:string):string{return `community-acquisition-retry:${channelId}`;}

/**
 * Operator-triggered bounded relationship-canary run. Validates the cohort
 * payload (bounds enforced) and enqueues exactly one durable job, idempotent
 * per cohort per UTC day. preventReopen:true (existing queue control) means a
 * repeat request never resets a COMPLETED/FAILED run back to PENDING: daily
 * idempotency without reopen loops. The worker re-checks enabled/kill-switch
 * at execution time, so disabling the canary stops even queued runs.
 */
export async function enqueueRelationshipCanaryRun(
  input: unknown,
  deps?: { enqueueJob?: typeof enqueueJob; checkCountryAllowed?: (country: string) => Promise<void> },
): Promise<{ jobId: string; cohortId: string }> {
  const { validateRelationshipCanaryPayload, RELATIONSHIP_CANARY_JOB_TYPE } = await import('./relationshipCanary');
  const payload = validateRelationshipCanaryPayload(input);
  // Enqueue-time exclusion boundary (same gate as search/enrichment jobs):
  // excluded targets never enter the canary queue.
  const checkAllowed = deps?.checkCountryAllowed || (async (country: string) => { await assertCountryAllowed(country, 'relationship-canary:enqueue'); });
  await checkAllowed(payload.targetCountry);
  const day = new Date().toISOString().slice(0, 10);
  const enqueue = deps?.enqueueJob || enqueueJob;
  const job = await enqueue(
    RELATIONSHIP_CANARY_JOB_TYPE,
    { ...payload },
    { idempotencyKey: `relationship-canary:${payload.cohortId}:${day}`, priority: 5, maxAttempts: 2, preventReopen: true },
  );
  return { jobId: job.id, cohortId: payload.cohortId };
}

/**
 * Dispatcher body for RELATIONSHIP_CANARY_EXPANSION jobs, extracted so the
 * production wiring (run worker → persist summary → attempt-bound complete,
 * in that order) is directly regression-testable without a database. Default
 * dependencies are the live pipeline; overrides are test seams only.
 */
export async function handleRelationshipCanaryExpansionJob(
  job: { id: string; attempts?: number; payload?: unknown },
  deps?: {
    runCanary?: (job: { id: string; payload?: unknown }) => Promise<import('./relationshipCanary').RelationshipCanarySummary>;
    persistSummary?: (jobId: string, summary: import('./relationshipCanary').RelationshipCanarySummary, attemptNumber?: number) => Promise<void>;
    completeAttempt?: (input: { jobId: string; attemptNumber: number; workerId: string }) => Promise<{ completed: boolean }>;
  },
  claim?: { workerId: string; attemptNumber: number },
): Promise<{ completed: boolean }> {
  const { processRelationshipCanaryJob, persistRelationshipCanarySummary, completeRelationshipCanaryAttempt } = await import('./relationshipCanary');
  // Forward the claim so the worker's ownership fence is live on the default
  // path too — otherwise fencing would only exist when tests inject it.
  const runDefault = (j: { id: string; payload?: unknown }) =>
    processRelationshipCanaryJob({ id: j.id, payload: j.payload }, processDiscoveredChannel, claim ? { claim } : undefined);
  const summary = await (deps?.runCanary || runDefault)(job);
  // Persist BEFORE completing: the attempt row must carry the observable
  // summary (including pre-dispatch provider failures) rather than closing
  // as COMPLETED with empty logs. Bound to this claim's attempt number.
  if (deps?.persistSummary) {
    await deps.persistSummary(job.id, summary, job.attempts);
  } else {
    const db = await getDb();
    await persistRelationshipCanarySummary(
      (text: string, values?: unknown[]) => db.query(text, values),
      job.id,
      summary,
      job.attempts,
    );
  }
  // Attempt-bound completion: a stale worker whose job was recovered and
  // re-claimed must not complete the newer retry. When this run has no claim
  // identity (defensive fallback only), no conditional completion is possible.
  if (deps?.completeAttempt) {
    return deps.completeAttempt({ jobId: job.id, attemptNumber: claim?.attemptNumber ?? job.attempts ?? 0, workerId: claim?.workerId ?? '' });
  }
  if (!claim) {
    const db = await getDb();
    await completeJob(job.id);
    return { completed: true };
  }
  const db = await getDb();
  // One dedicated client for the whole completion transaction: BEGIN/COMMIT
  // must not split across pooled connections (the helper acquires/releases).
  const result = await completeRelationshipCanaryAttempt(() => db.connect(), {
    jobId: job.id,
    attemptNumber: claim.attemptNumber,
    workerId: claim.workerId,
  });
  if (!result.completed) {
    console.warn(`[Queue Manager] Stale relationship-canary worker lost ownership of ${job.id}; leaving the active retry untouched.`);
  }
  return result;
}
/**
 * FOUND_REQUIRED_GAP scheduler decision (v2): the discovered-invite
 * validation branch must not swallow an outstanding retryable required
 * gap. Invite A stays retained/displayed through the validation projection
 * below; returning true schedules B's bounded recovery into the same durable
 * per-channel job (idempotent merge). Validation retry behavior is untouched:
 * this only *adds* the acquisition directive alongside it. Pure and
 * unit-tested; the only caller is the discovered-invite branch.
 */
/**
 * Final NOT_FOUND projection after all steps (extracted for direct runtime
 * testing): no admitted/discovered invite and no FAILED/PARTIAL acquisition
 * status. Projects absence state exactly as before, then schedules bounded
 * recovery when a FOUND+required-gap directive is outstanding (Ashish path:
 * invites retained but unadmitted, required gap unresolved). The enqueue
 * transport defaults to the durable scheduler and is injectable in tests;
 * validation, choke, status, and retry-policy semantics are untouched.
 */
/**
 * Pending-discovery-work detector for the final NOT_FOUND projection (E7).
 * The projection may only complete a channel when no discovery obligation
 * remains outstanding; otherwise it would strand the work. Pure over
 * channel + inspection state (no DB): the durable retry job is preserved by
 * never clearing scan attempts on a pending projection. Three keep-pending
 * signals:
 *  - a stored locator whose validation never reached a terminal verdict;
 *  - a FOUND+required-gap directive (invites retained, gap unresolved);
 *  - a mandatory community-surface observation that is retryable.
 *
 * The retryable-observation check intentionally reuses the shared
 * isCommunityRetryableObservation boundary. A raw `required && retryable`
 * check would treat YouTube About / recent-video-description upstream
 * failures as Discord work, converting a completed negative into FAILED and
 * scheduling a fabricated capacity retry.
 */
export function detectPendingDiscoveryWork(
  channel: Pick<ChannelRecord,'discord_candidate_locator'|'discord_validation_status'|'discord_discovery_status'>,
  inspection: {
    acquisitionOutcomes?: Array<{ surface?: unknown; outcome?: unknown; retryable?: unknown; required?: unknown; failureClass?: unknown }>;
    retrySuppressedUrls?: unknown;
    retryDirective?: unknown;
  } | null | undefined,
): { pending: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const locator = typeof channel.discord_candidate_locator === 'string' ? channel.discord_candidate_locator.trim() : '';
  const validationStatus = String(channel.discord_validation_status || '');
  // A stored locator owns pending work only while validation is genuinely
  // unfinished. FAILED_OPERATIONAL is a terminal operational verdict; treating
  // it as unfinished would reopen an exhausted retry forever.
  const locatorUnvalidated = !!locator && (
    validationStatus === 'RETRY_PENDING' ||
    validationStatus === 'NOT_STARTED'
  );
  if (locatorUnvalidated) reasons.push('locator-unvalidated');
  if (shouldScheduleFoundGapAcquisitionRetry(inspection)) reasons.push('found-gap-retry');
  const outcomes = Array.isArray(inspection?.acquisitionOutcomes) ? inspection.acquisitionOutcomes : [];
  const suppressed = Array.isArray(inspection?.retrySuppressedUrls) ? inspection.retrySuppressedUrls.map(String) : undefined;
  if (hasRetryableCommunityAcquisitionFailure(outcomes as Parameters<typeof hasRetryableCommunityAcquisitionFailure>[0], suppressed)) {
    reasons.push('required-retryable-observation');
  }
  return { pending: reasons.length > 0, reasons };
}

/** Maximum locator-only pending projections before the stored locator is
 * treated as operationally exhausted. Bound is the durable retry job's own
 * 5-attempt ceiling: a stale locator can no longer re-arm itself forever when
 * a fresh inspection keeps finding no replacement candidate. */
export const LOCATOR_PENDING_PROJECTION_LIMIT = 5;

export async function projectNotFoundAfterInspection(
  channel: ChannelRecord,
  inspection: {
    acquisitionOutcomes?: Array<{ outcome?: unknown; retryable?: unknown; failureClass?: unknown }>;
    retryDirective?: CommunityRetryDirective;
    nextClickOffsets?: Record<string, number>;
  } | null | undefined,
  admittedInspection: Parameters<typeof reconcileDiscordDiscoveryFromInspection>[1],
  scheduleRetry: boolean,
  enqueue: (channelId: string, directive?: CommunityRetryDirective) => Promise<void> = enqueueCommunityAcquisitionRetry,
): Promise<void> {
      // Pending-work guard (E7): never project COMPLETED/attempts=0 onto a
      // channel that still owns discovery work — a stored unvalidated locator,
      // a FOUND+required-gap directive, or a retryable community observation.
      // Project operational failure + RETRY_PENDING instead and preserve the
      // durable job: any directive merges idempotently into the existing
      // per-channel retry job.
      //
      // Locator-only pending work is bounded by the channel's durable scan
      // attempts. Without this bound a stored locator whose site never yields
      // it again re-arms RETRY_PENDING on every pass (and the idempotent
      // enqueue resets job attempts after terminal states), so the channel
      // never reaches a verdict. After the same 5-attempt ceiling as the retry
      // job, the locator becomes terminal FAILED_OPERATIONAL and the normal
      // absence projection runs. Other pending reasons keep their established
      // unbounded-preservation semantics because they own real acquisition work.
      const pendingWork=detectPendingDiscoveryWork(channel,inspection);
      const locatorOnly=pendingWork.reasons.length===1&&pendingWork.reasons[0]==='locator-unvalidated';
      const locatorExhausted=locatorOnly&&Math.max(0,Number(channel.scan_attempts)||0)>=LOCATOR_PENDING_PROJECTION_LIMIT;
      const alreadyValidatedSuccess=hasEstablishedValidatedDiscordSelection(channel);
      // Exhaustion belongs to the stored locator's unfinished retry work, not
      // to the serving selection. It must become terminal even when an
      // established serving selection exists: leaving RETRY_PENDING/NOT_STARTED
      // in place lets the later scan_attempts reset recreate
      // `locator-unvalidated` pending work, so the channel would re-arm the
      // same retry cycle forever. The established Discord projection
      // (status/invite/discovery) stays protected by the
      // `alreadyValidatedSuccess` guards below.
      if(locatorExhausted){
        channel.discord_validation_status='FAILED_OPERATIONAL';
      }else if(locatorOnly){
        channel.scan_attempts=Math.max(0,Number(channel.scan_attempts)||0)+1;
      }
      if(pendingWork.pending&&!locatorExhausted){
        if(!alreadyValidatedSuccess){
          channel.discord_status='UNCERTAIN';
          channel.discord_liveness_status=channel.discord_candidate_locator?(channel.discord_liveness_status||'UNCERTAIN'):'NOT_CHECKED';
          channel.discord_resolution_status=channel.discord_resolution_status||'RESOLVED';
          channel.discord_validation_status='RETRY_PENDING';
          channel.discord_discovery_status=channel.discord_candidate_locator?'DISCOVERED_VALIDATION_FAILED':(channel.discord_discovery_status||'NOT_DISCOVERED');
        }
        channel.scan_status='FAILED';
        reconcileDiscordDiscoveryFromInspection(channel,admittedInspection,{validationProjected:false});
        // Pending work must always own a durable job. A locator/NOT_STARTED
        // or required-retryable observation may not have produced an
        // inspection directive, so fall back to a bounded retry directive
        // rather than leaving pending state with no worker to consume it.
        // The fallback is NOT attempt-free and is not labeled a capacity
        // deferral: real inspection work already ran and must consume one
        // durable attempt (only proven capacity/browser no-start keeps
        // attempt-free semantics).
        const pendingDirective:CommunityRetryDirective|undefined=inspection?.retryDirective||
          (scheduleRetry?{
            attemptFree:false,
            code:COMMUNITY_ACQUISITION_REQUIRED,
            reason:`Pending discovery work: ${pendingWork.reasons.join(', ')}`,
            retryReason:COMMUNITY_RETRY_REASON.COMMUNITY_REQUIRED_ACQUISITION_FAILURE,
          }:undefined);
        if(scheduleRetry&&pendingDirective)await enqueue(channel.channel_id,inspection?.nextClickOffsets&&Object.keys(inspection.nextClickOffsets).length?{...pendingDirective,clickOffsets:inspection.nextClickOffsets}:pendingDirective);
        channel.last_checked=new Date().toISOString();
        return;
      }
      // Nothing Found After All Steps
      if(!alreadyValidatedSuccess){
        channel.discord_status = channel.discord_candidate_locator?'UNCERTAIN':'NOT_FOUND';
        if(!channel.discord_candidate_locator){channel.discord_resolution_status='NOT_ATTEMPTED';channel.discord_liveness_status='NOT_CHECKED';channel.discord_relevance_status='NOT_CHECKED';channel.discord_validation_status='COMPLETED';}
        // Only a complete inspection with no prior established discovery may
        // project absence. An established VALIDATED candidate must not be
        // downgraded merely because this later inspection retained no invite.
        if(!channel.discord_candidate_locator)channel.discord_discovery_status='NOT_DISCOVERED';
        else channel.discord_discovery_status='DISCOVERED_VALIDATION_FAILED';
      }
      channel.scan_status = 'COMPLETED';
      channel.scan_attempts = 0;
      reconcileDiscordDiscoveryFromInspection(channel,admittedInspection,{validationProjected:false});
      // FOUND_REQUIRED_GAP with no admitted invite: the validation branch and
      // the FAILED/PARTIAL branch both skipped, so an outstanding retryable
      // required gap would be silently lost here. Schedule its bounded
      // recovery into the same durable per-channel job instead. Status,
      // choke admission, and validation behavior above are untouched.
      if(scheduleRetry&&shouldScheduleFoundGapAcquisitionRetry(inspection))await enqueue(channel.channel_id,inspection.retryDirective);
      channel.last_checked = new Date().toISOString();
}
export function shouldScheduleFoundGapAcquisitionRetry(inspection:{
  acquisitionOutcomes?:Array<{outcome?:unknown;retryable?:unknown;failureClass?:unknown}>;
  retryDirective?:unknown;
}|null|undefined):boolean{
  if(!inspection||typeof inspection!=='object')return false;
  if(!inspection.retryDirective||typeof inspection.retryDirective!=='object')return false;
  const outcomes=Array.isArray(inspection.acquisitionOutcomes)?inspection.acquisitionOutcomes:[];
  return outcomes.some(item=>item&&typeof item==='object'
    &&(item as {outcome?:unknown}).outcome==='FOUND'
    &&(item as {retryable?:unknown}).retryable===true
    &&FOUND_GAP_RETRYABLE_FAILURE_CLASSES.has(String((item as {failureClass?:unknown}).failureClass||'')));
}

/**
 * Suppressed-retry job completion (v2): when no active retry directive
 * exists precisely because deterministic-tail suppression took retry
 * ownership away, the current retry job must complete normally instead of
 * re-entering the same work through the generic unresolved-failure path.
 * True only with a non-empty suppression list and a failed scan state;
 * browser-capacity attempt-free deferral (which throws before this check)
 * and all other paths are untouched. Pure and unit-tested.
 */
export function shouldCompleteSuppressedRetryJob(inspection:{
  retryDirective?:unknown;
  retrySuppressedUrls?:unknown;
}|null|undefined|void,scanStatus:unknown):boolean{
  if(!inspection||typeof inspection!=='object')return false;
  if(inspection.retryDirective)return false;
  const suppressed=(inspection as {retrySuppressedUrls?:unknown}).retrySuppressedUrls;
  if(!Array.isArray(suppressed)||!suppressed.length)return false;
  return scanStatus==='FAILED'||scanStatus==='FAILED_PERMANENT';
}

export async function enqueueCommunityAcquisitionRetry(channelId:string,directive?:CommunityRetryDirective,source:'INSPECTION'|'RECOVERY'|'LEGACY'='INSPECTION',clientOverride?:{query:(sql:string,params?:unknown[])=>Promise<{rows:unknown[];rowCount:number}>}):Promise<void>{
  const metadata=buildCommunityRetryJobMetadata({
    code:directive?.code||COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE,
    retryReason:directive?.retryReason||'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
    retrySource:source,
    clickOffsets:directive?.clickOffsets
  });
  // Saturation deferrals scheduled from a fresh inspection never pass through
  // the retry-worker deferral branch; count them at the durable enqueue point.
  if(String(directive?.reason||'').includes('RENDERED_FALLBACK_SATURATED'))bumpCommunitySaturationDeferral();
  const job=await enqueueJob('RETRY_COMMUNITY_ACQUISITION',{channelId,...metadata},{idempotencyKey:communityAcquisitionRetryKey(channelId),priority:15,maxAttempts:5,runAfter:directive?.retryAt?new Date(directive.retryAt).toISOString():undefined,clientOverride});
  // Preserve a pending job's original ownership and retry window while merging
  // the latest attributable reason into its durable payload. Per-seed click
  // progress is monotonic, and the merge must read the CURRENT row inside this
  // statement: a retry worker can advance the PROCESSING job between
  // enqueueJob's RETURNING and this update, and writing back the earlier copy
  // would rewind its newer offsets. A fresh scan has no previous offset map,
  // so its lower first-page offsets must never replace a retry's higher
  // progress. When this enqueue carries offsets, keep the greater stored or
  // incoming offset for each seed while still merging the rest of the
  // incoming metadata (retry code/reason/source); otherwise leave the
  // existing offset map untouched.
  const runner:{query:(sql:string,params?:unknown[])=>Promise<unknown>} = clientOverride||await getDb();
  await runner.query(
    `UPDATE jobs SET payload=CASE
       WHEN jsonb_typeof($2::jsonb->'clickOffsets')='object'
         THEN ((payload || ($2::jsonb - 'clickOffsets')) - 'clickOffsets') || jsonb_build_object(
           'clickOffsets',
           COALESCE((
             SELECT jsonb_object_agg(keys.key, GREATEST(
               CASE WHEN jsonb_typeof(payload->'clickOffsets')='object'
                      AND jsonb_typeof(payload->'clickOffsets'->keys.key)='number'
                    THEN (payload->'clickOffsets'->keys.key #>> '{}')::numeric ELSE 0 END,
               CASE WHEN jsonb_typeof($2::jsonb->'clickOffsets'->keys.key)='number'
                    THEN ($2::jsonb->'clickOffsets'->keys.key #>> '{}')::numeric ELSE 0 END
             ))
             FROM (
               SELECT jsonb_object_keys(
                 CASE WHEN jsonb_typeof(payload->'clickOffsets')='object'
                      THEN payload->'clickOffsets' ELSE '{}'::jsonb END
               ) AS key
               UNION
               SELECT jsonb_object_keys($2::jsonb->'clickOffsets') AS key
             ) keys
             WHERE (jsonb_typeof(payload->'clickOffsets')='object'
                    AND jsonb_typeof(payload->'clickOffsets'->keys.key)='number')
                OR jsonb_typeof($2::jsonb->'clickOffsets'->keys.key)='number'
           ), '{}'::jsonb)
         )
       ELSE payload || $2::jsonb END,
       updated_at=now()
     WHERE id=$1 AND status IN('PENDING','PROCESSING')`,
    [job.id,JSON.stringify(metadata)]
  );
}

export function operationalEnrichmentRecoveryKey(channelId:string):string{return `operational-enrichment-recovery:${channelId}`;}
/**
 * Pure payload constructor for operational enrichment recovery. The nullable
 * channel.country passes through verbatim as targetCountry (unknown country
 * is legitimate and the exclusion gate resolves it as allowed); no default
 * country is ever invented here. Extracted so the mapping is unit-testable
 * without a database; the enqueue path itself is unchanged.
 */
export function buildOperationalEnrichmentRecoveryPayload(channel:Pick<ChannelRecord,'channel_id'|'channel_name'|'youtube_url'|'country'|'discovery_source'|'subscriber_count'|'channel_thumbnail_url'>,reasonCodes:string[]){
  return {channelId:channel.channel_id,targetCountry:channel.country,source:(channel.discovery_source||'recovery') as DiscoverySource,enrichmentStage:1,evidenceAction:'CHANNEL_RECENT_METADATA',candidate:{channelId:channel.channel_id,channelName:channel.channel_name,youtubeUrl:channel.youtube_url,locationTag:channel.country,description:'',videoTitles:[],channelLinks:[],subscriberCount:channel.subscriber_count,channelThumbnailUrl:channel.channel_thumbnail_url,enrichmentStage:1},recoveryReasonCodes:reasonCodes};
}
export async function enqueueOperationalEnrichmentRecoveryJob(channel:ChannelRecord,reasonCodes:string[],clientOverride?:any):Promise<void>{
  const job=await enqueueJob('ENRICH_CHANNEL',buildOperationalEnrichmentRecoveryPayload(channel,reasonCodes),{idempotencyKey:operationalEnrichmentRecoveryKey(channel.channel_id),priority:10,maxAttempts:4,clientOverride});
  await (clientOverride||await getDb()).query(`UPDATE jobs SET first_transient_failure_at=NULL WHERE id=$1 AND status='PENDING'`,[job.id]);
}

/**
 * Re-tests stored channels in the database against the updated Hard Exclusion Engine.
 * Removes / marks previously accepted excluded-country channels as REJECTED.
 *
 * Memory-bounded: the audit streams narrow batches instead of loading every
 * stored channel. Country revalidation covers non-REJECTED channels (this
 * loop never un-REJECTs, so re-stamping already-REJECTED rows is idempotent
 * churn); a second pass preserves the previous Discord invite cleanup for
 * already-REJECTED rows. The full row loads only for channels that actually
 * need a write (via getChannelById + upsertChannel, identical semantics to
 * the previous full-table loop). Each batch is released before the next is
 * fetched, so at most one 200-row batch of narrow rows plus one full row is
 * ever retained.
 */
const EXCLUSION_AUDIT_BATCH_SIZE = 200;

export type ExclusionAuditScope = 'audit' | 'rejected-cleanup';
export interface ExclusionAuditCursor {
  cursorSeen: string | null;
  cursorId: string;
}
export interface ExclusionAuditBatchRow {
  channel_id: string;
  channel_name: string;
  country: string | null;
  discord_status: string;
  discord_invite: string | null;
  scan_status: string;
  cursor_seen: string;
}
export interface ExclusionAuditDb {
  query: (sql: string, params: any[]) => Promise<{ rows: ExclusionAuditBatchRow[]; rowCount: number | null }>;
}

/**
 * One keyset batch of audit candidates. The cursor is PostgreSQL-rendered
 * text (`first_seen::text`) passed back unchanged — never through JavaScript
 * Date, which drops microsecond precision and could skip rows at a batch
 * boundary. `channel_id` breaks ties for equal timestamps.
 */
export async function fetchExclusionAuditBatch(
  db: ExclusionAuditDb,
  cursor: ExclusionAuditCursor,
  limit: number,
  scope: ExclusionAuditScope = 'audit'
): Promise<{ rows: ExclusionAuditBatchRow[]; nextCursor: ExclusionAuditCursor | null }> {
  const statusPredicate = scope === 'rejected-cleanup'
    ? `country_status = 'REJECTED' AND discord_status IN ('DEAD','NON_TRADING','UNCERTAIN') AND discord_invite IS NOT NULL`
    : `country_status IS DISTINCT FROM 'REJECTED'`;
  const res = await db.query(
    `SELECT channel_id, channel_name, country, discord_status, discord_invite, scan_status, first_seen::text AS cursor_seen FROM channels WHERE ${statusPredicate} AND ($1::timestamptz IS NULL OR (first_seen, channel_id) < ($1::timestamptz, $2::text)) ORDER BY first_seen DESC, channel_id DESC LIMIT $3`,
    [cursor.cursorSeen, cursor.cursorId, limit]
  );
  const rows = res.rows;
  if (!rows.length) return { rows, nextCursor: null };
  const last = rows[rows.length - 1];
  return { rows, nextCursor: { cursorSeen: last.cursor_seen, cursorId: last.channel_id } };
}

export type ExclusionAuditRowAction = 'reject-write' | 'invite-cleanup' | 'none';
/**
 * Per-row audit decision, mirroring the previous full-table loop branches:
 * a REJECTED validation writes only for not-yet-rejected rows (re-stamping
 * already-REJECTED rows is dropped as idempotent churn), otherwise the
 * Discord persistence rule applies to every row including already-REJECTED
 * ones. A channel explicitly withheld for human review (`NEEDS_REVIEW`) is
 * the one exception: the review-only projection intentionally stores the
 * retained invite on an UNCERTAIN row as review evidence, so the audit must
 * not clear it before the review decision has been made. Rejected-cleanup
 * still enforces the persistence rule, and a resolved review leaves
 * NEEDS_REVIEW so the normal cleanup resumes.
 */
export function decideExclusionAuditRowAction(input: {
  alreadyRejected: boolean;
  validationStatus: string;
  discordStatus: unknown;
  discordInvite: unknown;
  scanStatus?: unknown;
}): ExclusionAuditRowAction {
  // The status branch runs first so a fresh REJECTED write is never blocked by
  // a stale invite, matching the pre-batching if/else-if order. Already-
  // REJECTED rows are never re-stamped (idempotent churn), but the Discord
  // persistence rule still applies to them: an invite on a
  // DEAD/NON_TRADING/UNCERTAIN channel is cleared.
  if (input.validationStatus === 'REJECTED' && !input.alreadyRejected) return 'reject-write';
  if (
    (input.discordStatus === 'DEAD' ||
      input.discordStatus === 'NON_TRADING' ||
      input.discordStatus === 'UNCERTAIN') &&
    input.discordInvite !== null
  ) {
    if (!input.alreadyRejected && input.scanStatus === 'NEEDS_REVIEW') return 'none';
    return 'invite-cleanup';
  }
  return 'none';
}

export async function auditExistingChannelsWithExclusionEngine(): Promise<{ total: number; rejected: number }> {
  try {
    const db = await getDb();
    let total = 0;
    let rejectedCount = 0;
    let cleanedInvites = 0;
    for (const scope of ['audit', 'rejected-cleanup'] as const) {
      const alreadyRejected = scope === 'rejected-cleanup';
      let cursor: ExclusionAuditCursor = { cursorSeen: null, cursorId: '' };
      for (;;) {
        const { rows, nextCursor } = await fetchExclusionAuditBatch(db, cursor, EXCLUSION_AUDIT_BATCH_SIZE, scope);
        if (!rows.length) break;
        for (const candidate of rows) {
          // Preserve the pre-batching `total` contract: channels whose country
          // is re-tested. The rejected-cleanup scope performs no validation, so
          // it must not inflate the re-tested count.
          if (!alreadyRejected) total++;
          // Country revalidation applies only to the audit scope: the
          // rejected-cleanup scope never re-judges country status (the row is
          // already REJECTED and the audit never un-REJECTs), so validation
          // there would be dead work. Cleanup is decided from the persistence
          // rule alone and is therefore independent of validation outcome.
          // Provenance boundary (see country revalidation above): the bulk audit
          // has no stored bio text available, and trail prose quotes country names
          // from prior validation/ acquisition logs. Feeding it as the Bio would
          // manufacture P2 evidence and terminally REJECT clean channels, so the
          // audit may only use the creator-level channelName. Unproven → untouched.
          const valRes = alreadyRejected
            ? null
            : await validateChannelCountry(
                {
                  channelName: candidate.channel_name,
                  description: '',
                  videoTitles: [candidate.channel_name],
                  externalLinks: candidate.discord_invite ? [candidate.discord_invite] : []
                },
                null
              );

          const action = decideExclusionAuditRowAction({
            alreadyRejected,
            validationStatus: valRes?.status ?? '',
            discordStatus: candidate.discord_status,
            discordInvite: candidate.discord_invite,
            scanStatus: candidate.scan_status
          });
          if (action === 'reject-write') {
            if (!valRes) continue; // unreachable: only non-rejected rows can write a rejection
            rejectedCount++;
            const channel = await getChannelById(candidate.channel_id);
            if (!channel) continue;
            channel.country_status = 'REJECTED';
            channel.confidence_score = valRes.score;
            channel.scan_status = 'COMPLETED';
            // Project the newly detected creator country (never retain a stale
            // attribution the fresh validation overturned). scope_eligibility
            // follows from the final country inside upsertChannel; a missing
            // detection keeps the prior country rather than nulling truth.
            if (valRes.detectedCreatorCountry) {
              channel.country = valRes.detectedCreatorCountry;
            }

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
          } else if (action === 'invite-cleanup') {
            // Enforce persistence rule: never store invite URLs for DEAD, NON_TRADING, or UNCERTAIN channels
            const channel = await getChannelById(candidate.channel_id);
            if (!channel) continue;
            channel.discord_invite = null;
            await upsertChannel(channel);
            cleanedInvites++;
          }
        }

        if (!nextCursor || rows.length < EXCLUSION_AUDIT_BATCH_SIZE) break;
        cursor = nextCursor;
      }
    }

    console.log(`[Database Audit] Re-tested ${total} stored channels: ${rejectedCount} excluded channels marked REJECTED; cleared ${cleanedInvites} stale invites under the Discord persistence rule.`);
    return { total, rejected: rejectedCount };
  } catch (err) {
    console.error('Error during database channel exclusion audit:', err);
    return { total: 0, rejected: 0 };
  }
}

export type ManualRecheckErrorClass = 'TIMEOUT' | 'CANCELLED' | 'RATE_LIMIT' | 'TRANSIENT' | 'PERMANENT_INPUT' | 'CREDENTIALS_EXHAUSTED';

export interface ManualRecheckResult {
  success: boolean;
  message: string;
  channel?: ChannelRecord;
  debugLog?: any;
  code?: string;
  retryable?: boolean;
    errorClass?: ManualRecheckErrorClass;
  retryAt?: number;
  retryAfterMs?: number;
  /** Probe allocation refusals remain policy waits through the worker bridge. */
  probeQuotaExceeded?: boolean;
  probeQuotaDisabled?: boolean;
  probeQuotaUnavailable?: boolean;
  languageContext?: ExplicitTerminologyLanguageContext;
}
const OFFICIAL_RECHECK_UNITS_PER_PROVIDER = 101;
const MANUAL_RECHECK_ERROR_CLASSES = new Set<ManualRecheckErrorClass>([
  'TIMEOUT', 'CANCELLED', 'RATE_LIMIT', 'TRANSIENT', 'PERMANENT_INPUT', 'CREDENTIALS_EXHAUSTED'
]);
const MANUAL_RECHECK_TRANSIENT_CLASSES = new Set<ManualRecheckErrorClass>([
  'TIMEOUT', 'CANCELLED', 'RATE_LIMIT', 'TRANSIENT', 'CREDENTIALS_EXHAUSTED'
]);


export async function reserveOfficialRecheckQuota(operationType: string, operationId: string): Promise<boolean> {
  const dailyBudget = getDailyYouTubeQuotaBudget();
  const allocationPercent = Math.max(1, Math.min(100, Number(await getAppSetting('discovery_enrichment_quota_percent', '10')) || 10));
  const maximumProviderAttempts = Math.max(1, getYouTubeKeyPool().length);
  const reservedUnits = OFFICIAL_RECHECK_UNITS_PER_PROVIDER * maximumProviderAttempts;
  return tryReserveQuota({
    operationType,
    operationId,
    allocation: 'ENRICHMENT',
    units: reservedUnits,
    dailyBudget,
    allocationPercent
  });
}

/** executeProviderCall wraps quota refusals as a provider error, so the probe
 * policy marker must be recovered from the cause chain before classification. */
function probeQuotaControlInChain(error: any, depth = 0): any {
  if (!error || typeof error !== 'object' || depth > 4) return null;
  if (isProbeQuotaControlError(error)) return error;
  return probeQuotaControlInChain(error.cause, depth + 1);
}

export function classifyManualRecheckAcquisitionFailure(error: any): {
  errorClass?: ManualRecheckErrorClass;
  retryable: boolean;
  code: string;
  retryAt?: number;
  retryAfterMs?: number;
  probeQuotaExceeded?: boolean;
  probeQuotaDisabled?: boolean;
  probeQuotaUnavailable?: boolean;
} {
  const message = String(error?.message || error || '');
  const rawErrorClass = String(error?.errorClass || '').toUpperCase() as ManualRecheckErrorClass;
  const code = String(error?.code || error?.cause?.code || 'MANUAL_RESCAN_UPSTREAM_FAILURE');
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const retryAt = Number(error?.retryAt);
  const retryAfterMs = Number(error?.retryAfterMs);
  const probeControl = probeQuotaControlInChain(error);

  // Probe allocation refusals are policy/capacity waits, not ordinary provider
  // failures. Preserve the marker and reset time so maintenance recovery can
  // defer attempt-free until capacity returns instead of aging out as FAILED.
  if (probeControl) {
    const probeRetryAt = Number(probeControl.retryAt);
    return {
      errorClass: MANUAL_RECHECK_ERROR_CLASSES.has(rawErrorClass) ? rawErrorClass : undefined,
      retryable: true,
      code: String(probeControl.code || code),
      retryAt: Number.isFinite(probeRetryAt) ? probeRetryAt : (Number.isFinite(retryAt) ? retryAt : undefined),
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      probeQuotaExceeded: probeControl.probeQuotaExceeded === true,
      probeQuotaDisabled: probeControl.probeQuotaDisabled === true,
      probeQuotaUnavailable: probeControl.probeQuotaUnavailable === true || probeControl.code === 'PROBE_QUOTA_UNAVAILABLE'
    };
  }

  // Attempt-free infrastructure retries are deliberately opt-in. The
  // upstream error itself must already carry a recognized transient
  // class and explicitly say it is retryable. Status codes, messages,
  // cooldown codes, and network-looking strings must never manufacture
  // transient semantics for migration-091 recovery.
  if (MANUAL_RECHECK_ERROR_CLASSES.has(rawErrorClass)) {
    return {
      errorClass: rawErrorClass,
      retryable: error?.retryable === true && MANUAL_RECHECK_TRANSIENT_CLASSES.has(rawErrorClass),
      code,
      retryAt: Number.isFinite(retryAt) ? retryAt : undefined,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined
    };
  }

  // Untyped permanent/not-found outcomes may still be identified for
  // diagnostics, but they never receive attempt-free retry semantics.
  if (status === 404 || /channel ['"][^'"]+['"] was not found|channel not found|does not exist|deleted channel/i.test(message)) {
    return { errorClass: 'PERMANENT_INPUT', retryable: false, code };
  }
  if ([400, 422].includes(status)) {
    return { errorClass: 'PERMANENT_INPUT', retryable: false, code };
  }

  // Every other untyped failure consumes the bounded normal attempt.
  return {
    retryable: false,
    code,
    retryAt: Number.isFinite(retryAt) ? retryAt : undefined,
    retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined
  };
}

/**
 * Triggers a manual re-scan for a specific channel.
 * Runs 4-step inspection synchronously with force live YouTube scraping.
 * Does NOT schedule any automatic future rechecks.
 */
export async function triggerManualRecheck(
  channelId: string,
  enableDebug?: boolean,
  quotaAlreadyReserved = false
): Promise<ManualRecheckResult> {
  const channel = await getChannelById(channelId);
  if (!channel) {
    return { success: false, message: 'Channel not found in database.', code: 'MANUAL_RESCAN_CHANNEL_NOT_FOUND', retryable: false, errorClass: 'PERMANENT_INPUT' };
  }

  if (channel.scan_status === 'FAILED_PERMANENT') {
    const trigger = shouldReactivateCommunityRecovery(channel, undefined, true);
    if (trigger.reactivate) {
      const reactivated = reactivateCommunityRecovery(channel, trigger.reasonCodes);
      await upsertChannel(reactivated);
      Object.assign(channel, reactivated);
    }
  }

  if (channel.trading_status === 'HUMAN_REJECTED') {
    return { success: false, message: 'Human-rejected channels require the authenticated, audited force-rescan review action.', code: 'MANUAL_RESCAN_POLICY_INELIGIBLE', retryable: false, channel };
  }

  const exclusion = await getCountryExclusion(channel.country);
  if (exclusion) {
    console.warn(JSON.stringify({ event: 'excluded_country_blocked', country: exclusion.country, reason: exclusion.reason, context: 'manual_recheck', channelId, timestamp: new Date().toISOString() }));
    return { success: false, message: `Manual re-scan blocked because ${exclusion.country} is excluded: ${exclusion.reason}`, code: 'MANUAL_RESCAN_POLICY_INELIGIBLE', retryable: false, channel };
  }

  // A stored known-low audience count must not spend recheck quota: the
  // low-audience gate would skip this channel before any enrichment work.
  if (evaluateLowAudienceGate(channel.subscriber_count).shouldSkipDeepEnrichment) {
    return { success: false, message: `Manual re-scan skipped: ${channel.subscriber_count} subscribers is below the 30-subscriber budget gate.`, code: 'MANUAL_RESCAN_LOW_AUDIENCE_SKIP', retryable: false, channel };
  }

  const quotaOperationId = `manual-recheck:${channelId}:${randomUUID()}`;
  let ownsQuotaReservation = false;
  let providerAttempted = false;

  if (!quotaAlreadyReserved) {
    const quotaReserved = await reserveOfficialRecheckQuota('MANUAL_RECHECK', quotaOperationId);
    if (!quotaReserved) {
      return {
        success: false,
        message: 'Manual re-scan is temporarily unavailable because the official YouTube enrichment quota allocation is exhausted.',
        code: 'QUOTA_ALLOCATION_EXHAUSTED',
        retryable: true,
        errorClass: 'RATE_LIMIT',
        channel
      };
    }
    ownsQuotaReservation = true;
  }

  try {
    const fallback: DiscoveredChannelRaw = {
      channelId: channel.channel_id,
      channelName: channel.channel_name,
      youtubeUrl: channel.youtube_url,
      description: channel.channel_name,
      videoTitles: [channel.channel_name],
      channelLinks: channel.discord_invite ? [channel.discord_invite] : [],
      channelThumbnailUrl: channel.channel_thumbnail_url
    };

    let freshCandidate: DiscoveredChannelRaw;
    try {
      providerAttempted = true;
      // Manual recheck runs outside a queue job, so it must establish the
      // persisted provenance itself. A probe-ingested channel is sticky PROBE;
      // fetching as NORMAL here would spend ordinary quota (and could be
      // refused when the ordinary path is fenced).
      freshCandidate = await runWithOfficialYouTubeQuotaOrigin(
        channel.quota_origin === 'PROBE' ? 'PROBE' : 'NORMAL',
        `manualRecheck:${channelId}`,
        () => fetchYouTubeChannelEnrichment(channelId, fallback, 1),
      );
    } catch (error: any) {
      const detail = error instanceof Error ? error.message : String(error);
      const failure = classifyManualRecheckAcquisitionFailure(error);
      const probeControl = failure.probeQuotaExceeded === true
        || failure.probeQuotaDisabled === true
        || failure.probeQuotaUnavailable === true;
      console.warn(`[Manual Recheck] Fresh YouTube creator acquisition failed for ${channelId}; preserving prior trading classification: ${detail}`);
      return {
        success: false,
        message: `Manual re-scan could not acquire fresh YouTube creator evidence. Existing trading classification was preserved. ${detail}`,
        code: probeControl ? failure.code : 'MANUAL_RESCAN_UPSTREAM_FAILURE',
        retryable: failure.retryable,
        errorClass: failure.errorClass,
        retryAt: failure.retryAt,
        retryAfterMs: failure.retryAfterMs,
        probeQuotaExceeded: failure.probeQuotaExceeded === true,
        probeQuotaDisabled: failure.probeQuotaDisabled === true,
        probeQuotaUnavailable: failure.probeQuotaUnavailable === true,
        channel
      };
    }

    freshCandidate.enrichmentStage = Math.max(1, freshCandidate.enrichmentStage || 0);
    freshCandidate.matchedDocument = { type: 'MANUAL', locator: `recheck:${channelId}` };
    console.log(`[Manual Reclassification Started] Channel: ${channel.channel_name} (${channel.channel_id})`);

    try {
      const outcome = await processChannelThroughPipeline(freshCandidate, channel.country, 'recheck', true, true);
      const updatedChannel = outcome.channelRecord || await getChannelById(channelId) || undefined;
      console.log(`[Manual Reclassification Completed] Channel: ${channel.channel_name}, Trading Status: ${updatedChannel?.trading_status || outcome.tradingStatus}, Score: ${updatedChannel?.trading_confidence_score ?? 'unknown'}, Discord Status: ${updatedChannel?.discord_status || outcome.discordStatus}`);
      return {
        success: true,
        message: `Manual re-scan completed for ${channel.channel_name}. Trading classification and downstream inspection were refreshed from current evidence.`,
        channel: updatedChannel,
        languageContext: selectExplicitTerminologyLanguageContext(freshCandidate)
      };
    } catch (error: any) {
      const detail = error instanceof Error ? error.message : String(error);
      const preserved = await getChannelById(channelId) || channel;
      const code = String(error?.code || 'MANUAL_RESCAN_OPERATIONAL_FAILURE');
      const rawErrorClass = String(error?.errorClass || '').toUpperCase() as ManualRecheckErrorClass;
      const typedTransient = MANUAL_RECHECK_TRANSIENT_CLASSES.has(rawErrorClass) && error?.retryable === true;
      console.warn(`[Manual Recheck] Reclassification failed operationally for ${channelId}; preserving prior decision where no complete classification was produced: ${detail}`);

      if (canContinueCommunityInspectionAfterDegradedManualClassification({
        existingTradingStatus: preserved.trading_status,
        errorCode: code
      })) {
        console.warn(`[Manual Recheck] Gemini classification coverage is degraded for already-confirmed trading creator ${channelId}; preserving TRADING_CONFIRMED and continuing fresh community inspection.`);
        try {
          preserved.trading_status = 'TRADING_CONFIRMED';
          await inspectAndValidateChannel(preserved, freshCandidate, true, enableDebug, false);
          const communityRefreshed = await getChannelById(channelId) || preserved;
          const communityIncomplete = communityRefreshed.scan_status === 'FAILED' || communityRefreshed.scan_status === 'FAILED_PERMANENT';
          if (communityIncomplete) {
            return {
              success: false,
              message: `Manual re-scan preserved the existing trading classification because semantic provider coverage was degraded, but the fresh Discord/community inspection did not complete reliably.`,
              code: 'MANUAL_RESCAN_COMMUNITY_INCOMPLETE',
              retryable: true,
              errorClass: 'TRANSIENT',
              channel: communityRefreshed
            };
          }
          return {
            success: true,
            message: `Manual re-scan preserved the existing TRADING_CONFIRMED classification while semantic provider coverage was degraded, and refreshed Discord/community inspection from current evidence.`,
            channel: communityRefreshed
          };
        } catch (communityError: any) {
          const communityDetail = communityError instanceof Error ? communityError.message : String(communityError);
          console.warn(`[Manual Recheck] Community-only continuation failed for ${channelId}: ${communityDetail}`);
          return {
            success: false,
            message: `Manual re-scan preserved the existing trading classification because semantic provider coverage was degraded, but fresh Discord/community inspection failed operationally. ${communityDetail}`,
            code: 'MANUAL_RESCAN_COMMUNITY_INCOMPLETE',
            retryable: true,
            errorClass: 'TRANSIENT',
            channel: await getChannelById(channelId) || preserved
          };
        }
      }

      return {
        success: false,
        message: `Manual re-scan could not complete a reliable trading reclassification. Existing classification was preserved where the classifier had incomplete provider coverage. ${detail}`,
        code,
        retryable: typedTransient,
        errorClass: MANUAL_RECHECK_ERROR_CLASSES.has(rawErrorClass) ? rawErrorClass : undefined,
        retryAt: Number.isFinite(Number(error?.retryAt)) ? Number(error.retryAt) : undefined,
        retryAfterMs: Number.isFinite(Number(error?.retryAfterMs)) ? Number(error.retryAfterMs) : undefined,
        channel: preserved
      };
    }
  } finally {
    if (ownsQuotaReservation) {
      await finishQuotaReservation('MANUAL_RECHECK', quotaOperationId, providerAttempted)
        .catch(error => console.error(`[Manual Recheck] Failed to finalize quota reservation ${quotaOperationId}:`, error));
    }
  }
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
function manualVariants(query: string, vocab?: Awaited<ReturnType<typeof getCountryVocabularies>>[number]): string[] {
  return [...new Set([query, vocab?.native_trading_terminology?.[0] ? `${query} ${vocab.native_trading_terminology[0]}` : '', vocab?.common_content_format_names?.[0] ? `${query} ${vocab.common_content_format_names[0]}` : ''].filter(Boolean))];
}

async function executeManualSearchPage(sessionId: string, pageNumber: number, pageToken: string | null, variantIndex = 0, jobId?: string): Promise<any> {
  const session = await getManualSearchSession(sessionId);
  if (!session || session.status !== 'RUNNING') return session;
  // A completed observation is the idempotency boundary for retried queue jobs.
  if (session.pagesProcessed >= pageNumber) return session;
  const maxPages = Math.max(1, Number(await getAppSetting('manual_search_max_pages', '8')));
  const maxCreators = Math.max(1, Number(await getAppSetting('manual_search_max_unique_creators', '150')));
  const minNovelty = Math.max(0, Number(await getAppSetting('manual_search_min_new_channel_ratio', '0.20')));
  const maxDuplicate = Math.min(1, Number(await getAppSetting('manual_search_max_duplicate_ratio', '0.80')));
  const maxLowYield = Math.max(1, Number(await getAppSetting('manual_search_max_low_yield_pages', '2')));
  const dailyBudget = getDailyYouTubeQuotaBudget();
  const quotaPercent = Number(await getAppSetting('manual_search_quota_percent', process.env.DISCOVERY_MANUAL_QUOTA_PERCENT || '20'));
  const operationId = `${sessionId}:${pageNumber}`;
  const queryVariant = session.generatedQueryVariants[variantIndex] || session.originalQuery;
  const reserved = await tryReserveQuota({ operationType: 'MANUAL_SEARCH_PAGE', operationId, allocation: 'MANUAL', units: 100, dailyBudget, allocationPercent: quotaPercent });
  if (!reserved) throw new QuotaAllocationExhaustedError('MANUAL');
  try {
    const vocabs = await getCountryVocabularies();
    const vocab = vocabs.find(v => v.country.toLowerCase() === session.country.toLowerCase());
    const page = await searchYouTubeChannelPage(queryVariant, session.country, vocab, session.retrievalLane, pageToken,'RELEVANCE',async additionalUnits=>{
      const toppedUp=await topUpQuotaReservation({
        operationType:'MANUAL_SEARCH_PAGE',operationId,allocation:'MANUAL',
        additionalUnits,dailyBudget,allocationPercent:quotaPercent
      });
      if(!toppedUp)throw new QuotaAllocationExhaustedError('MANUAL');
    },'manual');
    await finishQuotaReservation('MANUAL_SEARCH_PAGE', operationId, true);
    const rawIds = page.channels.map(c => c.channelId);
    const unique = [...new Map(page.channels.map(c => [c.channelId, c])).values()];
    const uniqueIds = unique.map(c => c.channelId);
    const knownIds: string[] = [];
    const acceptedIds: string[] = [];
    const confirmedIds: string[] = [];
    const qualityConfirmedIds: string[] = [];
    const qualityScores: number[] = [];
    const communityIds: string[] = [];
    const deferredIds = new Set<string>();
    let countryAccepted = 0;
    for (const [index,raw] of unique.entries()) {
      const nomination=await recordNomination({channelId:raw.channelId,sourceType:'manual_search',sourceActionId:sessionId,query:queryVariant,
        queryGenerationMode:'OPERATOR_DIRECTED',country:session.country,retrievalLane:session.retrievalLane,pageNumber,resultRank:index+1,
        matchedDocument:raw.matchedDocument||{type:'MANUAL'},rawObservation:{channelName:raw.channelName,youtubeUrl:raw.youtubeUrl,sessionId,variantIndex}},'INVESTIGATION_QUEUED');
      raw.nominationId=nomination.id||undefined;
      const outcome = await processDiscoveredChannelContained(raw, session.country, 'manual_search', { jobId });
      if (!outcome) { deferredIds.add(raw.channelId); continue; }
      if (outcome.wasKnown) knownIds.push(outcome.channelId);
      if (outcome.persisted && outcome.countryStatus !== 'REJECTED') acceptedIds.push(outcome.channelId);
      if (outcome.countryStatus !== 'REJECTED') countryAccepted++;
      if (outcome.tradingStatus === 'TRADING_CONFIRMED') {
        confirmedIds.push(outcome.channelId);
        const score = outcome.channelRecord?.quality_score || 0;
        qualityScores.push(score);
        if (score >= 55) qualityConfirmedIds.push(outcome.channelId);
        if (outcome.discordStatus === 'ACTIVE' || outcome.discordStatus === 'ACTIVE_LOW_VOLUME') communityIds.push(outcome.channelId);
      }
    }
    const manualMetrics = manualSearchContinuationMetrics({
      rawIds,
      uniqueIds,
      deferredIds: [...deferredIds],
      previousIds: session.uniqueChannelIds,
      countryAccepted,
      confirmedCount: confirmedIds.length,
      communityCount: communityIds.length,
    });
    const projectedUnique = new Set([...session.uniqueChannelIds, ...manualMetrics.evaluatedUniqueIds]).size;
    const hasNextVariant = variantIndex + 1 < session.generatedQueryVariants.length;
    const decision = evaluateContinuation({pageNumber,maxPages,hasNextPage:!!page.nextPageToken||hasNextVariant,distinctCreators:manualMetrics.distinctCreators,cumulativeDistinctCreators:projectedUnique,maxDistinctCreators:maxCreators,newCreators:manualMetrics.novelIds.length,confirmedCreators:confirmedIds.length,qualityConfirmedCreators:qualityConfirmedIds.length,countryPrecision:manualMetrics.countryPrecision,communityDiversity:manualMetrics.communityDiversity,duplicateRatio:manualMetrics.duplicateRatio,consecutiveLowYieldPages:session.consecutiveLowYieldPages,maxConsecutiveLowYieldPages:maxLowYield,deferredOnly:manualMetrics.deferredOnly});
    const stopReason = decision.shouldContinue ? null : decision.primaryReason;
    const updated = await recordManualSearchPage(sessionId, { pageNumber, queryVariant, lane: session.retrievalLane, inputPageToken: pageToken, nextPageToken: page.nextPageToken, rawResultCount:page.rawResultCount, rawIds, uniqueIds, evaluatedIds:manualMetrics.evaluatedUniqueIds, knownIds, acceptedIds, confirmedIds, qualityConfirmedIds, averageQualityScore:qualityScores.length?qualityScores.reduce((a,b)=>a+b,0)/qualityScores.length:0, countryPrecision:manualMetrics.countryPrecision,communityDiversity:manualMetrics.communityDiversity,noveltyRatio:manualMetrics.noveltyRatio, duplicateRatio:manualMetrics.duplicateRatio, quotaUnits: 100, quotaEfficiency: qualityConfirmedIds.length / 100, creatorYield: confirmedIds.length, lowYield:decision.lowYield,marginalUtility:decision.marginalUtility,shouldContinue:decision.shouldContinue,primaryReason:decision.primaryReason,reasonCodes:decision.reasonCodes,maxPages, stopReason });
    if (!stopReason) {
      const nextVariantIndex = page.nextPageToken ? variantIndex : variantIndex + 1;
      await enqueueJob('MANUAL_SEARCH_PAGE', { sessionId, pageNumber: pageNumber + 1, pageToken: page.nextPageToken, variantIndex: nextVariantIndex }, { priority: 200, maxAttempts: 3, idempotencyKey: `manual-page:${sessionId}:${pageNumber + 1}` });
    }
    return updated;
  } catch (error) { await finishQuotaReservation('MANUAL_SEARCH_PAGE', operationId, false); throw error; }
}

/** Starts a durable session and atomically queues its first page. */
export async function executeFullManualSearch(userQuery: string, countryName: string, traceId?:string): Promise<any> {
  await assertCountryAllowed(countryName, 'manual_search_session');
  const vocabs = await getCountryVocabularies();
  const vocab = vocabs.find(v => v.country.toLowerCase() === countryName.toLowerCase());
  await recordExecutionStage('JOB_CREATION','REACHED',{type:'MANUAL_SEARCH_PAGE'},traceId);
  const session = await createManualSearchSession({ id: randomUUID(), query: userQuery, country: countryName, variants: manualVariants(userQuery, vocab), lane: 'VIDEO', traceId });
  await recordExecutionStage('QUEUE_PERSISTENCE','REACHED',{sessionId:session.id,type:'MANUAL_SEARCH_PAGE'},traceId);
  return { session, traceId, message: 'Manual discovery is queued; page 1 and all continuation pages will run in the high-priority durable queue.' };
}

/** Default search workers when SEARCH_WORKER_CONCURRENCY is unset. */
export const SEARCH_WORKER_CONCURRENCY_DEFAULT = 4;
/** Resolve the search worker count from env (pure; explicit env wins, unset resolves to the default). */
export function resolveSearchWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Number(env.SEARCH_WORKER_CONCURRENCY || SEARCH_WORKER_CONCURRENCY_DEFAULT));
}
/** Default enrichment workers when ENRICHMENT_WORKER_CONCURRENCY is unset. */
export const ENRICHMENT_WORKER_CONCURRENCY_DEFAULT = 3;
/** Resolve the enrichment worker count from env (pure; env override wins). */
export function resolveEnrichmentWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Number(env.ENRICHMENT_WORKER_CONCURRENCY || ENRICHMENT_WORKER_CONCURRENCY_DEFAULT));
}
function startWorkerPool(type: 'SEARCH_YOUTUBE' | 'ENRICH_CHANNEL' | 'MANUAL_SEARCH_PAGE', concurrency: number, extraClaimableTypes: ClaimableSearchJobType[] = []): void {
  const safeConcurrency = Math.min(20, Math.max(1, Math.floor(concurrency) || 1));
  for (let index = 0; index < safeConcurrency; index++) {
    const workerId = `${type.toLowerCase()}_${process.pid}_${index}`;
    const tick = async () => {
      try {
        await processNextSearchJob([type, ...extraClaimableTypes], workerId);
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

let workersStarted = false;

/**
 * Start the durable queue consumers explicitly, after HTTP readiness. Keeping
 * this idempotent prevents duplicate consumers if startup orchestration is
 * retried; individual ticks already preserve the existing claim/retry rules.
 */
export function startSearchWorkers(): void {
  if (workersStarted) return;
  workersStarted = true;
  // The canary shares the SEARCH pool tick (same provider profile, same
  // lifecycle, unchanged concurrency): its own settings gate keeps the claim
  // closed unless explicitly enabled, so default pool behavior is identical.
  startWorkerPool('SEARCH_YOUTUBE', resolveSearchWorkerCount(), ['RELATIONSHIP_CANARY_EXPANSION']);
  startWorkerPool('MANUAL_SEARCH_PAGE', Math.max(1, Number(process.env.MANUAL_SEARCH_WORKER_CONCURRENCY || 1)));
  // Enrichment defaults to 3 workers: measured service demand is ~334s mean
  // per completion (~10.8/hr per worker), so 3 workers burst ~30/hr against
  // ample provider headroom while staying within daily YouTube (~107k/day at
  // full tilt vs 300k pool) and browser-gate bounds. Env override still wins.
  startWorkerPool('ENRICH_CHANNEL', resolveEnrichmentWorkerCount());
}
