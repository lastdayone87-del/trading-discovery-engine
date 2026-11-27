import { assessCrawlAdmission, isKnownBrokerOrExchangeHost } from './communitySurfacePolicy';
import {
  decodeCommunityHost,
  decodeCommunityPath,
  MULTILINGUAL_HOST_COMMUNITY_EVIDENCE,
  MULTILINGUAL_STRONG_COMMUNITY_EVIDENCE,
  MULTILINGUAL_URL_COMMUNITY_EVIDENCE,
  MULTILINGUAL_WEAK_COMMUNITY_EVIDENCE,
} from './multilingualCommunityLexicon';

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

/** Host identity used for first-party redirect checks. Scheme, port, and a
 * `www.` prefix must not turn an ordinary apex/www or HTTP/HTTPS redirect into
 * a third-party hop. Parent/subdomain matching is deliberately excluded:
 * on multi-tenant hosts such as `alice.substack.com`, treating the shared apex
 * `substack.com` as the creator's own site would let unrelated pages hop. */
function normalizedSiteHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}
export function isSameCreatorSite(first: URL, second: URL): boolean {
  const firstHost = normalizedSiteHost(first);
  const secondHost = normalizedSiteHost(second);
  return Boolean(firstHost && secondHost && firstHost === secondHost);
}

/** Redirect-host policy for a child page already admitted by the seed crawl.
 * While the crawl is still on the creator's own site, the redirect is
 * creator-authored and may hand off to a separate community domain. After the
 * crawl leaves that site, only same-site or evidenced-community targets are
 * allowed, so an external docs/reference page cannot fan out to unknown hosts. */
export function isAllowedChildRedirect(seed: URL, current: URL, target: URL): boolean {
  if (isSameCreatorSite(current, seed)) return true;
  if (isSameCreatorSite(target, seed) || isSameCreatorSite(target, current)) return true;
  // Off the creator's site, a redirect may only reach a known community
  // platform. A generic `/community` path on an unrelated host is not enough:
  // docs/reference pages routinely contain such links.
  return isKnownCommunityDestinationHost(target.hostname);
}

const LINK_HUB_HOSTS = [
  'linktr.ee',
  'beacons.ai',
  'bio.link',
  'solo.to',
  'campsite.bio',
  'lnk.bio',
  'stan.store',
];

/**
 * Discord destinations are terminal invite candidates. Shared with the
 * rendered cross-origin pass so its "never enqueue a Discord page" exclusion
 * cannot drift from the community-platform classification here.
 */
export const DISCORD_DESTINATION_HOSTS = [
  'discord.gg',
  'discord.com',
  'discordapp.com',
  'discord.app',
  'dsc.gg',
  'discord.me',
  'discord.io',
  'disboard.org',
];

const COMMUNITY_PLATFORM_HOSTS = [
  'skool.com',
  'whop.com',
  'circle.so',
  'patreon.com',
  ...DISCORD_DESTINATION_HOSTS,
];

/**
 * Strong evidence that a destination is a community/invite surface. These
 * terms justify opening an unknown cross-origin host. Paid/access terms are
 * strong only together with a community/platform context so a generic
 * "apply now" or "premium plan" link cannot open an arbitrary new host.
 */
export const STRONG_COMMUNITY_EVIDENCE = MULTILINGUAL_STRONG_COMMUNITY_EVIDENCE;
export const STRONG_PAID_COMMUNITY_EVIDENCE = /(?:premium|paid|subscribe|subscription|access|apply|waitlist|members?[-_ ]?area)/i;
/** Generic creator-site navigation. Eligible same-origin, never enough to
 * justify opening an unknown cross-origin host by itself. */
export const WEAK_COMMUNITY_EVIDENCE = MULTILINGUAL_WEAK_COMMUNITY_EVIDENCE;
const AFFILIATE_HINT = /(?:\/|[?&_-])(?:ref(?:erral)?|affiliate|partner|parrainage|cpa|campaign|promo|coupon)(?:\/|=|[?&_-]|$)/i;

export type DestinationReason =
  | 'same-origin'
  | 'known-community-host'
  | 'structured-nomination'
  | 'community-evidence'
  | 'no-community-evidence'
  | 'external-page-hop'
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
  // Paid/access wording becomes qualifying only with a platform/server
  // context. The multilingual strong regex is already the first check, so
  // this fallback must keep the original platform/server terms.
  return STRONG_PAID_COMMUNITY_EVIDENCE.test(text)
    && /(?:platform|server)/i.test(text);
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
  /** Original admitted creator seed. When the current page is already on a
   * third-party host, unknown outbound hosts are not followed: only its own
   * pages, known community/shortener hosts, and terminal Discord links stay
   * eligible. This prevents docs/wiki pages from cascading into unrelated
   * communities. */
  seedUrl?: string;
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
  // Path and anchor separators are normalized so the space-delimited lexicon
  // matches hyphenated/underscored URLs and CTAs (`Trading-Room`). Serialized
  // URLs percent-encode accented terms; decode before matching.
  const pathEvidence = decodeCommunityPath(input.url);
  const hostEvidence = decodeCommunityHost(input.url);
  const text = `${pathEvidence.replace(/[-_/]+/g, ' ')} ${String(input.anchorText || '').replace(/[-_/]+/g, ' ')}`;
  const knownHost = isKnownCommunityDestinationHost(host);
  // Concatenated URL slugs (`/vipintraders`) are legitimate community
  // evidence even when token boundaries prevent an anchor-style match.
  const strongEvidence = hasStrongCommunityEvidence(text)
    || MULTILINGUAL_HOST_COMMUNITY_EVIDENCE.test(hostEvidence)
    || MULTILINGUAL_URL_COMMUNITY_EVIDENCE.test(pathEvidence);
  const weakEvidence = WEAK_COMMUNITY_EVIDENCE.test(text);
  let externalPageHop = false;
  if (input.seedUrl && input.currentUrl && !sameOrigin && !knownHost) {
    try {
      const seed = new URL(input.seedUrl);
      const current = new URL(input.currentUrl);
      const target = new URL(input.url);
      // Apex/www and HTTP/HTTPS redirects are still the creator's site. Treat
      // same-site subdomains as first-party, and allow returns to the creator
      // host from an external reference page. Only a target unrelated to both
      // the seed site and the current site is an external-page hop.
      externalPageHop = !isSameCreatorSite(current, seed)
        && !isSameCreatorSite(target, seed)
        && !isSameCreatorSite(current, target);
    } catch { externalPageHop = false; }
  }
  if (externalPageHop) {
    return { eligible: false, score: 0, reason: 'external-page-hop' };
  }
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
  reserve: (url: string, currentUrl: string) => { admitted: boolean; reason: 'same-origin' | 'admitted' | 'host-budget' | 'page-budget'; release?: () => void };
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
      const result = { admitted: true, reason: 'admitted' as const };
      // Non-enumerable so existing deep-equality contracts stay stable while
      // callers can still release a slot after a post-reservation policy skip
      // (for example the Crawl-delay budget).
      Object.defineProperty(result, 'release', {
        enumerable: false,
        value: () => {
          const currentPages = pagesByHost.get(host);
          if (!currentPages?.delete(key)) return;
          if (currentPages.size === 0) pagesByHost.delete(host);
        },
      });
      return result;
    },
  };
}
