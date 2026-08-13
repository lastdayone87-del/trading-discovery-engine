from pathlib import Path
import json, re, subprocess

ROOT = Path.cwd()

def read(path): return (ROOT/path).read_text()
def write(path, text): (ROOT/path).write_text(text)
def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'missing expected pattern: {label}')
    if text.count(old) != 1:
        raise SystemExit(f'expected one occurrence for {label}, found {text.count(old)}')
    return text.replace(old, new, 1)

# 1) One authoritative YouTube quota day: Pacific Time, same as provider cooldown.
db = read('server/db.ts')
db = replace_once(db,
"import { youtubeProviderCooldown, type YouTubeProviderOperationalStatus } from './youtubeProviderCooldown';",
"import { youtubeProviderCooldown, youtubeQuotaDateKey, type YouTubeProviderOperationalStatus } from './youtubeProviderCooldown';",
'quota-day import')
db = replace_once(db, "const quotaDay = new Date().toISOString().slice(0, 10);", "const quotaDay = youtubeQuotaDateKey();", 'reservation quota day')
db = replace_once(db, "const today=new Date().toISOString().split('T')[0];", "const today=youtubeQuotaDateKey();", 'dashboard quota day')
db = db.replace('first worker after UTC midnight', 'first worker after the YouTube Pacific quota boundary')
db = db.replace('until the next UTC day', 'until the next YouTube Pacific quota day')

# Recover only genuinely stale orphan channel locks. A one-hour age gate avoids
# touching legitimate in-flight work, and active channel-addressed jobs veto recovery.
anchor = "export async function heartbeatJob(jobId:string,workerId:string):Promise<void>{"
if anchor not in db: raise SystemExit('heartbeat anchor missing')
recovery = """export async function recoverStaleChannelLocks(staleAfterMinutes=60):Promise<number>{const db=await getDb();const res=await db.query(`UPDATE channels c SET scan_status=CASE WHEN c.trading_status='UNCERTAIN' THEN 'ENRICHMENT_PENDING' WHEN c.trading_status='NEEDS_REVIEW' THEN 'NEEDS_REVIEW' ELSE 'PENDING' END,updated_at=now() WHERE c.scan_status='LOCKED' AND c.updated_at < now()-($1||' minutes')::interval AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.status='PROCESSING' AND j.payload->>'channelId'=c.channel_id) RETURNING c.channel_id`,[String(staleAfterMinutes)]);return res.rowCount||0;}\n"""
if 'recoverStaleChannelLocks' not in db:
    db = db.replace(anchor, recovery + anchor, 1)
write('server/db.ts', db)

# 2) Make the durable worker official-Data-API-only again. Remove Provider #2 and
# hybrid-enrichment routing, while keeping later retry/telemetry improvements.
qm = read('server/queueManager.ts')
qm = qm.replace('  recoverStaleJobs,\n', '  recoverStaleJobs,\n  recoverStaleChannelLocks,\n', 1)
qm = qm.replace('fetchYouTubeChannelEnrichment, fetchYouTubeChannelEnrichmentQuotaFree, DiscoveredChannelRaw', 'fetchYouTubeChannelEnrichment, DiscoveredChannelRaw')
qm = qm.replace("import { discoverWithInnerTube, nextInnerTubeLane, type InnerTubeDiscoveryLane } from './youtubeInnerTubeProvider';\n", '')
qm = replace_once(qm, '  await recoverStaleJobs();\n', '  await recoverStaleJobs();\n  await recoverStaleChannelLocks();\n', 'worker stale lock reconciliation')

