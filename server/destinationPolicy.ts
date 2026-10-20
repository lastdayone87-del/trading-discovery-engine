import { assessCrawlAdmission, isKnownBrokerOrExchangeHost } from './communitySurfacePolicy';

/**
 * Evidence-driven navigation destination policy.
 *
 * The legacy cross-domain rule was a hard host allowlist: an unknown creator
 * domain carrying an explicit "Join our Discord" / "community" link was
 * dropped before it could be fetched, and any same-origin URL without a
 * community keyword in its URL/anchor text was dropped as `score-zero`. Both
 * are proven false-negative sources.
 *
 * This policy keeps the shared crawl admission boundary (scheme/host/resource
 * checks still run) but decides pursuit from page evidence instead of domain
 * familiarity. Unknown cross-origin destinations need strong community
 * evidence, a known community/shortener host, or a structured nomination.
 * Weak generic labels alone ("about", "contact", "resources") never open a new
 * host, preserving protection against crawling arbitrary outbound links.
 */

const LINK_HUB_HOSTS = [
  'linktr.ee',
  'beacons.ai',
  'bio.link',
  'solo.to',
  'campsite.bio',
  'lnk.bio',
];

const COMMUNITY_PLATFORM_HOSTS = [
  'skool.com',
  'whop.com',
  'circle.so',
  'patreon.com',
  'discord.gg',
  'discord.com',
  'discordapp.com',
  'discord.app',
  'dsc.gg',
  'discord.me',
  'discord.io',
  'disboard.org',
];

/**
 * Strong evidence that a destination is a community/invite surface. These
 * terms justify opening an unknown cross-origin host. Paid/access terms are
 * strong only together with a community/platform context so a generic
 * "apply now" or "premium plan" link cannot open an arbitrary new host.
 */
export const STRONG_COMMUNITY_EVIDENCE = /(?:discord|community|join|invite|member|membership|vip|group|private|trading[-_ ]?(?:room|floor)|chat|club|signal|academy|mastermind|mentor|whop|skool|circle|patreon)/i;
export const STRONG_PAID_COMMUNITY_EVIDENCE = /(?:premium|paid|subscribe|subscription|access|apply|waitlist|members?[-_ ]?area)/i;
/** Generic creator-site navigation. Eligible same-origin, never enough to
 * justify opening an unknown cross-origin host by itself. */
export const WEAK_COMMUNITY_EVIDENCE = /(?:links?|social|contact|about|resources|support)/i;
const AFFILIATE_HINT = /(?:\/|[?&_-])(?:ref(?:erral)?|affiliate|partner|parrainage|cpa|campaign|promo|coupon)(?:\/|=|[?&_-]|$)/i;

export type DestinationReason =
  | 'same-origin'
  | 'known-community-host'
  | 'structured-nomination'
  | 'community-evidence'
  | 'no-community-evidence'
  | 'admission-rejected';

export interface DestinationDecision {
  eligible: boolean;
  score: number;
  reason: DestinationReason;
}

export function isKnownCommunityDestinationHost(host: string): boolean {
  const lower = String(host || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!lower) return false;
  return [...LINK_HUB_HOSTS, ...COMMUNITY_PLATFORM_HOSTS].some(entry => {
    const bare = entry.replace(/^www\./, '');
    return lower === bare || lower.endsWith(`.${bare}`);
  });
}

function hasStrongCommunityEvidence(text: string): boolean {
  if (STRONG_COMMUNITY_EVIDENCE.test(text)) return true;
  return STRONG_PAID_COMMUNITY_EVIDENCE.test(text)
    && /(?:discord|community|members?|platform|whop|skool|circle|patreon|server)/i.test(text);
}

/**
 * Decide whether a discovered destination is worth fetching.
 *
 * `currentUrl` identifies the page that nominated the destination. When it is
 * omitted the destination is treated as cross-origin for pure-policy callers;
 * production call sites pass the real current page.
 */
export function shouldFollowDestination(input: {
  url: string;
  currentUrl?: string;
  anchorText?: string;
  baseScore?: number;
  structuredNominated?: boolean;
}): DestinationDecision {
  const admission = assessCrawlAdmission(input.url);
  if (!admission.eligible) {
    return { eligible: false, score: 0, reason: 'admission-rejected' };
  }

  let host = '';
  try {
    host = new URL(input.url).hostname.toLowerCase();
  } catch {
    return { eligible: false, score: 0, reason: 'admission-rejected' };
  }

  let sameOrigin = false;
  if (input.currentUrl) {
    try {
      sameOrigin = new URL(input.currentUrl).origin === new URL(input.url).origin;
    } catch {
      sameOrigin = false;
    }
  }

  const baseScore = Math.max(0, Number(input.baseScore) || 0);
  // Use the destination pathname, never its query string: a tracking parameter
  // such as `?campaign=signal` is not evidence that an unrelated host is a
  // community surface. Anchor text remains the primary user-visible signal.
  let pathname = input.url;
  try { pathname = new URL(input.url).pathname || '/'; } catch { /* admission already validated */ }
  const text = `${pathname} ${input.anchorText || ''}`;
  const knownHost = isKnownCommunityDestinationHost(host);
  const strongEvidence = hasStrongCommunityEvidence(text);
  const weakEvidence = WEAK_COMMUNITY_EVIDENCE.test(text);
  const eligible = sameOrigin
    || Boolean(input.structuredNominated)
    || knownHost
    || strongEvidence;

  if (!eligible) {
    return { eligible: false, score: 0, reason: 'no-community-evidence' };
  }

  let score = baseScore;
  if (knownHost) score += 40;
  if (strongEvidence) score += 20;
  if (weakEvidence && !strongEvidence) score += 5;
  if (isKnownBrokerOrExchangeHost(host)) score -= 20;
  if (AFFILIATE_HINT.test(input.url)) score -= 15;
  // Same-origin pages remain navigable even without hint text: the creator's
  // own site may use an unfamiliar path for its community page. A nonzero
  // floor keeps them from being dropped by the legacy score-zero gate.
  if (sameOrigin && score <= 0) score = 1;

  return {
    eligible: true,
    score,
    reason: sameOrigin
      ? 'same-origin'
      : knownHost
        ? 'known-community-host'
        : input.structuredNominated
          ? 'structured-nomination'
          : 'community-evidence',
  };
}

