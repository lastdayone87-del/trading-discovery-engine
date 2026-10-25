/**
 * Confirmed static 404/410 terminal handling for optional community surfaces.
 *
 * A 404/410 on a creator website or social profile is only escalated to the
 * rendered browser when the static response leaves room for a soft 404, a
 * bot-protection page, or undiscovered community content. This module keeps
 * that decision conservative and separate from acquisition/retry policy:
 *
 * - only the two optional surfaces are eligible;
 * - the crawl must have failed with no candidates and no community intent;
 * - the seed's own observation must be a non-retryable HTTP_ERROR 404/410;
 * - the bounded body probe must have been readable, complete, non-blocking,
 *   free of community links, and either empty or a plain no-link error page.
 *
 * Everything else (soft 404 served as 200, 403/429/5xx, WAF markers, bodies
 * with links or community invitations, truncated/unreadable bodies) keeps the
 * existing rendered-escalation behavior. Required YouTube surfaces are never
 * eligible.
 */

import { decodeInviteObfuscation, extractDiscordCandidates } from './discordCandidates';
import { hasBlockMarkers } from './permanentBlockDetection';
import { normalizeVisitUrl } from './visitUrl';

export type StaticNotFoundSurface = 'CREATOR_WEBSITES' | 'SOCIAL_PROFILES';

export type StaticNotFoundBodyReason =
  | 'EMPTY_BODY'
  | 'NO_LINKS_SMALL_BODY'
  | 'NO_LINKS_EXPLICIT_NOT_FOUND'
  | 'HAS_LINKS'
  | 'HAS_COMMUNITY_CONTENT'
  | 'CLIENT_RENDER_SHELL'
  | 'BLOCK_MARKERS'
  | 'TRUNCATED'
  | 'LARGE_BODY'
  | 'BODY_NOT_READ'
  | 'UNREADABLE'
  | 'UNSAFE_MARKUP';

export interface StaticNotFoundBodyAssessment {
  confirmed: boolean;
  reason: StaticNotFoundBodyReason;
}

export interface StaticNotFoundObservation {
  requestedUrl?: string;
  outcome?: string;
  failureClass?: string;
  httpStatus?: number;
  retryable?: boolean;
  blockMarkers?: boolean;
  /** The bounded static body probe confirmed a terminal-looking 404/410 body.
   * This is body evidence only; the seed is not skipped until the whole
   * predicate passes and the caller marks `staticTerminalNotFound`. */
  staticNotFoundBodyConfirmed?: boolean;
  staticNotFoundBodyReason?: string;
  /** True only when rendered escalation was actually skipped for this seed.
   * Persisted provenance for post-deploy measurement keys on this field. */
  staticTerminalNotFound?: boolean;
  staticTerminalNotFoundReason?: string;
  telemetry?: { pagesInspected?: number };
}

// Hosts the rendered extractor can turn into a community candidate. Keep the
// broad host check (including invite forms without a code) so a body that
// merely names a community surface keeps the rendered path. Obfuscated forms
// are decoded first; the shared extractor is the authority for invite URLs.
const COMMUNITY_MARKER_PATTERN =
  /(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite|discord\.app\/invite|dsc\.gg|discord\.me|discord\.io|t\.me\/|telegram\.me\/|whop\.com\/|skool\.com\/|circle\.so\/|patreon\.com\/)/i;

function hasCommunityContent(text: string): boolean {
  const decoded = decodeInviteObfuscation(text);
  if (COMMUNITY_MARKER_PATTERN.test(decoded)) return true;
  return extractDiscordCandidates(decoded).length > 0;
}
const EXPLICIT_NOT_FOUND_PATTERN =
  /\b(?:404|410|not\s+found|page\s+(?:not\s+found|does\s+not\s+exist|doesn't\s+exist|could\s+not\s+be\s+found|cannot\s+be\s+found)|no\s+longer\s+(?:available|exists)|this\s+page\s+is\s+gone)\b/i;
// Bound each tag scan. The body is attacker-controlled (up to 64 KB); an
// unbounded `[^>]*` would rescan to end-of-body for every unclosed `<a`,
// `<meta`, or inline-handler prefix and could block the event loop. A tag that
// cannot be read safely inside the bound is never treated as link-free: the
// caller keeps rendered escalation instead of guessing what the tag contains.
const MAX_TAG_CHARS = 2_000;
const SMALL_BODY_CHARS = 2_048;
const HEADING_TEXT_CHARS = 4_096;
// Elements whose content is text, not markup. Skipping them keeps JavaScript
// or CSS containing `<` from being mistaken for unreadable markup. `plaintext`
// has no closing tag and consumes the rest of the document. `title` is not
// skipped: in HTML it is RCDATA, but an SVG `<title>` can contain a real
// `<a>` element, and scanning it only ever keeps rendered escalation.
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'xmp', 'plaintext']);
const CLIENT_RENDER_TAGS = new Set(['script', 'iframe', 'form', 'object', 'embed']);

