import {
  getDb,
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  recoverStaleJobs,
  getAllChannels,
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
  selectDiscordCandidate,
  countDiscordInvalidObservations,
  appendExternalAcquisitionObservations,
  getNeighborhoodForQueryRun
} from './db';
import { recomputeNeighborhoodRetrievalEvidence } from './retrievalPolicyEvidence';
import { reserveIncrementalTreatmentPageQuota, enqueueChildAndCommitPageReservation } from './retrievalPolicyCanary';
import { validateChannelCountry } from './countryValidator';
import { runChannelInspection } from './inspector';
import { validateDiscordInvite } from './discordValidator';
import {projectDiscordValidation, reconcileDiscordDiscoveryFromInspection} from './discordProjection';
import { searchYouTubeChannels, searchYouTubeChannelPage, generateCountryQueries, fetchYouTubeChannelEnrichment, DiscoveredChannelRaw, RetrievalLane } from './youtube';
import {buildProviderRequestBaseId,executeAllocatedRetrievalPage,providerSnapshot,YOUTUBE_SEARCH_PROVIDER,type ProviderAllocation} from './providerAwareRetrieval';
import './braveSearch';
import { calculateCreatorQualityScore, evaluateQueryPerformance, extractVocabularyFromCreator, selectNextQueryForCountry } from './queryIntelligence';
import { calculateQueryFunnel, type FunnelOutcome, type QueryObservation } from './queryPerformance';
import { processChannelThroughPipeline, isTerminalState } from './ingestionPipeline';
import { recordEvidenceActionOutcome } from './voiEvidenceController';
import { completeInvestigationStep, failInvestigationStep, heartbeatInvestigationStep, reconcileOrphanInvestigations, recoverStaleInvestigationSteps, startInvestigationStep } from './investigationWorkflow';
import { ChannelRecord, DiscoverySource, SearchJob, InspectionStep, DiscordStatus } from '../src/types';
import { assertCountryAllowed, ExcludedCountryError, getCountryExclusion } from './countryExclusion';
import { randomUUID } from 'node:crypto';
import { createManualSearchSession, getManualSearchSession, recordManualSearchPage, failManualSearch, cancelManualSearch } from './manualSearchStore';
import { evaluateContinuation } from './continuationPolicy';
import { evaluateAutonomousQueryAuthority } from './autonomousQueryAuthority';
import { reconcileCommunityAcquisitionRecovery, shouldReactivateCommunityRecovery, reactivateCommunityRecovery } from './communityRecovery';
import { autonomousPageExists, getAutonomousContinuationState, getAutonomousRunMetrics, recordAutonomousPage } from './autonomousPageStore';
import { recordPassivePage, recordShadowFailure } from './passiveExploration';
import { enqueueTermHarvest, processTermHarvestJob } from './candidateCorpus';
import { selectExplicitTerminologyLanguageContext, type ExplicitTerminologyLanguageContext } from './terminologyLanguageContext';
import { processAiAdjudicationJob, processCandidateScoringJob } from './candidateScoring';
import { processConceptResolutionJob } from './conceptGraph';
import { processOfflineEvaluationJob } from './offlineEvaluation';
import { getActiveCatalogPin } from './catalogPublication';
import { processStructuredProviderJob } from './persistentResearchPhase5';
import { recordExternalNominations } from './persistentResearchController';
import { processPlaylistInspectionJob } from './playlistAdapterWorker';
import { processFeaturedChannelInspectionJob } from './featuredChannelAdapterWorker';
import { QuotaAllocationExhaustedError } from './quotaCapacity';
import { recordExecutionStage, withExecutionTrace } from './executionTrace';
import { recordNomination } from './candidateAdmission/store';
import {recordAdmissionShadow} from './candidateAdmission/shadowEvaluator';
import { triggerPhaseBObservationReconciliation } from './phaseBObservationOutbox';
import { canContinueCommunityInspectionAfterDegradedManualClassification } from './manualRecheckPolicy';
import {COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE, isAttemptFreeCommunityFailure, attemptFreeDiscordValidation, retryAtFromUnknown, type CommunityRetryDirective} from './communityRetryPolicy';
import { discordCandidateCompositeRank } from './discordOwnershipSelection';
import { processPendingStagedCandidates } from './candidateStaging';

const WORKER_ID = `worker_${process.pid}`;

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
      priority: source === 'manual_search' ? 100 : 20
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

/**
 * Generates and enqueues country native queries for an automated discovery run.
 */
export async function addAutomatedCountrySearch(countryName: string, provenance?: JobProvenance): Promise<string[]> {
  await assertCountryAllowed(countryName, 'automated_search_generation');
  const vocabs = await getCountryVocabularies();
  const vocab = vocabs.find(v => v.country.toLowerCase() === countryName.toLowerCase());

  if (!vocab) {
    throw new Error(`Country '${countryName}' not found in allowed vocabulary database.`);
  }

  const selected = await selectNextQueryForCountry(countryName);
  const authority = evaluateAutonomousQueryAuthority(selected.queryRecord);
  if (!authority.eligible) {
    console.log(`[Unified Query Authority] Automated country search query "${selected.queryRecord.query}" (${countryName}) withheld before queuing: ${authority.reasonCodes.join(', ')}.`);
    return [];
  }

  await addSearchJob(selected.queryRecord.query, countryName, 'automated_query', provenance);
  return [selected.queryRecord.query];
}

export function preferredLanguageFromQueryMetadata(metadata: Record<string, unknown>): string | undefined {
  return [metadata.preferredLanguage, metadata.language, metadata.locale, metadata.dominantLocale]
    .find(value => typeof value === 'string' && value.trim().length > 0) as string | undefined;
}

/**
 * Worker loop that processes one durable search or enrichment job.
 */
