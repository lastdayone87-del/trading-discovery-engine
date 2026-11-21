import { createHash } from 'node:crypto';
import { fetchVideoSnippetsByIds, fetchYouTubeChannelEnrichment, type DiscoveredChannelRaw } from '../youtube';
import type { AdmissionEvidence } from './types';

/** Stable evidence fingerprint for decisions and the one semantic cache. */
export function admissionEvidenceChecksum(evidence: AdmissionEvidence): string {
  // Discovery provenance and fetch timestamps must not break the cache: the
  // same creator found through another query has the same subject.
  const stable = {
    channelId: evidence.channelId,
    channelName: evidence.channelName,
    description: evidence.description,
    links: evidence.links,
    declaredLanguage: evidence.declaredLanguage,
    country: evidence.country,
    subscriberCount: evidence.subscriberCount,
    topics: evidence.topics,
    playlists: evidence.playlists,
    videos: evidence.videos,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function uniqueLinks(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

/**
 * Temporary YouTube/provider failures are infrastructure waits, not creator
 * evidence. They must never consume an evidence attempt or expire a valid
 * candidate; only genuinely absent creator text may do that.
 */
export function isProviderEvidenceFailure(reason?: string): boolean {
  const value = String(reason || '').trim();
  if (!value) return false;
  // Only these markers mean creator text is genuinely absent. Every other
  // failure returned by the evidence fetcher is a provider, transport or
  // local collection failure and must not consume attempts or expire a
  // valid candidate.
  if (/^(?:NO_CREATOR_TEXT_AVAILABLE|FULL_DESCRIPTIONS_UNAVAILABLE\b)/i.test(value)) return false;
  // Deleted, private or invalid channels are permanent input failures, not
  // provider outages. Let the normal bounded missing-evidence path settle
  // them instead of deferring forever.
  if (/\b(?:404|410)\b|not[ _-]?found|does not exist|invalid channel|permanent input|videoNotFound|channelNotFound/i.test(value)) return false;
  return true;
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
  /** Stage 2 is a bounded playlist fallback for retries, never stage 1. */
  stage?: 1 | 2 | 3;
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
    playlists: input.candidate.playlists || [],
    matchedDocument: input.candidate.matchedDocument as unknown as Record<string, unknown> | undefined,
    relationshipProvenance: input.candidate.relationshipProvenance as unknown as Record<string, unknown> | undefined,
    query: input.query,
    queryId: input.queryId,
    queryRunId: input.queryRunId,
    pageNumber: input.pageNumber,
    resultRank: input.resultRank,
    source: input.source,
    targetCountry: input.targetCountry,
    evidenceCoverage: 'PARTIAL',
    evidenceStage: input.stage || 1,
    fetchedAt: new Date().toISOString(),
  };
  try {
    const enriched = await fetchYouTubeChannelEnrichment(input.candidate.channelId, input.candidate, input.stage || 1);
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
    const missingVideoDescriptions = videos.some(video => !String(video.description || '').trim());
    // A failed videos.list enrichment must not erase a usable sample that was
    // already acquired through the keyless InnerTube fallback.
    const coverage: AdmissionEvidence['evidenceCoverage'] =
      (videos.length > 0 && (!detailFailure || !missingVideoDescriptions)) || description.length > 0
        ? 'COMPLETE'
        : 'PARTIAL';
    return {
      ...base,
      channelName: enriched.channelName || base.channelName,
      description,
      links: uniqueLinks([...base.links, ...(enriched.channelLinks || [])]),
      country: enriched.locationTag || base.country,
      declaredLanguage: enriched.detectedLanguages?.[0]?.language || base.declaredLanguage,
      subscriberCount: enriched.subscriberCount || base.subscriberCount,
      videos,
      playlists: enriched.playlists || base.playlists,
      topics: enriched.channelTopics || base.topics,
      evidenceSample: videos.length > 0 ? 'VIDEO_SAMPLE' : description.length > 0 || uniqueLinks([...base.links, ...(enriched.channelLinks || [])]).length > 0 ? 'METADATA_ONLY' : 'NONE',
      evidenceCoverage: coverage,
      failureReason: coverage === 'PARTIAL'
        ? (detailFailure || 'NO_CREATOR_TEXT_AVAILABLE')
        : detailFailure ? `FULL_DESCRIPTIONS_UNAVAILABLE:${detailFailure}` : undefined,
    };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    // Official Data API failure must not hide keyless creator evidence. Try
    // the shared InnerTube/About fallbacks before declaring a provider wait.
    try {
      const { fetchPublicAboutEvidence } = await import('../youtubePublicAbout');
      const { fetchChannelAboutViaInnertube } = await import('../youtubeInnertubeProvider');
      const [about, innertubeAbout] = await Promise.all([
        fetchPublicAboutEvidence(`https://www.youtube.com/channel/${input.candidate.channelId}`).catch(() => null),
        fetchChannelAboutViaInnertube(input.candidate.channelId).catch(() => null),
      ]);
      const aboutBio = about?.status === 'AVAILABLE' ? about.about?.bio?.trim() : undefined;
      const innertubeBio = innertubeAbout?.status === 'AVAILABLE' ? innertubeAbout.description?.trim() : undefined;
      const description = aboutBio || innertubeBio || base.description;
      const links = uniqueLinks([
        ...base.links,
        ...(about?.status === 'AVAILABLE' ? about.about?.channelLinks || [] : []),
        ...(innertubeAbout?.status === 'AVAILABLE' ? innertubeAbout.links || [] : []),
      ]);
      if (description.trim() || links.length) {
        return {
          ...base,
          description,
          links,
          evidenceCoverage: 'COMPLETE',
          evidenceSample: 'METADATA_ONLY',
          failureReason,
        };
      }
    } catch {
      // Fall through to the provider-deferred result.
    }
    return {
      ...base,
      evidenceCoverage: 'PARTIAL',
      failureReason,
    };
  }
}
