import { fetchVideoSnippetsByIds, fetchYouTubeChannelEnrichment, type DiscoveredChannelRaw } from '../youtube';
import type { AdmissionEvidence } from './types';

function uniqueLinks(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

/**
 * Collect creator-level admission evidence. The channel metadata/upload list
 * costs two units; the full-description fetch costs one more. A failure is
 * returned as PARTIAL evidence so the caller can retry instead of guessing.
 */
export async function fetchAdmissionEvidence(input: {
  candidate: DiscoveredChannelRaw;
  targetCountry: string;
  source: AdmissionEvidence['source'];
  query?: string;
  queryId?: number;
  queryRunId?: string;
  pageNumber?: number;
  resultRank?: number;
}): Promise<AdmissionEvidence> {
  const base: AdmissionEvidence = {
    channelId: input.candidate.channelId,
    channelName: input.candidate.channelName,
    youtubeUrl: input.candidate.youtubeUrl,
    description: input.candidate.description || '',
    links: uniqueLinks(input.candidate.channelLinks || []),
    country: input.candidate.locationTag,
    declaredLanguage: input.candidate.detectedLanguages?.[0]?.language,
    subscriberCount: input.candidate.subscriberCount,
    videos: [],
    matchedDocument: input.candidate.matchedDocument as unknown as Record<string, unknown> | undefined,
    query: input.query,
    queryId: input.queryId,
    queryRunId: input.queryRunId,
    pageNumber: input.pageNumber,
    resultRank: input.resultRank,
    source: input.source,
    targetCountry: input.targetCountry,
    evidenceCoverage: 'PARTIAL',
    fetchedAt: new Date().toISOString(),
  };
  try {
    const enriched = await fetchYouTubeChannelEnrichment(input.candidate.channelId, input.candidate, 1);
    const ids = (enriched.videos || []).map(video => String(video.id || '')).filter(Boolean);
    let fullDetails: Awaited<ReturnType<typeof fetchVideoSnippetsByIds>> = [];
    let detailFailure: string | undefined;
    if (ids.length) {
      try {
        fullDetails = await fetchVideoSnippetsByIds(ids);
      } catch (error) {
        detailFailure = error instanceof Error ? error.message : String(error);
      }
    }
    const byId = new Map(fullDetails.map(item => [item.videoId, item]));
    const videos = (enriched.videos || [])
      .map((video, index) => {
        const full = video.id ? byId.get(String(video.id)) : undefined;
        return {
          videoId: video.id ? String(video.id) : undefined,
          title: String(full?.title || video.title || ''),
          description: String(full?.description || video.description || ''),
          publishedAt: full?.publishedAt || video.published_at,
        };
      })
      .filter(video => video.title.trim().length > 0)
      .slice(0, 10);
    const description = String(enriched.description || base.description || '').trim();
    const coverage: AdmissionEvidence['evidenceCoverage'] =
      videos.length > 0 || description.length > 0 ? 'COMPLETE' : 'PARTIAL';
    return {
      ...base,
      channelName: enriched.channelName || base.channelName,
      description,
      links: uniqueLinks([...base.links, ...(enriched.channelLinks || [])]),
      country: enriched.locationTag || base.country,
      declaredLanguage: enriched.detectedLanguages?.[0]?.language || base.declaredLanguage,
      subscriberCount: enriched.subscriberCount || base.subscriberCount,
      videos,
      evidenceCoverage: coverage,
      failureReason: coverage === 'PARTIAL'
        ? (detailFailure || 'NO_CREATOR_TEXT_AVAILABLE')
        : detailFailure ? `FULL_DESCRIPTIONS_UNAVAILABLE:${detailFailure}` : undefined,
    };
  } catch (error) {
    return {
      ...base,
      evidenceCoverage: 'PARTIAL',
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}