export async function processNextSearchJob(
  claimableOverride?: Array<'SEARCH_YOUTUBE' | 'ENRICH_CHANNEL' | 'RESOLVE_STAGED_CANDIDATE' | 'MANUAL_SEARCH_PAGE' | 'POST_APPROVAL_ENRICH' | 'FORCE_REVIEW_RESCAN' | 'RETRY_COMMUNITY_ACQUISITION' | 'TERM_HARVEST' | 'SCORE_CANDIDATES' | 'AI_ADJUDICATE_CANDIDATE' | 'PROPOSE_CONCEPT_RESOLUTION' | 'OFFLINE_CANDIDATE_EVALUATION' | 'INSPECT_PLAYLIST' | 'INSPECT_FEATURED_CHANNELS' | 'PERSISTENT_RESEARCH_EXTERNAL_PROVIDER'>,
  workerId = WORKER_ID
): Promise<boolean> {
  await recoverStaleJobs();
  await recoverStaleInvestigationSteps();
  await reconcileOrphanInvestigations();
  await reconcileCommunityAcquisitionRecovery(getDb, getChannelById, upsertChannel);
  triggerPhaseBObservationReconciliation();
  const qStatus = await getQueueStatus();
  const claimableTypes: string[] = [];
  if (!qStatus.searchJobs.isPaused && (!claimableOverride || claimableOverride.includes('SEARCH_YOUTUBE'))) claimableTypes.push('SEARCH_YOUTUBE');
  if (!qStatus.searchJobs.isPaused && (!claimableOverride || claimableOverride.includes('MANUAL_SEARCH_PAGE'))) claimableTypes.push('MANUAL_SEARCH_PAGE');
  if (!qStatus.channelProcessing.isPaused && (!claimableOverride || claimableOverride.includes('ENRICH_CHANNEL'))) claimableTypes.push('ENRICH_CHANNEL');
  if (!qStatus.channelProcessing.isPaused && (!claimableOverride || claimableOverride.includes('RESOLVE_STAGED_CANDIDATE'))) claimableTypes.push('RESOLVE_STAGED_CANDIDATE');
  if (!qStatus.channelProcessing.isPaused && claimableOverride?.includes('POST_APPROVAL_ENRICH')) claimableTypes.push('POST_APPROVAL_ENRICH');
  if (!qStatus.channelProcessing.isPaused && claimableOverride?.includes('FORCE_REVIEW_RESCAN')) claimableTypes.push('FORCE_REVIEW_RESCAN');
  if (!qStatus.discordValidation.isPaused && (!claimableOverride || claimableOverride.includes('RETRY_COMMUNITY_ACQUISITION'))) claimableTypes.push('RETRY_COMMUNITY_ACQUISITION');
  if(!claimableOverride||claimableOverride.includes('PERSISTENT_RESEARCH_EXTERNAL_PROVIDER')){const db=await getDb();const c=await db.query(`SELECT 1 FROM external_provider_adapter_controls WHERE mode IN('CANARY','ACTIVE') AND NOT paused AND NOT kill_switch LIMIT 1`);if(c.rowCount)claimableTypes.push('PERSISTENT_RESEARCH_EXTERNAL_PROVIDER');}
  if(!claimableOverride||claimableOverride.includes('INSPECT_PLAYLIST')){const db=await getDb();const c=await db.query(`SELECT mode,paused,kill_switch FROM acquisition_adapter_controls WHERE adapter_type='INSPECT_PLAYLIST'`);if(c.rows[0]?.mode==='CANARY'&&!c.rows[0].paused&&!c.rows[0].kill_switch)claimableTypes.push('INSPECT_PLAYLIST');}
  if(!claimableOverride||claimableOverride.includes('INSPECT_FEATURED_CHANNELS')){const db=await getDb();const c=await db.query(`SELECT 1 FROM acquisition_adapter_controls adapter JOIN creator_search_canary_control authority ON authority.singleton=true WHERE adapter.adapter_type='INSPECT_FEATURED_CHANNELS' AND adapter.mode='CANARY' AND NOT adapter.paused AND NOT adapter.kill_switch AND authority.enabled AND NOT authority.kill_switch AND authority.serving_authority_enabled AND authority.featured_channel_authority_enabled AND authority.featured_channel_rollout_basis_points>0`);if(c.rowCount)claimableTypes.push('INSPECT_FEATURED_CHANNELS');}
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

  const job = await claimNextJob(workerId, claimableTypes);
  if (!job) return false;
  const investigationId=String(job.payload?.investigationId||''),investigationStepId=String(job.payload?.investigationStepId||'');
  const traceId=String(job.payload?.traceId||'');
  return withExecutionTrace(traceId,async()=>{
  const heartbeat = setInterval(() => {
    heartbeatJob(job.id, workerId).catch(error => console.error(`[Queue Worker:${workerId}] Heartbeat failed:`, error));
    if(investigationId&&investigationStepId)heartbeatInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,workerId}).catch(error=>console.error(`[Investigation:${investigationId}] Heartbeat failed:`,error));
  }, 60_000);
  heartbeat.unref?.();

  try {
    if(investigationId&&investigationStepId&&!await startInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,attempt:job.attempts,workerId})){await completeJob(job.id);return true;}
    await recordExecutionStage('DISPATCHER','REACHED',{jobId:job.id,type:job.type});
    if(job.type==='RETRY_COMMUNITY_ACQUISITION'){
      const channel=await getChannelById(String(job.payload.channelId||''));
      if(!channel){await completeJob(job.id);return true;}
      const inspectionResult=await inspectAndValidateChannel(channel,undefined,false,false,false);
      if(inspectionResult && inspectionResult.retryDirective?.attemptFree){
        const directive=inspectionResult.retryDirective;
        const deferred=Object.assign(new Error(`Community acquisition deferred: ${directive.reason}`),{code:directive.code,retryable:true,retryAt:directive.retryAt});
        throw deferred;
      }
      const refreshed=await getChannelById(channel.channel_id);
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
    if(job.type==='INSPECT_PLAYLIST'){await processPlaylistInspectionJob(job,processDiscoveredChannel);return true;}
    if(job.type==='INSPECT_FEATURED_CHANNELS'){await processFeaturedChannelInspectionJob(job,processDiscoveredChannel);return true;}
    if (job.type === 'POST_APPROVAL_ENRICH' || job.type === 'FORCE_REVIEW_RESCAN') {
      const channelId=String(job.payload.channelId||'');
      const before=await getChannelById(channelId);
      if(!before) { await completeJob(job.id); return true; }
      const result=await triggerManualRecheck(channelId, true, true);
      if(!result.success) throw new Error(result.message);
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
          await extractVocabularyFromCreator(refreshed,[refreshed.channel_name],text,true,result.languageContext);
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
        await executeManualSearchPage(sessionId, Number(job.payload.pageNumber), String(job.payload.pageToken || '') || null, Number(job.payload.variantIndex || 0));
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
      };
      const enrichmentStage=Math.min(3,Math.max(1,Number(job.payload.enrichmentStage||1))) as 1|2|3;
      if(investigationId)candidate.investigationId=investigationId;
      await assertCountryAllowed(targetCountry, `enrichment_worker:${job.id}`);
      const channel = await getChannelById(channelId);
      if (!channel || isTerminalState(channel) || channel.trading_status !== 'UNCERTAIN') {
        if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'SKIPPED',resultingStatus:channel?.trading_status,providerCost:0,latencyMs:Date.now()-evidenceStartedAt,reasonCode:'CASE_NO_LONGER_ELIGIBLE'}).catch(()=>undefined);
        if(investigationId&&investigationStepId)await completeInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,resultingStatus:channel?.trading_status||'POLICY_REJECTED',output:{reason:channel?'CASE_NO_LONGER_ELIGIBLE':'CHANNEL_MISSING'}});
        await completeJob(job.id);
        return true;
      }

      channel.scan_status = 'ENRICHING';
      channel.scan_attempts = job.attempts;
      await upsertChannel(channel);
      const dailyBudget = getDailyYouTubeQuotaBudget();
      const enrichmentPercent = Number(await getAppSetting('discovery_enrichment_quota_percent', process.env.DISCOVERY_ENRICHMENT_QUOTA_PERCENT || '10'));
      const candidateAlreadyEnriched=Number(candidate.enrichmentStage||0)>=enrichmentStage;
      const enrichmentQuotaUnits=candidateAlreadyEnriched?0:(enrichmentStage>=2?202:101);
      let quotaReserved=false;
      let acquisitionPersisted=candidateAlreadyEnriched;
      if(!candidateAlreadyEnriched){
        quotaReserved=await tryReserveQuota({
          operationType:'ENRICH_CHANNEL',operationId:job.id,allocation:'ENRICHMENT',
          units:enrichmentQuotaUnits,dailyBudget,allocationPercent:enrichmentPercent
        });
        if(!quotaReserved)throw new QuotaAllocationExhaustedError('ENRICHMENT');
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
        const pipelineOutcome=await processChannelThroughPipeline(enriched,targetCountry,source,false,true);
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

    const { query, country, source, queryRunId, queryId, retrievalLane = 'VIDEO', searchOrdering = 'RELEVANCE', pageNumber = 1, pageToken = null, retrievalConfigKey = null, retrievalTreatmentOrigin = 'CONTROL', requestedPageDepth = 1 } = job.payload as {
      query: string; country: string; source: DiscoverySource; queryRunId?: string; queryId?: number; retrievalLane?: RetrievalLane; searchOrdering?: import('./searchOrdering').SearchOrdering; pageNumber?:number; pageToken?:string|null; retrievalConfigKey?: string | null; retrievalTreatmentOrigin?: string; requestedPageDepth?: number;provider?:ProviderAllocation;
    };
    // Defense in depth for jobs queued before a country was excluded.
    await assertCountryAllowed(country, `worker:${job.id}`);

    // Execution-time query authority revalidation: every non-manual search job
    // must satisfy the current retrieval-policy before YouTube quota is spent.
    let authorityQueryRecord: Awaited<ReturnType<typeof getQueryById>> = null;
    if (source !== 'manual_search') {
      authorityQueryRecord = queryId
        ? await getQueryById(queryId)
        : (await getQueriesByCountry(country)).find(q => q.query.toLowerCase() === query.toLowerCase()) || null;
      if (authorityQueryRecord) {
        const queryAuthority = evaluateAutonomousQueryAuthority(authorityQueryRecord);
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
    if (queryRunId) {
      const allocatedProvider=providerSnapshot(job.payload.provider||YOUTUBE_SEARCH_PROVIDER);
      const lineage=await (await getDb()).query(`SELECT provider_allocation_snapshot FROM query_runs WHERE id=$1`,[queryRunId]);
      if(!lineage.rowCount)throw new Error('PHASE9_PROVIDER_LINEAGE_MISSING');
      const dbProvider=providerSnapshot(lineage.rows[0].provider_allocation_snapshot);
      if(dbProvider.providerKey!==allocatedProvider.providerKey||dbProvider.retrievalSurface!==allocatedProvider.retrievalSurface||dbProvider.capability!==allocatedProvider.capability||dbProvider.costDomain!==allocatedProvider.costDomain||dbProvider.continuationOwner!==allocatedProvider.continuationOwner)throw new Error('PHASE9_PROVIDER_LINEAGE_MISMATCH');
      const braveProvider=allocatedProvider.costDomain==='BRAVE_SEARCH_API';
      let providerRequestId: string | null = null;
      if(braveProvider){
        providerRequestId=`${autonomousOperationId}:provider-request`;
        const reservation = await reserveProviderRequest({provider:allocatedProvider,requestId:providerRequestId,queryRunId});
        providerPricingVersion = reservation.pricingVersion;
        providerRequestsAttempted=1;
      } else {
        providerQuotaUnits=100;
        const budget=getDailyYouTubeQuotaBudget();
        const percent=Number(await getAppSetting('discovery_autonomous_quota_percent','70'));
        if(!await tryReserveQuota({operationType:'AUTONOMOUS_QUERY_PAGE',operationId:autonomousOperationId,allocation:'AUTONOMOUS',units:providerQuotaUnits,dailyBudget:budget,allocationPercent:percent}))throw new QuotaAllocationExhaustedError('AUTONOMOUS');
      }
      try {
        const providerRequestBaseId = buildProviderRequestBaseId({queryRunId,jobId:job.id,jobAttempt:job.attempts,pageNumber});
        const queryMetadata = authorityQueryRecord?.generation_metadata || {};
        const preferredLanguage = preferredLanguageFromQueryMetadata(queryMetadata);
        searchPage=await executeAllocatedRetrievalPage({provider:allocatedProvider,query,country,vocabulary:vocab,queryRunId,requestId:providerRequestBaseId,jobId:job.id,preferredLanguage,lane:retrievalLane,cursor:pageToken,ordering:searchOrdering,reserveAdditionalUnits:async additionalUnits=>{
          if(braveProvider) return;
          const budget=getDailyYouTubeQuotaBudget();
          const percent=Number(await getAppSetting('discovery_autonomous_quota_percent','70'));
          const toppedUp=await topUpQuotaReservation({operationType:'AUTONOMOUS_QUERY_PAGE',operationId:autonomousOperationId,allocation:'AUTONOMOUS',additionalUnits,dailyBudget:budget,allocationPercent:percent});
          if(!toppedUp)throw new QuotaAllocationExhaustedError('AUTONOMOUS');
        },priority:'autonomous'});
        if(braveProvider){
          providerRequestsSucceeded=1; providerPagesRetrieved=1; providerCostUsd=Number(searchPage.providerCostUsd ?? 0);
          await settleProviderRequest(providerRequestId!, 'SUCCEEDED', providerCostUsd);
          await (await getDb()).query(`UPDATE query_runs SET provider_cost_usd=provider_cost_usd+$2,provider_pricing_version=$3,provider_requests_attempted=provider_requests_attempted+1,provider_requests_succeeded=provider_requests_succeeded+1,provider_pages_retrieved=provider_pages_retrieved+1 WHERE id=$1`,[queryRunId,providerCostUsd,providerPricingVersion]);
        } else await finishQuotaReservation('AUTONOMOUS_QUERY_PAGE',autonomousOperationId,true);
      } catch (error:any) {
        if(braveProvider){
          const rateLimited=String(error?.code||'').toUpperCase()==='BRAVE_API_RATE_LIMIT_429';
          if(rateLimited)providerRateLimited=1; else providerRequestsFailed=1;
          await settleProviderRequest(providerRequestId!, rateLimited?'RATE_LIMITED':'FAILED', 0, String(error?.code||error?.message||'PROVIDER_FAILURE'));
          await (await getDb()).query(`UPDATE query_runs SET provider_requests_attempted=provider_requests_attempted+1,provider_requests_failed=provider_requests_failed+$2,provider_rate_limited=provider_rate_limited+$3 WHERE id=$1`,[queryRunId,rateLimited?0:1,rateLimited?1:0]);
          if(rateLimited&&Number(error?.retryAfterMs)>0) await setAppSetting('brave_cooldown_until',new Date(Date.now()+Number(error.retryAfterMs)).toISOString()).catch(()=>undefined);
        } else await finishQuotaReservation('AUTONOMOUS_QUERY_PAGE',autonomousOperationId,false);
        throw error;
      }
    }
    const extracted = searchPage?.channels || await searchYouTubeChannels(query, country, vocab, retrievalLane);
    const distinctExtracted = [...new Map(extracted.map(channel => [channel.channelId, channel])).values()];
    const queryRecord=queryId?await getQueryById(queryId):null;
    const observations: QueryObservation[] = [];
    const sightings = [];
    for (const [index, raw] of distinctExtracted.entries()) {
      // A durable nomination is written before channel processing. When the
      // ledger is OFF, legacy channel_sightings remain the compatibility path.
      const nomination=await recordNomination({channelId:raw.channelId,sourceType:source,queryId,queryRunId,jobId:job.id,
        queryCatalogVersion:typeof job.payload.catalogPin?.checksum==='string'?job.payload.catalogPin.checksum:undefined,
        query,querySemanticClasses:queryRecord?.intent?[queryRecord.intent]:[],queryGenerationMode:queryRecord?.generation_mode,
        country,declaredLanguage:raw.detectedLanguages?.[0]?.language,retrievalLane,searchOrdering,pageNumber,resultRank:index+1,
        matchedDocument:raw.matchedDocument||{type:'UNKNOWN'},rawObservation:{channelName:raw.channelName,youtubeUrl:raw.youtubeUrl,locationTag:raw.locationTag||null}},'INVESTIGATION_QUEUED');
      raw.nominationId=nomination.id||undefined;raw.queryRunId=queryRunId;raw.discoveryJobId=job.id;
      const outcome = await processDiscoveredChannel(raw, country, source);
      const funnelOutcome: FunnelOutcome = outcome.countryStatus === 'REJECTED'
        ? 'COUNTRY_REJECTED'
        : outcome.tradingStatus === 'HUMAN_REJECTED' ? 'NON_TRADING' : outcome.tradingStatus;
      const qualityScore = outcome.channelRecord?.quality_score || 0;
      const hasCommunity = outcome.discordStatus === 'ACTIVE' || outcome.discordStatus === 'ACTIVE_LOW_VOLUME';
      observations.push({ channelId: outcome.channelId, wasKnown: outcome.wasKnown, persisted: outcome.persisted, funnelOutcome, qualityScore, hasCommunity });
      sightings.push({
        channelId: outcome.channelId, resultRank: index + 1, searchLane: retrievalLane, wasKnown: outcome.wasKnown, persisted: outcome.persisted,
        countryOutcome: outcome.countryStatus, tradingOutcome: outcome.tradingStatus, funnelOutcome,
        metadata: { channelName: outcome.channelName, source, country, retrievalLane, searchOrdering }
      });
    }
    if (queryRunId && queryId) {
      const queryRecord = await getQueryById(queryId);
      if (!queryRecord) throw new Error(`Query ${queryId} no longer exists for run ${queryRunId}.`);
      const metrics = calculateQueryFunnel(searchPage?.rawResultCount ?? extracted.length, observations);
      await recordQueryRunSightings(queryRunId, queryId, sightings.map(s=>({...s,pageNumber})));
      const globalMaxPages = Math.max(1, Number(await getAppSetting('autonomous_pagination_max_pages', '3')));
      const maxPages = retrievalTreatmentOrigin === 'CANARY_TREATMENT'
        ? Math.min(requestedPageDepth ?? 1, globalMaxPages)
        : globalMaxPages;
      const maxLow = Math.max(1, Number(await getAppSetting('autonomous_pagination_max_low_yield_pages', '2')));
      const prior = await getAutonomousContinuationState(queryRunId, pageNumber);
      const decision = evaluateContinuation({
        pageNumber, maxPages, hasNextPage: !!searchPage?.nextPageToken,
        distinctCreators: metrics.distinctResults,
        cumulativeDistinctCreators: prior.cumulativeDistinctCreators + metrics.distinctResults,
        newCreators: metrics.newChannels, confirmedCreators: metrics.tradingConfirmed,
        qualityConfirmedCreators: metrics.qualityChannels,
        delayedConfirmedCreators: prior.delayedConfirmedCreators,
        delayedNonTradingCreators: prior.delayedNonTradingCreators,
        delayedQualityCreators: prior.delayedQualityCreators,
        countryPrecision: metrics.countryPrecision,
        communityDiversity: metrics.tradingConfirmed ? metrics.communitiesDiscovered / metrics.tradingConfirmed : 0,
        duplicateRatio: metrics.rawResults ? metrics.duplicateResults / metrics.rawResults : 1,
        consecutiveLowYieldPages: prior.consecutiveLowYieldPages,
        maxConsecutiveLowYieldPages: maxLow
      });
      const enabled = await getAppSetting('autonomous_pagination_enabled', 'true') === 'true';
      const stoppingReason = decision.shouldContinue ? null : decision.primaryReason;
      const pageObservation = {
        queryRunId, pageNumber, inputPageToken: pageToken, nextPageToken: searchPage?.nextPageToken || null,
        retrievalLane, searchOrdering, rawResultCount: metrics.rawResults,
        distinctCreatorCount: metrics.distinctResults, knownCreators: metrics.knownChannels,
        newCreators: metrics.newChannels, confirmedCreators: metrics.tradingConfirmed,
        qualityConfirmedCreators: metrics.qualityChannels, averageQualityScore: metrics.averageQualityScore,
        countryPrecision: metrics.countryPrecision,
        communityDiversity: metrics.tradingConfirmed ? metrics.communitiesDiscovered / metrics.tradingConfirmed : 0,
        noveltyRatio: metrics.noveltyRatio,
        duplicateRatio: metrics.rawResults ? metrics.duplicateResults / metrics.rawResults : 1,
        quotaUnits: providerQuotaUnits, decision, stoppingReason, pageMetrics: metrics,
        retrievalConfigKey, retrievalTreatmentOrigin
      };
      await recordAutonomousPage(pageObservation);
      try{await recordPassivePage({query,jobId:job.id,observation:pageObservation});}catch(shadowError){console.error('[Phase 5 shadow] Passive page write failed.',shadowError);await recordShadowFailure({queryRunId,jobId:job.id,stage:'PAGE_OUTCOME',error:shadowError}).catch(()=>undefined);}
      if (enabled && decision.shouldContinue && searchPage?.nextPageToken) {
        let incPageReservationId: string | undefined;

        // Incremental Treatment Page Quota Reservation Boundary
        if (retrievalTreatmentOrigin === 'CANARY_TREATMENT' && pageNumber >= 1) {
          const incRes = await reserveIncrementalTreatmentPageQuota({ queryRunId, pageNumber: pageNumber + 1 });
          if (!incRes.authorized) {
            console.log(`[Phase 9 Continuation] Incremental page continuation denied by treatment quota caps for run ${queryRunId}: ${incRes.reason}`);
            await completeJob(job.id);
            return true;
          }
          incPageReservationId = incRes.pageReservationId;
        }

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
          priority: 20,
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
      const quotaConsumed=providerCostUsd>0?0:pageNumber*100;
      const performance = await evaluateQueryPerformance(queryRecord, finalMetrics, { retrievalLane, searchOrdering, quotaConsumed, persist: false });
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
        averageQualityScore: finalMetrics.averageQualityScore,
        performanceScore: performance.performanceScore,
        newCollection: performance.newCollection
      });
      await addQueryExecutionLog({
        query_run_id: queryRunId,
        query_id: queryId, query, country, executed_at: new Date().toISOString(),
        channels_discovered: finalMetrics.distinctResults, unique_new_channels: finalMetrics.newChannels,
        quality_creators_discovered: finalMetrics.qualityChannels, communities_discovered: finalMetrics.communitiesDiscovered,
        cycle_quality_score: performance.performanceScore,
        logs: [`Durable autonomous ${retrievalLane} lane run ${queryRunId} completed by ${workerId} via YOUTUBE_DATA_API.`, `Funnel: ${JSON.stringify(metrics)}`]
      });

      // Post-run idempotent recomputation of derived evidence aggregate
      const neighborhoodInfo = await getNeighborhoodForQueryRun(queryRunId);
      if (neighborhoodInfo && retrievalConfigKey) {
        await recomputeNeighborhoodRetrievalEvidence(neighborhoodInfo.neighborhood_key, retrievalConfigKey)
          .catch(err => console.warn('[RetrievalPolicyEvidence] Post-run evidence recomputation error:', err));
      }
    }
    await completeJob(job.id);
    return true;
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
    if (job.type === 'ENRICH_CHANNEL' && terminal) {
      const channelId = String(job.payload?.channelId || '');
      const channel = channelId ? await getChannelById(channelId) : null;
      if (channel && channel.trading_status === 'UNCERTAIN') {
        channel.scan_status = 'FAILED';
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
      if(channel){channel.scan_status='FAILED';channel.discord_validation_status='RETRY_PENDING';channel.scan_attempts=Math.max(channel.scan_attempts||0,job.attempts);channel.last_checked=new Date().toISOString();await upsertChannel(channel);}
    }
    const runId = String(job.payload?.queryRunId || '');
    if (runId) await failQueryRun(runId, err, terminal);
    return false;
  } finally {
    clearInterval(heartbeat);
  }
  });
}