interface TagBounds {
  end: number;
  uncertain: boolean;
}

/**
 * Find the closing `>` of a tag without letting quoted attributes or an
 * oversized/malformed tag hide later markup. A `<` outside quotes, an
 * unterminated quote, or a tag longer than MAX_TAG_CHARS is uncertain.
 */
function findTagEnd(source: string, start: number): TagBounds {
  let quote = '';
  const last = Math.min(source.length - 1, start + MAX_TAG_CHARS);
  for (let index = start; index <= last; index++) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return { end: index, uncertain: false };
    if (char === '<') return { end: index, uncertain: true };
  }
  return { end: last, uncertain: true };
}

function skipRawText(source: string, lowerSource: string, from: number, tag: string): TagBounds {
  if (tag === 'plaintext') return { end: source.length, uncertain: false };
  const close = lowerSource.indexOf(`</${tag}`, from);
  if (close < 0) return { end: source.length, uncertain: true };
  return findTagEnd(source, close + 2 + tag.length);
}

interface MarkupScan {
  hasLink: boolean;
  hasClientRender: boolean;
  uncertain: boolean;
}

/**
 * Linear, bounded tag scan. Unlike the previous regexes, this understands
 * quoted attributes, so `<a title="1 < 2" href="/join">` is still a link.
 * Any tag that cannot be fully checked makes the whole body uncertain.
 *
 * `lowerText` is prepared once per assessment so raw-text lookups never
 * re-lowercase the whole attacker-controlled body for each element.
 */
