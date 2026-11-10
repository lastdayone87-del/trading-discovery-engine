import type { RawChannelInput } from './evidenceEngine/types';

/**
 * One audit work-item row. The same row is used to build classifier input and
 * the operator-visible evidence, so the item cannot show different videos from
 * the ones the replay classified.
 */
export interface ClassificationAuditWorkItem {
  itemId: string;
  channelId: string;
  channelName: string;
  country?: string | null;
  description?: string;
  videos?: Array<{ title?: string; description?: string; published_at?: string } | string>;
  links?: string[];
}

export interface NormalizedAuditVideo {
  id: string;
  title: string;
  description: string;
  published_at?: string;
}

/**
 * Normalize videos once and keep title/description arrays aligned. Filtering
 * titles and descriptions independently (the old behaviour) silently shifted
 * every description after a title-less row.
 */
export function normalizeAuditVideos(item: ClassificationAuditWorkItem): NormalizedAuditVideo[] {
  return (item.videos || [])
    .map((video, index) => {
      if (typeof video === 'string') {
        return { id: `${item.channelId}:${index}`, title: video.trim(), description: '', published_at: undefined };
      }
      return {
        id: `${item.channelId}:${index}`,
        title: String(video.title || '').trim(),
        description: String(video.description || ''),
        published_at: video.published_at,
      };
    })
    .filter(video => Boolean(video.title));
}

export function buildAuditChannelInput(item: ClassificationAuditWorkItem): RawChannelInput {
  const videos = normalizeAuditVideos(item);
  return {
    channel_id: item.channelId,
    channel_name: item.channelName,
    description: item.description || '',
    country: item.country || undefined,
    video_titles: videos.map(video => video.title),
    video_descriptions: videos.map(video => video.description),
    videos,
    external_links: item.links || [],
    // The audit worklist contains stored channel evidence, not the search
    // document that happened to match. Treat the sampled videos as hydrated
    // and authoritative rather than as retrieval-selected match content.
    enrichment_stage: 1,
    videoDescriptionsAuthoritative: true,
  };
}

/** Exactly the evidence an operator sees in the audit console. */
export function buildAuditEvidenceInput(item: ClassificationAuditWorkItem) {
  return {
    description: item.description || '',
    videos: normalizeAuditVideos(item).slice(0, 15).map(video => ({
      title: video.title,
      description: video.description,
      published_at: video.published_at,
    })),
    external_links: item.links || [],
  };
}

/** Validate an entire import before the first database write. */
export function validateAuditLabelRows<T extends { itemId: string; label: string }>(
  rows: T[],
  validItemIds: ReadonlySet<string>,
): void {
  const validLabels = new Set(['TRADING_CONFIRMED', 'NON_TRADING', 'UNCERTAIN']);
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.itemId || !validItemIds.has(row.itemId)) throw new Error(`UNKNOWN_AUDIT_ITEM:${row.itemId || 'EMPTY'}`);
    if (!validLabels.has(row.label)) throw new Error(`INVALID_AUDIT_LABEL:${row.itemId}:${row.label}`);
    if (seen.has(row.itemId)) throw new Error(`DUPLICATE_AUDIT_LABEL:${row.itemId}`);
    seen.add(row.itemId);
  }
}
