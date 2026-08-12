from pathlib import Path

q = Path('server/queueManager.ts')
s = q.read_text()
old = "import { searchYouTubeChannels, searchYouTubeChannelPage, generateCountryQueries, fetchYouTubeChannelEnrichment, DiscoveredChannelRaw, RetrievalLane } from './youtube';"
new = "import { searchYouTubeChannels, searchYouTubeChannelPage, generateCountryQueries, fetchYouTubeChannelEnrichment, fetchYouTubeChannelEnrichmentQuotaFree, DiscoveredChannelRaw, RetrievalLane } from './youtube';"
assert old in s
s = s.replace(old, new, 1)
anchor = "      const hybridEnrichmentEnabled=await getAppSetting('youtube_js_hybrid_enrichment_enabled',process.env.YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED||'true')==='true';\n      const enrichmentQuotaUnits=hybridEnrichmentEnabled?1:(enrichmentStage>=2?202:101);"
replacement = """      const hybridEnrichmentEnabled=await getAppSetting('youtube_js_hybrid_enrichment_enabled',process.env.YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED||'true')==='true';
      // If country attribution is already independently CONFIRMED, the expensive
      // creator-evidence portion can proceed entirely through YouTube.js. Official
      // channels.list remains required for unresolved country attribution and for
      // manual authoritative refreshes, but exhausted official quota must not freeze
      // confirmed-country creator evidence acquisition.
      if(hybridEnrichmentEnabled&&channel.country_status==='CONFIRMED'){
        try {
          const enriched=await fetchYouTubeChannelEnrichmentQuotaFree(channelId,candidate,enrichmentStage);
          const pipelineOutcome=await processChannelThroughPipeline(enriched,targetCountry,source,false,true);
          if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'SUCCEEDED',resultingStatus:pipelineOutcome.tradingStatus,providerCost:0,latencyMs:Date.now()-evidenceStartedAt,reasonCode:pipelineOutcome.tradingStatus==='UNCERTAIN'||pipelineOutcome.tradingStatus==='NEEDS_REVIEW'?'EVIDENCE_DID_NOT_RESOLVE':'DECISION_RESOLVED'}).catch(()=>undefined);
          if(investigationId&&investigationStepId)await completeInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,resultingStatus:pipelineOutcome.tradingStatus,output:{channelId:pipelineOutcome.channelId,tradingStatus:pipelineOutcome.tradingStatus,countryStatus:pipelineOutcome.countryStatus,quotaFreeHybrid:true}});else await completeJob(job.id);
          return true;
        } catch(error){
          if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'FAILED',providerCost:0,latencyMs:Date.now()-evidenceStartedAt,reasonCode:'PROVIDER_OR_PIPELINE_FAILURE'}).catch(()=>undefined);
          throw error;
        }
      }
      const enrichmentQuotaUnits=hybridEnrichmentEnabled?1:(enrichmentStage>=2?202:101);"""
assert anchor in s
q.write_text(s.replace(anchor, replacement, 1))