start = qm.index("      const dailyBudget = getDailyYouTubeQuotaBudget();", qm.index("if (job.type === 'ENRICH_CHANNEL')"))
end = qm.index("      return true;\n    }\n\n    const { query", start)
old = qm[start:end]
new = """      const dailyBudget = getDailyYouTubeQuotaBudget();
      const enrichmentPercent = Number(await getAppSetting('discovery_enrichment_quota_percent', process.env.DISCOVERY_ENRICHMENT_QUOTA_PERCENT || '10'));
      const enrichmentQuotaUnits=enrichmentStage>=2?202:101;
      const quotaReserved = await tryReserveQuota({
        operationType: 'ENRICH_CHANNEL', operationId: job.id, allocation: 'ENRICHMENT',
        units: enrichmentQuotaUnits, dailyBudget, allocationPercent: enrichmentPercent
      });
      if (!quotaReserved) throw new QuotaAllocationExhaustedError('ENRICHMENT');
      try {
        const enriched = await fetchYouTubeChannelEnrichment(channelId, candidate,enrichmentStage);
        const pipelineOutcome=await processChannelThroughPipeline(enriched, targetCountry, source, false, true);
        if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'SUCCEEDED',resultingStatus:pipelineOutcome.tradingStatus,providerCost:enrichmentQuotaUnits,latencyMs:Date.now()-evidenceStartedAt,reasonCode:pipelineOutcome.tradingStatus==='UNCERTAIN'||pipelineOutcome.tradingStatus==='NEEDS_REVIEW'?'EVIDENCE_DID_NOT_RESOLVE':'DECISION_RESOLVED'}).catch(()=>undefined);
        await finishQuotaReservation('ENRICH_CHANNEL', job.id, true);
        if(investigationId&&investigationStepId)await completeInvestigationStep({investigationId,stepId:investigationStepId,jobId:job.id,resultingStatus:pipelineOutcome.tradingStatus,output:{channelId:pipelineOutcome.channelId,tradingStatus:pipelineOutcome.tradingStatus,countryStatus:pipelineOutcome.countryStatus}});else await completeJob(job.id);
      } catch (error) {
        if(evidenceDecisionId)await recordEvidenceActionOutcome({decisionId:evidenceDecisionId,jobId:job.id,attempt:job.attempts,status:'FAILED',providerCost:0,latencyMs:Date.now()-evidenceStartedAt,reasonCode:'PROVIDER_OR_PIPELINE_FAILURE'}).catch(()=>undefined);
        await finishQuotaReservation('ENRICH_CHANNEL', job.id, false);
        throw error;
      }
"""
qm = qm[:start] + new + qm[end:]

# Replace Provider #2 autonomous routing block with the official path only.
auto_start = qm.index("    const { query, country, source, queryRunId")
auto_mid = qm.index("    const extracted = searchPage?.channels", auto_start)
old_auto = qm[auto_start:auto_mid]
new_auto = """    const { query, country, source, queryRunId, queryId, retrievalLane = 'VIDEO', searchOrdering = 'RELEVANCE', pageNumber = 1, pageToken = null } = job.payload as {
      query: string; country: string; source: DiscoverySource; queryRunId?: string; queryId?: number; retrievalLane?: RetrievalLane; searchOrdering?: import('./searchOrdering').SearchOrdering; pageNumber?:number; pageToken?:string|null;
    };
    // Defense in depth for jobs queued before a country was excluded.
    await assertCountryAllowed(country, `worker:${job.id}`);
    const vocabs = await getCountryVocabularies();
    const vocab = vocabs.find(v => v.country.toLowerCase() === country.toLowerCase());
    if (queryRunId) await startQueryRun(queryRunId);
    if (queryRunId && pageNumber > 1 && await autonomousPageExists(queryRunId,pageNumber)) { await completeJob(job.id); return true; }
    const autonomousOperationId=queryRunId?`${queryRunId}:${pageNumber}`:'';
    const providerQuotaUnits=queryRunId?100:0;
    let searchPage: { channels: DiscoveredChannelRaw[]; rawResultCount: number; nextPageToken?: string | null } | null = null;
    if (queryRunId) {
      const budget=getDailyYouTubeQuotaBudget();
      const percent=Number(await getAppSetting('discovery_autonomous_quota_percent','70'));
      if(!await tryReserveQuota({operationType:'AUTONOMOUS_QUERY_PAGE',operationId:autonomousOperationId,allocation:'AUTONOMOUS',units:100,dailyBudget:budget,allocationPercent:percent}))throw new QuotaAllocationExhaustedError('AUTONOMOUS');
      try {
        searchPage=await searchYouTubeChannelPage(query,country,vocab,retrievalLane,pageToken,searchOrdering);
        await finishQuotaReservation('AUTONOMOUS_QUERY_PAGE',autonomousOperationId,true);
      } catch (error) {
        await finishQuotaReservation('AUTONOMOUS_QUERY_PAGE',autonomousOperationId,false);
        throw error;
      }
    }
"""
qm = qm[:auto_start] + new_auto + qm[auto_mid:]