/** Template used only for navigation diversity, never for dropping pages.
 * Numeric path segments collapse so `page/1`, `page/2`, ... do not crowd a
 * queue with one paginated series. */
export function destinationTemplate(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '').split('/')
      .map(segment => /^\d+$/.test(segment) ? ':n' : segment)
      .join('/') || '/';
    return `${parsed.hostname.toLowerCase()}${path}`;
  } catch {
    return String(url || '');
  }
}

/**
 * Keep the bounded queue but reserve one slot for a different destination
 * template when the selected highest-scoring queue is entirely one repeated
 * family. This preserves the existing 12-item cap and queue-cap telemetry
 * while preventing keyword-heavy pagination from starving a lower-scored
 * legitimate same-site page (e.g. /about with an invite).
 */
export function selectDiverseNavigationQueue<T extends { url: string; score: number }>(
  items: T[],
  cap = 12,
): { selected: T[]; dropped: number; diversitySelected: boolean } {
  const boundedCap = Math.max(0, Math.trunc(cap) || 0);
  const sorted = [...items].sort((a, b) => b.score - a.score);
  if (sorted.length <= boundedCap || boundedCap === 0) {
    return { selected: sorted.slice(0, boundedCap), dropped: Math.max(0, sorted.length - boundedCap), diversitySelected: false };
  }
  const selected = sorted.slice(0, boundedCap);
  const dominant = destinationTemplate(selected[0]?.url || '');
  const allSameTemplate = selected.every(item => destinationTemplate(item.url) === dominant);
  if (!allSameTemplate) {
    return { selected, dropped: sorted.length - boundedCap, diversitySelected: false };
  }
  const diverse = sorted.slice(boundedCap).find(item => destinationTemplate(item.url) !== dominant);
  if (!diverse) {
    return { selected, dropped: sorted.length - boundedCap, diversitySelected: false };
  }
  selected[boundedCap - 1] = diverse;
  selected.sort((a, b) => b.score - a.score);
  return { selected, dropped: sorted.length - boundedCap, diversitySelected: true };
}

/**
 * Per-seed bound on cross-origin destination exploration. The crawler already
 * has global page/depth/time budgets; this adds a host fan-out bound so a page
 * full of partner/affiliate links cannot consume the navigation queue while
 * preserving representative unknown-domain recall. Budget skips are always
 * reported as incomplete coverage by the caller (never a clean absence).
 */
export function createDestinationBudget(input: {
  maxCrossOriginHosts?: number;
  maxPagesPerHost?: number;
  /** Original seed URL. Its origin stays free; once the crawler leaves that
   * origin, every destination host is counted even for same-origin children
   * of the external host. Without it, legacy same-origin behavior is retained. */
  seedUrl?: string;
} = {}): {
  reserve: (url: string, currentUrl: string) => { admitted: boolean; reason: 'same-origin' | 'admitted' | 'host-budget' | 'page-budget' };
} {
  const maxHosts = Math.max(1, Math.trunc(input.maxCrossOriginHosts ?? 3) || 3);
  const maxPages = Math.max(1, Math.trunc(input.maxPagesPerHost ?? 2) || 2);
  const pagesByHost = new Map<string, Set<string>>();
  let seedOrigin: string | null = null;
  if (input.seedUrl) {
    try { seedOrigin = new URL(input.seedUrl).origin; } catch { seedOrigin = null; }
  }
  return {
    reserve(url: string, currentUrl: string) {
      let target: URL;
      let current: URL;
      try {
        target = new URL(url);
        current = new URL(currentUrl);
      } catch {
        return { admitted: false, reason: 'page-budget' as const };
      }
      // Only the original seed origin is exempt. After entering an external
      // host, its own internal links are still bounded by maxPagesPerHost.
      if (seedOrigin ? target.origin === seedOrigin : target.origin === current.origin) {
        return { admitted: true, reason: 'same-origin' as const };
      }
      const key = `${target.origin}${target.pathname}${target.search}`;
      const host = target.hostname.toLowerCase();
      const pages = pagesByHost.get(host) || new Set<string>();
      if (pages.has(key)) return { admitted: true, reason: 'admitted' as const };
      if (pages.size === 0 && pagesByHost.size >= maxHosts) {
        return { admitted: false, reason: 'host-budget' as const };
      }
      if (pages.size >= maxPages) {
        return { admitted: false, reason: 'page-budget' as const };
      }
      pages.add(key);
      pagesByHost.set(host, pages);
      return { admitted: true, reason: 'admitted' as const };
    },
  };
}
