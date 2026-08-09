import {
  getDb,
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  recoverStaleJobs,
  getAllChannels,
  getChannelById,
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
  getAppSetting,
  heartbeatJob,
  recordQueryRunSightings,
  getDailyYouTubeQuotaBudget,
  appendDiscordCheckAttempts,
  countDiscordInvalidObservations,
  appendExternalAcquisitionObservations
} from './db';
import { validateChannelCountry } from './countryValidator';
import { runChannelInspection } from './inspector';
import { validateDiscordInvite } from './discordValidator';
import {projectDiscordValidation} from './discordProjection';
import { searchYouTubeChannels, searchYouTubeChannelPage, generateCountryQueries, fetchYouTubeChannelEnrichment, DiscoveredChannelRaw, RetrievalLane } from './youtube';
import { calculateCreatorQualityScore, evaluateQueryPerformance, extractVocabularyFromCreator } from './queryIntelligence';
import { calculateQueryFunnel, type FunnelOutcome, type QueryObservation } from './queryPerformance';
import { processChannelThroughPipeline, isTerminalState } from './ingestionPipeline';
import { recordEvidenceActionOutcome } from './voiEvidenceController';
import { completeInvestigationStep, failInvestigationStep, heartbeatInvestigationStep, reconcileOrphanInvestigations, recoverStaleInvestigationSteps, startInvestigationStep } from './investigationWorkflow';
import { ChannelRecord, DiscoverySource, SearchJob, InspectionStep, DiscordStatus } from '../src/types';
import { assertCountryAllowed, ExcludedCountryError, getCountryExclusion } from './countryExclusion';
import { randomUUID } from 'node:crypto';
import { createManualSearchSession, getManualSearchSession, recordManualSearchPage, failManualSearch, cancelManualSearch } from './manualSearchStore';
import { evaluateContinuation } from './continuationPolicy';
import { autonomousPageExists, getAutonomousContinuationState, getAutonomousRunMetrics, recordAutonomousPage } from './autonomousPageStore';
import { recordPassivePage, recordShadowFailure } from './passiveExploration';
import { enqueueTermHarvest, processTermHarvestJob } from './candidateCorpus';
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

const WORKER_ID = `worker_${process.pid}`;

/**
 * Pushes a new search query job to the Search Jobs Queue.
 */