old_cont = """      const allowDefaultInnerTube=await getAppSetting('youtube_inner_tube_default_backfill_enabled',process.env.YOUTUBE_INNERTUBE_DEFAULT_BACKFILL_ENABLED||'false')==='true';
      const nextLane=innerTubeEnabled?nextInnerTubeLane(innerTubeLane,decision.lowYield,allowDefaultInnerTube):null;
      const stoppingReason=nextLane?null:decision.shouldContinue?null:decision.primaryReason;
"""
qm = replace_once(qm, old_cont, "      const stoppingReason=decision.shouldContinue?null:decision.primaryReason;\n", 'InnerTube continuation')
qm = re.sub(r"\n      if\(enabled&&innerTubeEnabled&&nextLane\)\{.*?return true;\}", "", qm, count=1)
qm = qm.replace("if(enabled&&!innerTubeEnabled&&decision.shouldContinue&&searchPage?.nextPageToken)", "if(enabled&&decision.shouldContinue&&searchPage?.nextPageToken)")
qm = qm.replace("      const quotaConsumed=innerTubeEnabled?0:pageNumber*100;", "      const quotaConsumed=pageNumber*100;")
qm = qm.replace("logs: [`Durable autonomous ${retrievalLane} lane run ${queryRunId} completed by ${workerId} via ${innerTubeEnabled ? `YOUTUBE_JS/${innerTubeLane}` : 'YOUTUBE_DATA_API'}.`,", "logs: [`Durable autonomous ${retrievalLane} lane run ${queryRunId} completed by ${workerId} via YOUTUBE_DATA_API.`,")
if any(token in qm for token in ['innerTubeEnabled','innerTubeLane','nextInnerTubeLane','discoverWithInnerTube','youtube_inner_tube_','YOUTUBE_INNERTUBE_']):
    raise SystemExit('Provider #2 routing references remain in queueManager.ts')
write('server/queueManager.ts', qm)

# 3) Official enrichment: expensive search first; account every successful API
# request immediately. This prevents cheap metadata calls from being sprayed across
# keys when the 100-unit upload search is unavailable and removes undercounting.
yt = read('server/youtube.ts')
yt = yt.replace("import { fetchInnerTubeChannelEnrichment } from './youtubeInnerTubeEnrichment';\n", '')
old_pair = """      const channelUrl = buildYouTubeApiUrl('channels',apiKey,{part:'snippet,brandingSettings,statistics',id:channelId});
      const recentUrl = buildYouTubeApiUrl('search',apiKey,{part:'snippet',channelId,order:'date',type:'video',maxResults:10});
      const [channelResponse, recentResponse] = await Promise.all([youtubeFetch(channelUrl,'channel-details',1,attempt+1,acquisition),youtubeFetch(recentUrl,'channel-uploads',100,attempt+1,acquisition)]);

      activeKeyIndex = currentIndex;
      await incrementQuota(101);
      const channelData = await readYouTubeJsonObject(channelResponse, 'channel-details');
      const recentData = await readYouTubeJsonObject(recentResponse, 'channel-uploads');
"""
new_pair = """      const channelUrl = buildYouTubeApiUrl('channels',apiKey,{part:'snippet,brandingSettings,statistics',id:channelId});
      const recentUrl = buildYouTubeApiUrl('search',apiKey,{part:'snippet',channelId,order:'date',type:'video',maxResults:10});
      // Probe the expensive search first. If this project cannot serve the
      // 100-unit upload request, do not waste a 1-unit metadata call on it.
      const recentResponse = await youtubeFetch(recentUrl,'channel-uploads',100,attempt+1,acquisition);
      const recentData = await readYouTubeJsonObject(recentResponse, 'channel-uploads');
      await incrementQuota(100);
      const channelResponse = await youtubeFetch(channelUrl,'channel-details',1,attempt+1,acquisition);
      const channelData = await readYouTubeJsonObject(channelResponse, 'channel-details');
      await incrementQuota(1);
      activeKeyIndex = currentIndex;
"""
yt = replace_once(yt, old_pair, new_pair, 'official enrichment request pair')

