/**
 * Paid/private community intent (P4).
 *
 * Platform community surfaces (Whop, Skool, Circle, Patreon) are evidence that
 * a community exists even when no Discord invite can be verified. The historic
 * pipeline collapsed those pages into "no community found"; this module
 * produces first-class evidence instead, so the channel state can say
 * COMMUNITY_INDICATED_NO_INVITE / PAID_COMMUNITY_INDICATED (or PAYWALL_WALL +
 * PAID signals) rather than INSPECTED_NO_MATCH.
 *
 * Evidence is extraction-only: an observed community URL never becomes an
 * invite, never claims a registry code, and never validates. Paid/private
 * classification uses bounded static signals (price patterns, membership
 * wording, explicit login gates, `isAccessibleForFree:false`) and fails to
 * UNKNOWN when the static evidence cannot say — honesty over guessing.
 */
import type { CommunityDiscoveryStatus, CommunityIntentEvidence, CommunityIntentKind, CommunityPlatform } from '../src/types';

const PLATFORM_BY_BASE_HOST: Record<string, CommunityPlatform> = {
  'whop.com': 'WHOP',
  'skool.com': 'SKOOL',
  'circle.so': 'CIRCLE',
  'patreon.com': 'PATREON',
};

/** Maps a hostname (with or without `www.`, optionally a tenant subdomain) to
 * its community platform, or null when the host is not a known surface. */
export function communityPlatformForHost(host: string): CommunityPlatform | null {
  const normalized = String(host || '').trim().toLowerCase().split(':')[0].replace(/\.$/, '').replace(/^www\./, '');
  if (!normalized) return null;
  // Object.hasOwn prevents prototype keys ("constructor", "__proto__") from
  // being mistaken for platform entries.
  const direct = Object.hasOwn(PLATFORM_BY_BASE_HOST, normalized) ? PLATFORM_BY_BASE_HOST[normalized] : null;
  if (direct) return direct;
  for (const [base, platform] of Object.entries(PLATFORM_BY_BASE_HOST)) {
    if (normalized.endsWith(`.${base}`)) return platform;
  }
  return null;
}

/** Paid-access static signals. Each name is recorded in evidence so a report
 * can show why a surface was classified PAID rather than asserting it. */
export const PAID_SIGNAL_DETECTORS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'price', pattern: /\$\s?\d+(?:[.,]\d+)?|\b(?:usd|eur|gbp)\s?\d+(?:[.,]\d+)?\b/i },
  { name: 'per-month', pattern: /\/\s?(?:mo|month)\b|\bper\s+month\b|\bmonthly\b/i },
  // Bare "members"/"members only" is an access gate (PRIVATE), not a price.
  // A membership product word needs a paid/tier qualifier or fee noun; bare
  // "membership" can describe a free community.
  { name: 'membership', pattern: /\b(?:vip|paid|premium|exclusive|monthly|annual)\s+memberships?\b|\bmemberships?\s+(?:fee|price|cost|plan|tier)\b/i },
  { name: 'subscription', pattern: /\b(?:vip|paid|premium|monthly|annual)\s+subscri(?:be|ber|ption)\b|\bsubscri(?:be|ber|ption)\s+(?:fee|price|cost|plan|tier)\b/i },
  { name: 'premium', pattern: /\bpremium\s+(?:access|membership|community|content|plan|tier)\b/i },
  { name: 'paid-access', pattern: /\bpaywall\b|\bpaid\s+(?:access|membership|community|plan|tier)\b/i },
];

/** Explicit access-gate wording: PRIVATE is claimed only on direct gates. */
export const PRIVATE_SIGNAL_DETECTORS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'members-only', pattern: /\bmembers?\s*only\b|\bonly\s+members\b|\binner\s+circle\b/i },
  { name: 'login-required', pattern: /\b(?:sign|log)[\s-]?in\s+to\s+(?:continue|view|access|see)\b|\brequest\s+access\b|\bapply\s+to\s+join\b/i },
];