y = Path('server/youtube.ts')
s = y.read_text()
anchor = "/** Hybrid quota-light enrichment: YouTube.js for expensive creator evidence; official channels.list for authoritative metadata. */\nexport async function fetchYouTubeChannelEnrichment("
assert anchor in s
helper = """/**
 * Quota-free hybrid evidence acquisition for channels whose country attribution
 * is already independently CONFIRMED. This deliberately does not invent or
 * upgrade official country metadata; it only supplies creator-owned recent
 * uploads/activity/playlists from YouTube.js so official quota exhaustion cannot
 * block trading-evidence processing.
 */
export async function fetchYouTubeChannelEnrichmentQuotaFree(
  channelId: string,
  fallback: DiscoveredChannelRaw,
  stage:1|2|3=1
): Promise<DiscoveredChannelRaw> {
  const inner=await fetchInnerTubeChannelEnrichment(channelId,{maxVideos:10,detailVideos:stage>=2?10:6,includePlaylists:stage>=2,timeoutMs:Number(await getAppSetting('youtube_provider_timeout_ms',process.env.YOUTUBE_PROVIDER_TIMEOUT_MS||'30000'))});
  const observedAt=new Date();
  const videos=inner.videos.map(video=>({id:video.id,title:video.title,description:video.description||'',published_at:video.published_at,content_type:'youtube_video'}));
  const uploadTimestamps=videos.map(video=>video.published_at).filter((value):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value)));
  const countSince=(days:number)=>uploadTimestamps.filter(value=>Date.parse(value)>=observedAt.getTime()-days*86_400_000).length;
  const latestUploadAt=uploadTimestamps.slice().sort().at(-1);
  const uploadsLast30Days=countSince(30),uploadsLast90Days=countSince(90),uploadsLast365Days=countSince(365);
  const ageDays=latestUploadAt?(observedAt.getTime()-Date.parse(latestUploadAt))/86_400_000:Infinity;
  const activityBand:ChannelActivityBand=!latestUploadAt?'UNKNOWN':ageDays<=30?'VERY_ACTIVE':ageDays<=90?'ACTIVE':ageDays<=365?'OCCASIONAL':'DORMANT';
  const activityScore=!latestUploadAt?50:Math.max(5,Math.round(100*Math.exp(-ageDays/365)));
  return {...fallback,channelId,youtubeUrl:`https://www.youtube.com/channel/${channelId}`,videoTitles:videos.map(video=>video.title),videos,playlists:inner.playlists.length?inner.playlists:(fallback.playlists||[]),videoDescriptions:videos.map(video=>video.description||''),uploadTimestamps,latestUploadAt,uploadsLast30Days,uploadsLast90Days,uploadsLast365Days,activityBand,activityScore,activityObservedAt:observedAt.toISOString(),enrichmentStage:stage,countryMetadataStatus:fallback.countryMetadataStatus||'NOT_REQUESTED'};
}

"""
y.write_text(s.replace(anchor, helper + anchor, 1))

d = Path('server/db.ts')
s = d.read_text()
old = "db.query(`SELECT type,COUNT(*)::int depth,COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM(now()-created_at))*1000)),0)::bigint average_age_ms,COALESCE(ROUND(MAX(EXTRACT(EPOCH FROM(now()-created_at))*1000)),0)::bigint oldest_age_ms FROM jobs WHERE status='PENDING' GROUP BY type ORDER BY type`)]);"
new = "db.query(`SELECT type,COUNT(*)::int depth,COUNT(*) FILTER(WHERE run_after<=now())::int runnable_depth,COUNT(*) FILTER(WHERE run_after>now())::int deferred_depth,MIN(run_after) FILTER(WHERE run_after>now()) next_run_at,COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM(now()-created_at))*1000)),0)::bigint average_age_ms,COALESCE(ROUND(MAX(EXTRACT(EPOCH FROM(now()-created_at))*1000)),0)::bigint oldest_age_ms FROM jobs WHERE status='PENDING' GROUP BY type ORDER BY type`)]);"
assert old in s
d.write_text(s.replace(old, new, 1))

ui = Path('src/components/QueueMonitor.tsx')
s = ui.read_text()
old = "interface QueueLatencyRow {\n  type: string;\n  depth: number;\n  average_age_ms: number;\n  oldest_age_ms: number;\n}"
new = "interface QueueLatencyRow {\n  type: string;\n  depth: number;\n  runnable_depth?: number;\n  deferred_depth?: number;\n  next_run_at?: string | null;\n  average_age_ms: number;\n  oldest_age_ms: number;\n}"
assert old in s
s = s.replace(old, new, 1)
old = "      pending: Number(queue?.depth || 0),\n      oldestAgeMs: Number(queue?.oldest_age_ms || 0),"
new = "      pending: Number(queue?.depth || 0),\n      runnablePending: Number(queue?.runnable_depth || 0),\n      deferredPending: Number(queue?.deferred_depth || 0),\n      nextRunAt: queue?.next_run_at || null,\n      oldestAgeMs: Number(queue?.oldest_age_ms || 0),"
assert old in s
s = s.replace(old, new, 1)
old = '                <div className="text-[10px] text-slate-500">ENRICH_CHANNEL jobs</div>'
new = '                <div className="text-[10px] text-slate-500">{enrichmentHealth.runnablePending} runnable · {enrichmentHealth.deferredPending} deferred</div>'
assert old in s
ui.write_text(s.replace(old, new, 1))
