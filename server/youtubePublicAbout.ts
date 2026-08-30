/**
 * Public YouTube channel About retrieval (no Data API keys).
 * Shared by Gate 1 country validation fallback and channel inspection.
 */
import { decodeEmbeddedMarkup, extractEmbeddedUrls } from './crawlerExtraction';

/** Local unions avoid coupling this helper to the full app types module. */
export type PublicAboutCountryStatus = 'CONFIRMED' | 'LIKELY' | 'UNCERTAIN' | 'REJECTED';
export type PublicAboutMetadataStatus =
  | 'NOT_REQUESTED'
  | 'AVAILABLE_DECLARED'
  | 'AVAILABLE_NOT_DECLARED'
  | 'UNAVAILABLE';

export interface PublicYouTubeChannelAbout {
  bio?: string;
  channelLinks?: string[];
  thumbnailUrl?: string;
  rawHtml?: string;
  fetchLog?: string;
}

/** Match inspection short-bio threshold: treat under 20 chars as insufficient About text. */
export const INSUFFICIENT_DESCRIPTION_MAX_LEN = 20;

export function isChannelDescriptionInsufficient(description: string | undefined | null): boolean {
  return (description || '').trim().length < INSUFFICIENT_DESCRIPTION_MAX_LEN;
}

/**
 * Whether Gate 1 should attempt a public channel-page About fetch.
 * Does not change country policy — only decides whether to gather more text evidence.
 */
export function shouldAttemptPublicAboutCountryFallback(input: {
  countryStatus: PublicAboutCountryStatus | string;
  countryMetadataStatus?: PublicAboutMetadataStatus | string | null;
  description?: string | null;
  publicAboutAttempted?: boolean | null;
}): boolean {
  // Gate 1 trigger: when Data API country metadata failed or returned no declared country (AVAILABLE_NOT_DECLARED),
  // country attribution is still unresolved, we still lack usable About text, and public About has not already been attempted.
  if (input.publicAboutAttempted) return false;
  if (input.countryStatus !== 'UNCERTAIN') return false;
  if (input.countryMetadataStatus !== 'UNAVAILABLE' && input.countryMetadataStatus !== 'AVAILABLE_NOT_DECLARED') return false;
  return isChannelDescriptionInsufficient(input.description);
}