export interface JobProvenance { actorId: string; requestId?: string }
export async function addSearchJob(query: string, country: string, source: DiscoverySource, provenance: JobProvenance = {actorId:'system:scheduler'}): Promise<SearchJob> {
  await assertCountryAllowed(country, `queue:${source}`);
  const catalogPin=await getActiveCatalogPin(country);
  await recordExecutionStage('JOB_CREATION','REACHED',{type:'SEARCH_YOUTUBE',source},provenance.requestId);
  const job = await enqueueJob(
    'SEARCH_YOUTUBE',
    { query, country, source, provenance, catalogPin, traceId:provenance.requestId },
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

  const generatedQueries = generateCountryQueries(vocab, 5);
  for (const q of generatedQueries) {
    await addSearchJob(q, countryName, 'automated_query', provenance);
  }

  return generatedQueries;
}

/**
 * Worker loop that processes one durable search or enrichment job.
 */
export async function processNextSearchJob(
  claimableOverride?: Array<'SEARCH_YOUTUBE' | 'ENRICH_CHANNEL' | 'MANUAL_SEARCH_PAGE' | 'POST_APPROVAL_ENRICH' | 'FORCE_REVIEW_RESCAN' | 'RETRY_COMMUNITY_ACQUISITION' | 'TERM_HARVEST' | 'SCORE_CANDIDATES' | 'AI_ADJUDICATE_CANDIDATE' | 'PROPOSE_CONCEPT_RESOLUTION' | 'OFFLINE_CANDIDATE_EVALUATION' | 'INSPECT_PLAYLIST' | 'INSPECT_FEATURED_CHANNELS' | 'PERSISTENT_RESEARCH_EXTERNAL_PROVIDER'>,
  workerId = WORKER_ID
): Promise<boolean> {
  await recoverStaleJobs();
  await recoverStaleInvestigationSteps();
  await reconcileOrphanInvestigations();
  const qStatus = await getQueueStatus();
  const claimableTypes: string[] = [];
  if (!qStatus.searchJobs.isPaused && (!claimableOverride || claimableOverride.includes('SEARCH_YOUTUBE'))) claimableTypes.push('SEARCH_YOUTUBE');
  if (!qStatus.searchJobs.isPaused && (!claimableOverride || claimableOverride.includes('MANUAL_SEARCH_PAGE'))) claimableTypes.push('MANUAL_SEARCH_PAGE');
  if (!qStatus.channelProcessing.isPaused && (!claimableOverride || claimableOverride.includes('ENRICH_CHANNEL'))) claimableTypes.push('ENRICH_CHANNEL');
  if (!qStatus.channelProcessing.isPaused && (!claimableOverride || claimableOverride.includes('POST_APPROVAL_ENRICH'))) claimableTypes.push('POST_APPROVAL_ENRICH');
  if (!qStatus.channelProcessing.isPaused && (!claimableOverride || claimableOverride.includes('FORCE_REVIEW_RESCAN'))) claimableTypes.push('FORCE_REVIEW_RESCAN');
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
      await inspectAndValidateChannel(channel,undefined,false,false,false);
      const refreshed=await getChannelById(channel.channel_id);
      if(refreshed?.scan_status==='FAILED')throw new Error('Retryable community acquisition remains unresolved');
      await completeJob(job.id);return true;
    }
    if(job.type==='TERM_HARVEST'){await processTermHarvestJob(job);return true;}
    if(job.type==='SCORE_CANDIDATES'){await processCandidateScoringJob(job);return true;}
    if(job.type==='AI_ADJUDICATE_CANDIDATE'){await processAiAdjudicationJob(job);return true;}
    if(job.type==='PROPOSE_CONCEPT_RESOLUTION'){await processConceptResolutionJob(job);return true;}
    if(job.type==='OFFLINE_CANDIDATE_EVALUATION'){await processOfflineEvaluationJob(job);return true;}
    if(job.type==='PERSISTENT_RESEARCH_EXTERNAL_PROVIDER'){await processStructuredProviderJob(job,recordExternalNominations);return true;}
    if(job.type==='INSPECT_PLAYLIST'){await processPlaylistInspectionJob(job,processDiscoveredChannel);return true;}
    if(job.type==='INSPECT_FEATURED_CHANNELS'){await processFeaturedChannelInspectionJob(job,processDiscoveredChannel);return true;}
    if (job.type === 'POST_APPROVAL_ENRICH' || job.type === 'FORCE_REVIEW_RESCAN') {
      const channelId=String(job.payload.channelId||'');
      const before=await getChannelById(channelId);
      if(!before) { await completeJob(job.id); return true; }
      const result=await triggerManualRecheck(channelId, true);
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
          await extractVocabularyFromCreator(refreshed,[refreshed.channel_name],text,true);
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
        if(investigationId&&investigationStepId)await completeInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,resultingStatus:channel?.trading_status||'NEEDS_REVIEW',output:{reason:'CASE_NO_LONGER_ELIGIBLE'}});else await completeJob(job.id);
        await completeJob(job.id);
        return true;
      }

      channel.scan_status = 'ENRICHING';
      channel.scan_attempts = job.attempts;
      await upsertChannel(channel);
      const dailyBudget = getDailyYouTubeQuotaBudget();
      const enrichmentPercent = Number(await getAppSetting('discovery_enrichment_quota_percent', process.env.DISCOVERY_ENRICHMENT_QUOTA_PERCENT || '10'));
      const quotaReserved = await tryReserveQuota({
        operationType: 'ENRICH_CHANNEL', operationId: job.id, allocation: 'ENRICHMENT',
        units: enrichmentStage>=2?202:101, dailyBudget, allocationPercent: enrichmentPercent
      });
      if (!quotaReserved) throw new QuotaAllocationExhaustedError('ENRICHMENT');
      try {
        const enriched = await fetchYouTubeChannelEnrichment(channelId, candidate,enrichmentStage);
        const pipelineOutcome=await processChannelThroughPipeline(enriched, targetCountry, source, false, true);
        if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'SUCCEEDED',resultingStatus:pipelineOutcome.tradingStatus,providerCost:enrichmentStage>=2?202:101,latencyMs:Date.now()-evidenceStartedAt,reasonCode:pipelineOutcome.tradingStatus==='UNCERTAIN'||pipelineOutcome.tradingStatus==='NEEDS_REVIEW'?'EVIDENCE_DID_NOT_RESOLVE':'DECISION_RESOLVED'}).catch(()=>undefined);
        await finishQuotaReservation('ENRICH_CHANNEL', job.id, true);
        if(investigationId&&investigationStepId)await completeInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,resultingStatus:pipelineOutcome.tradingStatus,output:{channelId:pipelineOutcome.channelId,tradingStatus:pipelineOutcome.tradingStatus,countryStatus:pipelineOutcome.countryStatus}});else await completeJob(job.id);
      } catch (error) {
        if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'FAILED',providerCost:0,latencyMs:Date.now()-evidenceStartedAt,reasonCode:'PROVIDER_OR_PIPELINE_FAILURE'}).catch(()=>undefined);
        await finishQuotaReservation('ENRICH_CHANNEL', job.id, false);
        throw error;
      }
      return true;
    }

    const { query, country, source, queryRunId, queryId, retrievalLane = 'VIDEO', searchOrdering = 'RELEVANCE', pageNumber = 1, pageToken = null } = job.payload as {
      query: string; country: string; source: DiscoverySource; queryRunId?: string; queryId?: number; retrievalLane?: RetrievalLane; searchOrdering?: import('./searchOrdering').SearchOrdering; pageNumber?:number; pageToken?:string|null;
    };
    // Defense in depth for jobs queued before a country was excluded.
    await assertCountryAllowed(country, `worker:${job.id}`);
    const vocabs = await getCountryVocabularies();
    const vocab = vocabs.find(v => v.country.toLowerCase() === country.toLowerCase());
    if (queryRunId) await startQueryRun(queryRunId);
    if (queryRunId && pageNumber > 1 && await autonomousPageExists(queryRunId,pageNumber)) { await completeJob(job.id); return true; }
    const autonomousOperationId=queryRunId?`${queryRunId}:${pageNumber}`:'';
    if(queryRunId){const budget=getDailyYouTubeQuotaBudget();const percent=Number(await getAppSetting('discovery_autonomous_quota_percent','70'));if(!await tryReserveQuota({operationType:'AUTONOMOUS_QUERY_PAGE',operationId:autonomousOperationId,allocation:'AUTONOMOUS',units:100,dailyBudget:budget,allocationPercent:percent}))throw new QuotaAllocationExhaustedError('AUTONOMOUS');}
    const searchPage = queryRunId ? await searchYouTubeChannelPage(query,country,vocab,retrievalLane,pageToken,searchOrdering) : null;
    if(queryRunId) await finishQuotaReservation('AUTONOMOUS_QUERY_PAGE',autonomousOperationId,true);
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
      const maxPages=Math.max(1,Number(await getAppSetting('autonomous_pagination_max_pages','3')));const maxLow=Math.max(1,Number(await getAppSetting('autonomous_pagination_max_low_yield_pages','2')));
      const prior=await getAutonomousContinuationState(queryRunId);
      const decision=evaluateContinuation({pageNumber,maxPages,hasNextPage:!!searchPage?.nextPageToken,distinctCreators:metrics.distinctResults,cumulativeDistinctCreators:prior.cumulativeDistinctCreators+metrics.distinctResults,newCreators:metrics.newChannels,confirmedCreators:metrics.tradingConfirmed,qualityConfirmedCreators:metrics.qualityChannels,countryPrecision:metrics.countryPrecision,communityDiversity:metrics.tradingConfirmed?metrics.communitiesDiscovered/metrics.tradingConfirmed:0,duplicateRatio:metrics.rawResults?metrics.duplicateResults/metrics.rawResults:1,consecutiveLowYieldPages:prior.consecutiveLowYieldPages,maxConsecutiveLowYieldPages:maxLow});
      const enabled=await getAppSetting('autonomous_pagination_enabled','false')==='true';
      const pageObservation={queryRunId,pageNumber,inputPageToken:pageToken,nextPageToken:searchPage?.nextPageToken||null,retrievalLane,searchOrdering,rawResultCount:metrics.rawResults,distinctCreatorCount:metrics.distinctResults,knownCreators:metrics.knownChannels,newCreators:metrics.newChannels,confirmedCreators:metrics.tradingConfirmed,qualityConfirmedCreators:metrics.qualityChannels,averageQualityScore:metrics.averageQualityScore,countryPrecision:metrics.countryPrecision,communityDiversity:metrics.tradingConfirmed?metrics.communitiesDiscovered/metrics.tradingConfirmed:0,noveltyRatio:metrics.noveltyRatio,duplicateRatio:metrics.rawResults?metrics.duplicateResults/metrics.rawResults:1,quotaUnits:100,decision,stoppingReason:decision.shouldContinue?null:decision.primaryReason,pageMetrics:metrics};
      await recordAutonomousPage(pageObservation);
      try{await recordPassivePage({query,jobId:job.id,observation:pageObservation});}catch(shadowError){console.error('[Phase 5 shadow] Passive page write failed.',shadowError);await recordShadowFailure({queryRunId,jobId:job.id,stage:'PAGE_OUTCOME',error:shadowError}).catch(()=>undefined);}
      if(enabled&&decision.shouldContinue&&searchPage?.nextPageToken){await enqueueJob('SEARCH_YOUTUBE',{...job.payload,pageNumber:pageNumber+1,pageToken:searchPage.nextPageToken},{priority:20,maxAttempts:3,idempotencyKey:`search-run:${queryRunId}:page:${pageNumber+1}`});await completeJob(job.id);return true;}
      const finalMetrics=await getAutonomousRunMetrics(queryRunId);
      const performance = await evaluateQueryPerformance(queryRecord, finalMetrics, { retrievalLane, searchOrdering, quotaConsumed: pageNumber*100 });
      await completeQueryRun(queryRunId, {
        ...finalMetrics,
        uniqueChannels: finalMetrics.newChannels,
        qualityChannels: finalMetrics.qualityChannels,
        communitiesDiscovered: finalMetrics.communitiesDiscovered,
        quotaUsed: pageNumber*100
      });
      await addQueryExecutionLog({
        query_id: queryId, query, country, executed_at: new Date().toISOString(),
        channels_discovered: finalMetrics.distinctResults, unique_new_channels: finalMetrics.newChannels,
        quality_creators_discovered: finalMetrics.qualityChannels, communities_discovered: finalMetrics.communitiesDiscovered,
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
        channel.scan_status = 'NEEDS_REVIEW';
        channel.trading_status = 'NEEDS_REVIEW';
        channel.scan_attempts = job.attempts;
        channel.last_checked = new Date().toISOString();
        await upsertChannel(channel);
        void recordAdmissionShadow({channelId,priorState:'NOT_EVALUATED',classificationStatus:'UNCERTAIN',investigationState:'OPERATIONALLY_BLOCKED',operationalFailure:true,candidateHypothesis:{},evidenceCoverage:{failureClass:String(err?.code||err?.name||'WORKER_FAILURE')}})
          .catch(error=>console.warn(`[CandidateAdmission] operational-failure shadow write failed for ${channelId}:`,error instanceof Error?error.message:error));
      }
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

    if (inspection.foundInvite) {
      // Validate every bounded native candidate until one is live. A stale or
      // invalid first match must not suppress a later valid locator.
      const candidates=inspection.discordCandidates?.length?inspection.discordCandidates:[{candidateId:`legacy:${inspection.foundInvite}`,locatorType:'NATIVE_INVITE' as const,sourceSurface:'CHANNEL_EXTERNAL_LINKS' as const,rawLocator:inspection.foundInvite,nativeInviteCode:inspection.foundInvite,normalizedLocator:`https://discord.gg/${inspection.foundInvite}`,extractionConfidence:'EXPLICIT' as const}];
      let selected:Awaited<ReturnType<typeof validateDiscordInvite>>|null=null,selectedCandidate= candidates[0];
      const terminalInvalid:Array<Awaited<ReturnType<typeof validateDiscordInvite>>>=[];
      for(const candidate of candidates){
        if(!candidate.nativeInviteCode)continue;
        const locator=candidate.normalizedLocator||`https://discord.gg/${candidate.nativeInviteCode}`;
        const priorInvalidObservations=await countDiscordInvalidObservations(channel.channel_id,candidate.candidateId,locator);
        const validation=await validateDiscordInvite(candidate.nativeInviteCode,{parentChannelIsTrading:channel.trading_status==='TRADING_CONFIRMED',channelName:channel.channel_name,priorInvalidObservations});
        await appendDiscordCheckAttempts(channel.channel_id,validation.candidateInviteUrl,validation.status,validation.attempts,{candidateId:candidate.candidateId,rawLocator:candidate.rawLocator,locatorType:candidate.locatorType,resolvedLocator:validation.candidateInviteUrl,sourceSurface:candidate.sourceSurface,sourceUrl:candidate.sourceUrl});
        if(validation.operationalOutcome==='SUCCEEDED'){selected=validation;selectedCandidate=candidate;break;}
        if(validation.operationalOutcome==='CONFIRMED_INVALID'){terminalInvalid.push(validation);continue;}
        if(!selected||validation.operationalOutcome==='INVALID_OBSERVED'){selected=validation;selectedCandidate=candidate;}
      }
      if(!selected&&terminalInvalid.length===candidates.filter(candidate=>candidate.nativeInviteCode).length){selected=terminalInvalid[0];selectedCandidate=candidates[0];}
      if(!selected)throw new Error('No resolvable native Discord candidate was available for validation');
      Object.assign(channel,projectDiscordValidation(channel,selected,selectedCandidate));
      channel.scan_status=selected.operationalOutcome==='SUCCEEDED'||selected.operationalOutcome==='CONFIRMED_INVALID'?'COMPLETED':'FAILED';
      channel.scan_attempts=selected.operationalOutcome==='SUCCEEDED'||selected.operationalOutcome==='CONFIRMED_INVALID'?0:channel.scan_attempts+selected.attempts.length;
      channel.last_checked=now;
      if(selected.retryable&&scheduleRetry)await enqueueCommunityAcquisitionRetry(channel.channel_id);
    } else if(inspection.acquisitionStatus==='ACQUISITION_FAILED'||inspection.acquisitionStatus==='PARTIALLY_INSPECTED') {
      // A failed or partial crawl is operational uncertainty, not confirmed absence.
      channel.discord_status='UNCERTAIN';
      channel.discord_liveness_status=channel.discord_candidate_locator?channel.discord_liveness_status||'UNCERTAIN':'NOT_CHECKED';channel.discord_validation_status='RETRY_PENDING';
      channel.scan_status='FAILED';
      channel.scan_attempts++;
      // An incomplete rescan cannot erase an earlier discovered locator. The
      // append-only checks remain authoritative until a new validation replaces
      // this compatibility projection.
      channel.discord_discovery_status=channel.discord_candidate_locator?'DISCOVERED_VALIDATION_FAILED':'NOT_DISCOVERED';
      channel.last_checked=now;
      if(inspection.acquisitionOutcomes?.some(item=>item.retryable)&&scheduleRetry)await enqueueCommunityAcquisitionRetry(channel.channel_id);
    } else {
      // Nothing Found After All Steps
      channel.discord_status = channel.discord_candidate_locator?'UNCERTAIN':'NOT_FOUND';
      if(!channel.discord_candidate_locator){channel.discord_resolution_status='NOT_ATTEMPTED';channel.discord_liveness_status='NOT_CHECKED';channel.discord_relevance_status='NOT_CHECKED';channel.discord_validation_status='COMPLETED';}
      channel.scan_status = 'COMPLETED';
      channel.scan_attempts = 0;
      // Only a complete inspection with no prior discovery may project absence.
      if(!channel.discord_candidate_locator)channel.discord_discovery_status='NOT_DISCOVERED';
      else channel.discord_discovery_status='DISCOVERED_VALIDATION_FAILED';
      channel.last_checked = now;
    }

  } catch (err) {
    channel.scan_attempts++;
    if (channel.scan_attempts >= 3) {
      channel.scan_status = 'FAILED_PERMANENT';
    } else {
      channel.scan_status = 'FAILED';
    }
    if(scheduleRetry)await enqueueCommunityAcquisitionRetry(channel.channel_id).catch(error=>console.warn(`[CommunityAcquisition] retry scheduling failed for ${channel.channel_id}:`,error instanceof Error?error.message:error));
  } finally {
    await upsertChannel(channel);
  }
  if (enableDebug) return { debugLog: finalDebugLog };
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

  if (channel.trading_status === 'HUMAN_REJECTED') {
    return { success: false, message: 'Human-rejected channels require the authenticated, audited force-rescan review action.', channel };
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
    const page = await searchYouTubeChannelPage(queryVariant, session.country, vocab, session.retrievalLane, pageToken);
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
