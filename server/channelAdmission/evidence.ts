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
  aboutSubscriberCount?: string;
  innertubeSubscriberCount?: string;
}): { description: string; addedLinks: string[]; subscriberCount?: string; usable: boolean } {
  const description = [input.aboutBio, input.innertubeBio]
    .map(value => String(value || '').trim())
    .find(value => hasMeaningfulCreatorText(value)) || '';
  const addedLinks = uniqueLinks([...(input.aboutLinks || []), ...(input.innertubeLinks || [])]);
  const subscriberCount = String(input.aboutSubscriberCount || input.innertubeSubscriberCount || '').trim() || undefined;
  return { description, addedLinks, subscriberCount, usable: hasMeaningfulCreatorText(description) || addedLinks.length > 0 };
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
  videoSampleFailure?: string;
}): AdmissionCoverageAssessment {
  const description = String(input.description || '').trim();
  const meaningfulDescription = hasMeaningfulCreatorText(description);
  const meaningfulPlaylists = (input.playlists || []).some(playlist =>
    hasMeaningfulCreatorText(playlist.name) || hasMeaningfulCreatorText(playlist.description));
  const missingVideoDescriptions = input.videos.some(video => !String(video.description || '').trim());
  const completeVideoSample = input.videos.length > 0 && (!input.detailFailure || !missingVideoDescriptions);
  const videoAcquisitionFailed = input.videos.length === 0 && Boolean(input.videoSampleFailure);
  const coverage: AdmissionEvidence['evidenceCoverage'] =
    !videoAcquisitionFailed && (completeVideoSample || (!input.detailFailure && (meaningfulDescription || meaningfulPlaylists)))
      ? 'COMPLETE'
      : 'PARTIAL';
  const failureReason = coverage === 'COMPLETE'
    ? undefined
    : input.detailFailure
      ? `FULL_DESCRIPTIONS_UNAVAILABLE:${input.detailFailure}`
      : input.videoSampleFailure
        ? `PROVIDER_EVIDENCE_UNAVAILABLE:${input.videoSampleFailure}`
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
export interface AdmissionEvidenceInput {
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
}

export function admissionEvidenceTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.ADMISSION_EVIDENCE_TIMEOUT_MS || '120000');
  return Number.isFinite(parsed) && parsed >= 5_000
    ? Math.min(600_000, Math.floor(parsed))
    : 120_000;
}

