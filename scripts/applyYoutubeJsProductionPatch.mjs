import fs from 'node:fs';

const path = 'server/queueManager.ts';
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(label, from, to) {
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`${label}: target not found`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`${label}: target is not unique`);
  source = source.slice(0, first) + to + source.slice(first + from.length);
}

replaceOnce(
  'provider import',
  "import { triggerPhaseBObservationReconciliation } from './phaseBObservationOutbox';\n",
  "import { triggerPhaseBObservationReconciliation } from './phaseBObservationOutbox';\nimport { discoverWithInnerTube, nextInnerTubeLane, type InnerTubeDiscoveryLane } from './youtubeInnerTubeProvider';\n"
);

replaceOnce(
  'autonomous payload and provider acquisition',
`    const { query, country, source, queryRunId, queryId, retrievalLane = 'VIDEO', searchOrdering = 'RELEVANCE', pageNumber = 1, pageToken = null } = job.payload as {
      query: string; country: string; source: DiscoverySource; queryRunId?: string; queryId?: number; retrievalLane?: RetrievalLane; searchOrdering?: import('./searchOrdering').SearchOrdering; pageNumber?:number; pageToken?:string|null;
    };
    // Defense in depth for jobs queued before a country was excluded.
    await assertCountryAllowed(country, \`worker:\${job.id}\`);
    const vocabs = await getCountryVocabularies();
    const vocab = vocabs.find(v => v.country.toLowerCase() === country.toLowerCase());
    if (queryRunId) await startQueryRun(queryRunId);
    if (queryRunId && pageNumber > 1 && await autonomousPageExists(queryRunId,pageNumber)) { await completeJob(job.id); return true; }
    const autonomousOperationId=queryRunId?\`\${queryRunId}:\${pageNumber}\`:'';
    if(queryRunId){const budget=getDailyYouTubeQuotaBudget();const percent=Number(await getAppSetting('discovery_autonomous_quota_percent','70'));if(!await tryReserveQuota({operationType:'AUTONOMOUS_QUERY_PAGE',operationId:autonomousOperationId,allocation:'AUTONOMOUS',units:100,dailyBudget:budget,allocationPercent:percent}))throw new QuotaAllocationExhaustedError('AUTONOMOUS');}
    const searchPage = queryRunId ? await searchYouTubeChannelPage(query,country,vocab,retrievalLane,pageToken,searchOrdering) : null;
    if(queryRunId) await finishQuotaReservation('AUTONOMOUS_QUERY_PAGE',autonomousOperationId,true);
    const extracted = searchPage?.channels || await searchYouTubeChannels(query, country, vocab, retrievalLane);
    const distinctExtracted = [...new Map(extracted.map(channel => [channel.channelId, channel])).values()];`,
`    const { query, country, source, queryRunId, queryId, retrievalLane = 'VIDEO', searchOrdering = 'RELEVANCE', pageNumber = 1, pageToken = null, innerTubeLane = 'MONTH' } = job.payload as {
      query: string; country: string; source: DiscoverySource; queryRunId?: string; queryId?: number; retrievalLane?: RetrievalLane; searchOrdering?: import('./searchOrdering').SearchOrdering; pageNumber?:number; pageToken?:string|null; innerTubeLane?:InnerTubeDiscoveryLane;
    };
    // Defense in depth for jobs queued before a country was excluded.
    await assertCountryAllowed(country, \`worker:\${job.id}\`);
    const vocabs = await getCountryVocabularies();
    const vocab = vocabs.find(v => v.country.toLowerCase() === country.toLowerCase());
    if (queryRunId) await startQueryRun(queryRunId);
    if (queryRunId && pageNumber > 1 && await autonomousPageExists(queryRunId,pageNumber)) { await completeJob(job.id); return true; }

    // Only durable autonomous query runs are eligible for quota-free InnerTube
    // discovery. Manual/operator searches keep the official Data API path.
    const innerTubeEnabled = !!queryRunId && await getAppSetting('youtube_inner_tube_autonomous_enabled', process.env.YOUTUBE_INNERTUBE_AUTONOMOUS_ENABLED || 'true') === 'true';
    const autonomousOperationId=queryRunId?\`\${queryRunId}:\${pageNumber}\`:'';
    let providerQuotaUnits = 0;
    let searchPage: { channels: DiscoveredChannelRaw[]; rawResultCount: number; nextPageToken?: string | null } | null = null;
    if (queryRunId && innerTubeEnabled) {
      const maxProviderPages=Math.max(1,Math.min(3,Number(await getAppSetting('youtube_inner_tube_pages_per_lane',process.env.YOUTUBE_INNERTUBE_PAGES_PER_LANE||'2'))));
      const result=await discoverWithInnerTube(query,{lane:innerTubeLane,maxPages:maxProviderPages,maxChannels:100,telemetry:{requestId:traceId||undefined,runId:queryRunId,jobId:job.id,attempt:job.attempts}});
      searchPage={channels:result.channels,rawResultCount:result.rawCandidateCount,nextPageToken:null};
    } else if (queryRunId) {
      providerQuotaUnits=100;
      const budget=getDailyYouTubeQuotaBudget();
      const percent=Number(await getAppSetting('discovery_autonomous_quota_percent','70'));
      if(!await tryReserveQuota({operationType:'AUTONOMOUS_QUERY_PAGE',operationId:autonomousOperationId,allocation:'AUTONOMOUS',units:providerQuotaUnits,dailyBudget:budget,allocationPercent:percent}))throw new QuotaAllocationExhaustedError('AUTONOMOUS');
      try {
        searchPage=await searchYouTubeChannelPage(query,country,vocab,retrievalLane,pageToken,searchOrdering);
        await finishQuotaReservation('AUTONOMOUS_QUERY_PAGE',autonomousOperationId,true);
      } catch (error) {
        await finishQuotaReservation('AUTONOMOUS_QUERY_PAGE',autonomousOperationId,false);
        throw error;
      }
    }
    const extracted = searchPage?.channels || await searchYouTubeChannels(query, country, vocab, retrievalLane);
    const distinctExtracted = [...new Map(extracted.map(channel => [channel.channelId, channel])).values()];`
);