old_stage2 = """        const ids=videos.map(video=>video.id).filter(Boolean).join(',');
        const requests:Promise<Response>[]=[];
        if(ids)requests.push(youtubeFetch(buildYouTubeApiUrl('videos',apiKey,{part:'snippet',id:ids}),'enrichment-video-details',1,attempt+1,acquisition));
        requests.push(youtubeFetch(buildYouTubeApiUrl('search',apiKey,{part:'snippet',channelId,type:'playlist',maxResults:10}),'enrichment-playlists',100,attempt+1,acquisition));
        const detailResponses=await Promise.all(requests);await incrementQuota(requests.length===2?101:100);
        for(const response of detailResponses){const payload=await readYouTubeJsonObject(response, 'enrichment-details');if(payload.items?.some((item:any)=>item.id?.kind==='youtube#playlist'||typeof item.id==='object'))playlists=payload.items.map((item:any)=>({id:item.id?.playlistId,name:String(item.snippet?.title||''),description:String(item.snippet?.description||'')})).filter((item:any)=>item.name);else{const byId=new Map(payload.items?.map((item:any)=>[item.id,item.snippet])||[]);videos=videos.map(video=>({...video,description:String((byId.get(video.id) as any)?.description||video.description||'')}));}}
"""
new_stage2 = """        const ids=videos.map(video=>video.id).filter(Boolean).join(',');
        // As above, spend/record the expensive search first and account each
        // successful provider call independently.
        const playlistResponse=await youtubeFetch(buildYouTubeApiUrl('search',apiKey,{part:'snippet',channelId,type:'playlist',maxResults:10}),'enrichment-playlists',100,attempt+1,acquisition);
        const playlistPayload=await readYouTubeJsonObject(playlistResponse,'enrichment-playlists');
        await incrementQuota(100);
        playlists=playlistPayload.items.map((item:any)=>({id:item.id?.playlistId,name:String(item.snippet?.title||''),description:String(item.snippet?.description||'')})).filter((item:any)=>item.name);
        if(ids){const videoResponse=await youtubeFetch(buildYouTubeApiUrl('videos',apiKey,{part:'snippet',id:ids}),'enrichment-video-details',1,attempt+1,acquisition);const videoPayload=await readYouTubeJsonObject(videoResponse,'enrichment-video-details');await incrementQuota(1);const byId=new Map(videoPayload.items?.map((item:any)=>[item.id,item.snippet])||[]);videos=videos.map(video=>({...video,description:String((byId.get(video.id) as any)?.description||video.description||'')}));}
"""
yt = replace_once(yt, old_stage2, new_stage2, 'stage2 request accounting')

