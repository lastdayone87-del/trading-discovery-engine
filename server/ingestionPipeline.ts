import { ChannelRecord, DiscoverySource, DiscordStatus } from '../src/types';
import { DiscoveredChannelRaw, fetchYouTubeChannelCountryMetadata } from './youtube';
import { validateChannelCountry } from './countryValidator';
import { classifyTradingRelevanceDetailed } from './tradingRelevanceClassifier';
import { runAndRecordAdaptiveShadow } from './adaptiveTradingClassifier';
import { inspectAndValidateChannel } from './queueManager';
import {
  getChannelById,
  upsertChannel,
  enqueueJob,
  getQuota,
  getAppSetting
} from './db';
import { calculateCreatorQualityScore, extractVocabularyFromCreator } from './queryIntelligence';
import { enqueueTermHarvest } from './candidateCorpus';
import { resolveUncertainLifecycle } from './enrichmentLifecycle';
import {ConfigurableWeightedStrategy,evaluateClassificationStages,type EvidenceCollectionReport,type RawChannelInput} from './evidenceEngine';
import { observeProductionDiagnosticReliably, observeRetrievalAssignmentReliably } from './phaseBObservationOutbox';
import { ACTIONS, deriveVitalityScheduling, planAndRecordEvidenceAction, type EvidenceActionType, type EvidenceActionPlan } from './voiEvidenceController';
import { INVESTIGATION_POLICY_VERSION, scheduleInvestigationStep } from './investigationWorkflow';
import {assignRelease5Serving} from './release5/rollout';
import { deterministicUuid, entityChecksum, observeYouTubeChannelEntity, sourceFamilyIdentity } from './entityResolution';
import { recordAdmissionShadow } from './candidateAdmission/shadowEvaluator';
import { recordReviewEligibilityShadow } from './reviewEligibility/store';
import { shouldPreserveExistingChannel } from './terminalPreservationPolicy';

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
export async function processChannelThroughPipeline(
  candidate: IngestionCandidate,
  targetCountry: string,
  source: DiscoverySource,
  isManualScan: boolean = false,
  isEnrichmentPass: boolean = false
): Promise<IngestionPipelineOutcome> {
  const now = new Date().toISOString();
  if(await getAppSetting('decision_evaluation_sampling_enabled','false')==='true')await observeRetrievalAssignmentReliably({type:'RETRIEVAL_ASSIGNMENT',input:{channelId:candidate.channelId,targetCountry,discoveryOrigin:source,language:candidate.detectedLanguages?.[0]?.language,observedAt:now,context:{isManualScan,isEnrichmentPass}},policy:{policyKey:'protected-audit',version:1,salt:process.env.DECISION_EVALUATION_SAMPLING_SALT||'',protectedAuditBasisPoints:100,targetedAuditBasisPoints:0}})
    .catch(error=>console.warn(`[DecisionEvaluation] Cohort assignment failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));

  // Step 0: Terminal State & Existing Channel Check
  const existing = await getChannelById(candidate.channelId);
  if (existing) {
    // Preserve terminal rows for every ordinary discovery lane. Explicit
    // operator recheck is the only supported terminal override.
    if (shouldPreserveExistingChannel(existing, source, isManualScan)) {
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

  // Step 1: GATE 1 - Country Validation Hard Gate
  let countryVal = await validateChannelCountry(
    {
      channelName: candidate.channelName,
      description: candidate.description,
      videoTitles: candidate.videoTitles,
      locationTag: candidate.locationTag,
      externalLinks: candidate.channelLinks,
      metadataStatus: candidate.countryMetadataStatus
    },
    targetCountry
  );
  // Country uncertainty is independent of trading uncertainty. Hydrate the
  // authoritative channel resource with a one-unit call before spending on AI
  // or community crawling. Failure remains observable and conservatively does
  // not turn absence of metadata into an exclusion.
  if (countryVal.status === 'UNCERTAIN' && candidate.countryMetadataStatus !== 'AVAILABLE_NOT_DECLARED') {
    const hydrated = await fetchYouTubeChannelCountryMetadata(candidate.channelId, candidate);
    Object.assign(candidate, hydrated);
    countryVal = await validateChannelCountry({ channelName:candidate.channelName, description:candidate.description,
      videoTitles:candidate.videoTitles, locationTag:candidate.locationTag, externalLinks:candidate.channelLinks, metadataStatus:candidate.countryMetadataStatus }, targetCountry);
  }
  const resolvedCountry = countryVal.detectedCountry || targetCountry;

  const countryValidationStep = {
    step: 'COUNTRY_VALIDATION' as const,
    title: `Country Validation (${resolvedCountry})`,
    status: countryVal.status === 'REJECTED' ? ('REJECTED' as const) : ('FOUND' as const),
    details: countryVal.decisionLogs,
    timestamp: now
  };

  if (countryVal.status === 'REJECTED') {
    console.log(
      `[Unified Ingestion Pipeline - Gate 1] Channel '${candidate.channelName}' REJECTED by Hard Exclusion Engine (${targetCountry}). Halting pipeline immediately.`
    );
    console.warn(JSON.stringify({
      event: 'excluded_channel_blocked',
      channelId: candidate.channelId,
      targetCountry: resolvedCountry,
      reason: countryVal.rejectionReason,
      context: 'ingestion_gate',
      timestamp: now
    }));

    void recordAdmissionShadow({channelId:candidate.channelId,priorState:'NOT_EVALUATED',classificationStatus:'COUNTRY_REJECTED',
      investigationState:'POLICY_REJECTED',terminalCountryPolicy:true,candidateHypothesis:{},evidenceCoverage:{countryDecision:countryVal.status}})
      .catch(error=>console.warn(`[CandidateAdmission] country-policy shadow write failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));
    return {
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      isNew: false,
      wasKnown: !!existing,
      persisted: false,
      countryStatus: 'REJECTED',
      tradingStatus: 'UNCERTAIN',
      discordStatus: 'NOT_FOUND',
      discordInvite: null,
      // Exclusion audit is emitted to logs; excluded candidates do not create or
      // mutate channel records and never reach trading AI or Discord inspection.
      channelRecord: undefined
    };
  }

  // Step 2: GATE 2 - Evidence-Based Trading Verification Engine
  const channelEntityId=deterministicUuid('youtube-channel',candidate.channelId),channelSourceFamilyId=sourceFamilyIdentity({provider:'youtube',nativeId:candidate.channelId}).familyId;
  const structuredVideos=(candidate.videos || candidate.videoTitles.map((title,index)=>({title,description:candidate.videoDescriptions?.[index],published_at:candidate.uploadTimestamps?.[index]}))).map((video,index)=>({...video,source_entity_id:video.source_entity_id||channelEntityId,source_family_id:video.source_family_id||sourceFamilyIdentity({provider:'youtube',nativeId:video.id||`${candidate.channelId}:slot:${index}`}).familyId}));
  const structuredExternalLinks=(candidate.externalLinkDetails||(candidate.channelLinks||[]).map(url=>({url}))).map(detail=>{let familyId='source_family_id' in detail&&typeof detail.source_family_id==='string'?detail.source_family_id:undefined;if(!familyId)try{familyId=sourceFamilyIdentity({provider:'external-link',canonicalUrl:detail.url}).familyId;}catch{familyId=sourceFamilyIdentity({provider:'external-link',artifactId:entityChecksum(detail.url)}).familyId;}return {...detail,source_family_id:familyId};});
  void observeYouTubeChannelEntity({channelId:candidate.channelId,channelName:candidate.channelName,youtubeUrl:candidate.youtubeUrl,observedAt:now,videos:structuredVideos,externalUrls:structuredExternalLinks.map(detail=>detail.url)}).catch(error=>console.warn(`[EntityResolution] Channel observation failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));
  const classifierInput:RawChannelInput={
    channel_id:candidate.channelId,channel_name:candidate.channelName,description:candidate.description||'',country:resolvedCountry,
    channel_entity_id:channelEntityId,channel_source_family_id:channelSourceFamilyId,
    location_tag:candidate.locationTag,external_links:candidate.channelLinks||[],external_link_details:structuredExternalLinks,
    videos:structuredVideos,
    video_titles:candidate.videoTitles,video_descriptions:candidate.videoDescriptions||[],playlists:candidate.playlists,
    transcript_excerpts:candidate.transcriptExcerpts,detected_languages:candidate.detectedLanguages,visual_evidence:candidate.visualEvidence,
    pinned_comment:candidate.pinnedComment,enrichment_stage:candidate.enrichmentStage||0,
    search_match_context:candidate.matchedDocument?{type:candidate.matchedDocument.type,provider_native_id:candidate.matchedDocument.providerNativeId,title:candidate.matchedDocument.title,description:candidate.matchedDocument.description,published_at:candidate.matchedDocument.publishedAt,locator:candidate.matchedDocument.locator}:undefined,
    activity_metadata:{latest_upload_at:candidate.latestUploadAt,uploads_last_30_days:candidate.uploadsLast30Days,uploads_last_90_days:candidate.uploadsLast90Days,uploads_last_365_days:candidate.uploadsLast365Days,activity_band:candidate.activityBand,activity_score:candidate.activityScore,observed_at:candidate.activityObservedAt}
  };
  const productionClassification = await classifyTradingRelevanceDetailed(classifierInput);
  // Manual rechecks are operator-requested semantic refreshes. A runtime provider
  // failure must not turn incomplete evidence into a replacement classification.
  // Fail before diagnostic/admission/channel writes so the prior production
  // decision remains authoritative until a complete recheck can run.
  if (source === 'recheck' && isManualScan && productionClassification.decision.evidenceCollection.degraded) {
    const failedProviders = productionClassification.decision.evidenceCollection.providers.filter(provider => provider.availability === 'FAILED');
    const reasonCodes = failedProviders.flatMap(provider => provider.reasonCodes || []);
    const error = Object.assign(
      new Error(`Manual recheck classification provider coverage is degraded: ${failedProviders.map(provider => provider.provider).join(', ') || 'unknown provider'}.`),
      { code: 'MANUAL_RESCAN_CLASSIFICATION_DEGRADED', retryable: true, providerReasons: reasonCodes }
    );
    throw error;
  }
  const classificationDiagnosticId=await observeProductionDiagnosticReliably({type:'PRODUCTION_DIAGNOSTIC',input:{channelId:candidate.channelId,input:productionClassification.input,decision:productionClassification.decision,jobId:candidate.discoveryJobId,queryRunId:candidate.queryRunId,nominationId:candidate.nominationId}})
    .catch(error=>{console.warn(`[ClassificationDiagnostics] write failed for ${candidate.channelId}:`,error instanceof Error?error.message:error);return undefined;});
  let tradingVal = productionClassification.result;
  void recordAdmissionShadow({channelId:candidate.channelId,priorState:'NOT_EVALUATED',classificationStatus:productionClassification.decision.status,
    investigationState:productionClassification.decision.status==='UNCERTAIN'?'ACTIVE':'COMPLETED',classificationDiagnosticId,
    candidateHypothesis:{category:productionClassification.decision.category,positiveEvidenceCount:productionClassification.decision.positiveEvidence.length},
    evidenceCoverage:{sufficiency:productionClassification.decision.evidenceCollection.sufficiency,degraded:productionClassification.decision.evidenceCollection.degraded,fieldsPresent:productionClassification.decision.evidenceCollection.fieldsPresent}})
    .catch(error=>console.warn(`[CandidateAdmission] shadow write failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));
  // Governed evidence remains independently observable and is rollout-gated. It
  // may corroborate existing production-positive evidence, never confirm alone.
  try {
    const shadow=await runAndRecordAdaptiveShadow(candidate.channelId,productionClassification.input,productionClassification.decision);
    const governedEnabled=await getAppSetting('governed_classifier_production_enabled','false')==='true';
    if(governedEnabled&&shadow.evidence.length>0&&productionClassification.decision.positiveEvidence.length>0&&productionClassification.decision.negativeEvidence.length===0){
      // Governed knowledge is an evidence provider, not a post-classification
      // status override. Transport it through the same scoring, corroboration,
      // contradiction and lifecycle gates as every other provider.
      const evidence=[...productionClassification.decision.positiveEvidence,...productionClassification.decision.negativeEvidence,...shadow.evidence];
      const governedReports=shadow.evidence.map(item=>item.source).filter((source,index,all)=>all.indexOf(source)===index).map(provider=>({provider,availability:'AVAILABLE' as const,evidenceCount:shadow.evidence.filter(item=>item.source===provider).length,outcome:'EXECUTED_WITH_EVIDENCE' as const,reasonCodes:['GOVERNED_PRODUCTION_EVIDENCE_TRANSPORTED']}));
      const collection:EvidenceCollectionReport={...productionClassification.decision.evidenceCollection,providers:[...productionClassification.decision.evidenceCollection.providers,...governedReports]};
      const stages=evaluateClassificationStages(productionClassification.input,evidence,collection);
      const governedDecision=new ConfigurableWeightedStrategy().evaluateDecision(evidence,{globalInstruments:[],globalPlatformsPropFirms:[],globalAdvancedConcepts:[],globalNegativeTerms:[]},resolvedCountry,collection,stages);
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
      country: resolvedCountry,
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
    nonTradingChannel.country = resolvedCountry;
    nonTradingChannel.confidence_score = countryVal.score;
    nonTradingChannel.trading_status = 'NON_TRADING';
    nonTradingChannel.trading_confidence_score = tradingVal.confidenceScore;
    nonTradingChannel.trading_category = tradingVal.category;
    nonTradingChannel.trading_relevance_breakdown = tradingVal.breakdown;
    nonTradingChannel.scan_status = 'SKIPPED_NON_TRADING';
    nonTradingChannel.discord_status = 'NON_TRADING';
    nonTradingChannel.discord_invite = null;
    nonTradingChannel.last_checked = now;
    applyCandidateObservability(nonTradingChannel, candidate);

    await upsertChannel(nonTradingChannel);

    return {
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      isNew: !existing,
      wasKnown: !!existing,
      persisted: true,
      countryStatus: countryVal.status,
      tradingStatus: 'NON_TRADING',
      discordStatus: 'NON_TRADING',
      discordInvite: null,
      channelRecord: nonTradingChannel
    };
  }

  if (tradingVal.status === 'UNCERTAIN') {
    console.log(
      `[Unified Ingestion Pipeline - Gate 2] Channel '${candidate.channelName}' classified as UNCERTAIN (${tradingVal.confidenceScore}/100). Evaluating the governed enrichment/review route.`
    );

    const currentStage=candidate.enrichmentStage||0,legacyAction:EvidenceActionType=currentStage>=2?'HUMAN_REVIEW':currentStage===1?'VIDEO_PLAYLIST_CORROBORATION':'CHANNEL_RECENT_METADATA';
    let evidencePlan:EvidenceActionPlan|undefined;
    try {const quota=await getQuota();evidencePlan=await planAndRecordEvidenceAction({channelId:candidate.channelId,diagnosticId:classificationDiagnosticId,decision:productionClassification.decision,rawInput:productionClassification.input,legacyAction,providerQuotaRemaining:Math.max(0,quota.dailyLimit-quota.unitsUsed)});} catch(error){console.warn(`[VOI Evidence] Planning failed for ${candidate.channelId}; preserving legacy enrichment.`,error instanceof Error?error.message:error);}
    const appliedAction=evidencePlan?.appliedAction||legacyAction,shouldReview=appliedAction==='HUMAN_REVIEW';
    const lifecycle = resolveUncertainLifecycle(shouldReview);
    const finalUncertainStatus = lifecycle.tradingStatus;
    const finalScanStatus = lifecycle.scanStatus;
    const corroboration=productionClassification.decision.stagedClassification?.stages.find(stage=>stage.stage==='CORROBORATION');
    void recordReviewEligibilityShadow({channelId:candidate.channelId,classificationDiagnosticId,classificationStatus:'UNCERTAIN',investigationState:shouldReview?'UNRESOLVED':'ACTIVE',plausibleTradingHypothesis:productionClassification.decision.positiveEvidence.length>0,evidenceSufficient:productionClassification.decision.evidenceCollection.sufficiency==='SUFFICIENT',independentEvidence:corroboration?.disposition==='PASS',countryAllowed:true,operationalFailure:false,providerDegraded:productionClassification.decision.evidenceCollection.degraded,unsupportedLanguage:productionClassification.decision.evidenceCollection.providers.some(provider=>provider.outcome==='ABSTAINED_UNSUPPORTED_LANGUAGE'),terminalDecision:false}).catch(error=>console.warn(`[ReviewEligibility] shadow write failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));

    const uncertainChannel: ChannelRecord = existing || {
      channel_id: candidate.channelId,
      channel_name: candidate.channelName,
      youtube_url: candidate.youtubeUrl,
      country: resolvedCountry,
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

    uncertainChannel.country_status = countryVal.status;
    uncertainChannel.country = resolvedCountry;
    uncertainChannel.confidence_score = countryVal.score;
    uncertainChannel.trading_status = finalUncertainStatus;
    uncertainChannel.trading_confidence_score = tradingVal.confidenceScore;
    uncertainChannel.trading_category = tradingVal.category;
    uncertainChannel.trading_relevance_breakdown = tradingVal.breakdown;
    uncertainChannel.scan_status = finalScanStatus;
    uncertainChannel.discord_status = 'UNCERTAIN';
    uncertainChannel.last_checked = now;
    applyCandidateObservability(uncertainChannel, candidate);

    await upsertChannel(uncertainChannel);

    if (lifecycle.shouldEnqueue) {
      const action=ACTIONS.find(item=>item.action===appliedAction),nextStage=action?.enrichmentStage||Math.min(2,currentStage+1);
      const vitality=deriveVitalityScheduling(productionClassification.input.activity_metadata,productionClassification.decision.timestamp),priority=10+vitality.jobPriorityDelta,payload={ channelId: candidate.channelId, targetCountry: resolvedCountry, source, candidate, enrichmentStage:nextStage, evidenceAcquisitionDecisionId:evidencePlan?.decisionId, evidenceAction:appliedAction, vitalityScheduling:vitality };
      const workflowAssignment=await assignRelease5Serving('INVESTIGATION_WORKFLOW',candidate.channelId).catch(()=>({assigned:false,mode:'OFF'})),legacyWorkflowEnabled=await getAppSetting('investigation_workflow_enabled','false')==='true';
      if(workflowAssignment.assigned||legacyWorkflowEnabled){
        try{await scheduleInvestigationStep({investigationId:candidate.investigationId,channelId:candidate.channelId,diagnosticId:classificationDiagnosticId,actionType:appliedAction,jobType:'ENRICH_CHANNEL',jobPayload:payload,priority,maxAttempts:4,idempotencyKey:`investigation-step:${candidate.channelId}:${classificationDiagnosticId||now}:${appliedAction}`,policyVersion:INVESTIGATION_POLICY_VERSION,utilityContractVersion:'utility-constraints-v1',deadlineMinutes:Number(await getAppSetting('investigation_deadline_minutes','30'))||30});}
        catch(error){if(candidate.investigationId)throw error;console.error(`[Investigation] Initial transactional scheduling failed for ${candidate.channelId}; using compatible queue fallback.`,error);await enqueueJob('ENRICH_CHANNEL',payload,{priority,maxAttempts:4,idempotencyKey:`enrich:${candidate.channelId}:stage:${nextStage}`});}
      }else await enqueueJob('ENRICH_CHANNEL',payload,{priority,maxAttempts:4,idempotencyKey:`enrich:${candidate.channelId}:stage:${nextStage}`});
    }

    return {
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      isNew: !existing,
      wasKnown: !!existing,
      persisted: true,
      countryStatus: countryVal.status,
      tradingStatus: finalUncertainStatus,
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
    country: resolvedCountry,
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
  activeChannel.country = resolvedCountry;
  activeChannel.confidence_score = countryVal.score;
  activeChannel.trading_status = tradingVal.status;
  activeChannel.trading_confidence_score = tradingVal.confidenceScore;
  activeChannel.trading_category = tradingVal.category;
  activeChannel.trading_relevance_breakdown = tradingVal.breakdown;
  activeChannel.scan_status = 'LOCKED';
  applyCandidateObservability(activeChannel, candidate);

  await upsertChannel(activeChannel);

  // Run Discord Inspection Engine
  await inspectAndValidateChannel(activeChannel, candidate, isManualScan);

  const finalChannel = (await getChannelById(candidate.channelId)) || activeChannel;

  // Compute Quality Score & Extract Vocabulary if Quality >= 55
  const qualityResult = calculateCreatorQualityScore(finalChannel, candidate.videoTitles, candidate.description);
  finalChannel.quality_score = qualityResult.score;
  finalChannel.quality_breakdown = qualityResult.breakdown;
  await upsertChannel(finalChannel);

  // Professional manual search is an operator-directed measurement lane. Its
  // discoveries are persisted, but must not train autonomous terminology until
  // an explicit human approval supplies independent provenance.
  if (qualityResult.score >= 55 && source !== 'manual_search') {
    await extractVocabularyFromCreator(finalChannel, candidate.videoTitles, candidate.description);
    await enqueueTermHarvest({channelId:finalChannel.channel_id,text:[candidate.description,...candidate.videoTitles].filter(Boolean).join('\n'),lineage:'AUTONOMOUS'});
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

function applyCandidateObservability(channel: ChannelRecord, candidate: IngestionCandidate): void {
  channel.country_metadata_status = candidate.countryMetadataStatus || channel.country_metadata_status || 'NOT_REQUESTED';
  channel.country_metadata_checked_at = candidate.countryMetadataCheckedAt || channel.country_metadata_checked_at || null;
  channel.latest_upload_at = candidate.latestUploadAt || channel.latest_upload_at || null;
  channel.uploads_last_30_days = candidate.uploadsLast30Days ?? channel.uploads_last_30_days ?? 0;
  channel.uploads_last_90_days = candidate.uploadsLast90Days ?? channel.uploads_last_90_days ?? 0;
  channel.uploads_last_365_days = candidate.uploadsLast365Days ?? channel.uploads_last_365_days ?? 0;
  channel.activity_band = candidate.activityBand || channel.activity_band || 'UNKNOWN';
  channel.activity_score = candidate.activityScore ?? channel.activity_score ?? 50;
  channel.activity_observed_at = candidate.activityObservedAt || channel.activity_observed_at || null;
}
