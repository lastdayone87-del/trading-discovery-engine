from pathlib import Path

yt=Path('server/youtube.ts')
text=yt.read_text()
import_anchor="import { FEATURED_CHANNEL_PROVIDER_COST, parseFeaturedChannelSections, type FeaturedChannelProviderResult } from './featuredChannelAdapter';\n"
import_line="import { fetchInnerTubeChannelEnrichment } from './youtubeInnerTubeEnrichment';\n"
if import_line not in text:
    if import_anchor not in text: raise SystemExit('youtube import anchor not found')
    text=text.replace(import_anchor,import_anchor+import_line,1)

old_sig="export async function fetchYouTubeChannelEnrichment(\n  channelId: string,\n  fallback: DiscoveredChannelRaw,\n  stage:1|2|3=1\n): Promise<DiscoveredChannelRaw> {"
new_sig="async function fetchYouTubeChannelEnrichmentOfficial(\n  channelId: string,\n  fallback: DiscoveredChannelRaw,\n  stage:1|2|3=1\n): Promise<DiscoveredChannelRaw> {"
if old_sig not in text: raise SystemExit('legacy enrichment signature not found')
text=text.replace(old_sig,new_sig,1)
marker="\n/** One-unit metadata hydration used only when country evidence remains uncertain. */\n"
if marker not in text: raise SystemExit('country hydration marker not found')
wrapper='''

/** Hybrid quota-light enrichment: YouTube.js for expensive creator evidence; official channels.list for authoritative metadata. */
export async function fetchYouTubeChannelEnrichment(
  channelId: string,
  fallback: DiscoveredChannelRaw,
  stage:1|2|3=1
): Promise<DiscoveredChannelRaw> {
  const hybridEnabled=await getAppSetting('youtube_js_hybrid_enrichment_enabled',process.env.YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED||'true')==='true';
  if(!hybridEnabled) return fetchYouTubeChannelEnrichmentOfficial(channelId,fallback,stage);
  const inner=await fetchInnerTubeChannelEnrichment(channelId,{maxVideos:10,detailVideos:stage>=2?10:6,includePlaylists:stage>=2,timeoutMs:Number(await getAppSetting('youtube_provider_timeout_ms',process.env.YOUTUBE_PROVIDER_TIMEOUT_MS||'30000'))});
  if(!inner.videos.length) throw new ProviderCallError(`YouTube.js enrichment returned no recent videos for '${channelId}'.`,'TRANSIENT',true);
  const keyPool=getYouTubeKeyPool();
  if(!keyPool.length) throw new ProviderCallError('Hybrid YouTube enrichment requires one official API key for authoritative channel metadata.','CREDENTIALS_EXHAUSTED',true);
  const acquisition=youtubePoolBackoff.beginAcquisition();
  let lastError:Error|null=null,quotaExceededCount=0;
  try {
    const providerIndexes=availableKeyIndexes(keyPool);
    for(let attempt=0;attempt<providerIndexes.length;attempt++){
      const currentIndex=providerIndexes[attempt],apiKey=keyPool[currentIndex];
      try{
        const channelUrl=buildYouTubeApiUrl('channels',apiKey,{part:'snippet,brandingSettings,statistics',id:channelId});
        const response=await youtubeFetch(channelUrl,'hybrid-enrichment-channel-details',1,attempt+1,acquisition);
        const channelData=await readYouTubeJsonObject(response,'hybrid-enrichment-channel-details');
        const channel=channelData.items?.[0];
        if(!channel) throw new Error(`YouTube channel '${channelId}' was not found.`);
        activeKeyIndex=currentIndex;await incrementQuota(1);
        const description=channel.snippet?.description||fallback.description;
        const observedAt=new Date();
        const videos=inner.videos.map(video=>({id:video.id,title:video.title,description:video.description||'',published_at:video.published_at,content_type:'youtube_video'}));
        const uploadTimestamps=videos.map(video=>video.published_at).filter((value):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value)));
        const countSince=(days:number)=>uploadTimestamps.filter(value=>Date.parse(value)>=observedAt.getTime()-days*86_400_000).length;
        const latestUploadAt=uploadTimestamps.slice().sort().at(-1);
        const uploadsLast30Days=countSince(30),uploadsLast90Days=countSince(90),uploadsLast365Days=countSince(365);
        const ageDays=latestUploadAt?(observedAt.getTime()-Date.parse(latestUploadAt))/86_400_000:Infinity;
        const activityBand:ChannelActivityBand=!latestUploadAt?'UNKNOWN':ageDays<=30?'VERY_ACTIVE':ageDays<=90?'ACTIVE':ageDays<=365?'OCCASIONAL':'DORMANT';
        const activityScore=!latestUploadAt?50:Math.max(5,Math.round(100*Math.exp(-ageDays/365)));
        const officialCountry=channel.brandingSettings?.channel?.country;
        const extractedLinks=description.match(/https?:\\/\\/[^\\s)\\]}]+/g)||[];
        const playlists=inner.playlists.length?inner.playlists:(fallback.playlists||[]);
        return {...fallback,channelId,channelName:channel.snippet?.title||fallback.channelName,youtubeUrl:`https://www.youtube.com/channel/${channelId}`,description,videoTitles:videos.map(video=>video.title),videos,playlists,videoDescriptions:videos.map(video=>video.description||''),locationTag:officialCountry||fallback.locationTag,countryMetadataStatus:officialCountry?'AVAILABLE_DECLARED':'AVAILABLE_NOT_DECLARED',countryMetadataCheckedAt:observedAt.toISOString(),channelLinks:Array.from(new Set([...(fallback.channelLinks||[]),...extractedLinks])),subscriberCount:channel.statistics?.subscriberCount||fallback.subscriberCount,channelThumbnailUrl:channel.snippet?.thumbnails?.high?.url||channel.snippet?.thumbnails?.default?.url||fallback.channelThumbnailUrl,uploadTimestamps,latestUploadAt,uploadsLast30Days,uploadsLast90Days,uploadsLast365Days,activityBand,activityScore,activityObservedAt:observedAt.toISOString(),enrichmentStage:stage,externalLinkDetails:extractedLinks.map(url=>{try{return {url,domain:new URL(url).hostname.toLowerCase()};}catch{return {url};}})};
      }catch(error:any){recordProviderFailure(apiKey,error);if(isQuotaExceeded(error))quotaExceededCount++;lastError=error instanceof Error?error:new Error(String(error));}
    }
    acquisition.providerFailed(quotaExceededCount===keyPool.length?'QUOTA_EXHAUSTED':'INDETERMINATE');
    throwIfAllProvidersCoolingDown(keyPool);
    throw lastError||new Error(`Hybrid YouTube enrichment failed for '${channelId}'.`);
  } finally { acquisition.release(); }
}
'''
text=text.replace(marker,wrapper+marker,1)
yt.write_text(text)

