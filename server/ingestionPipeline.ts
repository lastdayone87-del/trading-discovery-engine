import { randomUUID } from 'node:crypto';
import { ChannelRecord, DiscoverySource, DiscordStatus } from '../src/types';
import { DiscoveredChannelRaw, classifierLanguageInputs, fetchYouTubeChannelCountryMetadata } from './youtube';
import { aggregatedLanguageCandidateSet, validateChannelCountry, type ValidationResult } from './countryValidator';
import { bumpGate1Evaluation } from './operationsTelemetry';
import type { AcquisitionLane } from './acquisitionLaneKeys';
import { resolveScopeEligibility } from './scopeEligibility';
import { classifyTradingRelevanceDetailed } from './tradingRelevanceClassifier';
import { runAndRecordAdaptiveShadow } from './adaptiveTradingClassifier';
import { inspectAndValidateChannel } from './queueManager';
import { hasEstablishedValidatedDiscordSelection, projectTradingReclassificationDiscordState } from './discordProjection';
import { applyPublicAboutToCandidate, fetchLiveYouTubeChannelData, shouldAttemptPublicAboutCountryFallback } from './youtubePublicAbout';
import {
  getChannelById,
  upsertChannel,
  upsertChannelWithResult,
  enqueueJob,
  getJobByIdempotencyKey,
  getQuota,
  getAppSetting,
  getDb,
  hasActiveEnrichmentJob
} from './db';
import { calculateCreatorQualityScore, extractVocabularyFromCreator, invokeChannelVocabularyExtraction, replayVocabularyForRetry, resolveExtractionVideoIds } from './queryIntelligence';
import { selectExplicitTerminologyLanguageContext } from './terminologyLanguageContext';
import { enqueueTermHarvest } from './candidateCorpus';
import { isEnrichmentStageExhausted, resolveEnrichmentReopenBlockedLifecycle, resolveExistingEnrichmentAction, resolveUncertainLifecycle } from './enrichmentLifecycle';
import { enrichmentJobIdempotencyKey } from './classificationDecoupling';
import {ConfigurableWeightedStrategy,evaluateClassificationStages,buildCanonicalEvidenceCorpus,getLayeredKnowledgeContext,type EvidenceCollectionReport,type RawChannelInput} from './evidenceEngine';
import { buildContextualComposition } from './evidenceEngine/contextualComposition';
import { contentLanguagePacks } from './evidenceEngine/multilingualTerminology';
import { LANGUAGE_KNOWLEDGE_PACKS } from './evidenceEngine/knowledgePacks';
import { observeProductionDiagnosticReliably, observeRetrievalAssignmentReliably } from './phaseBObservationOutbox';
import { buildDecisionEvaluationSamplingPolicy } from './decisionEvaluationSamplingPolicy';
import { ACTIONS, deriveVitalityScheduling, planAndRecordEvidenceAction, type EvidenceActionType, type EvidenceActionPlan } from './voiEvidenceController';
import { INVESTIGATION_POLICY_VERSION, restoreBlockedInvestigationStep, retryInvestigationStep, scheduleInvestigationStep } from './investigationWorkflow';
import {assignRelease5Serving} from './release5/rollout';
import { deterministicUuid, entityChecksum, observeYouTubeChannelEntity, sourceFamilyIdentity } from './entityResolution';
import { enrichmentOperationalFailure, hasDecisionGradeEvidenceWithoutFailedProviders, manualRecheckDegradedError } from './enrichmentOperationalFailure';
import { recordAdmissionShadow } from './candidateAdmission/shadowEvaluator';
import { recordReviewEligibilityShadow } from './reviewEligibility/store';
import { evaluateReviewEligibilityV2, resolveReviewProviderDegraded } from './reviewEligibility/policy';
import { shouldBypassPreservationForDiscordEvidence, shouldPreserveExistingChannel, shouldPreserveResolvedCountry, shouldRevalidateConfirmedCountry, terminalScanStatusForConfirmedRediscovery } from './terminalPreservationPolicy';
import { CANDIDATE_TRIAGE_POLICY_VERSION, hasIndependentTradingHypothesis, triageAutonomousSearchCandidate } from './candidateTriage';
import { evaluateLowAudienceGate, parseSubscriberCountNumber, shouldReclassifyPreservedCompletedChannel } from './lowAudienceGate';
import { validatedDiscordEvidenceInvite } from './discordEvidence';
import { shouldReactivateCommunityRecovery, reactivateCommunityRecovery } from './communityRecovery';
import { maybeRunDiscoveryEvidenceExtraction } from './discovery/evidencePipeline';
import {
  currentOfficialYouTubeQuotaOrigin,
  OfficialYouTubeQuotaFenceError,
  persistedQuotaOrigin,
  runWithOfficialYouTubeQuotaOrigin,
} from './officialYouTubeQuotaFence';
import { resolveClassificationRoutingMode } from './classificationRouting/deterministicFirst';
import { resolvePipelineQuotaOrigin } from './quotaOrigin';
import { isProbeQuotaControlError, YouTubeKeyCapUnavailableError } from './quotaKeyCapShadow';
import { isYouTubeQuotaAccountingError } from './youtubeKeyHealth';

// Extraction is best-effort and flag-gated, but a burst of ingestion jobs must
// not open hundreds of concurrent staging transactions. Serialize the
// fire-and-forget runs; each run is cheap and already bounded internally.
let discoveryExtractionTail: Promise<unknown> = Promise.resolve();
let discoveryExtractionBacklog = 0;
const MAX_DISCOVERY_EXTRACTION_BACKLOG = 8;

export interface NativeExtractionEligibilityInput {
  cdlEnabled: boolean;
  nativeExtractionFlagEnabled: boolean;
  promotionV2Enabled: boolean;
  qualityScore: number;
  source: string;
  countryStatus: string | null | undefined;
  countryInScope: boolean;
  tradingStatus: string | null | undefined;
}

export interface NativeExtractionEligibility {
  /** All three CDL gates on. `discovery_extraction_enabled` is deliberately absent. */
  nativeExtractionEnabled: boolean;
  qualityEligible: boolean;
  countryValid: boolean;
  nativeEligible: boolean;
  /** undefined preserves legacy observation behavior when the new path is off. */
  promotionEligible: boolean | undefined;
  persistLegacyTerm: boolean;
  termHarvestEnabled: boolean;
}

/**
 * Pure expanded-extraction split (CDL §7.8). The candidate-corpus path stays
 * quality-gated exactly as before. The native terminology path also admits
 * country-valid CONFIRMED + TRADING_CONFIRMED creators below the quality bar,
 * but those observations are promotion-ineligible and never write legacy
 * extracted_vocabulary rows. The legacy `discovery_extraction_enabled` flag
 * is not an input: it governs only the separate staging pipeline.
 */
export function resolveNativeExtractionEligibility(input: NativeExtractionEligibilityInput): NativeExtractionEligibility {
  const nativeExtractionEnabled =
    input.cdlEnabled === true &&
    input.nativeExtractionFlagEnabled === true &&
    input.promotionV2Enabled === true;
  const qualityEligible = input.qualityScore >= 55 && input.source !== 'manual_search';
  const countryValid = input.countryStatus === 'CONFIRMED' && input.countryInScope === true;
  const nativeEligible =
    nativeExtractionEnabled &&
    countryValid &&
    input.tradingStatus === 'TRADING_CONFIRMED' &&
    input.source !== 'manual_search';
  const promotionEligible = nativeExtractionEnabled
    ? qualityEligible && countryValid && input.tradingStatus === 'TRADING_CONFIRMED'
    : undefined;
  return {
    nativeExtractionEnabled,
    qualityEligible,
    countryValid,
    nativeEligible: qualityEligible || nativeEligible,
    promotionEligible,
    persistLegacyTerm: promotionEligible !== false,
    termHarvestEnabled: qualityEligible,
  };
}

export interface IngestionCandidate extends DiscoveredChannelRaw {
  // Option for additional candidate details if provided
}