function admissionEvidenceBase(input: AdmissionEvidenceInput): AdmissionEvidence {
  return {
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
}

/**
 * Bound the whole evidence acquisition. The unbounded path retries keys and
 * keyless fallbacks; a stuck provider must return a partial, retryable
 * observation instead of holding an admission worker for the 15-minute stale
 * recovery window. Overlapping work may finish later but performs no writes.
 */
let admissionEvidenceLoaderForTests: ((input: AdmissionEvidenceInput, deadlineAtMs: number) => Promise<AdmissionEvidence>) | null = null;
export function setAdmissionEvidenceLoaderForTests(
  loader: ((input: AdmissionEvidenceInput, deadlineAtMs: number) => Promise<AdmissionEvidence>) | null,
): void {
  admissionEvidenceLoaderForTests = loader;
}

function evidenceTimeoutResult(input: AdmissionEvidenceInput): AdmissionEvidence {
  return {
    ...admissionEvidenceBase(input),
    failureReason: 'ADMISSION_EVIDENCE_TIMEOUT',
  };
}

/**
 * Stop waiting once the evidence budget expires and prevent later fallback
 * stages from starting. The already-running provider call is bounded by its
 * own provider deadline; it performs no admission writes. The worker receives
 * a retryable partial observation instead of a 15-minute stale lease.
 */
export async function fetchAdmissionEvidence(
  input: AdmissionEvidenceInput,
  options: { timeoutMs?: number } = {},
): Promise<AdmissionEvidence> {
  const requestedTimeoutMs = Number(options.timeoutMs ?? admissionEvidenceTimeoutMs());
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.min(600_000, Math.max(1, Math.floor(requestedTimeoutMs)))
    : admissionEvidenceTimeoutMs();
  const deadlineAtMs = Date.now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<AdmissionEvidence>((resolve) => {
    timer = setTimeout(() => resolve(evidenceTimeoutResult(input)), timeoutMs);
    timer.unref?.();
  });
  const loader = admissionEvidenceLoaderForTests ?? fetchAdmissionEvidenceUnbounded;
  try {
    return await Promise.race([loader(input, deadlineAtMs), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchAdmissionEvidenceUnbounded(input: AdmissionEvidenceInput, deadlineAtMs = Date.now() + admissionEvidenceTimeoutMs()): Promise<AdmissionEvidence> {
  const base = admissionEvidenceBase(input);
  if (Date.now() >= deadlineAtMs) return evidenceTimeoutResult(input);
  try {
    const enriched = await fetchYouTubeChannelEnrichment(input.candidate.channelId, input.candidate, input.stage || 1);
    if (Date.now() >= deadlineAtMs) return evidenceTimeoutResult(input);
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
      videoSampleFailure: enriched.videoSampleFailure,
    });
    if (Date.now() >= deadlineAtMs) return evidenceTimeoutResult(input);
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
    if (Date.now() >= deadlineAtMs) return evidenceTimeoutResult(input);
    // Official Data API failure must not hide keyless creator evidence. Try
    // the shared InnerTube/About fallbacks before declaring a provider wait.
    try {
      const { fetchPublicAboutEvidence } = await import('../youtubePublicAbout');
      const { fetchChannelAboutViaInnertube, fetchChannelVideoDescriptionsViaInnertube } = await import('../youtubeInnertubeProvider');
      let fallbackVideos: AdmissionEvidence['videos'] = [];
      let videoSampleFailure: string | undefined;
      const [about, innertubeAbout] = await Promise.all([
        fetchPublicAboutEvidence(`https://www.youtube.com/channel/${input.candidate.channelId}`).catch(() => null),
        fetchChannelAboutViaInnertube(input.candidate.channelId).catch(() => null),
        fetchChannelVideoDescriptionsViaInnertube(input.candidate.channelId, { maxVideos: 10 })
          .then(sample => {
            fallbackVideos = sample.items
              .map(item => ({
                videoId: item.videoId,
                title: String(item.title || ''),
                description: String(item.description || ''),
                publishedAt: item.publishedAt,
              }))
              .filter(video => video.title.trim() || video.description.trim())
              .slice(0, 10);
          })
          .catch(error => {
            videoSampleFailure = error instanceof Error ? error.message : String(error);
          }),
      ]);
      const fallback = selectKeylessFallbackEvidence({
        aboutBio: about?.status === 'AVAILABLE' ? about.about?.bio : undefined,
        innertubeBio: innertubeAbout?.status === 'AVAILABLE' ? innertubeAbout.description : undefined,
        aboutLinks: about?.status === 'AVAILABLE' ? about.about?.channelLinks : undefined,
        innertubeLinks: innertubeAbout?.status === 'AVAILABLE' ? innertubeAbout.links : undefined,
        aboutSubscriberCount: about?.status === 'AVAILABLE' ? about.about?.subscriberCountText : undefined,
        innertubeSubscriberCount: innertubeAbout?.status === 'AVAILABLE' ? innertubeAbout.subscriberCount : undefined,
      });
      if (fallback.usable || fallbackVideos.length) {
        const assessment = assessAdmissionEvidenceCoverage({
          description: fallback.description,
          videos: fallbackVideos,
          playlists: base.playlists,
          acquisitionFailure: failureReason,
          videoSampleFailure,
        });
        if (Date.now() >= deadlineAtMs) return evidenceTimeoutResult(input);
        return {
          ...base,
          description: fallback.description,
          links: uniqueLinks([...base.links, ...fallback.addedLinks]),
          subscriberCount: fallback.subscriberCount || base.subscriberCount,
          videos: fallbackVideos,
          evidenceCoverage: assessment.coverage,
          evidenceSample: assessment.evidenceSample,
          failureReason: assessment.failureReason,
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