replaceOnce(
  'autonomous continuation and accounting',
`      const enabled=await getAppSetting('autonomous_pagination_enabled','true')==='true';
      const pageObservation={queryRunId,pageNumber,inputPageToken:pageToken,nextPageToken:searchPage?.nextPageToken||null,retrievalLane,searchOrdering,rawResultCount:metrics.rawResults,distinctCreatorCount:metrics.distinctResults,knownCreators:metrics.knownChannels,newCreators:metrics.newChannels,confirmedCreators:metrics.tradingConfirmed,qualityConfirmedCreators:metrics.qualityChannels,averageQualityScore:metrics.averageQualityScore,countryPrecision:metrics.countryPrecision,communityDiversity:metrics.tradingConfirmed?metrics.communitiesDiscovered/metrics.tradingConfirmed:0,noveltyRatio:metrics.noveltyRatio,duplicateRatio:metrics.rawResults?metrics.duplicateResults/metrics.rawResults:1,quotaUnits:100,decision,stoppingReason:decision.shouldContinue?null:decision.primaryReason,pageMetrics:metrics};
      await recordAutonomousPage(pageObservation);
      try{await recordPassivePage({query,jobId:job.id,observation:pageObservation});}catch(shadowError){console.error('[Phase 5 shadow] Passive page write failed.',shadowError);await recordShadowFailure({queryRunId,jobId:job.id,stage:'PAGE_OUTCOME',error:shadowError}).catch(()=>undefined);}
      if(enabled&&decision.shouldContinue&&searchPage?.nextPageToken){await enqueueJob('SEARCH_YOUTUBE',{...job.payload,pageNumber:pageNumber+1,pageToken:searchPage.nextPageToken},{priority:20,maxAttempts:3,idempotencyKey:\`search-run:\${queryRunId}:page:\${pageNumber+1}\`});await completeJob(job.id);return true;}
      const finalMetrics=await getAutonomousRunMetrics(queryRunId);
      const performance = await evaluateQueryPerformance(queryRecord, finalMetrics, { retrievalLane, searchOrdering, quotaConsumed: pageNumber*100 });
      await completeQueryRun(queryRunId, {
        ...finalMetrics,
        uniqueChannels: finalMetrics.newChannels,
        qualityChannels: finalMetrics.qualityChannels,
        communitiesDiscovered: finalMetrics.communitiesDiscovered,
        quotaUsed: pageNumber*100
      });`,
`      const enabled=await getAppSetting('autonomous_pagination_enabled','true')==='true';
      const allowDefaultInnerTube=await getAppSetting('youtube_inner_tube_default_backfill_enabled',process.env.YOUTUBE_INNERTUBE_DEFAULT_BACKFILL_ENABLED||'false')==='true';
      const nextLane=innerTubeEnabled?nextInnerTubeLane(innerTubeLane,decision.lowYield,allowDefaultInnerTube):null;
      const stoppingReason=nextLane?null:decision.shouldContinue?null:decision.primaryReason;
      const pageObservation={queryRunId,pageNumber,inputPageToken:pageToken,nextPageToken:searchPage?.nextPageToken||null,retrievalLane,searchOrdering,rawResultCount:metrics.rawResults,distinctCreatorCount:metrics.distinctResults,knownCreators:metrics.knownChannels,newCreators:metrics.newChannels,confirmedCreators:metrics.tradingConfirmed,qualityConfirmedCreators:metrics.qualityChannels,averageQualityScore:metrics.averageQualityScore,countryPrecision:metrics.countryPrecision,communityDiversity:metrics.tradingConfirmed?metrics.communitiesDiscovered/metrics.tradingConfirmed:0,noveltyRatio:metrics.noveltyRatio,duplicateRatio:metrics.rawResults?metrics.duplicateResults/metrics.rawResults:1,quotaUnits:providerQuotaUnits,decision,stoppingReason,pageMetrics:metrics};
      await recordAutonomousPage(pageObservation);
      try{await recordPassivePage({query,jobId:job.id,observation:pageObservation});}catch(shadowError){console.error('[Phase 5 shadow] Passive page write failed.',shadowError);await recordShadowFailure({queryRunId,jobId:job.id,stage:'PAGE_OUTCOME',error:shadowError}).catch(()=>undefined);}
      if(enabled&&innerTubeEnabled&&nextLane){await enqueueJob('SEARCH_YOUTUBE',{...job.payload,pageNumber:pageNumber+1,pageToken:null,innerTubeLane:nextLane},{priority:20,maxAttempts:3,idempotencyKey:\`search-run:\${queryRunId}:page:\${pageNumber+1}:youtube-js:\${nextLane.toLowerCase()}\`});await completeJob(job.id);return true;}
      if(enabled&&!innerTubeEnabled&&decision.shouldContinue&&searchPage?.nextPageToken){await enqueueJob('SEARCH_YOUTUBE',{...job.payload,pageNumber:pageNumber+1,pageToken:searchPage.nextPageToken},{priority:20,maxAttempts:3,idempotencyKey:\`search-run:\${queryRunId}:page:\${pageNumber+1}\`});await completeJob(job.id);return true;}
      const finalMetrics=await getAutonomousRunMetrics(queryRunId);
      const quotaConsumed=innerTubeEnabled?0:pageNumber*100;
      const performance = await evaluateQueryPerformance(queryRecord, finalMetrics, { retrievalLane, searchOrdering, quotaConsumed });
      await completeQueryRun(queryRunId, {
        ...finalMetrics,
        uniqueChannels: finalMetrics.newChannels,
        qualityChannels: finalMetrics.qualityChannels,
        communitiesDiscovered: finalMetrics.communitiesDiscovered,
        quotaUsed: quotaConsumed
      });`
);

replaceOnce(
  'execution log provider detail',
  "        logs: [`Durable autonomous ${retrievalLane} lane run ${queryRunId} completed by ${workerId}.`, `Funnel: ${JSON.stringify(metrics)}`]\n",
  "        logs: [`Durable autonomous ${retrievalLane} lane run ${queryRunId} completed by ${workerId} via ${innerTubeEnabled ? `YOUTUBE_JS/${innerTubeLane}` : 'YOUTUBE_DATA_API'}.`, `Funnel: ${JSON.stringify(metrics)}`]\n"
);

fs.writeFileSync(path, source);
console.log('Applied YouTube.js autonomous production routing patch to server/queueManager.ts');
