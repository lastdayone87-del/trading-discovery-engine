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
  | 'UNREADABLE';

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
const ANCHOR_PATTERN = /<(?:a|area)\b[^>]*\bhref\s*=/i;
// A small shell can still become a soft 404 or redirect once scripts run, or
// expose content through an embedded frame/form/inline handler. Such bodies
// are never terminal even when they carry no anchor.
const CLIENT_RENDER_PATTERN = /<(?:script|iframe|form|object|embed)\b|<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh|<[^>]+\son[a-z]+\s*=/i;
const SMALL_BODY_CHARS = 2_048;

function tagText(html: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html);
  return match ? match[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
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
  if (hasBlockMarkers(text)) return { confirmed: false, reason: 'BLOCK_MARKERS' };
  if (hasCommunityContent(text)) return { confirmed: false, reason: 'HAS_COMMUNITY_CONTENT' };
  if (ANCHOR_PATTERN.test(text)) return { confirmed: false, reason: 'HAS_LINKS' };
  if (CLIENT_RENDER_PATTERN.test(text)) return { confirmed: false, reason: 'CLIENT_RENDER_SHELL' };
  const trimmed = text.trim();
  if (!trimmed) return { confirmed: true, reason: 'EMPTY_BODY' };
  const heading = `${tagText(text, 'title')} ${tagText(text, 'h1')}`.trim();
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