export interface IngestionPipelineOutcome {
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
    channel.trading_status === 'HUMAN_REJECTED' ||
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
/**
 * Projects a Gate-1 hard exclusion onto an already-known channel row.
 * Mutates and returns the same row: country_status REJECTED, detected
 * creator country, confidence, terminal scan status, audit trail append, and
 * last_checked. Trading/discord ownership is never touched — this is a
 * country-policy projection only, mirroring the NEEDS_REVIEW branch shape.
 */
export function applyGate1CountryRejectionToExisting(
  row: ChannelRecord,
  rejection: { creatorCountry: string | null; score: number; validationStep: ChannelRecord['inspection_trail'][number]; now: string },
  candidate: IngestionCandidate
): ChannelRecord {
  row.country_status = 'REJECTED';
  row.country = rejection.creatorCountry;
  row.confidence_score = rejection.score;
  row.scan_status = 'COMPLETED';
  row.last_checked = rejection.now;
  row.inspection_trail = [...(row.inspection_trail || []), rejection.validationStep];
  // A Gate-1 rejection re-attributes the country, so scope eligibility is
  // re-derived from the NEW country (never preserved from the old one): an
  // unsupported-country rejection flips a stale IN_SCOPE to OUT_OF_SCOPE.
  row.scope_eligibility = resolveScopeEligibility(rejection.creatorCountry);
  applyCandidateObservability(row, candidate);
  return row;
}
/**
 * Establishes the official-quota provenance before any pipeline work. Probe
 * channels are sticky in the database, so a retry or re-enrichment cannot
 * silently become a NORMAL (official-quota) run.
 */
export interface PipelineExecutionOptions {
  forceExtraction?: boolean;
  quotaOrigin?: 'NORMAL' | 'PROBE';
  /** Observability attribution for semantic provider ledger rows. */
  jobId?: string;
  runId?: string;
  /** Phase 0 acquisition lane for durable lane telemetry (optional). */
  lane?: AcquisitionLane;
  jobType?: string;
  /** Discord-evidence reclassification must evaluate a previously COMPLETED
   * row once; confirmed rows remain terminal. */
  forceClassification?: boolean;
}

/**
 * Shared country-evidence hydration for the ordinary Gate-1 pass and the
 * confirmed-row country-only revalidation. A confirmed row skips trading
 * classification, but it must still fetch the same official metadata and
 * keyless About fallback before deciding that country remains unresolved.
 */
async function validateCountryWithHydration(
  candidate: IngestionCandidate,
  existing: ChannelRecord | null,
  targetCountry: string,
  now: string,
  options: { includeAudience?: boolean } = {},
): Promise<ValidationResult> {
  const build = () => validateChannelCountry({
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
  let countryVal = await build();
  const includeAudience = options.includeAudience === true;
  const subscriberEvidenceMissing = includeAudience && evaluateLowAudienceGate(candidate.subscriberCount).reasonCode === 'SUBSCRIBER_COUNT_UNAVAILABLE';
  const needsCountryHydration = countryVal.status === 'UNCERTAIN' && candidate.countryMetadataStatus !== 'AVAILABLE_NOT_DECLARED';
  if (needsCountryHydration || subscriberEvidenceMissing) {
    const hydrated = await fetchYouTubeChannelCountryMetadata(candidate.channelId, candidate);
    Object.assign(candidate, hydrated);
    countryVal = await build();
  }
  const subscriberEvidenceMissingAfterOfficial = includeAudience && evaluateLowAudienceGate(candidate.subscriberCount).reasonCode === 'SUBSCRIBER_COUNT_UNAVAILABLE';
  const publicAboutStatus = (candidate as any).publicAboutStatus || existing?.public_about_status || 'NOT_ATTEMPTED';
  const publicAboutAttempts = Number((candidate as any).publicAboutAttempts ?? existing?.public_about_attempts ?? 0);
  const publicAboutAttempted = Boolean(
    (candidate as any).publicAboutAttempted ||
    publicAboutStatus === 'ATTEMPTED_SUCCEEDED' ||
    publicAboutStatus === 'ATTEMPTED_EMPTY' ||
    existing?.inspection_trail?.some(s => s.details?.includes('Public About') || s.title?.includes('Live About'))
  );
  const countryFallbackWanted = shouldAttemptPublicAboutCountryFallback({
    countryStatus: countryVal.status,
    countryMetadataStatus: candidate.countryMetadataStatus,
    description: candidate.description,
    publicAboutStatus,
    publicAboutAttempts,
    publicAboutAttempted,
  });
  const countryAlreadyRejected = countryVal.status === 'REJECTED'
    || countryVal.gateDisposition === 'REJECT_EXCLUDED'
    || countryVal.gateDisposition === 'REJECT_UNSUPPORTED';
  const subscriberFallbackWanted = includeAudience
    && subscriberEvidenceMissingAfterOfficial
    && candidate.countryMetadataStatus === 'UNAVAILABLE'
    && !countryAlreadyRejected
    && publicAboutAttempts < 2;
  if (countryFallbackWanted || subscriberFallbackWanted) {
    const beforeDescription = candidate.description;
    const beforeLinks = [...(candidate.channelLinks || [])];
    (candidate as any).publicAboutAttempted = true;
    (candidate as any).publicAboutAttempts = publicAboutAttempts + 1;
    (candidate as any).publicAboutCheckedAt = now;
    candidate.countryMetadataCheckedAt = now;
    try {
      const liveAbout = await fetchLiveYouTubeChannelData(candidate.youtubeUrl);
      if (applyPublicAboutToCandidate(candidate, liveAbout)) {
        (candidate as any).publicAboutStatus = 'ATTEMPTED_SUCCEEDED';
        const afterLinks = candidate.channelLinks || [];
        const linksChanged = afterLinks.length !== beforeLinks.length
          || afterLinks.some((link, index) => link !== beforeLinks[index]);
        if (countryFallbackWanted || candidate.description !== beforeDescription || linksChanged) {
          countryVal = await build();
        }
      } else {
        (candidate as any).publicAboutStatus = liveAbout ? 'ATTEMPTED_EMPTY' : 'ATTEMPTED_FAILED';
      }
    } catch (error) {
      (candidate as any).publicAboutStatus = 'ATTEMPTED_FAILED';
      console.warn(`[Unified Ingestion Pipeline - Gate 1] Public About fallback failed for ${candidate.channelId}:`, error instanceof Error ? error.message : error);
    }
  }
  return countryVal;
}

export interface ConfirmedCountryRevalidationResult {
  countryChecked: boolean;
  rejectionApplied: boolean;
}

export interface ConfirmedCountryRevalidationDeps {
  hydrate?: (
    candidate: IngestionCandidate,
    existing: ChannelRecord,
    targetCountry: string,
    now: string,
  ) => Promise<ValidationResult>;
}

/**
 * Country-only revalidation for a preserved TRADING_CONFIRMED row. Trading
 * classification is never re-run; the function gathers country evidence,
 * applies the rejection projection, and reports whether the row changed.
 * Quota policy/accounting failures propagate to the caller's retry lifecycle.
 */
export async function revalidateConfirmedCountryForPreservedRow(
  candidate: IngestionCandidate,
  existing: ChannelRecord,
  targetCountry: string,
  now: string,
  deps: ConfirmedCountryRevalidationDeps = {},
): Promise<ConfirmedCountryRevalidationResult> {
  try {
    // Search results can be sparse. Use the same official metadata and public
    // About hydration as Gate 1 before preserving the confirmed trading
    // decision; only trading classification is skipped.
    const hydrate = deps.hydrate
      || ((input: IngestionCandidate, row: ChannelRecord, country: string, at: string) =>
        validateCountryWithHydration(input, row, country, at, { includeAudience: false }));
    const countryCheck = await hydrate(candidate, existing, targetCountry, now);
    applyCandidateObservability(existing, candidate);
    if (countryCheck.status === 'REJECTED' && countryCheck.detectedCreatorCountry) {
      applyGate1CountryRejectionToExisting(existing, {
        creatorCountry: countryCheck.detectedCreatorCountry,
        score: countryCheck.score,
        validationStep: {
          step: 'COUNTRY_VALIDATION',
          title: `Country Validation (${countryCheck.detectedCreatorCountry})`,
          status: 'REJECTED',
          details: countryCheck.decisionLogs,
          timestamp: now,
        },
        now,
      }, candidate);
      return { countryChecked: true, rejectionApplied: true };
    }
    if ((countryCheck.status === 'CONFIRMED' || countryCheck.status === 'LIKELY') && countryCheck.detectedCreatorCountry) {
      existing.country = countryCheck.detectedCreatorCountry;
      existing.country_status = countryCheck.status;
      existing.confidence_score = countryCheck.score;
    }
    return { countryChecked: true, rejectionApplied: false };
  } catch (error) {
    // Probe/quota policy and accounting failures are not evidence failures:
    // propagating them keeps the caller's retry lifecycle and prevents a paid
    // request from being silently replayed elsewhere.
    if (error instanceof OfficialYouTubeQuotaFenceError
      || error instanceof YouTubeKeyCapUnavailableError
      || isProbeQuotaControlError(error)
      || isYouTubeQuotaAccountingError(error)) {
      throw error;
    }
    console.warn(`[Unified Ingestion Pipeline] Confirmed-country revalidation failed for ${candidate.channelId}; preserving confirmed row:`, error instanceof Error ? error.message : error);
    return { countryChecked: false, rejectionApplied: false };
  }
}

export async function processChannelThroughPipeline(
  candidate: IngestionCandidate,
  targetCountry: string,
  source: DiscoverySource,
  isManualScan: boolean = false,
  isEnrichmentPass: boolean = false,
  options?: PipelineExecutionOptions
): Promise<IngestionPipelineOutcome> {
  const resolvedOrigin = await resolvePipelineQuotaOrigin(candidate, options);
  if (resolvedOrigin === 'UNKNOWN') {
    throw new OfficialYouTubeQuotaFenceError(
      'UNKNOWN',
      'processChannelThroughPipeline',
      `could not establish quota origin for ${candidate.channelId || 'unknown channel'}`,
    );
  }
  candidate.quotaOrigin = resolvedOrigin;
  return runWithOfficialYouTubeQuotaOrigin(
    resolvedOrigin,
    'processChannelThroughPipeline',
    () => processChannelThroughPipelineInContext(
      candidate,
      targetCountry,
      source,
      isManualScan,
      isEnrichmentPass,
      options,
    ),
  );
}

async function processChannelThroughPipelineInContext(
  candidate: IngestionCandidate,
  targetCountry: string,
  source: DiscoverySource,
  isManualScan: boolean = false,
  isEnrichmentPass: boolean = false,
  options?: PipelineExecutionOptions
): Promise<IngestionPipelineOutcome> {
  const now = new Date().toISOString();
  if (await getAppSetting('decision_evaluation_sampling_enabled', 'false') === 'true') {
    const samplingPolicy = buildDecisionEvaluationSamplingPolicy(process.env.DECISION_EVALUATION_SAMPLING_SALT);
    if (samplingPolicy) {
      await observeRetrievalAssignmentReliably({
        type: 'RETRIEVAL_ASSIGNMENT',
        input: {
          channelId: candidate.channelId,
          targetCountry,
          discoveryOrigin: source,
          language: candidate.detectedLanguages?.[0]?.language,
          observedAt: now,
          context: { isManualScan, isEnrichmentPass },
        },
        policy: samplingPolicy,
      }).catch(error => console.warn(
        `[DecisionEvaluation] Cohort assignment failed for ${candidate.channelId}:`,
        error instanceof Error ? error.message : error
      ));
    }
  }

  // Step 0: Terminal State & Existing Channel Check
  const existing = await getChannelById(candidate.channelId);
  if (existing) {
    if (existing.scan_status === 'FAILED_PERMANENT') {
      const trigger = shouldReactivateCommunityRecovery(existing, candidate, isManualScan);
      if (trigger.reactivate) {
        const reactivated = reactivateCommunityRecovery(existing, trigger.reasonCodes);
        await upsertChannel(reactivated);
        existing.scan_status = reactivated.scan_status;
        existing.discord_status = reactivated.discord_status;
      }
    }
    // Preserve terminal rows for every ordinary discovery lane. Explicit
    // operator recheck is the only supported terminal override.
    if (shouldPreserveExistingChannel(existing, source, isManualScan, Date.now(), { allowActiveEnrichmentClassification: isEnrichmentPass === true && existing.trading_status === 'UNCERTAIN' }) && !shouldBypassPreservationForDiscordEvidence(existing, options?.forceClassification === true)) {
      let confirmedCountryChecked = false;
      const countryRevalidation = shouldRevalidateConfirmedCountry(existing, isManualScan);
      // Capture the policy this pass read; the write below must not overwrite
      // a concurrent rejection/confirmation committed while hydration ran.
      const countryPolicySnapshot = countryRevalidation
        ? {
            countryStatus: existing.country_status,
            country: existing.country,
            tradingStatus: existing.trading_status,
            scanStatus: existing.scan_status,
          }
        : undefined;
      // A guarded write can be skipped when another pass changed the country
      // decision. Re-read the committed row so the returned outcome and
      // sighting projection never report a value the database rejected.
      const persistPreservedRow = async (): Promise<void> => {
        const written = await upsertChannelWithResult(existing, countryPolicySnapshot ? { requireCountrySnapshot: countryPolicySnapshot } : undefined);
        if (!written) {
          const refreshed = await getChannelById(candidate.channelId);
          if (refreshed) Object.assign(existing, refreshed);
        }
      };
      if (countryRevalidation) {
        const revalidation = await revalidateConfirmedCountryForPreservedRow(candidate, existing, targetCountry, now);
        confirmedCountryChecked = revalidation.countryChecked;
        if (revalidation.rejectionApplied) {
          await persistPreservedRow();
          return {
            channelId: candidate.channelId,
            channelName: candidate.channelName,
            isNew: false,
            wasKnown: true,
            persisted: true,
            countryStatus: existing.country_status,
            tradingStatus: existing.trading_status,
            discordStatus: existing.discord_status,
            discordInvite: existing.discord_invite || null,
            channelRecord: existing,
            skippedTerminalState: true,
          };
        }
      }

      const refreshedAudienceGate = evaluateLowAudienceGate(candidate.subscriberCount);
      if (shouldReclassifyPreservedCompletedChannel(existing.scan_status, refreshedAudienceGate, existing.trading_status)) {
        console.log(`[Unified Ingestion Pipeline] Refreshing preserved completed channel '${candidate.channelName}' as low-audience after fresh official subscriber metadata.`);
        existing.subscriber_count = candidate.subscriberCount;
        existing.scan_status = 'SKIPPED_LOW_AUDIENCE';
        existing.last_checked = now;
        existing.inspection_trail = [
          ...(existing.inspection_trail || []),
          {
            step: 'BIO',
            title: 'Low-Audience Budget Gate',
            status: 'SKIPPED',
            details: `Subscribers: ${candidate.subscriberCount} (< 30). Stored and skipped deep enrichment.`,
            timestamp: now,
          },
        ];
        await persistPreservedRow();
        return {
          channelId: candidate.channelId,
          channelName: candidate.channelName,
          isNew: false,
          wasKnown: true,
          persisted: true,
          countryStatus: existing.country_status,
          tradingStatus: existing.trading_status || 'UNCERTAIN',
          discordStatus: existing.discord_status,
          discordInvite: existing.discord_invite || null,
          channelRecord: existing,
          skippedTerminalState: true,
        };
      }
      console.log(
        `[Unified Ingestion Pipeline] Channel '${candidate.channelName}' (${candidate.channelId}) is already in database (Country: ${existing.country_status}, Trading: ${existing.trading_status}, Scan: ${existing.scan_status}). Preserving existing record.`
      );
      // Retry repair (see replayVocabularyForRetry): a retried job replays
      // vocabulary extraction so a save that failed after its observation
      // committed cannot strand missing rows behind this early return.
      await replayVocabularyForRetry(existing, candidate, source, options?.forceExtraction ?? false);
      // Update basic existing metadata if changed
      let updated = confirmedCountryChecked;
      if (candidate.subscriberCount && candidate.subscriberCount !== existing.subscriber_count) {
        existing.subscriber_count = candidate.subscriberCount;
        updated = true;
      }
      if (candidate.channelThumbnailUrl && candidate.channelThumbnailUrl !== existing.channel_thumbnail_url) {
        existing.channel_thumbnail_url = candidate.channelThumbnailUrl;
        updated = true;
      }
      let activeEnrichmentJob = false;
      if (existing.trading_status === 'TRADING_CONFIRMED') {
        try { activeEnrichmentJob = await hasActiveEnrichmentJob(existing.channel_id, options?.jobId); } catch { activeEnrichmentJob = true; }
      }
      const confirmedScanStatus = existing.trading_status === 'TRADING_CONFIRMED'
        ? terminalScanStatusForConfirmedRediscovery(existing.scan_status, activeEnrichmentJob)
        : existing.scan_status;
      if (confirmedScanStatus !== existing.scan_status) {
        existing.scan_status = confirmedScanStatus;
        updated = true;
      }
      if (updated) {
        await persistPreservedRow();
      }

      return {
        channelId: candidate.channelId,
        channelName: candidate.channelName,
        isNew: false,
        wasKnown: true,
        persisted: true,
        countryStatus: existing.country_status,
        tradingStatus: existing.trading_status || 'UNCERTAIN',
        discordStatus: existing.discord_status,
        discordInvite: existing.discord_invite || null,
        channelRecord: existing,
        skippedTerminalState: true
      };
    }
  }

  // Search-result content is routing provenance, not creator evidence. Before an
  // autonomous result can trigger country hydration, semantic AI, enrichment or
  // Discord work, require a cheap plausible trading hypothesis from the matched
  // retrieval document. Withheld candidates remain preserved in the nomination
  // ledger and can be rediscovered later by independent evidence.
  if (options?.forceClassification !== true) {
    const retrievalTriage = triageAutonomousSearchCandidate(candidate, source, isEnrichmentPass);
    if (retrievalTriage.disposition === 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS') {
      console.log(`[Unified Ingestion Pipeline - Triage] Withholding '${candidate.channelName}' before provider spend: ${retrievalTriage.reasonCodes.join(', ')}.`);
      void recordAdmissionShadow({
        channelId:candidate.channelId, priorState:'NOT_EVALUATED', classificationStatus:'UNCERTAIN', investigationState:'COMPLETED',
        candidateHypothesis:{plausibleTradingHypothesis:false,triagePolicyVersion:CANDIDATE_TRIAGE_POLICY_VERSION,matchedSignals:retrievalTriage.matchedSignals},
        evidenceCoverage:{stage:'RETRIEVAL_TRIAGE',reasonCodes:retrievalTriage.reasonCodes,enrichmentStage:candidate.enrichmentStage||0}
      }).catch(error=>console.warn(`[CandidateAdmission] retrieval-triage shadow write failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));
      return {
        channelId:candidate.channelId, channelName:candidate.channelName, isNew:!existing, wasKnown:!!existing, persisted:false,
        countryStatus:'UNCERTAIN', tradingStatus:'UNCERTAIN', discordStatus:'NOT_FOUND', discordInvite:null, channelRecord:undefined
      };
    }
  }

  // Step 1: GATE 1 - Country Validation Hard Gate
  // Country uncertainty and subscriber availability are both cheap official
  // channel-metadata concerns. Hydrate them together with one channels.list
  // request before semantic AI, enrichment, or Discord, then fall back to the
  // keyless public page when country evidence is still sparse.
  const countryVal = await validateCountryWithHydration(candidate, existing, targetCountry, now, { includeAudience: true });

  // ABSOLUTE INVARIANT:
  // creatorCountry represents creator-level evidence ONLY. It is null if no creator evidence exists.
  // targetCountry is retrieval context and NEVER populates creatorCountry or channels.country.
  const creatorCountry = countryVal.detectedCreatorCountry || null;

  const languageCandidateCountries = aggregatedLanguageCandidateSet(countryVal.evidence);
  const countryValidationStep = {
    step: 'COUNTRY_VALIDATION' as const,
    title: `Country Validation (${creatorCountry || 'Unknown'})`,
    status: countryVal.status === 'REJECTED'
      ? ('REJECTED' as const)
      : (countryVal.status === 'CONFIRMED' || countryVal.status === 'LIKELY')
      ? ('FOUND' as const)
      : ('NOT_FOUND' as const),
    details: `${countryVal.decisionLogs}${(candidate as any).publicAboutAttempted ? '\nPublic About page attempted.' : ''}`,
    // Structured candidate set for recovery reconciliation (no prose parsing).
    ...(languageCandidateCountries ? { candidateCountries: languageCandidateCountries } : {}),
    timestamp: now
  };

  if (countryVal.gateDisposition === 'REJECT_EXCLUDED' || countryVal.gateDisposition === 'REJECT_UNSUPPORTED' || countryVal.status === 'REJECTED') {
    bumpGate1Evaluation(countryVal.gateDisposition);
    console.log(
      `[Unified Ingestion Pipeline - Gate 1] Channel '${candidate.channelName}' REJECTED by Hard Exclusion Engine (${targetCountry}). Halting pipeline immediately.`
    );
    console.warn(JSON.stringify({
      event: 'excluded_channel_blocked',
      channelId: candidate.channelId,
      targetCountry,
      detectedCountry: creatorCountry,
      reason: countryVal.rejectionReason,
      context: 'ingestion_gate',
      timestamp: now
    }));

    void recordAdmissionShadow({channelId:candidate.channelId,priorState:'NOT_EVALUATED',classificationStatus:'COUNTRY_REJECTED',
      investigationState:'POLICY_REJECTED',terminalCountryPolicy:true,candidateHypothesis:{},evidenceCoverage:{countryDecision:countryVal.status}})
      .catch(error=>console.warn(`[CandidateAdmission] country-policy shadow write failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));
    // Enrichment-hardening: an authoritative language rejection must durably
    // project onto an already-known row. Without this, an existing UNCERTAIN
    // channel stays UNCERTAIN after the ENRICH_CHANNEL job completes and can
    // reenter processing. No-row candidates stay write-free by design.
    if (existing) {
      applyGate1CountryRejectionToExisting(
        existing,
        { creatorCountry, score: countryVal.score, validationStep: countryValidationStep, now },
        candidate
      );
      await upsertChannel(existing);
      return {
        channelId: candidate.channelId,
        channelName: candidate.channelName,
        isNew: false,
        wasKnown: true,
        persisted: true,
        countryStatus: 'REJECTED',
        detectedCountry: creatorCountry,
        rejectionReason: countryVal.rejectionReason,
        // The row keeps its own trading/Discord ownership (never mutated
        // above); the outcome must mirror the persisted record so enrichment
        // and investigation consumers never contradict the channelRecord.
        tradingStatus: existing.trading_status || 'UNCERTAIN',
        discordStatus: existing.discord_status,
        discordInvite: existing.discord_invite || null,
        channelRecord: existing
      };
    }
    return {
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      isNew: false,
      wasKnown: !!existing,
      persisted: false,
      countryStatus: 'REJECTED',
      detectedCountry: creatorCountry,
      rejectionReason: countryVal.rejectionReason,
      tradingStatus: 'UNCERTAIN',
      discordStatus: 'NOT_FOUND',
      discordInvite: null,
      channelRecord: undefined
    };
  }

  if (countryVal.gateDisposition === 'NEEDS_REVIEW') {
    bumpGate1Evaluation(countryVal.gateDisposition);
    console.log(`[Unified Ingestion Pipeline - Gate 1] Channel '${candidate.channelName}' routed to NEEDS_REVIEW by country gate disposition.`);
    const reviewChannel: ChannelRecord = existing || {
      channel_id: candidate.channelId,
      channel_name: candidate.channelName,
      youtube_url: candidate.youtubeUrl,
      country: creatorCountry,
      country_status: countryVal.status,
      confidence_score: countryVal.score,
      discord_status: 'UNCERTAIN',
      discord_invite: null,
      scan_status: 'NEEDS_REVIEW',
      scan_attempts: 0,
      discovery_source: source,
      first_seen: now,
      last_checked: now,
      inspection_trail: [countryValidationStep],
      subscriber_count: candidate.subscriberCount,
      channel_thumbnail_url: candidate.channelThumbnailUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(candidate.channelName)}&background=0f172a&color=38bdf8&bold=true`,
      trading_status: 'NEEDS_REVIEW'
    };
    reviewChannel.country_status = countryVal.status;
    reviewChannel.country = creatorCountry;
    reviewChannel.confidence_score = countryVal.score;
    reviewChannel.trading_status = 'NEEDS_REVIEW';
    reviewChannel.scan_status = 'NEEDS_REVIEW';
    reviewChannel.last_checked = now;
    applyCandidateObservability(reviewChannel, candidate);
    await upsertChannel(reviewChannel);

    return {
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      isNew: !existing,
      wasKnown: !!existing,
      persisted: true,
      countryStatus: countryVal.status,
      tradingStatus: 'NEEDS_REVIEW',
      discordStatus: 'UNCERTAIN',
      discordInvite: null,
      channelRecord: reviewChannel
    };
  }

  // Phase 7: Low-Audience Budget Gate
  // Gate 1 allow-path telemetry: reached only when the channel was neither
  // rejected nor routed to review above.
  bumpGate1Evaluation(countryVal.gateDisposition);

  // Evidence-first discovery Phase 1 (flag `discovery_extraction_enabled`,
  // absent => OFF): harvest deterministic candidate signals from the metadata
  // already parsed above and stage screened PROBE_ELIGIBLE candidates.
  // Fire-and-forget, no new fetches, errors logged and swallowed; writes only
  // the staging domain and never touches serving/eligibility paths.
  if (discoveryExtractionBacklog >= MAX_DISCOVERY_EXTRACTION_BACKLOG) {
    // This observation is intentionally best-effort. Bound the number of
    // waiting runs so a stalled staging write cannot retain an unbounded list
    // of candidate payloads; drop the newest observation instead.
    console.warn(
      `[DiscoveryExtraction] backlog full (${MAX_DISCOVERY_EXTRACTION_BACKLOG}); skipping ${candidate.channelId}`
    );
  } else {
    discoveryExtractionBacklog += 1;
    discoveryExtractionTail = discoveryExtractionTail
      .catch(() => undefined)
      .then(() =>
        maybeRunDiscoveryEvidenceExtraction({
          channelId: candidate.channelId,
          channelName: candidate.channelName,
          description: candidate.description,
          pinnedComment: candidate.pinnedComment,
          videoTitles: candidate.videoTitles,
          videoDescriptions: candidate.videoDescriptions,
          videos: candidate.videos,
          detectedLanguages: candidate.detectedLanguages,
          transcriptExcerpts: candidate.transcriptExcerpts,
          creatorCountry,
          fallbackCountry: targetCountry,
        })
      )
      .catch(error =>
        console.warn(
          `[DiscoveryExtraction] run failed for ${candidate.channelId}:`,
          error instanceof Error ? error.message : error
        )
      )
      .finally(() => {
        discoveryExtractionBacklog -= 1;
      });
  }

  const lowAudienceGate = evaluateLowAudienceGate(candidate.subscriberCount);
  if (lowAudienceGate.shouldSkipDeepEnrichment) {
    console.log(`[Unified Ingestion Pipeline - Phase 7] Channel '${candidate.channelName}' (${candidate.channelId}) has ${candidate.subscriberCount} subscribers (< 30 threshold). Storing and marking low-audience skip.`);
    const lowAudienceChannel: ChannelRecord = existing || {
      channel_id: candidate.channelId,
      channel_name: candidate.channelName,
      youtube_url: candidate.youtubeUrl,
      country: creatorCountry,
      country_status: countryVal.status,
      confidence_score: countryVal.score,
      discord_status: 'NOT_FOUND',
      discord_invite: null,
      scan_status: 'SKIPPED_LOW_AUDIENCE',
      scan_attempts: 0,
      discovery_source: source,
      first_seen: now,
      last_checked: now,
      inspection_trail: [countryValidationStep, {
        step: 'BIO',
        title: 'Low-Audience Budget Gate',
        status: 'SKIPPED',
        details: `Subscribers: ${candidate.subscriberCount} (< 30). Stored and skipped deep enrichment.`,
        timestamp: now
      }],
      subscriber_count: candidate.subscriberCount,
      channel_thumbnail_url: candidate.channelThumbnailUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(candidate.channelName)}&background=0f172a&color=38bdf8&bold=true`,
      trading_status: 'UNCERTAIN'
    };

    // lowAudienceChannel aliases existing, so capture the prior lifecycle
    // state before the SKIPPED_LOW_AUDIENCE mutation below. Checking
    // existing.scan_status afterwards would always miss the provisional row.
    const wasClassificationPending = existing?.scan_status === 'CLASSIFICATION_PENDING';
    lowAudienceChannel.subscriber_count = candidate.subscriberCount;
    lowAudienceChannel.scan_status = 'SKIPPED_LOW_AUDIENCE';
    lowAudienceChannel.trading_status = existing?.trading_status || 'UNCERTAIN';
    lowAudienceChannel.last_checked = now;
    if (wasClassificationPending) {
      // A provisional classification row starts as country='UNKNOWN'. The
      // low-audience branch reuses that row, so the validated creator country
      // must be projected here or the durable row keeps the placeholder.
      // Restrict the projection to provisional rows: an uncertain rediscovery
      // must not downgrade country evidence on a completed channel. Without a
      // creator country, preserve the prior country/status pair because
      // downgrading only the status would leave a stale country looking
      // established to country-gated recovery paths.
      if (creatorCountry) {
        const verdictChanged = lowAudienceChannel.country !== creatorCountry
          || lowAudienceChannel.country_status !== countryVal.status;
        lowAudienceChannel.country = creatorCountry;
        lowAudienceChannel.country_status = countryVal.status;
        lowAudienceChannel.confidence_score = countryVal.score;
        // A low-audience row can be rediscovered repeatedly while its
        // classification is queued. Append the validation step only when the
        // country verdict actually changes so the trail stays bounded.
        if (verdictChanged) {
          lowAudienceChannel.inspection_trail = [
            ...(lowAudienceChannel.inspection_trail || []),
            countryValidationStep,
          ];
        }
      }
    }
    applyCandidateObservability(lowAudienceChannel, candidate);
    await upsertChannel(lowAudienceChannel);

    return {
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      isNew: !existing,
      wasKnown: !!existing,
      persisted: true,
      // Report the country evidence that was actually persisted. When no new
      // creator country is available, the existing country/status pair is
      // retained, so returning the fresh countryVal.status would disagree
      // with the durable row (for example CONFIRMED row reported UNCERTAIN).
      countryStatus: lowAudienceChannel.country_status,
      detectedCountry: lowAudienceChannel.country_status === 'UNCERTAIN'
        ? null
        : lowAudienceChannel.country,
      tradingStatus: lowAudienceChannel.trading_status || 'UNCERTAIN',
      discordStatus: 'NOT_FOUND',
      discordInvite: null,
      channelRecord: lowAudienceChannel
    };
  }

  // Step 2: GATE 2 - Evidence-Based Trading Verification Engine
  const channelEntityId=deterministicUuid('youtube-channel',candidate.channelId),channelSourceFamilyId=sourceFamilyIdentity({provider:'youtube',nativeId:candidate.channelId}).familyId;
  const structuredVideos=(candidate.videos || candidate.videoTitles.map((title,index)=>({title,description:candidate.videoDescriptions?.[index],published_at:candidate.uploadTimestamps?.[index]}))).map((video,index)=>({...video,source_entity_id:video.source_entity_id||channelEntityId,source_family_id:video.source_family_id||sourceFamilyIdentity({provider:'youtube',nativeId:video.id||`${candidate.channelId}:slot:${index}`}).familyId}));
  const structuredExternalLinks=(candidate.externalLinkDetails||(candidate.channelLinks||[]).map(url=>({url}))).map(detail=>{let familyId='source_family_id' in detail&&typeof detail.source_family_id==='string'?detail.source_family_id:undefined;if(!familyId)try{familyId=sourceFamilyIdentity({provider:'external-link',canonicalUrl:detail.url}).familyId;}catch{familyId=sourceFamilyIdentity({provider:'external-link',artifactId:entityChecksum(detail.url)}).familyId;}return {...detail,source_family_id:familyId};});
  void observeYouTubeChannelEntity({channelId:candidate.channelId,channelName:candidate.channelName,youtubeUrl:candidate.youtubeUrl,observedAt:now,videos:structuredVideos,externalUrls:structuredExternalLinks.map(detail=>detail.url)}).catch(error=>console.warn(`[EntityResolution] Channel observation failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));
  const languageInputs = classifierLanguageInputs(candidate, structuredVideos, isEnrichmentPass);
  // Resolve attribution once so provider events and the production diagnostic
  // describe the same active job/run. Candidate provenance remains the fallback.
  const activeJobId=options?.jobId||candidate.discoveryJobId;
  const activeRunId=options?.runId||candidate.queryRunId;
  const classifierInput:RawChannelInput={
    channel_id:candidate.channelId,channel_name:candidate.channelName,description:candidate.description||'',country:creatorCountry || undefined,
    job_id:activeJobId,run_id:activeRunId,
    channel_entity_id:channelEntityId,channel_source_family_id:channelSourceFamilyId,
    location_tag:candidate.locationTag,external_links:candidate.channelLinks||[],external_link_details:structuredExternalLinks,
    // Language inputs resolved above (classifierLanguageInputs): enrichment
    // passes strip enrichment-added hints, other passes preserve them.
    videos:languageInputs.videos,
    video_titles:candidate.videoTitles,video_descriptions:candidate.videoDescriptions||[],videoDescriptionsAuthoritative:candidate.videoDescriptionsAuthoritative,
    playlists:candidate.playlists,
    transcript_excerpts:candidate.transcriptExcerpts,detected_languages:languageInputs.detected_languages,visual_evidence:candidate.visualEvidence,
    pinned_comment:candidate.pinnedComment,enrichment_stage:candidate.enrichmentStage||0,
    // Completed Discord validation is stored evidence. Supply it to the
    // existing DiscordProvider so classification evaluates the complete
    // evidence set; the provider/policy still decides whether it is enough.
    discord_invite:validatedDiscordEvidenceInvite(existing) || undefined,
    subscriber_count:parseSubscriberCountNumber(candidate.subscriberCount),video_count:structuredVideos.length,
    search_match_context:candidate.matchedDocument?{type:candidate.matchedDocument.type,provider_native_id:candidate.matchedDocument.providerNativeId,title:candidate.matchedDocument.title,description:candidate.matchedDocument.description,published_at:candidate.matchedDocument.publishedAt,locator:candidate.matchedDocument.locator}:undefined,
    activity_metadata:{latest_upload_at:candidate.latestUploadAt,uploads_last_30_days:candidate.uploadsLast30Days,uploads_last_90_days:candidate.uploadsLast90Days,uploads_last_365_days:candidate.uploadsLast365Days,activity_band:candidate.activityBand,activity_score:candidate.activityScore,observed_at:candidate.activityObservedAt}
  };
  const productionClassification = await classifyTradingRelevanceDetailed(classifierInput);
  const classificationRouting = productionClassification.decision.deterministicRouting;
  const routingActive = resolveClassificationRoutingMode() === 'ACTIVE';
  const deterministicReview = routingActive && classificationRouting?.humanReview === true;
  const decisionReadyWithoutFailedProvider=hasDecisionGradeEvidenceWithoutFailedProviders(productionClassification.decision);
  const enrichmentProviderFailure=enrichmentOperationalFailure(
    productionClassification.decision.evidenceCollection,
    isEnrichmentPass,
    decisionReadyWithoutFailedProvider
  );
  if(enrichmentProviderFailure) throw enrichmentProviderFailure;
  if (source === 'recheck' && isManualScan && productionClassification.decision.evidenceCollection.degraded) {
    const recheckError = manualRecheckDegradedError(productionClassification.decision.evidenceCollection);
    if (recheckError) throw recheckError;
  }
  const classificationDiagnosticId=await observeProductionDiagnosticReliably({type:'PRODUCTION_DIAGNOSTIC',input:{channelId:candidate.channelId,input:productionClassification.input,decision:productionClassification.decision,jobId:activeJobId,queryRunId:activeRunId,nominationId:candidate.nominationId}})
    .catch(error=>{console.warn(`[ClassificationDiagnostics] write failed for ${candidate.channelId}:`,error instanceof Error?error.message:error);return undefined;});
  let tradingVal = productionClassification.result;
  if (routingActive && classificationRouting?.humanReview === true
    && (classificationRouting.reasonCodes.includes('NON_TERMINAL_NEGATIVE_EVIDENCE_REQUIRES_REVIEW')
      || classificationRouting.reasonCodes.includes('NON_TRADING_CONTENT_FOCUS_REQUIRES_REVIEW'))) {
    // The evidence policy already refuses keyword-only rejection; this is the
    // final pipeline guard so a malformed NON_TRADING decision, or a confirmed
    // decision whose video sample contradicts its bio, cannot skip human review.
    tradingVal = { ...tradingVal, status: 'UNCERTAIN' };
  }
  void recordAdmissionShadow({channelId:candidate.channelId,priorState:'NOT_EVALUATED',classificationStatus:productionClassification.decision.status,
    investigationState:productionClassification.decision.status==='UNCERTAIN'?'ACTIVE':'COMPLETED',classificationDiagnosticId,
    candidateHypothesis:{category:productionClassification.decision.category,positiveEvidenceCount:productionClassification.decision.positiveEvidence.length},
    evidenceCoverage:{sufficiency:productionClassification.decision.evidenceCollection.sufficiency,degraded:productionClassification.decision.evidenceCollection.degraded,fieldsPresent:productionClassification.decision.evidenceCollection.fieldsPresent}})
    .catch(error=>console.warn(`[CandidateAdmission] shadow write failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));
  try {
    const shadow=await runAndRecordAdaptiveShadow(candidate.channelId,productionClassification.input,productionClassification.decision);
    const governedEnabled=await getAppSetting('governed_classifier_production_enabled','false')==='true';
    if(governedEnabled&&shadow.evidence.length>0&&productionClassification.decision.positiveEvidence.length>0&&productionClassification.decision.negativeEvidence.length===0){
      const evidence=[...productionClassification.decision.positiveEvidence,...productionClassification.decision.negativeEvidence,...shadow.evidence];
      const governedReports=shadow.evidence.map(item=>item.source).filter((source,index,all)=>all.indexOf(source)===index).map(provider=>({provider,availability:'AVAILABLE' as const,evidenceCount:shadow.evidence.filter(item=>item.source===provider).length,outcome:'EXECUTED_WITH_EVIDENCE' as const,reasonCodes:['GOVERNED_PRODUCTION_EVIDENCE_TRANSPORTED']}));
      const collection:EvidenceCollectionReport={...productionClassification.decision.evidenceCollection,providers:[...productionClassification.decision.evidenceCollection.providers,...governedReports]};
      // evaluateChannel builds a corpus on a local copy, so the caller's input
      // never carries one. Rebuild it here and pass the same knowledge context
      // the production evaluator used; otherwise every governed composition is
      // empty and the creator's own content is ignored.
      const governedInput: RawChannelInput = { ...productionClassification.input, evidence_corpus: buildCanonicalEvidenceCorpus(productionClassification.input) };
      const governedContext = getLayeredKnowledgeContext(governedInput.country || 'UNKNOWN');
      const governedCodes = contentLanguagePacks(governedInput, governedContext).map(pack => pack.languageCode);
      governedContext.languageKnowledgePacks = [...new Map([
        ...(governedContext.languageKnowledgePacks || []),
        ...governedCodes.map(code => LANGUAGE_KNOWLEDGE_PACKS[code]).filter(Boolean),
      ].map(pack => [pack.languageCode, pack])).values()];
      const stages=evaluateClassificationStages(governedInput,evidence,collection,buildContextualComposition(governedInput,governedContext));
      const governedDecision=new ConfigurableWeightedStrategy().evaluateDecision(evidence,{globalInstruments:[],globalPlatformsPropFirms:[],globalAdvancedConcepts:[],globalNegativeTerms:[]},creatorCountry || undefined,collection,stages);
      tradingVal={...tradingVal,status:governedDecision.status,confidenceScore:governedDecision.confidenceScore,category:governedDecision.category,breakdown:{...tradingVal.breakdown,reasoning:[...(tradingVal.breakdown.reasoning||[]),...governedDecision.mathematicalJustification.split(' | '),'GOVERNED ROLLOUT: evidence traversed the production staged classifier; no decision bypass was used.']}};
    }
  } catch(error) { console.warn(`[AdaptiveClassifier] Shadow evaluation failed for ${candidate.channelId}:`,error instanceof Error?error.message:error); }

  if (tradingVal.status === 'NON_TRADING') {
    console.log(
      `[Unified Ingestion Pipeline - Gate 2] Channel '${candidate.channelName}' REJECTED as VERIFIED_NON_TRADING (${tradingVal.breakdown.classification_method || 'EVIDENCE'}, Score: ${tradingVal.confidenceScore}/100). Halting pipeline (Skipping Discord crawler).`
    );

    const nonTradingChannel: ChannelRecord = existing || {
      channel_id: candidate.channelId,
      channel_name: candidate.channelName,
      youtube_url: candidate.youtubeUrl,
      country: creatorCountry,
      country_status: countryVal.status,
      confidence_score: countryVal.score,
      discord_status: 'UNCERTAIN',
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
    nonTradingChannel.country = creatorCountry;
    nonTradingChannel.confidence_score = countryVal.score;
    nonTradingChannel.trading_status = 'NON_TRADING';
    nonTradingChannel.trading_confidence_score = tradingVal.confidenceScore;
    nonTradingChannel.trading_category = tradingVal.category;
    nonTradingChannel.trading_relevance_breakdown = tradingVal.breakdown;
    nonTradingChannel.scan_status = 'SKIPPED_NON_TRADING';
    // The Discord crawler did not run for this trading-classification skip, so
    // the honest persisted Discord state is "untouched", not NON_TRADING. The
    // database trigger `normalize_upstream_skipped_discord_state` enforces the
    // same shape; mirror it here so the returned record matches what is stored.
    nonTradingChannel.discord_status = 'UNCERTAIN';
    nonTradingChannel.discord_invite = null;
    nonTradingChannel.discord_discovery_status = 'NOT_DISCOVERED';
    nonTradingChannel.discord_resolution_status = 'NOT_ATTEMPTED';
    nonTradingChannel.discord_liveness_status = 'NOT_CHECKED';
    nonTradingChannel.discord_relevance_status = 'NOT_CHECKED';
    nonTradingChannel.discord_validation_status = 'NOT_STARTED';
    nonTradingChannel.last_checked = now;
    applyCandidateObservability(nonTradingChannel, candidate);

    // Gate 2 is a fresh terminal classification, not a stale ordinary snapshot:
    // it must be allowed to clear a previously serving Discord invite. Without
    // this explicit option the locked-row retention guard would keep the old
    // ACTIVE projection while the row's trading status becomes NON_TRADING.
    await upsertChannel(nonTradingChannel, { allowDiscordClear: true });

    return {
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      isNew: !existing,
      wasKnown: !!existing,
      persisted: true,
      countryStatus: countryVal.status,
      tradingStatus: 'NON_TRADING',
      discordStatus: 'UNCERTAIN',
      discordInvite: null,
      channelRecord: nonTradingChannel
    };
  }

  if (tradingVal.status === 'UNCERTAIN') {
    console.log(
      `[Unified Ingestion Pipeline - Gate 2] Channel '${candidate.channelName}' classified as UNCERTAIN (${tradingVal.confidenceScore}/100). Evaluating the governed enrichment/review route.`
    );

    const currentStage=candidate.enrichmentStage||0;
    const independentHypothesis=hasIndependentTradingHypothesis(productionClassification.decision);
    // Trading classification is not Discord validation evidence. Capture any
    // already-established Discord projection before this branch mutates the
    // shared existing row, so a later UNCERTAIN/review reclassification cannot
    // clear a live invite or make it look unvalidated to the retry path.
    const preservedDiscordState=existing&&hasEstablishedValidatedDiscordSelection(existing)
      ?projectTradingReclassificationDiscordState(existing)
      :null;

    // Once creator-level enrichment has run, absence of any independent trading
    // hypothesis means machine evidence is exhausted without a safe terminal
    // classification. Do not silently present that state as COMPLETED: route it
    // to operator review so the channel can be explicitly approved or rejected,
    // and never run Discord inspection unless a trading decision is approved.
    if (currentStage > 0 && !independentHypothesis) {
      console.log(`[Unified Ingestion Pipeline - Gate 2] Routing '${candidate.channelName}' to human review after enrichment: no independent trading hypothesis and no safe terminal classifier decision.`);
      const withheldChannel: ChannelRecord = existing || {
        channel_id:candidate.channelId, channel_name:candidate.channelName, youtube_url:candidate.youtubeUrl,
        country:creatorCountry, country_status:countryVal.status, confidence_score:countryVal.score,
        discord_status:'UNCERTAIN', discord_invite:null, scan_status:'NEEDS_REVIEW', scan_attempts:0,
        discovery_source:source, first_seen:now, last_checked:now, inspection_trail:[countryValidationStep],
        subscriber_count:candidate.subscriberCount,
        channel_thumbnail_url:candidate.channelThumbnailUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(candidate.channelName)}&background=0f172a&color=38bdf8&bold=true`,
        trading_status:'NEEDS_REVIEW', trading_confidence_score:tradingVal.confidenceScore,
        trading_category:tradingVal.category, trading_relevance_breakdown:tradingVal.breakdown
      };
      withheldChannel.country=creatorCountry; withheldChannel.country_status=countryVal.status; withheldChannel.confidence_score=countryVal.score;
      withheldChannel.trading_status='NEEDS_REVIEW'; withheldChannel.trading_confidence_score=tradingVal.confidenceScore;
      withheldChannel.trading_category=tradingVal.category; withheldChannel.trading_relevance_breakdown=tradingVal.breakdown;
      withheldChannel.scan_status='NEEDS_REVIEW';
      // This branch performs no Discord validation. Reuse the shared
      // classification-only projection so an existing invite is never cleared
      // merely because the row is not recognized as an established selection.
      Object.assign(withheldChannel,projectTradingReclassificationDiscordState(withheldChannel));
      withheldChannel.last_checked=now;
      applyCandidateObservability(withheldChannel,candidate);
      await upsertChannel(withheldChannel,{preserveDiscordOnUpdate:true});
      void recordAdmissionShadow({channelId:candidate.channelId,priorState:'WITHHELD_INVESTIGATING',classificationStatus:'NEEDS_REVIEW',investigationState:'REVIEW_ELIGIBLE',classificationDiagnosticId,
        candidateHypothesis:{plausibleTradingHypothesis:false,positiveEvidenceCount:productionClassification.decision.positiveEvidence.length,triagePolicyVersion:CANDIDATE_TRIAGE_POLICY_VERSION},
        evidenceCoverage:{sufficiency:productionClassification.decision.evidenceCollection.sufficiency,degraded:productionClassification.decision.evidenceCollection.degraded,fieldsPresent:productionClassification.decision.evidenceCollection.fieldsPresent,enrichmentStage:currentStage,reasonCodes:['NO_INDEPENDENT_TRADING_HYPOTHESIS_AFTER_ENRICHMENT']}})
        .catch(error=>console.warn(`[CandidateAdmission] post-enrichment withholding write failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));
      void recordReviewEligibilityShadow({channelId:candidate.channelId,classificationDiagnosticId,classificationStatus:'UNCERTAIN',investigationState:'NEEDS_REVIEW',plausibleTradingHypothesis:false,evidenceSufficient:productionClassification.decision.evidenceCollection.sufficiency==='SUFFICIENT',independentEvidence:false,countryAllowed:true,operationalFailure:false,providerDegraded:productionClassification.decision.evidenceCollection.degraded,unsupportedLanguage:productionClassification.decision.evidenceCollection.providers.some(provider=>provider.outcome==='ABSTAINED_UNSUPPORTED_LANGUAGE'),terminalDecision:false,decidedAt:productionClassification.decision.timestamp})
        .catch(error=>console.warn(`[ReviewEligibility] withholding shadow write failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));
      const authoritativeWithheld=(await getChannelById(candidate.channelId))||withheldChannel;
      return {channelId:candidate.channelId,channelName:candidate.channelName,isNew:!existing,wasKnown:!!existing,persisted:true,countryStatus:countryVal.status,tradingStatus:'NEEDS_REVIEW',discordStatus:authoritativeWithheld.discord_status,discordInvite:authoritativeWithheld.discord_invite??null,channelRecord:authoritativeWithheld};
    }

    const legacyAction:EvidenceActionType=currentStage>=2?'HUMAN_REVIEW':currentStage===1?'VIDEO_PLAYLIST_CORROBORATION':'CHANNEL_RECENT_METADATA';
    let evidencePlan:EvidenceActionPlan|undefined;
    try {const quota=await getQuota();evidencePlan=await planAndRecordEvidenceAction({channelId:candidate.channelId,diagnosticId:classificationDiagnosticId,decision:productionClassification.decision,rawInput:productionClassification.input,legacyAction,providerQuotaRemaining:Math.max(0,quota.dailyLimit-quota.unitsUsed)});} catch(error){console.warn(`[VOI Evidence] Planning failed for ${candidate.channelId}; preserving legacy enrichment.`,error instanceof Error?error.message:error);}
    const appliedAction=evidencePlan?.appliedAction||legacyAction;
    const shouldReview=appliedAction==='HUMAN_REVIEW'||deterministicReview;
    if(deterministicReview)console.log(`[Unified Ingestion Pipeline - Routing] Channel '${candidate.channelName}' reached human review: ${classificationRouting?.fallbackReason||'DETERMINISTIC_AMBIGUITY'}.`);
    const corroboration=productionClassification.decision.stagedClassification?.stages.find(stage=>stage.stage==='CORROBORATION');
    const reviewEligibilityInput={classificationStatus:'UNCERTAIN',investigationState:shouldReview?'UNRESOLVED':'ACTIVE',plausibleTradingHypothesis:independentHypothesis||deterministicReview,evidenceSufficient:productionClassification.decision.evidenceCollection.sufficiency==='SUFFICIENT',independentEvidence:corroboration?.disposition==='PASS',countryAllowed:true,operationalFailure:false,providerDegraded:resolveReviewProviderDegraded(productionClassification.decision.evidenceCollection),unsupportedLanguage:productionClassification.decision.evidenceCollection.providers.some(provider=>provider.outcome==='ABSTAINED_UNSUPPORTED_LANGUAGE'),terminalDecision:false};
    const reviewEligibility=evaluateReviewEligibilityV2(reviewEligibilityInput);
    const lifecycle = resolveUncertainLifecycle(shouldReview,reviewEligibility);
    // Preserve an evidence-complete human-ambiguity decision as NEEDS_REVIEW.
    // resolveUncertainLifecycle already keeps low-information, degraded, active,
    // and non-candidate cases machine-owned; remapping its review result to
    // UNCERTAIN/COMPLETED silently stranded useful human-adjudication work.
    const finalUncertainStatus = lifecycle.tradingStatus;
    const finalScanStatus = lifecycle.scanStatus;

    const uncertainChannel: ChannelRecord = existing || {
      channel_id: candidate.channelId,
      channel_name: candidate.channelName,
      youtube_url: candidate.youtubeUrl,
      country: creatorCountry,
      country_status: countryVal.status,
      confidence_score: countryVal.score,
      discord_status: 'UNCERTAIN',
      discord_invite: null,
      scan_status: finalScanStatus,
      scan_attempts: 0,
      discovery_source: source,
      first_seen: now,
      last_checked: now,
      inspection_trail: [countryValidationStep],
      subscriber_count: candidate.subscriberCount,
      channel_thumbnail_url: candidate.channelThumbnailUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(candidate.channelName)}&background=0f172a&color=38bdf8&bold=true`,
      trading_status: finalUncertainStatus,
      trading_confidence_score: tradingVal.confidenceScore,
      trading_category: tradingVal.category,
      trading_relevance_breakdown: tradingVal.breakdown
    };

    if (!shouldPreserveResolvedCountry(existing?.country_status, countryVal.status)) {
      uncertainChannel.country_status = countryVal.status;
      uncertainChannel.country = creatorCountry;
      uncertainChannel.confidence_score = countryVal.score;
    }
    uncertainChannel.trading_status = finalUncertainStatus;
    uncertainChannel.trading_confidence_score = tradingVal.confidenceScore;
    uncertainChannel.trading_category = tradingVal.category;
    uncertainChannel.trading_relevance_breakdown = tradingVal.breakdown;
    uncertainChannel.scan_status = finalScanStatus;
    uncertainChannel.discord_status = preservedDiscordState?.discord_status ?? 'UNCERTAIN';
    if (preservedDiscordState) uncertainChannel.discord_invite = preservedDiscordState.discord_invite;
    uncertainChannel.last_checked = now;
    applyCandidateObservability(uncertainChannel, candidate);

    // Classification-only write: the upsert keeps the locked row's Discord
    // projection so a validation committed during classification still wins.
    await upsertChannel(uncertainChannel,{preserveDiscordOnUpdate:true});
    await recordReviewEligibilityShadow({channelId:candidate.channelId,classificationDiagnosticId,...reviewEligibilityInput,decidedAt:productionClassification.decision.timestamp});
    const authoritativeChannel=(await getChannelById(candidate.channelId))||uncertainChannel;

    if (lifecycle.shouldEnqueue) {
      const action=ACTIONS.find(item=>item.action===appliedAction),nextStage=action?.enrichmentStage||Math.min(2,currentStage+1);
      if(isEnrichmentStageExhausted(isEnrichmentPass,currentStage,nextStage)){
        // The pass already executed this stage. Close the machine-owned
        // marker instead of enqueueing the same stage forever.
        const terminal=resolveEnrichmentReopenBlockedLifecycle(authoritativeChannel,{blockedJobStatus:'COMPLETED',hasOtherActiveEnrichmentJob:false});
        if(terminal.scanStatus!==authoritativeChannel.scan_status){
          const refreshed=await projectBlockedEnrichmentScanStatus(candidate.channelId,terminal.scanStatus,now,options?.jobId);
          if(refreshed)Object.assign(authoritativeChannel,refreshed);
        }
      }else{
        const vitality=deriveVitalityScheduling(productionClassification.input.activity_metadata,productionClassification.decision.timestamp),priority=10+vitality.jobPriorityDelta,payload={ channelId: candidate.channelId, targetCountry, source, candidate, enrichmentStage:nextStage, quotaOrigin: currentOfficialYouTubeQuotaOrigin() === 'PROBE' ? 'PROBE' : 'NORMAL', evidenceAcquisitionDecisionId:evidencePlan?.decisionId, evidenceAction:appliedAction, vitalityScheduling:vitality };
        // Ordinary rediscovery must not turn completed enrichment back into
        // PENDING or create a second job beside active work. The stable
        // channel/stage identity makes enqueue naturally idempotent across day
        // boundaries; preventCompletedReopen keeps completed work terminal while
        // still allowing a FAILED job to retry. Explicit rechecks use a fresh
        // recheck key and are never blocked by an earlier completed pass.
        const explicitRecheck=isManualScan||source==='recheck';
        const enrichmentKey=enrichmentJobIdempotencyKey(candidate.channelId,nextStage,Date.now(),{explicitRecheck,recheckNonce:explicitRecheck?randomUUID():undefined});
        const enqueueEnrichment=(extra?:Record<string,unknown>)=>enqueueJob('ENRICH_CHANNEL',extra?{...payload,...extra}:payload,{priority,maxAttempts:4,idempotencyKey:enrichmentKey,...(explicitRecheck?{}:{preventCompletedReopen:true})});
        // Recover a failed workflow owner: restore its step before reopening the
        // stable job so the worker keeps investigation tracking. If admission is
        // refused or the enqueue fails, put the blocked projection back.
        const enqueueWorkflowRetry=async(failed:{id:string},investigationId:string,stepId:string)=>{
          let retryLinkage:Record<string,unknown>|undefined;
          if(investigationId&&stepId){
            try{if(await retryInvestigationStep({investigationId,stepId}))retryLinkage={investigationId,investigationStepId:stepId};}
            catch(error){console.warn(`[Investigation] Failed to reopen step for ${candidate.channelId}; retrying without workflow linkage:`,error instanceof Error?error.message:error);}
          }
          try{
            const job=await enqueueEnrichment(retryLinkage);
            if(retryLinkage&&job?.reopen_blocked===true){
              await restoreBlockedInvestigationStep({investigationId,stepId,jobId:failed.id,reason:'RETRY_NOT_ADMITTED'})
                .catch(error=>console.warn(`[Investigation] Failed to restore blocked step for ${candidate.channelId}:`,error instanceof Error?error.message:error));
            }
            return job;
          }catch(error){
            if(retryLinkage){
              await restoreBlockedInvestigationStep({investigationId,stepId,jobId:failed.id,reason:'RETRY_ENQUEUE_FAILED'})
                .catch(restoreError=>console.warn(`[Investigation] Failed to restore blocked step for ${candidate.channelId}:`,restoreError instanceof Error?restoreError.message:restoreError));
            }
            throw error;
          }
        };
        const scheduleWorkflowOwner=async()=>{
          const scheduled=await scheduleInvestigationStep({investigationId:candidate.investigationId,channelId:candidate.channelId,diagnosticId:classificationDiagnosticId,actionType:appliedAction,jobType:'ENRICH_CHANNEL',jobPayload:payload,priority,maxAttempts:4,idempotencyKey:enrichmentKey,policyVersion:INVESTIGATION_POLICY_VERSION,utilityContractVersion:'utility-constraints-v1',deadlineMinutes:Number(await getAppSetting('investigation_deadline_minutes','30'))||30});
          // A failed owner needs its step restored before the job reopen. An
          // already-claimed owner cannot accept a step and is reused through the
          // idempotent queue path; a completed owner drives the blocked lifecycle
          // projection.
          if(scheduled.job.status==='FAILED')return enqueueWorkflowRetry(scheduled.job,scheduled.investigationId,scheduled.stepId);
          if(!scheduled.stepId||scheduled.job.status!=='PENDING')return enqueueEnrichment();
          return undefined;
        };
        const workflowAssignment=await assignRelease5Serving('INVESTIGATION_WORKFLOW',candidate.channelId).catch(()=>({assigned:false,mode:'OFF'})),legacyWorkflowEnabled=await getAppSetting('investigation_workflow_enabled','false')==='true';
        let enqueued: Awaited<ReturnType<typeof enqueueJob>> | undefined;
        if(workflowAssignment.assigned||legacyWorkflowEnabled){
          // The workflow lane must reuse the stable channel/stage owner instead
          // of scheduling a second job under a per-classification key. An
          // existing active job already owns the work, a completed one is
          // terminal, and failed work retries through the ordinary reopen path.
          let existing: Awaited<ReturnType<typeof getJobByIdempotencyKey>> = null,lookupFailed=false;
          if(!explicitRecheck){
            try{existing=await getJobByIdempotencyKey(enrichmentKey);}
            catch(error){lookupFailed=true;console.warn(`[Investigation] Stable enrichment lookup failed for ${candidate.channelId}; using the idempotent queue path:`,error instanceof Error?error.message:error);}
          }
          const admission=resolveExistingEnrichmentAction(explicitRecheck?null:existing?.status,lookupFailed);
          if(admission==='REUSE_ACTIVE'&&existing)enqueued=existing;
          else if(admission==='PROJECT_TERMINAL'&&existing)enqueued={...existing,reopen_blocked:true};
          else if(admission==='RETRY_FAILED'&&existing){
            enqueued=await enqueueWorkflowRetry(existing,String(existing.payload?.investigationId||''),String(existing.payload?.investigationStepId||''));
          }
          else if(admission==='ENQUEUE_IDEMPOTENT'){
            // The stable-key read failed, but the scheduler can still find and
            // restore a failed workflow owner. Fall back to the idempotent queue
            // only when scheduling itself fails.
            try{enqueued=await scheduleWorkflowOwner();}
            catch(error){if(candidate.investigationId)throw error;console.error(`[Investigation] Lookup-recovery scheduling failed for ${candidate.channelId}; using compatible queue fallback.`,error);enqueued=await enqueueEnrichment();}
          }
          else{
            try{enqueued=await scheduleWorkflowOwner();}
            catch(error){if(candidate.investigationId)throw error;console.error(`[Investigation] Initial transactional scheduling failed for ${candidate.channelId}; using compatible queue fallback.`,error);enqueued=await enqueueEnrichment();}
          }
        }else enqueued=await enqueueEnrichment();
        if(enqueued?.reopen_blocked===true){
          // The stable same-stage pass is already terminal. Project the honest
          // terminal state, but update only the committed row's scan status so
          // a concurrent recovery/recheck cannot be overwritten by this stale
          // snapshot. The same UPDATE excludes a later-stage active job in one
          // statement, which narrows the race to a job committed after that
          // statement's snapshot. A worker that still owns the channel will
          // reassert its marker; no separate read can orphan the pending row.
          // A blocked FAILED job is FAILED, never COMPLETED.
          const blocked=resolveEnrichmentReopenBlockedLifecycle(authoritativeChannel,{blockedJobStatus:enqueued.status,hasOtherActiveEnrichmentJob:false});
          if(blocked.scanStatus!==authoritativeChannel.scan_status){
            const refreshed=await projectBlockedEnrichmentScanStatus(candidate.channelId,blocked.scanStatus,now,options?.jobId);
            if(refreshed)Object.assign(authoritativeChannel,refreshed);
          }
        }
      }
    }

    return {
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      isNew: !existing,
      wasKnown: !!existing,
      persisted: true,
      countryStatus: authoritativeChannel.country_status,
      tradingStatus: authoritativeChannel.trading_status || finalUncertainStatus,
      discordStatus: authoritativeChannel.discord_status,
      discordInvite: authoritativeChannel.discord_invite ?? null,
      channelRecord: authoritativeChannel
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
    country: creatorCountry,
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
  activeChannel.country = creatorCountry;
  activeChannel.confidence_score = countryVal.score;
  activeChannel.trading_status = tradingVal.status;
  activeChannel.trading_confidence_score = tradingVal.confidenceScore;
  activeChannel.trading_category = tradingVal.category;
  activeChannel.trading_relevance_breakdown = tradingVal.breakdown;
  activeChannel.scan_status = 'LOCKED';
  applyCandidateObservability(activeChannel, candidate);

  await upsertChannel(activeChannel);

  // Run Discord Inspection Engine. Lane attribution is observational only and
  // defaults to the pipeline shape when the caller does not supply one.
  await inspectAndValidateChannel(activeChannel, candidate, isManualScan, false, true, undefined, {
    lane: options?.lane || (isManualScan ? 'MANUAL' : isEnrichmentPass ? 'ENRICHMENT' : 'DISCOVERY'),
    ...(options?.jobType ? { jobType: options.jobType } : {}),
    ...(options?.jobId ? { jobId: options.jobId } : {}),
    slicePass: 1,
  });

  const finalChannel = (await getChannelById(candidate.channelId)) || activeChannel;

  // Compute Quality Score & Extract Vocabulary if Quality >= 55
  const qualityResult = calculateCreatorQualityScore(finalChannel, candidate.videoTitles, candidate.description);
  finalChannel.quality_score = qualityResult.score;
  finalChannel.quality_breakdown = qualityResult.breakdown;
  await upsertChannel(finalChannel);

  // Expanded extraction split (CDL §7.8): the candidate-corpus path stays
  // quality-gated exactly as before, while the native terminology path may
  // also admit country-valid CONFIRMED + TRADING_CONFIRMED creators below the
  // quality bar. Those lower-quality observations are promotion-ineligible
  // and never write legacy extracted_vocabulary rows.
  // Independent settings: one query and one round trip avoids three serial
  // setting reads on the successful-ingestion path.
  // A settings-read failure must not fail the channel ingestion after the
  // channel row was already upserted. Missing or unreadable gates fail closed
  // to the legacy quality path; migration 161 seeds all three to 'true' for
  // the normal CDL path.
  let extractionValues = new Map<string, string>();
  try {
    const extractionSettings = await (await getDb()).query(
      `SELECT setting_key,setting_value FROM app_settings WHERE setting_key = ANY($1)`,
      [['country_discovery_loop_enabled', 'native_vocabulary_extraction_enabled', 'native_evidence_promotion_v2_enabled']],
    );
    extractionValues = new Map<string, string>((extractionSettings.rows || []).map(
      (row: Record<string, unknown>) => [String(row.setting_key), String(row.setting_value)],
    ));
  } catch (error) {
    console.warn('[Ingestion] CDL extraction settings read failed; falling back to the legacy extraction path:', error);
  }
  const extractionFlag = (key: string): boolean => (extractionValues.get(key) ?? 'false') === 'true';
  const cdlEnabled = extractionFlag('country_discovery_loop_enabled');
  const nativeExtractionFlagEnabled = extractionFlag('native_vocabulary_extraction_enabled');
  const promotionV2Enabled = extractionFlag('native_evidence_promotion_v2_enabled');
  const extraction = resolveNativeExtractionEligibility({
    cdlEnabled,
    nativeExtractionFlagEnabled,
    promotionV2Enabled,
    qualityScore: qualityResult.score,
    source,
    countryStatus: finalChannel.country_status,
    countryInScope: resolveScopeEligibility(finalChannel.country) === 'IN_SCOPE',
    tradingStatus: finalChannel.trading_status,
  });

  // Candidate-corpus shadow path: unchanged, quality-gated only. Operator
  // rechecks are not autonomous corpus evidence: their observations stay in
  // the channel/terminology audit trail and must not feed AUTONOMOUS lineage.
  if (extraction.termHarvestEnabled && !isManualScan) {
    await enqueueTermHarvest({channelId:finalChannel.channel_id,text:[candidate.description,...candidate.videoTitles].filter(Boolean).join('\n'),lineage:'AUTONOMOUS'});
  }

  // Native terminology path: existing quality path or expanded confirmed-
  // trader path. Provenance: aligned YouTube video IDs trace title-backed
  // terminology observations to their source video.
  if (extraction.nativeEligible) {
    await invokeChannelVocabularyExtraction(finalChannel, candidate, selectExplicitTerminologyLanguageContext(candidate), undefined, {
      promotionEligible: extraction.promotionEligible,
      persistLegacyTerm: extraction.persistLegacyTerm,
      queryRunId: options?.runId || candidate.queryRunId,
      queryPageNumber: candidate.queryPageNumber,
    });
  }

  return {
    channelId: candidate.channelId,
    channelName: candidate.channelName,
    isNew: !existing,
    wasKnown: !!existing,
    persisted: true,
    countryStatus: countryVal.status,
    tradingStatus: finalChannel.trading_status || tradingVal.status,
    discordStatus: finalChannel.discord_status,
    discordInvite: finalChannel.discord_invite || null,
    channelRecord: finalChannel
  };
}

/**
 * Project a blocked enrichment owner's terminal scan state without clobbering
 * a later-stage active job. One statement keeps the ownership check and write
 * in the same snapshot.
 */
async function projectBlockedEnrichmentScanStatus(
  channelId: string,
  targetScanStatus: ChannelRecord['scan_status'],
  now: string,
  excludeJobId?: string | null,
): Promise<ChannelRecord | null> {
  const db = await getDb();
  await db.query(
    `UPDATE channels c SET scan_status=$2,last_checked=$3,updated_at=now()
      WHERE c.channel_id=$1 AND c.scan_status = ANY($4::text[])
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.type='ENRICH_CHANNEL'
             AND j.status IN ('PENDING','PROCESSING')
             AND j.payload->>'channelId'=c.channel_id
             AND ($5::uuid IS NULL OR j.id<>$5::uuid)
        )`,
    [channelId, targetScanStatus, now, ['ENRICHMENT_PENDING','ENRICHING','LOCKED'], excludeJobId || null],
  );
  return getChannelById(channelId);
}

function applyCandidateObservability(channel: ChannelRecord, candidate: IngestionCandidate): void {
  channel.quota_origin = persistedQuotaOrigin(
    channel.quota_origin,
    candidate.quotaOrigin,
    currentOfficialYouTubeQuotaOrigin(),
  );
  channel.country_metadata_status = candidate.countryMetadataStatus || channel.country_metadata_status || 'NOT_REQUESTED';
  channel.country_metadata_checked_at = candidate.countryMetadataCheckedAt || channel.country_metadata_checked_at || null;
  channel.public_about_status = (candidate as any).publicAboutStatus || channel.public_about_status || 'NOT_ATTEMPTED';
  channel.public_about_checked_at = (candidate as any).publicAboutCheckedAt || channel.public_about_checked_at || null;
  channel.public_about_attempts = (candidate as any).publicAboutAttempts ?? channel.public_about_attempts ?? 0;
  channel.latest_upload_at = candidate.latestUploadAt || channel.latest_upload_at || null;
  channel.uploads_last_30_days = candidate.uploadsLast30Days ?? channel.uploads_last_30_days ?? 0;
  channel.uploads_last_90_days = candidate.uploadsLast90Days ?? channel.uploads_last_90_days ?? 0;
  channel.uploads_last_365_days = candidate.uploadsLast365Days ?? channel.uploads_last_365_days ?? 0;
  channel.activity_band = candidate.activityBand || channel.activity_band || 'UNKNOWN';
  channel.activity_score = candidate.activityScore ?? channel.activity_score ?? 50;
  channel.activity_observed_at = candidate.activityObservedAt || channel.activity_observed_at || null;
}