export function detectPaidSignals(text: string | null | undefined): string[] {
  const haystack = String(text || '');
  if (!haystack) return [];
  return PAID_SIGNAL_DETECTORS.filter(entry => entry.pattern.test(haystack)).map(entry => entry.name);
}

export function detectPrivateSignals(text: string | null | undefined): string[] {
  const haystack = String(text || '');
  if (!haystack) return [];
  return PRIVATE_SIGNAL_DETECTORS.filter(entry => entry.pattern.test(haystack)).map(entry => entry.name);
}

/** `isAccessibleForFree:false` structured data is an explicit paid marker. */
function hasPaidStructuredData(html: string): boolean {
  return /["']isAccessibleForFree["']\s*:\s*false/i.test(html);
}

export function classifyCommunityIntent(signals: { paid: string[]; private: string[] }): CommunityIntentKind {
  if (signals.paid.length) return 'PAID';
  if (signals.private.length) return 'PRIVATE';
  return 'UNKNOWN';
}

const INTENT_RANK: Record<CommunityIntentKind, number> = { PAID: 3, PRIVATE: 2, PUBLIC: 1, UNKNOWN: 0 };

export function strongerCommunityIntent(a: CommunityIntentKind, b: CommunityIntentKind): CommunityIntentKind {
  return INTENT_RANK[a] >= INTENT_RANK[b] ? a : b;
}

export interface CommunityIntentScanInput {
  /** Page that was actually inspected (source of page-level evidence). */
  pageUrl: string;
  html?: string;
  observedAt?: string;
  /** The crawler confirmed a paywall for this page: the surface is paid even
   * when the static prefix carries no price markers. */
  confirmedPaywall?: boolean;
}

/** Text a visitor can actually see. Script/style/comment bodies are not page
 * copy and must never contribute paid/private signals (a membership SDK in a
 * <script> is not a paywall). Structured-data detection still reads raw HTML
 * separately. */
function visiblePageText(html: string): string {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Anchor scan (href + visible text) without pulling a full DOM parser: the
 * crawler already parses anchors separately; this module stays standalone.
 * Attribute parsing requires whitespace/start before `href`, so `data-href`
 * is not mistaken for a link, and supports quoted or unquoted values. */
function pageAnchors(html: string): Array<{ href: string; text: string }> {
  const anchors: Array<{ href: string; text: string }> = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const hrefMatch = match[1].match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '';
    if (!href) continue;
    const text = match[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    anchors.push({ href, text });
  }
  return anchors;
}

/**
 * Extracts platform-community evidence from one inspected page:
 * - the page itself when its URL is a platform community surface (page-level
 *   signals: price/membership wording, structured data, confirmed paywall);
 * - every anchor whose destination is a platform surface (anchor-text signals;
 *   a raw URL in the href alone never implies PAID).
 * Returns deduplicated evidence, strongest intent per community URL.
 */
export function extractCommunityIntentEvidence(input: CommunityIntentScanInput): CommunityIntentEvidence[] {
  const html = String(input.html || '');
  const pageText = visiblePageText(html);
  const observedAt = input.observedAt || new Date().toISOString();
  const found = new Map<string, CommunityIntentEvidence>();

  const consider = (url: string, contextText: string, pageLevel: boolean) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    const platform = communityPlatformForHost(parsed.hostname);
    if (!platform) return;
    parsed.hash = '';
    const communityUrl = parsed.toString();
    const paid = pageLevel ? detectPaidSignals(pageText) : detectPaidSignals(contextText);
    if (pageLevel && hasPaidStructuredData(html) && !paid.includes('structured-data-paid')) paid.push('structured-data-paid');
    if (pageLevel && input.confirmedPaywall && !paid.includes('paywall')) paid.push('paywall');
    const privateSignals = pageLevel ? detectPrivateSignals(pageText) : detectPrivateSignals(contextText);
    const intent = classifyCommunityIntent({ paid, private: privateSignals });
    const evidence: CommunityIntentEvidence = {
      communityPlatform: platform,
      communityUrl,
      intent,
      paidSignals: [...paid],
      privateSignals: [...privateSignals],
      observedAt,
      sourcePageUrl: input.pageUrl,
      extractionConfidence: 'EXPLICIT',
    };
    const existing = found.get(communityUrl);
    if (!existing) { found.set(communityUrl, evidence); return; }
    found.set(communityUrl, {
      ...existing,
      intent: strongerCommunityIntent(existing.intent, evidence.intent),
      paidSignals: [...new Set([...existing.paidSignals, ...evidence.paidSignals])],
      privateSignals: [...new Set([...existing.privateSignals, ...evidence.privateSignals])],
      observedAt: evidence.observedAt >= existing.observedAt ? evidence.observedAt : existing.observedAt,
    });
  };

  consider(input.pageUrl, '', true);
  for (const anchor of pageAnchors(html)) {
    let absolute: string;
    try { absolute = new URL(anchor.href, input.pageUrl).toString(); } catch { continue; }
    consider(absolute, anchor.text, false);
  }
  return [...found.values()];
}

/** Status projection: PAID wins when any observed surface proved paid access;
 * any other observed platform surface still yields COMMUNITY_INDICATED_NO_INVITE
 * (never "no community"). Empty evidence is NONE. */
export function resolveCommunityDiscoveryStatus(intents: Array<Pick<CommunityIntentEvidence, 'intent'>> | null | undefined): CommunityDiscoveryStatus {
  const list = intents || [];
  if (!list.length) return 'NONE';
  return list.some(item => item.intent === 'PAID') ? 'PAID_COMMUNITY_INDICATED' : 'COMMUNITY_INDICATED_NO_INVITE';
}

/** Merge evidence across inspections: one record per community URL, strongest
 * intent and union of signals, newest observation wins, capped newest-first. */
export function mergeCommunityIntentEvidence(
  existing: CommunityIntentEvidence[] | null | undefined,
  incoming: CommunityIntentEvidence[] | null | undefined,
  max = 10,
): CommunityIntentEvidence[] {
  const byUrl = new Map<string, CommunityIntentEvidence>();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    if (!item || typeof item.communityUrl !== 'string' || !item.communityUrl) continue;
    const prior = byUrl.get(item.communityUrl);
    if (!prior) { byUrl.set(item.communityUrl, { ...item, paidSignals: [...new Set(item.paidSignals || [])], privateSignals: [...new Set(item.privateSignals || [])] }); continue; }
    const newest = (item.observedAt || '') >= (prior.observedAt || '') ? item : prior;
    byUrl.set(item.communityUrl, {
      ...newest,
      intent: strongerCommunityIntent(prior.intent, item.intent),
      paidSignals: [...new Set([...(prior.paidSignals || []), ...(item.paidSignals || [])])],
      privateSignals: [...new Set([...(prior.privateSignals || []), ...(item.privateSignals || [])])],
    });
  }
  const sorted = [...byUrl.values()]
    .sort((a, b) => (b.observedAt || '').localeCompare(a.observedAt || ''));
  const capped = sorted.slice(0, Math.max(1, max));
  // Recency must not evict the strongest paid evidence: a paid surface older
  // than the cap still proves the creator runs a paid community. Replace the
  // oldest retained slot with the newest paid record when none survived.
  if (capped.length && !capped.some(item => item.intent === 'PAID')) {
    const paid = sorted.find(item => item.intent === 'PAID');
    if (paid) capped[capped.length - 1] = paid;
  }
  return capped;
}

/**
 * Apply observed platform-community intent to a channel. This is deliberately
 * disjoint from the Discord projection: it writes only the community state and
 * never reads or writes discord_status / discord_discovery_status /
 * discord_invite, so a retained invite and an additional intent coexist.
 */
export function applyCommunityIntentEvidence(
  channel: {
    community_intents?: CommunityIntentEvidence[] | null;
    community_discovery_status?: CommunityDiscoveryStatus | null;
  },
  incoming: CommunityIntentEvidence[] | null | undefined,
): boolean {
  if (!incoming?.length) return false;
  channel.community_intents = mergeCommunityIntentEvidence(channel.community_intents, incoming);
  channel.community_discovery_status = resolveCommunityDiscoveryStatus(channel.community_intents);
  return true;
}
