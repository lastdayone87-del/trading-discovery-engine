import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  getAllChannels,
  getChannelById,
  getCountryVocabularies,
  saveCountryVocabulary,
  getExcludedCountries,
  addExcludedCountry,
  removeExcludedCountry,
  getQueueStatus,
  toggleQueuePause,
  getQuota,
  getSchemaInfo,
  performManualDatabaseBackup,
  getAllQueries,
  getQueriesByCountry,
  getRecentQueryExecutionLogs,
  getExtractedVocabulary,
  setQueryCollection,
  purgeSyntheticTestChannels, appendOperatorAuditEvent, getOperatorAuditEvents, getProviderOperationalMetrics, getValidationRuns, getReplayReport,
  listChannelsPage, getChannelListingRevision, getDashboardOperationalSummary
} from './server/db';
import { inspectPassivePrograms } from './server/passiveExploration';
import { inspectTopicPilot, updatePilotControl } from './server/topicPilot';
import { inspectCoverageLifecycle, recordLifecycleEvent } from './server/coverageLifecycle';
import { inspectCorpus, inspectDocument } from './server/candidateCorpus';
import { inspectCandidateAssertions } from './server/candidateScoring';
import { inspectConceptGraph, moderateConcept } from './server/conceptGraph';
import { buildCatalog, createEvaluation, inspectEvaluations, reviewCatalog } from './server/offlineEvaluation';
import { createExperiment, inspectExperiments, transitionExperiment } from './server/terminologyTrials';
import { approveCatalog, inspectCatalogs, publishCatalog, stageCatalog, transitionLifecycle } from './server/catalogPublication';
import { configurePlaylistCanary, enqueuePlaylistCanary, inspectEvidenceGraph, proposePlaylistInspection } from './server/evidenceGraphAdapters';
import { allocateBestFirst, createPolicy, inspectPortfolio, transitionPolicy } from './server/portfolioAllocator';
import { inspectAdaptiveClassifier } from './server/adaptiveTradingClassifier';
import {
  addSearchJob,
  addManualCountrySearch,
  addAutomatedCountrySearch,
  triggerManualRecheck,
  processNextSearchJob,
  executeFullManualSearch,
  startSearchWorkers,
  auditExistingChannelsWithExclusionEngine
} from './server/queueManager';
import { sanitizeSearchQuery } from './server/youtube';
import {
  runAutonomousDiscoveryCycle,
  getAutonomousDiscoveryStatus,
  startAutonomousDiscoveryScheduler,
  stopAutonomousDiscoveryScheduler,
  pauseQueryIntelligence,
  resumeQueryIntelligence,
  getDiscoveryScope,
  setDiscoveryScope
} from './server/autonomousDiscovery';
import { generateCandidateQueriesForCountry } from './server/queryIntelligence';
import { getTerminologyDashboard } from './server/terminologyIntelligence';
import {
  runRegressionTestSuite,
  getRegressionRuns,
  getLatestRegressionComparison
} from './server/regressionSuite';
import { runDatabaseStressTest } from './server/dbStressTest';
import { verifyChannelTradingRelevance, generateClassificationReport } from './server/evidenceEngine';
import { assertCountryAllowed, ExcludedCountryError } from './server/countryExclusion';
import { getManualSearchSession, listManualSearchSessions, requestManualSearchCancellation } from './server/manualSearchStore';
import { decideReview, getReviewDetails, listReviewQueue, ReviewConflictError, ReviewNotFoundError } from './server/reviewStore';
import { resolveReviewerIdentity, reviewerDefaultsAvailable, reviewerTokenIsValid } from './server/reviewerCredentials';
import { operatorAuthorization, validateOperatorConfiguration } from './server/operatorAuth';
import { createReadinessState, launchAfterReadiness } from './server/startupLifecycle';