function scanMarkup(text: string, lowerText: string): MarkupScan {
  const result: MarkupScan = { hasLink: false, hasClientRender: false, uncertain: false };
  let index = 0;
  while (index < text.length) {
    const lt = text.indexOf('<', index);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) return { ...result, uncertain: true };
      index = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      // In text/html this is not a CDATA section; it starts a bogus comment
      // that ends at the first `>`. Skipping to `]]>` would hide markup the
      // browser parses after that `>`, including a real anchor.
      const end = text.indexOf('>', lt + 9);
      if (end < 0) return { ...result, uncertain: true };
      index = end + 1;
      continue;
    }
    if (text.startsWith('<!', lt) || text.startsWith('<?', lt)) {
      const bounds = findTagEnd(text, lt + 2);
      if (bounds.uncertain) return { ...result, uncertain: true };
      index = bounds.end + 1;
      continue;
    }
    if (text[lt + 1] === '/') {
      const bounds = findTagEnd(text, lt + 2);
      if (bounds.uncertain) return { ...result, uncertain: true };
      index = bounds.end + 1;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(text.slice(lt, Math.min(text.length, lt + 64)));
    if (!nameMatch) {
      // A bare `<` followed by text (for example `1 < 2`) is document text.
      index = lt + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const bounds = findTagEnd(text, lt + 1 + nameMatch[1].length);
    if (bounds.uncertain) return { ...result, uncertain: true };
    const tagText = text.slice(lt, bounds.end + 1);
    if ((name === 'a' || name === 'area') && /\bhref\s*=/i.test(tagText)) result.hasLink = true;
    if (CLIENT_RENDER_TAGS.has(name)) result.hasClientRender = true;
    if (name === 'meta' && /\bhttp-equiv\s*=\s*["']?refresh/i.test(tagText)) result.hasClientRender = true;
    if (/\son[a-z]+\s*=/i.test(tagText)) result.hasClientRender = true;
    index = bounds.end + 1;
    if (RAW_TEXT_TAGS.has(name)) {
      const raw = skipRawText(text, lowerText, index, name);
      if (raw.uncertain) return { ...result, uncertain: true };
      index = raw.end + 1;
    }
  }
  return result;
}

function findOpeningTag(source: string, lowerSource: string, tag: string): { start: number; end: number; uncertain: boolean } | null {
  let index = 0;
  while (index < source.length) {
    const lt = source.indexOf('<', index);
    if (lt < 0) return null;
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end < 0) return { start: lt, end: source.length, uncertain: true };
      index = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      // HTML bogus comment: ends at the first `>`, not at `]]>`.
      const end = source.indexOf('>', lt + 9);
      if (end < 0) return { start: lt, end: source.length, uncertain: true };
      index = end + 1;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt) || source[lt + 1] === '/') {
      const bounds = findTagEnd(source, lt + 2);
      if (bounds.uncertain) return { start: lt, end: bounds.end, uncertain: true };
      index = bounds.end + 1;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(source.slice(lt, Math.min(source.length, lt + 64)));
    if (!nameMatch) {
      index = lt + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const bounds = findTagEnd(source, lt + 1 + nameMatch[1].length);
    if (bounds.uncertain) return { start: lt, end: bounds.end, uncertain: true };
    if (name === tag) return { start: lt, end: bounds.end, uncertain: false };
    index = bounds.end + 1;
    if (RAW_TEXT_TAGS.has(name)) {
      const raw = skipRawText(source, lowerSource, index, name);
      if (raw.uncertain) return { start: lt, end: raw.end, uncertain: true };
      index = raw.end + 1;
    }
  }
  return null;
}

function stripHeadingTags(content: string): { text: string; uncertain: boolean } {
  let text = '';
  let index = 0;
  const lowerContent = content.toLowerCase();
  while (index < content.length) {
    const lt = content.indexOf('<', index);
    if (lt < 0) {
      text += content.slice(index);
      break;
    }
    text += content.slice(index, lt);
    if (content.startsWith('<!--', lt)) {
      const end = content.indexOf('-->', lt + 4);
      if (end < 0) return { text: '', uncertain: true };
      text += ' ';
      index = end + 3;
      continue;
    }
    if (content.startsWith('<![CDATA[', lt)) {
      // HTML bogus comment: ends at the first `>`, not at `]]>`.
      const end = content.indexOf('>', lt + 9);
      if (end < 0) return { text: '', uncertain: true };
      text += ' ';
      index = end + 1;
      continue;
    }
    if (content.startsWith('<!', lt) || content.startsWith('<?', lt) || content[lt + 1] === '/') {
      const bounds = findTagEnd(content, lt + 2);
      if (bounds.uncertain) return { text: '', uncertain: true };
      text += ' ';
      index = bounds.end + 1;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(content.slice(lt, Math.min(content.length, lt + 64)));
    if (!nameMatch) {
      text += '<';
      index = lt + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const bounds = findTagEnd(content, lt + 1 + nameMatch[1].length);
    if (bounds.uncertain) return { text: '', uncertain: true };
    text += ' ';
    index = bounds.end + 1;
    if (RAW_TEXT_TAGS.has(name)) {
      const raw = skipRawText(content, lowerContent, index, name);
      if (raw.uncertain) return { text: '', uncertain: true };
      index = raw.end + 1;
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), uncertain: false };
}

function tagText(html: string, lowerHtml: string, tag: string): { text: string; uncertain: boolean } {
  // Index-based extraction with bounded scans, not a backtracking regex. The
  // whole (already size-capped) body is scanned so an artificial window cannot
  // cut a tag in half and falsely report unsafe markup.
  const open = findOpeningTag(html, lowerHtml, tag);
  if (!open) return { text: '', uncertain: false };
  if (open.uncertain) return { text: '', uncertain: true };
  const close = lowerHtml.indexOf(`</${tag}`, open.end + 1);
  if (close < 0) return { text: '', uncertain: false };
  const closeEnd = findTagEnd(html, close + 2 + tag.length);
  if (closeEnd.uncertain) return { text: '', uncertain: true };
  const content = html.slice(open.end + 1, Math.min(close, open.end + 1 + HEADING_TEXT_CHARS));
  const stripped = stripHeadingTags(content);
  return stripped.uncertain ? { text: '', uncertain: true } : { text: stripped.text, uncertain: false };
}

/**
 * Assess a bounded 404/410 body for terminality. Suppression is allowed only
 * when the response cannot plausibly contain an undiscovered community path:
 * no anchors, no community-host markers, no WAF/block markers, complete body,
 * and either empty or a plain error page. A 404 page with any link keeps the
 * rendered path because the link/footer may expose a creator community.
 */
export function assessStaticNotFoundBody(input: {
  text: string;
  truncated: boolean;
  bodySuppressed?: boolean;
  bodyProbeFailed?: boolean;
}): StaticNotFoundBodyAssessment {
  if (input.bodyProbeFailed === true) return { confirmed: false, reason: 'UNREADABLE' };
  if (input.bodySuppressed === true) return { confirmed: false, reason: 'BODY_NOT_READ' };
  if (input.truncated === true) return { confirmed: false, reason: 'TRUNCATED' };
  const text = String(input.text || '');
  // UTF-16/UTF-32 decoded as UTF-8 leaves NULs between characters, which can
  // hide links and community markers. Never treat such a body as empty/plain.
  if (text.includes('\u0000')) return { confirmed: false, reason: 'UNREADABLE' };
  if (hasBlockMarkers(text)) return { confirmed: false, reason: 'BLOCK_MARKERS' };
  if (hasCommunityContent(text)) return { confirmed: false, reason: 'HAS_COMMUNITY_CONTENT' };
  // Prepare the lowercase body once; raw-text and heading scans reuse it so a
  // body with thousands of elements cannot trigger quadratic lowercasing.
  const lowerText = text.toLowerCase();
  const markup = scanMarkup(text, lowerText);
  // A tag that could not be fully checked may hide a link, inline handler, or
  // meta refresh. Never confirm absence from partial markup.
  if (markup.uncertain) return { confirmed: false, reason: 'UNSAFE_MARKUP' };
  if (markup.hasLink) return { confirmed: false, reason: 'HAS_LINKS' };
  if (markup.hasClientRender) return { confirmed: false, reason: 'CLIENT_RENDER_SHELL' };
  const trimmed = text.trim();
  if (!trimmed) return { confirmed: true, reason: 'EMPTY_BODY' };
  const title = tagText(text, lowerText, 'title');
  const h1 = tagText(text, lowerText, 'h1');
  if (title.uncertain || h1.uncertain) return { confirmed: false, reason: 'UNSAFE_MARKUP' };
  const heading = `${title.text} ${h1.text}`.trim();
  if (heading && EXPLICIT_NOT_FOUND_PATTERN.test(heading)) {
    return { confirmed: true, reason: 'NO_LINKS_EXPLICIT_NOT_FOUND' };
  }
  if (trimmed.length <= SMALL_BODY_CHARS) return { confirmed: true, reason: 'NO_LINKS_SMALL_BODY' };
  return { confirmed: false, reason: 'LARGE_BODY' };
}

/**
 * True only when the seed itself produced a confirmed terminal 404/410 and the
 * whole static crawl produced no community evidence. Callers use this to skip
 * rendered escalation; it never changes the observation, retry ownership, or
 * acquisition outcome.
 */
export function isConfirmedStaticTerminalNotFound(input: {
  surface: string;
  seedUrl: string;
  crawlOutcome: string;
  observations: readonly StaticNotFoundObservation[];
  candidateCount: number;
  communityIntentCount?: number;
}): boolean {
  if (input.surface !== 'CREATOR_WEBSITES' && input.surface !== 'SOCIAL_PROFILES') return false;
  if (input.crawlOutcome !== 'ACQUISITION_FAILED') return false;
  if (input.candidateCount > 0) return false;
  if ((input.communityIntentCount ?? 0) > 0) return false;
  const seedKey = normalizeVisitUrl(input.seedUrl);
  if (!seedKey) return false;
  const seedObservations = input.observations.filter(
    observation => normalizeVisitUrl(String(observation.requestedUrl || '')) === seedKey,
  );
  if (seedObservations.length !== 1) return false;
  const seed = seedObservations[0];
  if (seed.outcome !== 'ACQUISITION_FAILED') return false;
  if (seed.failureClass !== 'HTTP_ERROR') return false;
  if (seed.httpStatus !== 404 && seed.httpStatus !== 410) return false;
  if (seed.retryable !== false) return false;
  if (seed.staticNotFoundBodyConfirmed !== true) return false;
  if (seed.blockMarkers === true) return false;
  // Any successful or partially inspected evidence means the seed was not a
  // clean terminal miss; leave rendered escalation untouched.
  if (input.observations.some(observation =>
    observation.outcome === 'FOUND' ||
    observation.outcome === 'INSPECTED_NO_MATCH' ||
    observation.outcome === 'PARTIALLY_INSPECTED')) return false;
  return true;
}

/**
 * Record that rendered escalation was actually skipped. The fetch-level body
 * probe may confirm terminal-looking content even when another condition
 * (community intent, a candidate, or mixed evidence) keeps rendering; only
 * this marker is persisted as `staticTerminalNotFound` provenance, so
 * post-deploy counts cannot overstate avoided renders.
 */
export function markConfirmedStaticTerminalNotFound(input: {
  seedUrl: string;
  observations: StaticNotFoundObservation[];
}): void {
  const seedKey = normalizeVisitUrl(input.seedUrl);
  if (!seedKey) return;
  const seed = input.observations.find(
    observation =>
      normalizeVisitUrl(String(observation.requestedUrl || '')) === seedKey &&
      observation.staticNotFoundBodyConfirmed === true,
  );
  if (!seed) return;
  seed.staticTerminalNotFound = true;
  seed.staticTerminalNotFoundReason = seed.staticNotFoundBodyReason;
}