# Remove quota-free/hybrid implementation and expose only the official adapter.
marker1 = "/**\n * Quota-free hybrid evidence acquisition"
marker2 = "/** One-unit metadata hydration used only when country evidence remains uncertain. */"
if marker1 not in yt or marker2 not in yt: raise SystemExit('hybrid markers missing')
a = yt.index(marker1); b = yt.index(marker2, a)
wrapper = """/** Official YouTube Data API enrichment path. */
export async function fetchYouTubeChannelEnrichment(
  channelId: string,
  fallback: DiscoveredChannelRaw,
  stage:1|2|3=1
): Promise<DiscoveredChannelRaw> {
  return fetchYouTubeChannelEnrichmentOfficial(channelId,fallback,stage);
}

"""
yt = yt[:a] + wrapper + yt[b:]
if any(token in yt for token in ['fetchInnerTubeChannelEnrichment','youtube_js_hybrid_enrichment_enabled','YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED']):
    raise SystemExit('hybrid enrichment references remain in youtube.ts')
write('server/youtube.ts', yt)

# 4) Remove Provider #2 / hybrid implementation files and dependency.
for rel in [
    'server/youtubeInnerTubeProvider.ts','server/youtubeInnerTubeProvider.test.ts',
    'server/youtubeInnerTubeEnrichment.ts','server/youtubeInnerTubeEnrichment.test.ts',
    'server/youtubeInnerTubeEnrichment.integration.test.ts'
]:
    p=ROOT/rel
    if p.exists(): p.unlink()

pkg = json.loads(read('package.json'))
pkg.get('dependencies',{}).pop('youtubei.js',None)
write('package.json', json.dumps(pkg, indent=2) + '\n')
subprocess.run(['npm','install','--package-lock-only','--ignore-scripts'],check=True)

# 5) Migration: remove obsolete feature settings and recover old orphan locks once.
migdir=ROOT/'server/db/migrations'
versions=[]
for p in migdir.glob('*.sql'):
    m=re.match(r'(\d+)_',p.name)
    if m: versions.append(int(m.group(1)))
version=max(versions)+1
mig=migdir/f'{version:03d}_remove_youtubejs_routes_and_recover_stale_locks.sql'
if not mig.exists():
    mig.write_text("""-- Provider #2 and YouTube.js hybrid enrichment have been removed from runtime.
DELETE FROM app_settings WHERE setting_key IN (
  'youtube_inner_tube_autonomous_enabled',
  'youtube_inner_tube_pages_per_lane',
  'youtube_inner_tube_default_backfill_enabled',
  'youtube_js_hybrid_enrichment_enabled'
);

-- One-time recovery for orphaned channel rows left in LOCKED after old worker exits.
-- The runtime reconciliation keeps the same conservative one-hour/no-active-job rule.
UPDATE channels c
SET scan_status = CASE
  WHEN c.trading_status='UNCERTAIN' THEN 'ENRICHMENT_PENDING'
  WHEN c.trading_status='NEEDS_REVIEW' THEN 'NEEDS_REVIEW'
  ELSE 'PENDING'
END,
updated_at=now()
WHERE c.scan_status='LOCKED'
  AND c.updated_at < now()-interval '60 minutes'
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.status='PROCESSING' AND j.payload->>'channelId'=c.channel_id
  );
""")

# Guardrails: historical migrations may mention old settings, but runtime source/package must not.
scan=[]
for base in ['server','src']:
    for p in (ROOT/base).rglob('*'):
        if p.is_file() and 'db/migrations' not in p.as_posix() and p.suffix in {'.ts','.tsx','.js','.json'}:
            s=p.read_text(errors='ignore')
            if any(x in s for x in ['youtubeInnerTube','youtube_inner_tube_','YOUTUBE_INNERTUBE_','youtube_js_hybrid_enrichment_enabled','YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED','youtubei.js']): scan.append(p.as_posix())
if scan: raise SystemExit('obsolete runtime references remain: '+', '.join(scan))
if 'youtubei.js' in read('package-lock.json'): raise SystemExit('youtubei.js remains in package-lock')

print('Recovery patch applied successfully; migration', mig.name)