async function startServer() {
  validateOperatorConfiguration();
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  const readiness = createReadinessState();

  app.use(express.json());
  app.use('/api', operatorAuthorization(appendOperatorAuditEvent));

  const requireReviewer: express.RequestHandler = (req,res,next) => {
    // The central operator boundary has authenticated this request. Keeping this
    // named middleware preserves the review route structure during transition.
    if (!req.operator) return res.status(401).json({error:'Bearer authentication required.',code:'UNAUTHENTICATED',requestId:req.requestId});
    next();
  };

  const sendOperationError = (res: express.Response, err: any) => {
    if (err instanceof ExcludedCountryError) {
      return res.status(422).json({
        error: err.message,
        code: err.code,
        country: err.country,
        reason: err.reason
      });
    }
    return res.status(500).json({ error: err.message });
  };

  // --- API ROUTES ---

  app.get('/api/operator-audit-events', async(req,res)=>{try{res.json(await getOperatorAuditEvents(Number(req.query.limit||100)));}catch(err:any){sendOperationError(res,err);}});
  app.get('/api/provider-metrics', async(req,res)=>{try{res.json(await getProviderOperationalMetrics(Number(req.query.hours||24)));}catch(err:any){sendOperationError(res,err);}});
  app.get('/api/validation-status', async(req,res)=>{try{res.json({policyVersion:'phase-3-baseline-v1',runs:await getValidationRuns(Number(req.query.limit||100))});}catch(err:any){sendOperationError(res,err);}});
  app.get('/api/measurement/replay',async(req,res)=>{try{const to=String(req.query.to||new Date().toISOString());const from=String(req.query.from||new Date(Date.now()-24*60*60*1000).toISOString());res.json(await getReplayReport(from,to,Number(req.query.tolerance||0)));}catch(err:any){res.status(400).json({error:err.message,code:'INVALID_REPLAY_REQUEST',requestId:req.requestId});}});
  app.get('/api/research-programs',async(req,res)=>{try{res.json(await inspectPassivePrograms(Number(req.query.limit||100)));}catch(err:any){sendOperationError(res,err);}});
  app.get('/api/research-programs/price-action-trading',async(req,res)=>{try{res.json(await inspectTopicPilot());}catch(err:any){sendOperationError(res,err);}});
  app.get('/api/research-programs/price-action-trading/coverage',async(req,res)=>{try{res.json(await inspectCoverageLifecycle());}catch(err:any){sendOperationError(res,err);}});
  app.get('/api/evidence-graph',async(req,res)=>{try{res.json(await inspectEvidenceGraph(Number(req.query.limit||100)));}catch(err:any){sendOperationError(res,err);}});
  app.get('/api/adaptive-classifier/shadow',async(req,res)=>{try{res.json(await inspectAdaptiveClassifier(Number(req.query.limit||100)));}catch(err:any){sendOperationError(res,err);}});
  app.post('/api/acquisition-adapters/playlist/proposals',async(req,res)=>{try{res.status(201).json(await proposePlaylistInspection({...req.body,programKey:req.body.programKey||'price-action-trading'}));}catch(err:any){res.status(400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  app.post('/api/acquisition-adapters/playlist/control',async(req,res)=>{try{res.json(await configurePlaylistCanary({...req.body,actor:req.operator!.actorId}));}catch(err:any){res.status(err.message==='ADAPTER_CONFIGURATION_CONFLICT'?409:400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  app.post('/api/acquisition-adapters/playlist/actions/:id/enqueue',async(req,res)=>{try{const result=await enqueuePlaylistCanary(req.params.id,String(req.body.targetCountry||''));res.status(result.queued?202:409).json(result);}catch(err:any){res.status(400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  app.get('/api/portfolio',async(req,res)=>{try{res.json(await inspectPortfolio(Number(req.query.limit||100)));}catch(err:any){sendOperationError(res,err);}});
  app.post('/api/portfolio/simulate',async(req,res)=>{try{res.json({networkAccess:false,materialized:false,choices:allocateBestFirst(req.body.candidates||[],req.body.configuration)});}catch(err:any){res.status(400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  app.post('/api/portfolio/policies',async(req,res)=>{try{res.status(201).json(await createPolicy({...req.body,actor:req.operator!.actorId}));}catch(err:any){res.status(400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  app.post('/api/portfolio/policies/:id/:action',async(req,res)=>{try{const action=String(req.params.action).toUpperCase();if(!['APPROVE','CANARY','PAUSE','ROLLBACK'].includes(action))throw new Error('INVALID_POLICY_ACTION');res.json(await transitionPolicy({id:req.params.id,action:action as any,reason:req.body.reason,idempotencyKey:req.header('idempotency-key')||req.body.idempotencyKey,actor:req.operator!.actorId}));}catch(err:any){res.status(err.message==='PORTFOLIO_POLICY_NOT_FOUND'?404:400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  app.get('/api/corpus',async(req,res)=>{try{res.json(await inspectCorpus(Number(req.query.limit||100)));}catch(err:any){sendOperationError(res,err);}});
  app.get('/api/corpus/documents/:id',async(req,res)=>{try{res.json(await inspectDocument(req.params.id));}catch(err:any){res.status(err.message==='Corpus document not found.'?404:500).json({error:err.message,requestId:req.requestId});}});
  app.get('/api/candidate-assertions',async(req,res)=>{try{res.json(await inspectCandidateAssertions(Number(req.query.limit||100)));}catch(err:any){sendOperationError(res,err);}});
  app.get('/api/concepts',async(req,res)=>{try{res.json(await inspectConceptGraph(Number(req.query.limit||100)));}catch(err:any){sendOperationError(res,err);}});
  app.post('/api/concepts/:id/moderate',async(req,res)=>{try{res.json(await moderateConcept({action:req.body.action,targetId:req.params.id,expectedVersion:Number(req.body.expectedVersion),idempotencyKey:req.header('idempotency-key')||req.body.idempotencyKey,actor:req.operator!.actorId,reason:req.body.reason,payload:req.body.payload}));}catch(err:any){res.status(err.message==='MODERATION_VERSION_CONFLICT'?409:400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  app.get('/api/offline-evaluations',async(req,res)=>{try{res.json(await inspectEvaluations(Number(req.query.limit||100)));}catch(err:any){sendOperationError(res,err);}});
  app.post('/api/offline-evaluations',async(req,res)=>{try{res.status(202).json(await createEvaluation({...req.body,actor:req.operator!.actorId}));}catch(err:any){res.status(400).json({error:err.message,code:'INVALID_OFFLINE_EVALUATION',requestId:req.requestId});}});
  app.post('/api/offline-evaluations/:id/catalogs',async(req,res)=>{try{res.status(201).json(await buildCatalog(req.params.id,req.operator!.actorId));}catch(err:any){res.status(400).json({error:err.message,code:'INVALID_CATALOG',requestId:req.requestId});}});
  app.post('/api/candidate-catalogs/:id/review',async(req,res)=>{try{res.json(await reviewCatalog({catalogId:req.params.id,decision:req.body.decision,idempotencyKey:req.header('idempotency-key')||req.body.idempotencyKey,actor:req.operator!.actorId,reason:req.body.reason}));}catch(err:any){res.status(err.message==='CATALOG_REVIEW_CONFLICT'?409:400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  app.get('/api/terminology-experiments',async(req,res)=>{try{res.json(await inspectExperiments(Number(req.query.limit||100)));}catch(err:any){sendOperationError(res,err);}});
  app.post('/api/terminology-experiments',async(req,res)=>{try{res.status(201).json(await createExperiment({...req.body,actor:req.operator!.actorId}));}catch(err:any){res.status(400).json({error:err.message,code:'INVALID_EXPERIMENT',requestId:req.requestId});}});
  app.post('/api/terminology-experiments/:id/state',async(req,res)=>{try{res.json(await transitionExperiment({id:req.params.id,expectedVersion:Number(req.body.expectedVersion),action:req.body.action,reason:req.body.reason,idempotencyKey:req.header('idempotency-key')||req.body.idempotencyKey,actor:req.operator!.actorId}));}catch(err:any){res.status(err.message==='EXPERIMENT_VERSION_CONFLICT'?409:400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  app.get('/api/serving-catalogs',async(req,res)=>{try{res.json(await inspectCatalogs(Number(req.query.limit||100)));}catch(err:any){sendOperationError(res,err);}});
  app.post('/api/candidate-catalogs/:id/stage',async(req,res)=>{try{res.status(201).json(await stageCatalog({sourceCatalogId:req.params.id,policyVersion:req.body.policyVersion,curatedShareBasisPoints:Number(req.body.curatedShareBasisPoints??10000),actor:req.operator!.actorId}));}catch(err:any){res.status(400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  app.post('/api/serving-catalogs/:id/approve',async(req,res)=>{try{res.json(await approveCatalog({catalogVersionId:req.params.id,expectedStatus:'DRAFT',idempotencyKey:req.header('idempotency-key')||req.body.idempotencyKey,actor:req.operator!.actorId,reason:req.body.reason}));}catch(err:any){res.status(err.message==='CATALOG_VERSION_CONFLICT'?409:400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  const publicationAction=(action:'PUBLISH'|'ROLLBACK'):express.RequestHandler=>async(req,res)=>{try{res.json(await publishCatalog({catalogVersionId:req.params.id,scope:req.body.scope,expectedPointerVersion:Number(req.body.expectedPointerVersion),idempotencyKey:req.header('idempotency-key')||req.body.idempotencyKey,actor:req.operator!.actorId,reason:req.body.reason,action}));}catch(err:any){res.status(err.message==='CATALOG_POINTER_CONFLICT'?409:400).json({error:err.message,code:err.message,requestId:req.requestId});}};
  app.post('/api/serving-catalogs/:id/publish',publicationAction('PUBLISH'));
  app.post('/api/serving-catalogs/:id/rollback',publicationAction('ROLLBACK'));
  app.post('/api/catalog-lifecycle/:key/transition',async(req,res)=>{try{res.json(await transitionLifecycle({lifecycleKey:req.params.key,to:req.body.to,expectedVersion:Number(req.body.expectedVersion),policyVersion:req.body.policyVersion,evidenceChecksum:req.body.evidenceChecksum,cooldownUntil:req.body.cooldownUntil,idempotencyKey:req.header('idempotency-key')||req.body.idempotencyKey,actor:req.operator!.actorId,reason:req.body.reason,manualOverride:false}));}catch(err:any){res.status(err.message==='LIFECYCLE_VERSION_CONFLICT'?409:400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  app.post('/api/catalog-lifecycle/:key/override',async(req,res)=>{try{res.json(await transitionLifecycle({lifecycleKey:req.params.key,to:req.body.to,expectedVersion:Number(req.body.expectedVersion),policyVersion:req.body.policyVersion,evidenceChecksum:req.body.evidenceChecksum,cooldownUntil:req.body.cooldownUntil,idempotencyKey:req.header('idempotency-key')||req.body.idempotencyKey,actor:req.operator!.actorId,reason:req.body.reason,manualOverride:true}));}catch(err:any){res.status(err.message==='LIFECYCLE_VERSION_CONFLICT'?409:400).json({error:err.message,code:err.message,requestId:req.requestId});}});
  app.post('/api/research-programs/price-action-trading/pause',async(req,res)=>{try{res.json(await updatePilotControl({paused:true,killSwitch:true},req.operator!.actorId));}catch(err:any){res.status(400).json({error:err.message,code:'INVALID_PILOT_CONTROL',requestId:req.requestId});}});
  app.post('/api/research-programs/price-action-trading/resume',async(req,res)=>{try{res.json(await updatePilotControl({paused:false},req.operator!.actorId));}catch(err:any){res.status(400).json({error:err.message,code:'INVALID_PILOT_CONTROL',requestId:req.requestId});}});
  app.post('/api/research-programs/price-action-trading/budget',async(req,res)=>{try{res.json(await updatePilotControl({mode:req.body.mode,dailyYoutubeCap:req.body.dailyYoutubeCap,totalYoutubeCap:req.body.totalYoutubeCap},req.operator!.actorId));}catch(err:any){res.status(400).json({error:err.message,code:'INVALID_PILOT_CONTROL',requestId:req.requestId});}});
  app.post('/api/research-programs/price-action-trading/kill-switch',async(req,res)=>{try{res.json(await updatePilotControl({killSwitch:req.body.enabled!==false,paused:req.body.enabled!==false?true:undefined},req.operator!.actorId));}catch(err:any){res.status(400).json({error:err.message,code:'INVALID_PILOT_CONTROL',requestId:req.requestId});}});
  app.post('/api/research-programs/price-action-trading/lifecycle/pause',async(req,res)=>{try{res.json(await recordLifecycleEvent({to:'PAUSED',reason:req.body.reason,idempotencyKey:req.header('idempotency-key')||req.body.idempotencyKey,actor:req.operator!.actorId}));}catch(err:any){res.status(400).json({error:err.message,code:'INVALID_LIFECYCLE_DECISION',requestId:req.requestId});}});
  app.post('/api/research-programs/price-action-trading/lifecycle/reactivate',async(req,res)=>{try{res.json(await recordLifecycleEvent({to:'ACTIVE',reason:req.body.reason,idempotencyKey:req.header('idempotency-key')||req.body.idempotencyKey,trigger:req.body.trigger,providerCostCap:req.body.providerCostCap,actor:req.operator!.actorId}));}catch(err:any){res.status(400).json({error:err.message,code:'INVALID_LIFECYCLE_DECISION',requestId:req.requestId});}});

  app.get('/api/reviewer-credentials', (_req,res)=>res.json({defaultsAvailable:reviewerDefaultsAvailable()}));
  app.get('/api/reviews', requireReviewer, async(req,res)=>{try{res.json(await listReviewQueue({country:req.query.country as string|undefined,search:req.query.search as string|undefined,limit:Number(req.query.limit||50),offset:Number(req.query.offset||0)}));}catch(err:any){sendOperationError(res,err);}});
  app.get('/api/reviews/:channelId', requireReviewer, async(req,res)=>{try{res.json(await getReviewDetails(req.params.channelId));}catch(err:any){res.status(err instanceof ReviewNotFoundError?404:500).json({error:err.message});}});
  const reviewAction=(action:'APPROVE'|'REJECT'|'FORCE_RESCAN'):express.RequestHandler=>async(req,res)=>{try{const reviewer=resolveReviewerIdentity(req.header('x-reviewer-id'))||req.operator?.actorId;if(!reviewer)return res.status(400).json({error:'Reviewer identity is required.'});const result=await decideReview({channelId:req.params.channelId,action,expectedVersion:Number(req.body.reviewVersion),reviewer,reason:String(req.body.reason||''),notes:req.body.notes,idempotencyKey:req.header('idempotency-key')||''});res.json(result);}catch(err:any){res.status(err instanceof ReviewConflictError?409:err instanceof ReviewNotFoundError?404:400).json({error:err.message});}};
  app.post('/api/reviews/:channelId/approve',requireReviewer,reviewAction('APPROVE'));
  app.post('/api/reviews/:channelId/reject',requireReviewer,reviewAction('REJECT'));
  app.post('/api/reviews/:channelId/force-rescan',requireReviewer,reviewAction('FORCE_RESCAN'));

  // Health check
  app.get('/api/health', (_req, res) => {
    const state = readiness.snapshot();
    res.status(state.readiness === 'ready' ? 200 : 503).json(state);
  });

  // 1. Get all channels (returns active validated channels by default; include_rejected=true returns all)
  app.get('/api/channels', async (req, res) => {
    try {
      const includeRejected = req.query.include_rejected === 'true';
      res.json(await listChannelsPage({includeRejected,limit:Number(req.query.limit||100),offset:Number(req.query.offset||0),search:req.query.search as string|undefined,country:req.query.country as string|undefined,countryStatus:req.query.country_status as string|undefined,tradingStatus:req.query.trading_status as string|undefined,discordStatus:req.query.discord_status as string|undefined,scanStatus:req.query.scan_status as string|undefined}));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  const channelFilterFromRequest=(req:express.Request)=>({includeRejected:req.query.include_rejected==='true',search:req.query.search as string|undefined,country:req.query.country as string|undefined,countryStatus:req.query.country_status as string|undefined,tradingStatus:req.query.trading_status as string|undefined,discordStatus:req.query.discord_status as string|undefined,scanStatus:req.query.scan_status as string|undefined});
  app.get('/api/channels-revision',async(req,res)=>{try{res.json(await getChannelListingRevision(channelFilterFromRequest(req)));}catch(err:any){res.status(500).json({error:err.message});}});
  app.get('/api/dashboard/summary',async(_req,res)=>{try{res.json(await getDashboardOperationalSummary());}catch(err:any){res.status(500).json({error:err.message});}});

  // Dedicated diagnostics view for rejected / excluded channels
  app.get('/api/channels/diagnostics/rejected', async (req, res) => {
    try {
      const allChannels = await getAllChannels();
      const rejectedChannels = allChannels.filter(c =>
        c.country_status === 'REJECTED' ||
        c.scan_status === 'SKIPPED_EXCLUDED' ||
        c.trading_status === 'NON_TRADING' ||
        c.discord_status === 'NON_TRADING'
      );
      res.json(rejectedChannels);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. Get single channel
  app.get('/api/channels/:id', async (req, res) => {
    try {
      const channel = await getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });

      res.json(channel);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2b. Permanent Classification Report for Stored Channel
  app.get('/api/channels/:id/report', async (req, res) => {
    try {
      const channel = await getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });

      await assertCountryAllowed(channel.country, 'stored_classification_report');

      const report = await generateClassificationReport({
        channel_id: channel.channel_id,
        channel_name: channel.channel_name,
        description: channel.inspection_trail?.find(t => t.step === 'BIO')?.details || '',
        video_titles: [],
        country: channel.country,
        location_tag: channel.country
      });

      res.json(report);
    } catch (err: any) {
      sendOperationError(res, err);
    }
  });

  // 2c. On-Demand Relevance Verification Endpoint
  app.post('/api/relevance/verify', async (req, res) => {
    try {
      const { channelName, channel_name, description, videoTitles, video_titles, country, locationTag, location_tag } = req.body;
      const cName = channelName || channel_name;
      if (!cName) return res.status(400).json({ error: 'Missing channel_name or channelName parameter.' });

      await assertCountryAllowed(country || 'United States', 'relevance_verification');

      const decision = await verifyChannelTradingRelevance({
        channel_name: cName,
        description: description || '',
        video_titles: videoTitles || video_titles || [],
        country: country || 'United States',
        location_tag: locationTag || location_tag
      });

      res.json(decision);
    } catch (err: any) {
      sendOperationError(res, err);
    }
  });

  // 2d. Permanent Classification Report Generator Endpoint
  app.post('/api/relevance/report', async (req, res) => {
    try {
      const { channelName, channel_name, description, videoTitles, video_titles, country, locationTag, location_tag } = req.body;
      const cName = channelName || channel_name;
      if (!cName) return res.status(400).json({ error: 'Missing channel_name or channelName parameter.' });

      await assertCountryAllowed(country || 'United States', 'classification_report');

      const report = await generateClassificationReport({
        channel_name: cName,
        description: description || '',
        video_titles: videoTitles || video_titles || [],
        country: country || 'United States',
        location_tag: locationTag || location_tag
      });

      res.json(report);
    } catch (err: any) {
      sendOperationError(res, err);
    }
  });

  // 3. Execute manual search with full pipeline execution & stage tracing
  app.post('/api/search/manual', async (req, res) => {
    try {
      const { query, country } = req.body;
      if (!query || !country) {
        return res.status(400).json({ error: 'Missing required query or country parameter.' });
      }

      // Sanitize query to strictly remove any forbidden 'discord' keywords
      const sanitized = sanitizeSearchQuery(query);
      if (!sanitized) {
        return res.status(400).json({ error: 'Invalid search query. Query contained disallowed keywords.' });
      }

      console.log(`[Manual Search Requested] Query: "${sanitized}", Country: "${country}"`);

      const executionResult = await executeFullManualSearch(sanitized, country);

      res.json({
        message: `Manual search completed for '${sanitized}' (${country}).`,
        sanitizedQuery: sanitized,
        ...executionResult
      });
    } catch (err: any) {
      console.error('[Manual Search Error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/search/manual/sessions', async (req, res) => {
    try { res.json(await listManualSearchSessions(Number(req.query.limit || 20))); }
    catch (err: any) { sendOperationError(res, err); }
  });

  app.get('/api/search/manual/sessions/:id', async (req, res) => {
    try { const session = await getManualSearchSession(req.params.id); if (!session) return res.status(404).json({ error: 'Manual search session not found.' }); res.json(session); }
    catch (err: any) { sendOperationError(res, err); }
  });

  app.post('/api/search/manual/sessions/:id/cancel', async (req, res) => {
    try { const session = await requestManualSearchCancellation(req.params.id); if (!session) return res.status(404).json({ error: 'Manual search session not found.' }); res.status(202).json(session); }
    catch (err: any) { sendOperationError(res, err); }
  });

  // 4. Generate & Run Automated Country Search
  app.post('/api/search/automated', async (req, res) => {
    try {
      const { country } = req.body;
      if (!country) {
        return res.status(400).json({ error: 'Missing country parameter.' });
      }

      const queries = await addAutomatedCountrySearch(country, { actorId: req.operator!.actorId, requestId: req.requestId });
      
      // Kick off processing
      processNextSearchJob().catch(() => {});

      res.json({ message: `Generated ${queries.length} native queries for ${country}. Jobs queued.`, queries });
    } catch (err: any) {
      sendOperationError(res, err);
    }
  });

  // 5. Trigger manual re-check
  app.post('/api/channels/:id/recheck', async (req, res) => {
    try {
      const result = await triggerManualRecheck(req.params.id, req.query.debug === 'true');
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. Get country vocabularies
  app.get('/api/country-vocabularies', async (req, res) => {
    try {
      const vocabs = await getCountryVocabularies();
      res.json(vocabs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. Save or update country vocabulary
  app.post('/api/country-vocabularies', async (req, res) => {
    try {
      await saveCountryVocabulary(req.body);
      res.json({ message: 'Country vocabulary saved.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 8. Get excluded countries
  app.get('/api/excluded-countries', async (req, res) => {
    try {
      const list = await getExcludedCountries();
      res.json(list);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 9. Add excluded country
  app.post('/api/excluded-countries', async (req, res) => {
    try {
      await addExcludedCountry(req.body);
      res.json({ message: 'Excluded country added.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 10. Remove excluded country
  app.delete('/api/excluded-countries/:name', async (req, res) => {
    try {
      await removeExcludedCountry(req.params.name);
      res.json({ message: 'Excluded country removed.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 11. Queue Status & Quota Info
  app.get('/api/queues/status', async (req, res) => {
    try {
      const queues = await getQueueStatus();
      const quota = await getQuota();
      res.json({ queues, quota });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 12. Toggle Queue Pause/Resume
  app.post('/api/queues/pause', async (req, res) => {
    try {
      const { queueName, isPaused } = req.body;
      await toggleQueuePause(queueName, isPaused);
      res.json({ message: `Queue '${queueName}' pause state updated to ${isPaused}.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 13. Database Schema Migrations & Versioning Info
  app.get('/api/database/schema-info', async (req, res) => {
    try {
      const info = await getSchemaInfo();
      res.json(info);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 14. Manual Database Backup Snapshot Trigger
  app.post('/api/database/backup', async (req, res) => {
    try {
      const backupResult = await performManualDatabaseBackup();
      res.json(backupResult);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- QUERY INTELLIGENCE ENGINE ROUTES ---

  // 15. Get Query Library
  app.get('/api/query-intelligence/library', async (req, res) => {
    try {
      const country = req.query.country as string | undefined;
      let queries = country ? await getQueriesByCountry(country) : await getAllQueries();
      res.json(queries);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 16. Get Extracted Vocabulary
  app.get('/api/query-intelligence/vocabulary', async (req, res) => {
    try {
      const country = req.query.country as string | undefined;
      const terms = await getExtractedVocabulary(country);
      res.json(terms);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Canonical Phase F view. The legacy vocabulary endpoint remains compatible.
  app.get('/api/query-intelligence/terminology', async (req, res) => {
    try {
      res.json(await getTerminologyDashboard(req.query.country as string | undefined));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 17. Get Execution Logs
  app.get('/api/query-intelligence/logs', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const logs = await getRecentQueryExecutionLogs(limit);
      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 18. Get Autonomous Scheduler Status
  app.get('/api/query-intelligence/status', async (req, res) => {
    try {
      const status = await getAutonomousDiscoveryStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 18b. Pause Query Intelligence Engine
  app.post('/api/query-intelligence/pause', async (req, res) => {
    try {
      const result = await pauseQueryIntelligence();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 18c. Resume Query Intelligence Engine
  app.post('/api/query-intelligence/resume', async (req, res) => {
    try {
      const result = await resumeQueryIntelligence();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 18d. Get Discovery Scope Configuration
  app.get('/api/query-intelligence/scope', async (req, res) => {
    try {
      const scope = await getDiscoveryScope();
      res.json(scope);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 18e. Update Discovery Scope Configuration
  app.post('/api/query-intelligence/scope', async (req, res) => {
    try {
      const { scope, selectedCountries } = req.body;
      if (!scope || !['GLOBAL', 'SELECTED_COUNTRIES'].includes(scope)) {
        return res.status(400).json({ error: 'Invalid scope mode. Must be GLOBAL or SELECTED_COUNTRIES.' });
      }
      const updated = await setDiscoveryScope(scope, selectedCountries || []);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 19. Run Autonomous Discovery Cycle On-Demand
  app.post('/api/query-intelligence/run-cycle', async (req, res) => {
    try {
      const { country } = req.body;
      const result = await runAutonomousDiscoveryCycle(country);
      res.json(result);
    } catch (err: any) {
      sendOperationError(res, err);
    }
  });

  // 20. Generate Candidate Queries
  app.post('/api/query-intelligence/generate-candidates', async (req, res) => {
    try {
      const { country, count } = req.body;
      if (!country) return res.status(400).json({ error: 'Missing required country parameter.' });
      const generated = await generateCandidateQueriesForCountry(country, count || 3);
      res.json(generated);
    } catch (err: any) {
      sendOperationError(res, err);
    }
  });

  // 21. Update Query Collection (Promote / Demote)
  app.post('/api/query-intelligence/queries/:id/collection', async (req, res) => {
    try {
      const queryId = parseInt(req.params.id);
      const { collection } = req.body;
      if (!['PROVEN', 'EXPERIMENTAL', 'REJECTED'].includes(collection)) {
        return res.status(400).json({ error: 'Invalid collection type. Must be PROVEN, EXPERIMENTAL, or REJECTED.' });
      }
      await setQueryCollection(queryId, collection);
      res.json({ message: `Query #${queryId} moved to collection '${collection}'.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- AUTOMATED REGRESSION SUITE ROUTES ---

  // 22. Get Historical Regression Runs
  app.get('/api/regression/runs', async (req, res) => {
    try {
      const runs = await getRegressionRuns();
      res.json(runs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 23. Get Latest Regression Diff Comparison Report vs Baseline
  app.get('/api/regression/latest', async (req, res) => {
    try {
      const comparison = await getLatestRegressionComparison();
      res.json(comparison);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 24. Trigger Automated Execution of the Regression Test Suite
  app.post('/api/regression/run', async (req, res) => {
    try {
      const { runLabel } = req.body;
      const runRecord = await runRegressionTestSuite(runLabel);
      res.json(runRecord);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 25. Database Concurrency & Persistence Stress Test Endpoint
  app.post('/api/db/stress-test', async (req, res) => {
    try {
      const testResult = await runDatabaseStressTest();
      res.json(testResult);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 26. Clean Synthetic Stress Test Records Endpoint
  app.post('/api/db/clean-stress-tests', async (req, res) => {
    try {
      const purgedCount = await purgeSyntheticTestChannels();
      res.json({ success: true, purgedCount, message: `Purged ${purgedCount} synthetic stress test channels.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- VITE / STATIC SERVING ---
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Trading Community Discovery Engine running on http://0.0.0.0:${PORT}`);
    // Bind promptly for the platform, but do not advertise readiness or launch
    // database-backed workers until the configured PostgreSQL database has been
    // reached and fully migrated. Provider work remains outside readiness.
    Promise.all([getSchemaInfo(), getQueueStatus()]).then(([schema]) => {
      readiness.markDatabaseReady();
      console.log(`[Startup] PostgreSQL ready at schema version ${schema.currentVersion}; ${schema.channelCount} channels available.`);
      launchAfterReadiness([
        { name: 'startup maintenance purge', run: async () => { await purgeSyntheticTestChannels(); } },
        { name: 'country exclusion audit', run: async () => { await auditExistingChannelsWithExclusionEngine(); } },
        { name: 'durable queue workers', run: () => { startSearchWorkers(); } },
        { name: 'autonomous discovery scheduler', run: () => { startAutonomousDiscoveryScheduler(); } }
      ]);
    }).catch(error => {
      console.error('[Startup] PostgreSQL initialization failed; service remains not ready:', error);
    });
  });

  // Development UI middleware is intentionally initialized after the listener.
  // API readiness must not wait for tooling initialization.
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }
}

startServer().catch(err => {
  console.error('Fatal error starting server:', err);
});
