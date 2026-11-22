import { createHash } from 'node:crypto';

const SIGNATURE_PARAMETERS = [
  'type', 'order', 'regionCode', 'relevanceLanguage', 'publishedAfter', 'publishedBefore',
  'channelId', 'id', 'playlistId', 'videoId', 'part',
] as const;

export interface YouTubeQuarantineRequestIdentity {
  provider: string;
  operation: string;
  signature: string;
}

/**
 * Stable identity for the exact provider request shape. The input hash alone
 * cannot distinguish a query that failed with `relevanceLanguage=lb` from the
 * same query served through another surface; this signature keeps quarantine
 * scoped to the parameters that actually failed.
 */
export function youtubeRequestSignature(
  provider: string,
  operation: string,
  parameters: Record<string, unknown>,
): string {
  const pairs = SIGNATURE_PARAMETERS
    .flatMap((name) => {
      const value = parameters[name];
      return value === undefined || value === null || String(value).trim() === ''
        ? []
        : [`${name}=${String(value).trim()}`];
    })
    .sort();
  return createHash('sha256')
    .update(`${provider}|${operation}|${pairs.join('&')}`)
    .digest('hex');
}

export function youtubeRequestSignatureFromUrl(
  provider: string,
  operation: string,
  rawUrl: string,
): string | null {
  try {
    const params = new URL(rawUrl).searchParams;
    return youtubeRequestSignature(provider, operation, Object.fromEntries(params.entries()));
  } catch {
    return null;
  }
}