qm=Path('server/queueManager.ts')
text=qm.read_text()
old="""      const dailyBudget = getDailyYouTubeQuotaBudget();
      const enrichmentPercent = Number(await getAppSetting('discovery_enrichment_quota_percent', process.env.DISCOVERY_ENRICHMENT_QUOTA_PERCENT || '10'));
      const quotaReserved = await tryReserveQuota({
        operationType: 'ENRICH_CHANNEL', operationId: job.id, allocation: 'ENRICHMENT',
        units: enrichmentStage>=2?202:101, dailyBudget, allocationPercent: enrichmentPercent
      });
"""
new="""      const dailyBudget = getDailyYouTubeQuotaBudget();
      const enrichmentPercent = Number(await getAppSetting('discovery_enrichment_quota_percent', process.env.DISCOVERY_ENRICHMENT_QUOTA_PERCENT || '10'));
      const hybridEnrichmentEnabled=await getAppSetting('youtube_js_hybrid_enrichment_enabled',process.env.YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED||'true')==='true';
      const enrichmentQuotaUnits=hybridEnrichmentEnabled?1:(enrichmentStage>=2?202:101);
      const quotaReserved = await tryReserveQuota({
        operationType: 'ENRICH_CHANNEL', operationId: job.id, allocation: 'ENRICHMENT',
        units: enrichmentQuotaUnits, dailyBudget, allocationPercent: enrichmentPercent
      });
"""
if old not in text: raise SystemExit('queue quota reservation anchor not found')
text=text.replace(old,new,1)
text=text.replace("providerCost:enrichmentStage>=2?202:101,latencyMs", "providerCost:enrichmentQuotaUnits,latencyMs",1)
qm.write_text(text)
