/**
 * P1 surface extractors (CORE infrastructure).
 * Pure, deterministic, DB-free, no quota. Extract literal observed surfaces
 * (hashtags, video tags, topic details, handles, URLs) with code-point
 * offsets matching candidateCorpus sliceCodePoints semantics.
 * Query promotion of these surfaces remains EXPERIMENTAL and is NOT
 * implemented here — this module only produces provenance-bound surfaces.
 * Classification: extractor logic = A (architectural constant for
 * normalization/offsets); which surfaces become queries = EXPERIMENTAL (B).
 */

export interface SurfaceSpan {
  literal: string;
  normalized: string;
  startOffset: number;
  endOffset: number;
}

const HASHTAG_PATTERN = /#([\p{L}\p{N}_][\p{L}\p{N}_\p{M}.-]*)/gu;
const HANDLE_PATTERN = /@([\p{L}\p{N}][\p{L}\p{N}._-]{0,38})/gu;
const CHANNEL_ID_PATTERN = /\bUC[A-Za-z0-9_-]{22}\b/g;
const URL_PATTERN = /https?:\/\/[^\s)\]}]+/g;

function normalizeSurface(literal: string): string {
  return literal.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/g, ' ').trim();
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function spansForMatches(text: string, pattern: RegExp): SurfaceSpan[] {
  const points = Array.from(text.normalize('NFC'));
  const normalized = points.join('');
  const spans: SurfaceSpan[] = [];
  // Map UTF-16 match indices to code-point offsets.
  for (const match of normalized.matchAll(pattern)) {
    const utf16 = match.index ?? 0;
    const start = Array.from(normalized.slice(0, utf16)).length;
    const end = start + Array.from(match[0]).length;
    const literal = points.slice(start, end).join('');
    const normalizedSurface = normalizeSurface(match[0]);
    if (!normalizedSurface) continue;
    spans.push({ literal, normalized: normalizedSurface, startOffset: start, endOffset: end });
  }
  void codePointLength;
  return spans;
}

/** Extract #hashtags with code-point offsets. Pure. */
export function extractHashtagsWithOffsets(text: string): SurfaceSpan[] {
  if (!text) return [];
  return spansForMatches(text, new RegExp(HASHTAG_PATTERN.source, HASHTAG_PATTERN.flags));
}

/** Extract @handles with code-point offsets. Pure. */
export function extractHandlesWithOffsets(text: string): SurfaceSpan[] {
  if (!text) return [];
  return spansForMatches(text, new RegExp(HANDLE_PATTERN.source, HANDLE_PATTERN.flags));
}

/** Extract bare UC* channel IDs. Pure. */
export function extractChannelIds(text: string): string[] {
  if (!text) return [];
  const found = text.match(new RegExp(CHANNEL_ID_PATTERN.source, CHANNEL_ID_PATTERN.flags));
  return found ? [...new Set(found)] : [];
}

/** Extract https?:// URLs. Pure. */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const found = text.match(new RegExp(URL_PATTERN.source, URL_PATTERN.flags));
  return found ? [...new Set(found)] : [];
}

/**
 * Parse video tags from a videos.list snippet payload.
 * Accepts unknown (API shape varies); returns [] on any malformed input.
 * Never throws on producer shape drift — fail-closed to empty.
 */
export function parseVideoTagsSnippet(snippet: unknown): string[] {
  if (typeof snippet !== 'object' || snippet === null) return [];
  const tags = (snippet as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const clean = normalizeSurface(tag);
    if (clean.length >= 2 && clean.length <= 80 && !out.includes(clean)) out.push(clean);
  }
  return out;
}

/**
 * Parse topicDetails from a channels.list / videos.list response item.
 * Returns topicIds + wikipedia URLs flattened, normalized, deduped.
 * Fail-closed to [] on malformed input.
 */
export function parseChannelTopicDetails(item: unknown): string[] {
  if (typeof item !== 'object' || item === null) return [];
  const details = (item as { topicDetails?: unknown }).topicDetails;
  if (typeof details !== 'object' || details === null) return [];
  const d = details as { topicIds?: unknown; topicCategories?: unknown };
  const raw: string[] = [];
  if (Array.isArray(d.topicIds)) for (const t of d.topicIds) if (typeof t === 'string') raw.push(t);
  if (Array.isArray(d.topicCategories)) for (const t of d.topicCategories) if (typeof t === 'string') raw.push(t);
  const out: string[] = [];
  for (const entry of raw) {
    const clean = entry.normalize('NFKC').trim();
    if (clean.length >= 2 && clean.length <= 2048 && !out.includes(clean)) out.push(clean);
  }
  return out;
}

/**
 * Parse channel handle / custom URL from a channels.list snippet.
 * Checks customUrl then snippet.customUrl variants. Returns null when absent.
 */
export function parseChannelHandle(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) return null;
  const root = item as { customUrl?: unknown; snippet?: unknown };
  const direct = typeof root.customUrl === 'string' ? root.customUrl.trim() : '';
  if (direct) return direct;
  if (typeof root.snippet === 'object' && root.snippet !== null) {
    const custom = (root.snippet as { customUrl?: unknown }).customUrl;
    if (typeof custom === 'string' && custom.trim()) return custom.trim();
  }
  return null;
}

export const SURFACE_EXTRACTOR_VERSION = 'surface-extractors-v1';