export interface ProcessDiscoveredChannelOutcome {
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
}

/** Channel attempts count lifecycle executions. Provider/candidate attempts are
 * independently durable in discord_check_attempts and must not inflate this. */
export function nextChannelScanAttempts(current:number,terminalSemanticOrSuccess:boolean):number{
  return terminalSemanticOrSuccess?0:Math.max(0,current)+1;
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
  enableDebug: boolean = false,
  scheduleRetry: boolean = true
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

  const now = new Date().toISOString();

  let finalDebugLog: any = null;
  let inspection: Awaited<ReturnType<typeof runChannelInspection>> | null = null;
  let retryDirective: CommunityRetryDirective | undefined;
  let attemptFree = false;
  try {
    // 1. Re-check Country Validation before Discord scanning
    const valRes = await validateChannelCountry(
      {
        channelName: channel.channel_name,
        description: rawDetails?.description || channel.inspection_trail?.map(t => t.details || '').join(' ') || channel.channel_name,
        videoTitles: rawDetails?.videoTitles || [channel.channel_name],
        locationTag: rawDetails?.locationTag,
        externalLinks: rawDetails?.channelLinks || (channel.discord_invite ? [channel.discord_invite] : []),
        metadataStatus: rawDetails?.countryMetadataStatus || channel.country_metadata_status
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
    inspection = await runChannelInspection({
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
    if(inspection.acquisitionOutcomes?.length)await appendExternalAcquisitionObservations(channel.channel_id,inspection.acquisitionOutcomes)
      .catch(error=>console.warn(`[ExternalAcquisition] observational write failed for ${channel.channel_id}:`,error instanceof Error?error.message:error));

    // Live About-page hydration can reveal stronger country evidence than the
    // search snippet. Re-evaluate before persisting any discovered community.
    const liveCountry = await validateChannelCountry({channelName:channel.channel_name,
      description:inspection.observedAboutBio, videoTitles:rawDetails?.videoTitles || [channel.channel_name],
      locationTag:rawDetails?.locationTag, externalLinks:inspection.observedChannelLinks,
      metadataStatus:rawDetails?.countryMetadataStatus || channel.country_metadata_status}, channel.country);
    if (liveCountry.status === 'REJECTED') {
      channel.country_status='REJECTED'; channel.country=liveCountry.detectedCountry || channel.country;
      channel.confidence_score=liveCountry.score; channel.discord_invite=null; channel.discord_status='NOT_FOUND';
      channel.scan_status='COMPLETED'; channel.last_checked=now;
      channel.inspection_trail=[countryStep,{step:'COUNTRY_VALIDATION',title:`Country Validation (${channel.country}) — Live About`,status:'REJECTED',details:liveCountry.decisionLogs,timestamp:now}];
      return;
    }
    if (liveCountry.detectedCountry) { channel.country=liveCountry.detectedCountry; channel.country_status=liveCountry.status; channel.confidence_score=liveCountry.score; }

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
    // structured collection.
    const structuredCandidates=(inspection.discordCandidates||[]).filter(candidate=>!!candidate.nativeInviteCode);
    const discoveredInvite=structuredCandidates.find(candidate=>candidate.nativeInviteCode)?.nativeInviteCode||inspection.foundInvite||null;
    if (discoveredInvite) {
      // Validate bounded native candidates until a high-confidence trading
      // community is found. A live-but-ambiguous or live-but-non-trading first
      // invite is a fallback, not a reason to suppress a stronger later invite.
      const candidates=structuredCandidates.length?structuredCandidates:[{candidateId:`legacy:${discoveredInvite}`,locatorType:'NATIVE_INVITE' as const,sourceSurface:'CHANNEL_EXTERNAL_LINKS' as const,rawLocator:discoveredInvite,nativeInviteCode:discoveredInvite,normalizedLocator:`https://discord.gg/${discoveredInvite}`,extractionConfidence:'EXPLICIT' as const}];
      await persistDiscordCandidates(channel.channel_id,candidates.map(candidate=>({candidateId:candidate.candidateId,rawLocator:candidate.rawLocator,locatorType:candidate.locatorType,resolvedLocator:candidate.normalizedLocator,sourceSurface:candidate.sourceSurface,sourceUrl:candidate.sourceUrl,observations:candidate.observations})));
      let selected:Awaited<ReturnType<typeof validateDiscordInvite>>|null=null,selectedCandidate= candidates[0],selectedRank=-1;
      const terminalInvalid:Array<Awaited<ReturnType<typeof validateDiscordInvite>>>=[];
      for(const candidate of candidates){
        if(!candidate.nativeInviteCode)continue;
        const locator=candidate.normalizedLocator||`https://discord.gg/${candidate.nativeInviteCode}`;
        const priorInvalidObservations=await countDiscordInvalidObservations(channel.channel_id,candidate.candidateId,locator);
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
          priorInvalidObservations
        });
        await appendDiscordCheckAttempts(channel.channel_id,validation.candidateInviteUrl,validation.status,validation.attempts,{candidateId:candidate.candidateId,rawLocator:candidate.rawLocator,locatorType:candidate.locatorType,resolvedLocator:validation.candidateInviteUrl,sourceSurface:candidate.sourceSurface,sourceUrl:candidate.sourceUrl});
        if(validation.operationalOutcome==='CONFIRMED_INVALID'){terminalInvalid.push(validation);continue;}
        const rank=discordCandidateCompositeRank(candidate,validation);
        if(rank>selectedRank){selected=validation;selectedCandidate=candidate;selectedRank=rank;}
      }
      if(!selected&&terminalInvalid.length===candidates.filter(candidate=>candidate.nativeInviteCode).length){selected=terminalInvalid[0];selectedCandidate=candidates[0];}
      if(!selected)throw new Error('No resolvable native Discord candidate was available for validation');
      const alreadyValidatedSuccess=channel.discord_discovery_status==='VALIDATED'&&(channel.discord_status==='ACTIVE'||channel.discord_status==='DEAD');
      const sameValidatedCandidate=!channel.discord_candidate_id||channel.discord_candidate_id===selectedCandidate.candidateId;
      const shouldProjectValidation=!alreadyValidatedSuccess||selected.operationalOutcome==='SUCCEEDED'||(selected.operationalOutcome==='CONFIRMED_INVALID'&&sameValidatedCandidate);
      if(shouldProjectValidation){Object.assign(channel,projectDiscordValidation(channel,selected,selectedCandidate));await selectDiscordCandidate(channel.channel_id,selectedCandidate.candidateId);}
      attemptFree=attemptFreeDiscordValidation(selected.operationalOutcome,selected.retryable);
      channel.scan_status=selected.operationalOutcome==='SUCCEEDED'||selected.operationalOutcome==='CONFIRMED_INVALID'?'COMPLETED':'FAILED';
      channel.scan_attempts=selected.operationalOutcome==='SUCCEEDED'||selected.operationalOutcome==='CONFIRMED_INVALID'?0:attemptFree?Math.max(0,channel.scan_attempts):nextChannelScanAttempts(channel.scan_attempts,false);
      channel.last_checked=now;
      reconcileDiscordDiscoveryFromInspection(channel,inspection,{validationProjected:true});
      if(selected.retryable&&scheduleRetry)await enqueueCommunityAcquisitionRetry(channel.channel_id);
      retryDirective=attemptFree?{attemptFree:true,code:COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE,reason:`Discord validation remained ${selected.operationalOutcome}`,retryAt:undefined}:undefined;
    } else if(inspection.acquisitionStatus==='ACQUISITION_FAILED'||inspection.acquisitionStatus==='PARTIALLY_INSPECTED') {
      // A failed or partial crawl is operational uncertainty, not confirmed absence.
      const alreadyValidatedSuccess=channel.discord_discovery_status==='VALIDATED'&&(channel.discord_status==='ACTIVE'||channel.discord_status==='DEAD');
      const requiredAcquisitionFailures=(inspection.acquisitionOutcomes||[]).filter(item=>item.required&&item.outcome==='ACQUISITION_FAILED');
      const hasRetryableAcquisitionFailure=requiredAcquisitionFailures.some(item=>item.retryable);
      if(!alreadyValidatedSuccess){
        channel.discord_status='UNCERTAIN';
        channel.discord_liveness_status=channel.discord_candidate_locator?channel.discord_liveness_status||'UNCERTAIN':'NOT_CHECKED';
        channel.discord_validation_status=hasRetryableAcquisitionFailure?'RETRY_PENDING':'FAILED_OPERATIONAL';
        channel.discord_resolution_status=channel.discord_resolution_status||'RESOLVED';
        channel.discord_discovery_status=channel.discord_candidate_locator?'DISCOVERED_VALIDATION_FAILED':'NOT_DISCOVERED';
      }
      reconcileDiscordDiscoveryFromInspection(channel,inspection,{validationProjected:false});
      retryDirective=inspection.retryDirective;
      attemptFree=Boolean(retryDirective?.attemptFree);
      channel.scan_status='FAILED';
      if(!retryDirective?.attemptFree)channel.scan_attempts++;
      // An incomplete rescan cannot erase an earlier discovered locator. The
      // append-only checks remain authoritative until a new validation replaces
      // this compatibility projection.
      channel.last_checked=now;
      if(retryDirective?.attemptFree&&scheduleRetry)await enqueueCommunityAcquisitionRetry(channel.channel_id);
    } else {
      // Nothing Found After All Steps
      const alreadyValidatedSuccess=channel.discord_discovery_status==='VALIDATED'&&(channel.discord_status==='ACTIVE'||channel.discord_status==='DEAD');
      if(!alreadyValidatedSuccess){
        channel.discord_status = channel.discord_candidate_locator?'UNCERTAIN':'NOT_FOUND';
        if(!channel.discord_candidate_locator){channel.discord_resolution_status='NOT_ATTEMPTED';channel.discord_liveness_status='NOT_CHECKED';channel.discord_relevance_status='NOT_CHECKED';channel.discord_validation_status='COMPLETED';}
      }
      channel.scan_status = 'COMPLETED';
      channel.scan_attempts = 0;
      // Only a complete inspection with no prior discovery may project absence.
      if(!channel.discord_candidate_locator)channel.discord_discovery_status='NOT_DISCOVERED';
      else channel.discord_discovery_status='DISCOVERED_VALIDATION_FAILED';
      reconcileDiscordDiscoveryFromInspection(channel,inspection,{validationProjected:false});
      channel.last_checked = now;
    }

  } catch (err) {
    // Preserve any structured discovery even when validation or later
    // processing throws. This must run before catch persistence and retry.
    reconcileDiscordDiscoveryFromInspection(channel,inspection,{validationProjected:false});
    attemptFree=isAttemptFreeCommunityFailure(err);
    retryDirective=attemptFree?{attemptFree:true,code:COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE,reason:String(err?.message||err),retryAt:retryAtFromUnknown(err)}:undefined;
    if(!attemptFree)channel.scan_attempts++;
    // Durable RETRY_COMMUNITY_ACQUISITION owns the retry budget. Keep channel
    // state retryable here so an internal scan counter cannot prematurely stop
    // a job that still has durable attempts remaining.
    channel.scan_status = 'FAILED';
    if(scheduleRetry)await enqueueCommunityAcquisitionRetry(channel.channel_id).catch(error=>console.warn(`[CommunityAcquisition] retry scheduling failed for ${channel.channel_id}:`,error instanceof Error?error.message:error));
  } finally {
    await upsertChannel(channel);
  }
  return { debugLog: enableDebug ? finalDebugLog : undefined, inspection, retryDirective };
}

export function communityAcquisitionRetryKey(channelId:string):string{return `community-acquisition-retry:${channelId}`;}
async function enqueueCommunityAcquisitionRetry(channelId:string):Promise<void>{
  await enqueueJob('RETRY_COMMUNITY_ACQUISITION',{channelId},{idempotencyKey:communityAcquisitionRetryKey(channelId),priority:15,maxAttempts:5});
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

function classifyManualRecheckAcquisitionFailure(error: any): {
  errorClass?: ManualRecheckErrorClass;
  retryable: boolean;
  code: string;
  retryAt?: number;
  retryAfterMs?: number;
} {
  const message = String(error?.message || error || '');
  const rawErrorClass = String(error?.errorClass || '').toUpperCase() as ManualRecheckErrorClass;
  const code = String(error?.code || error?.cause?.code || 'MANUAL_RESCAN_UPSTREAM_FAILURE');
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const retryAt = Number(error?.retryAt);
  const retryAfterMs = Number(error?.retryAfterMs);

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
      freshCandidate = await fetchYouTubeChannelEnrichment(channelId, fallback, 1);
    } catch (error: any) {
      const detail = error instanceof Error ? error.message : String(error);
      const failure = classifyManualRecheckAcquisitionFailure(error);
      console.warn(`[Manual Recheck] Fresh YouTube creator acquisition failed for ${channelId}; preserving prior trading classification: ${detail}`);
      return {
        success: false,
        message: `Manual re-scan could not acquire fresh YouTube creator evidence. Existing trading classification was preserved. ${detail}`,
        code: 'MANUAL_RESCAN_UPSTREAM_FAILURE',
        retryable: failure.retryable,
        errorClass: failure.errorClass,
        retryAt: failure.retryAt,
        retryAfterMs: failure.retryAfterMs,
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

async function executeManualSearchPage(sessionId: string, pageNumber: number, pageToken: string | null, variantIndex = 0): Promise<any> {
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
    let countryAccepted = 0;
    for (const [index,raw] of unique.entries()) {
      const nomination=await recordNomination({channelId:raw.channelId,sourceType:'manual_search',sourceActionId:sessionId,query:queryVariant,
        queryGenerationMode:'OPERATOR_DIRECTED',country:session.country,retrievalLane:session.retrievalLane,pageNumber,resultRank:index+1,
        matchedDocument:raw.matchedDocument||{type:'MANUAL'},rawObservation:{channelName:raw.channelName,youtubeUrl:raw.youtubeUrl,sessionId,variantIndex}},'INVESTIGATION_QUEUED');
      raw.nominationId=nomination.id||undefined;
      const outcome = await processDiscoveredChannel(raw, session.country, 'manual_search');
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
    const previous = new Set(session.uniqueChannelIds);
    const novelIds = uniqueIds.filter(id => !previous.has(id));
    const noveltyRatio = uniqueIds.length ? novelIds.length / uniqueIds.length : 0;
    const duplicateRatio = rawIds.length ? 1 - (novelIds.length / rawIds.length) : 1;
    const projectedUnique = new Set([...session.uniqueChannelIds, ...uniqueIds]).size;
    const hasNextVariant = variantIndex + 1 < session.generatedQueryVariants.length;
    const decision = evaluateContinuation({pageNumber,maxPages,hasNextPage:!!page.nextPageToken||hasNextVariant,distinctCreators:uniqueIds.length,cumulativeDistinctCreators:projectedUnique,maxDistinctCreators:maxCreators,newCreators:novelIds.length,confirmedCreators:confirmedIds.length,qualityConfirmedCreators:qualityConfirmedIds.length,countryPrecision:unique.length?countryAccepted/unique.length:0,communityDiversity:confirmedIds.length?communityIds.length/confirmedIds.length:0,duplicateRatio,consecutiveLowYieldPages:session.consecutiveLowYieldPages,maxConsecutiveLowYieldPages:maxLowYield});
    const stopReason = decision.shouldContinue ? null : decision.primaryReason;
    const updated = await recordManualSearchPage(sessionId, { pageNumber, queryVariant, lane: session.retrievalLane, inputPageToken: pageToken, nextPageToken: page.nextPageToken, rawResultCount:page.rawResultCount, rawIds, uniqueIds, knownIds, acceptedIds, confirmedIds, qualityConfirmedIds, averageQualityScore:qualityScores.length?qualityScores.reduce((a,b)=>a+b,0)/qualityScores.length:0, countryPrecision:unique.length?countryAccepted/unique.length:0,communityDiversity:confirmedIds.length?communityIds.length/confirmedIds.length:0,noveltyRatio, duplicateRatio, quotaUnits: 100, quotaEfficiency: qualityConfirmedIds.length / 100, creatorYield: confirmedIds.length, lowYield:decision.lowYield,marginalUtility:decision.marginalUtility,shouldContinue:decision.shouldContinue,primaryReason:decision.primaryReason,reasonCodes:decision.reasonCodes,maxPages, stopReason });
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

function startWorkerPool(type: 'SEARCH_YOUTUBE' | 'ENRICH_CHANNEL' | 'MANUAL_SEARCH_PAGE', concurrency: number): void {
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

let workersStarted = false;

/**
 * Start the durable queue consumers explicitly, after HTTP readiness. Keeping
 * this idempotent prevents duplicate consumers if startup orchestration is
 * retried; individual ticks already preserve the existing claim/retry rules.
 */
export function startSearchWorkers(): void {
  if (workersStarted) return;
  workersStarted = true;
  startWorkerPool('SEARCH_YOUTUBE', Math.max(1, Number(process.env.SEARCH_WORKER_CONCURRENCY || 1)));
  startWorkerPool('MANUAL_SEARCH_PAGE', Math.max(1, Number(process.env.MANUAL_SEARCH_WORKER_CONCURRENCY || 1)));
  startWorkerPool('ENRICH_CHANNEL', Math.max(1, Number(process.env.ENRICHMENT_WORKER_CONCURRENCY || 1)));
}