function extractExternalUrlsFromHtmlText(text: string): string[] {
  if (!text) return [];
  const clean = decodeEmbeddedMarkup(text);
  const matches = extractEmbeddedUrls(clean);
  const results: string[] = [];
  for (let m of matches) {
    m = m.replace(/[\.,\)\;\:\>\<"]+$/, '');
    const lowerM = m.toLowerCase();
    if (
      !lowerM.includes('youtube.com') &&
      !lowerM.includes('youtu.be') &&
      !lowerM.includes('google.com') &&
      !lowerM.includes('googleusercontent.com') &&
      !lowerM.includes('ggpht.com') &&
      !lowerM.includes('gstatic.com') &&
      !lowerM.includes('doubleclick.net') &&
      !lowerM.includes('googlesyndication.com') &&
      (lowerM.startsWith('http://') || lowerM.startsWith('https://'))
    ) {
      results.push(m);
    }
  }
  return Array.from(new Set(results));
}

/**
 * Soft-failing HTTP GET used for public YouTube pages.
 * Returns null on timeout, non-OK status, network error, or non-HTML body.
 */
export async function fetchPublicYouTubePage(
  url: string,
  depth = 0,
  fetchImpl: typeof fetch = fetch
): Promise<{ html: string; finalUrl: string } | null> {
  if (depth > 2) return null;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      redirect: 'follow'
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('json') &&
      !contentType.includes('plain')
    ) {
      return null;
    }
    return { html: await res.text(), finalUrl: res.url };
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Parse channel About/bio and links from a public channel page HTML body.
 * Prefer ytInitialData channelMetadataRenderer.description; fall back to og/name description.
 */
export function parseYouTubeChannelAboutFromHtml(
  html: string,
  options?: { enableDebug?: boolean; finalUrl?: string }
): PublicYouTubeChannelAbout {
  const cleanHtml = decodeEmbeddedMarkup(html);
  let thumbnailUrl: string | undefined;
  let bio: string | undefined;
  const explicitLinks: string[] = [];

  const match = html.match(/ytInitialData\s*=\s*({.*?});<\/script>/);
  if (match) {
    try {
      const ytData = JSON.parse(match[1]);
      if (ytData.metadata?.channelMetadataRenderer?.description) {
        bio = ytData.metadata.channelMetadataRenderer.description;
      }
      if (ytData.metadata?.channelMetadataRenderer?.avatar?.thumbnails?.[0]?.url) {
        thumbnailUrl = ytData.metadata.channelMetadataRenderer.avatar.thumbnails[0].url;
      }
      function extractLinks(obj: unknown): void {
        if (typeof obj !== 'object' || obj === null) return;
        const record = obj as Record<string, unknown>;
        const viewModel = record.channelExternalLinkViewModel as
          | { link?: { content?: string } }
          | undefined;
        if (viewModel?.link?.content) explicitLinks.push(viewModel.link.content);
        const urlEndpoint = record.urlEndpoint as { url?: string } | undefined;
        if (urlEndpoint?.url) {
          const url = urlEndpoint.url;
          if (
            typeof url === 'string' &&
            url.startsWith('http') &&
            !url.includes('youtube.com/watch') &&
            !url.includes('youtube.com/channel')
          ) {
            explicitLinks.push(url);
          }
        }
        for (const key of Object.keys(record)) extractLinks(record[key]);
      }
      extractLinks(ytData);
    } catch (e) {
      console.warn('Failed to parse ytInitialData', e);
    }
  }

  if (!thumbnailUrl) {
    const ogImg =
      html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
      html.match(/<link\s+rel="image_src"\s+href="([^"]+)"/i);
    if (ogImg?.[1]) thumbnailUrl = ogImg[1];
  }

  if (!bio) {
    const ogDesc =
      html.match(/<meta\s+name="description"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (ogDesc?.[1]) bio = ogDesc[1];
  }

  const extractedUrls = Array.from(
    new Set([...explicitLinks, ...extractExternalUrlsFromHtmlText(cleanHtml)])
  );

  return {
    bio,
    channelLinks: extractedUrls,
    thumbnailUrl,
    rawHtml: options?.enableDebug ? cleanHtml : undefined,
    fetchLog:
      options?.enableDebug && options.finalUrl
        ? `Fetched ${options.finalUrl} (${html.length} bytes)`
        : undefined
  };
}

/**
 * Fetch public channel About without YouTube Data API keys.
 * Soft-fails to null on any network/parse/consent failure.
 */
export async function fetchLiveYouTubeChannelData(
  youtubeUrl: string,
  enableDebug?: boolean,
  fetchImpl: typeof fetch = fetch
): Promise<PublicYouTubeChannelAbout | null> {
  if (!youtubeUrl || !youtubeUrl.startsWith('http')) return null;
  try {
    const page = await fetchPublicYouTubePage(youtubeUrl, 0, fetchImpl);
    if (!page) return null;
    return parseYouTubeChannelAboutFromHtml(page.html, {
      enableDebug,
      finalUrl: page.finalUrl
    });
  } catch {
    return null;
  }
}

/**
 * Apply public About text onto a mutable candidate and return whether description changed.
 * Soft-failing: returns false when nothing usable was retrieved.
 */
export function applyPublicAboutToCandidate(
  candidate: {
    description?: string;
    channelLinks?: string[];
    channelThumbnailUrl?: string;
  },
  live: PublicYouTubeChannelAbout | null | undefined
): boolean {
  if (!live?.bio?.trim()) return false;
  candidate.description = live.bio.trim();
  if (live.channelLinks?.length) {
    candidate.channelLinks = Array.from(
      new Set([...(candidate.channelLinks || []), ...live.channelLinks])
    );
  }
  if (live.thumbnailUrl && !candidate.channelThumbnailUrl) {
    candidate.channelThumbnailUrl = live.thumbnailUrl;
  }
  return true;
}
