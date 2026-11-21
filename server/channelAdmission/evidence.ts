import { createHash } from 'node:crypto';
import { fetchVideoSnippetsByIds, fetchYouTubeChannelEnrichment, type DiscoveredChannelRaw } from '../youtube';
import type { AdmissionEvidence } from './types';
import { hasMeaningfulCreatorText } from '../evidenceEngine/creatorText';

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
  if (/^NO_CREATOR_TEXT_AVAILABLE\b/i.test(value)) return false;
  // Deleted, private or invalid channels are permanent input failures, not
  // provider outages. Let the normal bounded missing-evidence path settle
  // them instead of deferring forever.
  if (/\b(?:404|410)\b|not[ _-]?found|does not exist|invalid channel|permanent input|videoNotFound|channelNotFound/i.test(value)) return false;
  return true;
}


/**
 * Select only evidence actually recovered by the keyless fallbacks. Discovery
 * snippets and candidate links are deliberately not inputs: an official
 * provider outage must stay a retryable provider failure unless a fallback
 * surface produced real creator text or a link.
 */
export function selectKeylessFallbackEvidence(input: {
  aboutBio?: string;
  innertubeBio?: string;
  aboutLinks?: string[];
  innertubeLinks?: string[];
}): { description: string; addedLinks: string[]; usable: boolean } {
  const description = [input.aboutBio, input.innertubeBio]
    .map(value => String(value || '').trim())
    .find(value => hasMeaningfulCreatorText(value)) || '';
  const addedLinks = uniqueLinks([...(input.aboutLinks || []), ...(input.innertubeLinks || [])]);
  return { description, addedLinks, usable: hasMeaningfulCreatorText(description) || addedLinks.length > 0 };
}

export interface AdmissionCoverageAssessment {
  coverage: AdmissionEvidence['evidenceCoverage'];
  evidenceSample: NonNullable<AdmissionEvidence['evidenceSample']>;
  failureReason?: string;
}

/**
 * Pure coverage assessment shared by the acquisition path and tests.
 * A provider failure is only retryable when no meaningful creator evidence
 * was acquired; a boilerplate bio or discovery snippet never makes an empty
 * video sample authoritative.
 */
export function assessAdmissionEvidenceCoverage(input: {
  description?: string;
  videos: Array<{ title?: string; description?: string }>;
  playlists?: Array<{ name?: string; description?: string }>;
  detailFailure?: string;
  acquisitionFailure?: string;
}): AdmissionCoverageAssessment {
  const description = String(input.description || '').trim();
  const meaningfulDescription = hasMeaningfulCreatorText(description);
  const meaningfulPlaylists = (input.playlists || []).some(playlist =>
    hasMeaningfulCreatorText(playlist.name) || hasMeaningfulCreatorText(playlist.description));
  const missingVideoDescriptions = input.videos.some(video => !String(video.description || '').trim());
  const completeVideoSample = input.videos.length > 0 && (!input.detailFailure || !missingVideoDescriptions);
  const coverage: AdmissionEvidence['evidenceCoverage'] =
    completeVideoSample || (!input.detailFailure && (meaningfulDescription || meaningfulPlaylists))
      ? 'COMPLETE'
      : 'PARTIAL';
  const failureReason = coverage === 'COMPLETE'
    ? undefined
    : input.detailFailure
      ? `FULL_DESCRIPTIONS_UNAVAILABLE:${input.detailFailure}`
      : input.acquisitionFailure
        ? `PROVIDER_EVIDENCE_UNAVAILABLE:${input.acquisitionFailure}`
        : 'NO_CREATOR_TEXT_AVAILABLE';
  const evidenceSample: NonNullable<AdmissionEvidence['evidenceSample']> = input.videos.length > 0
    ? 'VIDEO_SAMPLE'
    : meaningfulPlaylists
      ? 'PLAYLIST_SAMPLE'
      : meaningfulDescription
        ? 'METADATA_ONLY'
        : 'NONE';
  return { coverage, evidenceSample, failureReason };
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
      .filter(video => video.title.trim().length > 0 || video.description.trim().length > 0)
      .slice(0, 10);
    const description = String(enriched.description || '').trim();
    const playlists = enriched.playlists || base.playlists || [];
    const assessment = assessAdmissionEvidenceCoverage({
      description,
      videos,
      playlists,
      detailFailure,
      acquisitionFailure: enriched.evidenceAcquisitionFailure,
    });
    return {
      ...base,
      channelName: enriched.channelName || base.channelName,
      description,
      links: uniqueLinks([...base.links, ...(enriched.channelLinks || [])]),
      country: enriched.locationTag || base.country,
      declaredLanguage: enriched.detectedLanguages?.[0]?.language || base.declaredLanguage,
      subscriberCount: enriched.subscriberCount || base.subscriberCount,
      videos,
      playlists,
      topics: enriched.channelTopics || base.topics,
      evidenceSample: assessment.evidenceSample,
      evidenceCoverage: assessment.coverage,
      failureReason: assessment.failureReason,
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
      const fallback = selectKeylessFallbackEvidence({
        aboutBio: about?.status === 'AVAILABLE' ? about.about?.bio : undefined,
        innertubeBio: innertubeAbout?.status === 'AVAILABLE' ? innertubeAbout.description : undefined,
        aboutLinks: about?.status === 'AVAILABLE' ? about.about?.channelLinks : undefined,
        innertubeLinks: innertubeAbout?.status === 'AVAILABLE' ? innertubeAbout.links : undefined,
      });
      if (fallback.usable) {
        return {
          ...base,
          description: fallback.description,
          links: uniqueLinks([...base.links, ...fallback.addedLinks]),
          evidenceCoverage: 'COMPLETE',
          evidenceSample: 'METADATA_ONLY',
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
