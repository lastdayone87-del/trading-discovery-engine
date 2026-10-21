/**
 * Presentation-only classification of persisted community evidence URLs.
 *
 * Platform hosts (Whop/Skool/Circle/Patreon) mix creator community pages with
 * the platform's own corporate, docs, newsroom, and marketing pages. Those
 * platform-owned pages can carry price/membership wording without describing
 * the creator's own community, so a dashboard badge built only from them is a
 * false positive.
 *
 * This helper mirrors the conservative classifier used by the read-only paid
 * community provenance investigation, so the dashboard and the review data
 * agree on which evidence is creator-specific, with one deliberate
 * refinement: Skool tenant subdomains (for example trading.skool.com) are
 * creator sites in the rest of the pipeline, so only reserved platform
 * subdomain labels are treated as platform-owned there. It reads nothing and
 * writes nothing: persisted `community_discovery_status`/`community_intents`
 * remain authoritative, and callers use this only to decide what to display.
 */

export type CommunityPlatformHost = 'WHOP' | 'SKOOL' | 'CIRCLE' | 'PATREON';

const KNOWN_PLATFORMS: readonly CommunityPlatformHost[] = ['WHOP', 'SKOOL', 'CIRCLE', 'PATREON'];

// Conservative platform-owned path prefixes. Anything else on the platform
// host is treated as creator-specific, so the filter does not assume that
// single-segment creator URLs are platform pages.
const RESERVED_PATHS: Record<CommunityPlatformHost, ReadonlySet<string>> = {
  WHOP: new Set([
    '', 'about', 'academy', 'affiliates', 'api', 'apps', 'blog', 'brand', 'blueprints',
    'browse', 'careers', 'categories', 'collections', 'company', 'contact', 'creators',
    'customers', 'developers', 'discover', 'docs', 'enterprise', 'events', 'explore',
    'features', 'guides', 'help', 'jobs', 'leaderboards', 'legal', 'login', 'marketplace',
    'newsroom', 'partners', 'press', 'pricing', 'privacy', 'resources', 'search', 'security',
    'sell', 'signin', 'signup', 'sitemap', 'status', 'support', 'team', 'terms', 'trust',
  ]),
  SKOOL: new Set([
    '', 'about', 'academy', 'affiliates', 'api', 'blog', 'brand', 'careers', 'communities',
    'community-guidelines', 'company', 'contact', 'creators', 'customers', 'developers',
    'discover', 'download', 'enterprise', 'events', 'features', 'games', 'guidelines',
    'help', 'jobs', 'leaderboard', 'leaderboards', 'legal', 'login', 'newsroom',
    'pricing', 'privacy', 'resources', 'signin', 'signup', 'sitemap', 'status',
    'support', 'terms',
  ]),
  CIRCLE: new Set([
    '', 'about', 'academy', 'api', 'blog', 'brand', 'careers', 'communities', 'community',
    'company', 'contact', 'creators', 'customers', 'demo', 'developers', 'docs', 'events',
    'features', 'help', 'integrations', 'jobs', 'legal', 'login', 'newsroom', 'pricing',
    'privacy', 'resources', 'security', 'signin', 'signup', 'sitemap', 'status', 'support',
    'terms', 'trust',
  ]),
  PATREON: new Set([
    '', 'about', 'api', 'blog', 'brand', 'careers', 'collections', 'community',
    'communities', 'company', 'contact', 'create', 'creators', 'developers', 'discover',
    'explore', 'features', 'help', 'home', 'jobs', 'join', 'legal', 'membership',
    'newsroom', 'paid', 'podcast', 'policy', 'press', 'pricing', 'privacy', 'resources',
    'search', 'signin', 'signup', 'sitemap', 'status', 'support', 'terms', 'trust',
    'video',
  ]),
};

const RESERVED_PLATFORM_SUBDOMAINS = new Set([
  'www', 'help', 'support', 'docs', 'blog', 'careers', 'status', 'api', 'login',
  'signup', 'signin', 'auth', 'billing', 'trust', 'security',
]);

// Whop serves its frontend bundles and translation/API fixtures from the same
// host as creator pages. A URL under one of these segments is platform
// plumbing, never a creator community, even when its body contains prices.
const WHOP_PLATFORM_ASSET_SEGMENTS = new Set([
  '_web', '_next', 'assets', 'static', 'cdn', 'translations',
]);

// A community surface is an HTML page. Known static-file extensions are
// platform assets even when they appear outside an /assets/ directory.
const WHOP_PLATFORM_ASSET_EXTENSIONS = /\.(?:json|js|mjs|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot)$/i;

/** Maps a hostname (with or without `www.`, optionally a tenant subdomain) to
 * its community platform, or null when the host is not a known platform. */
export function platformHostForHostname(hostname: string | null | undefined): CommunityPlatformHost | null {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!host) return null;
  if (host === 'whop.com' || host.endsWith('.whop.com')) return 'WHOP';
  if (host === 'skool.com' || host.endsWith('.skool.com')) return 'SKOOL';
  if (host === 'circle.so' || host.endsWith('.circle.so')) return 'CIRCLE';
  if (host === 'patreon.com' || host.endsWith('.patreon.com')) return 'PATREON';
  return null;
}

/**
 * True when the stored evidence URL is a platform-owned corporate/docs/
 * newsroom/careers page rather than a creator's own community surface.
 *
 * The check is deliberately conservative in the display direction:
 * - only records whose stored platform is a known platform are classified;
 * - a record whose URL host does not match the stored platform is never
 *   classified as platform-owned, and
 * - malformed URLs return false.
 * Callers must therefore keep the badge when this returns false.
 */
export function isPlatformOwnedCommunityUrl(
  platform: string | null | undefined,
  communityUrl: string | null | undefined,
): boolean {
  const storedPlatform = String(platform || '').toUpperCase() as CommunityPlatformHost;
  if (!KNOWN_PLATFORMS.includes(storedPlatform)) return false;
  const url = parseUrl(communityUrl);
  if (!url) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // Inconsistent persisted records (platform and URL host disagree) are never
  // filtered: keeping the badge is the safe presentation outcome.
  if (platformHostForHostname(host) !== storedPlatform) return false;

  const segments = pathSegments(url);
  const first = segments[0] || '';

  if (storedPlatform === 'WHOP') {
    // Whop creator pages are path-based. Every whop.com subdomain in the
    // observed evidence set is a platform property (newsroom/docs/careers/...).
    if (host !== 'whop.com' && host !== 'www.whop.com') return true;
    // Whop's own bundles/translation JSONs can contain price and per-month
    // text. They are platform assets, not paid community surfaces.
    if (segments.some(segment => WHOP_PLATFORM_ASSET_SEGMENTS.has(segment))) return true;
    if (WHOP_PLATFORM_ASSET_EXTENSIONS.test(url.pathname)) return true;
    // Whop also serves creator product/store pages as /discover/<slug> and
    // /marketplace/<slug>. Those are creator-specific even though the parent
    // catalog path is a platform surface; nested catalog pages such as
    // /discover/browse/... remain platform-owned.
    if ((first === 'discover' || first === 'marketplace')
      && segments.length === 2
      && !RESERVED_PATHS.WHOP.has(segments[1])) return false;
    return RESERVED_PATHS.WHOP.has(first);
  }

  if (storedPlatform === 'SKOOL') {
    // Skool creator communities are path-based on skool.com / www.skool.com,
    // but Skool also supports creator tenant subdomains (for example
    // trading.skool.com/<community>) that the rest of the pipeline treats as
    // distinct creator sites. Only explicitly reserved platform subdomains
    // are platform-owned; every other subdomain stays creator-specific so
    // genuine paid evidence still triggers the badge.
    if (host !== 'skool.com' && host !== 'www.skool.com') {
      const sub = host.replace(/^www\./, '').split('.')[0];
      return RESERVED_PLATFORM_SUBDOMAINS.has(sub);
    }
    return RESERVED_PATHS.SKOOL.has(first);
  }

  if (storedPlatform === 'CIRCLE') {
    // Circle tenant communities are usually on a *.circle.so subdomain. The
    // platform's own marketing/docs site is circle.so. A /c/<slug> or
    // /join/<slug> path is community-specific even on a shared host.
    if (first === 'c' && segments.length >= 2) return false;
    if (first === 'join' && segments.length >= 2) return false;
    if (host !== 'circle.so' && host !== 'www.circle.so') {
      const sub = host.replace(/^www\./, '').split('.')[0];
      return RESERVED_PLATFORM_SUBDOMAINS.has(sub);
    }
    return RESERVED_PATHS.CIRCLE.has(first);
  }

  if (storedPlatform === 'PATREON') {
    // Creator pages are patreon.com/<creator>, /c/<creator>, /join/<creator>.
    if (first === 'c' && segments.length >= 2) return false;
    if (first === 'join' && segments.length >= 2) return false;
    if (host !== 'patreon.com' && host !== 'www.patreon.com') return true;
    return RESERVED_PATHS.PATREON.has(first);
  }

  return false;
}

function parseUrl(input: string | null | undefined): URL | null {
  if (!input) return null;
  try {
    return new URL(String(input));
  } catch {
    return null;
  }
}

function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).map(part => {
    // Malformed percent-encoding must not break a dashboard render; the raw
    // segment is still safe to compare against the reserved lists.
    try {
      return decodeURIComponent(part).toLowerCase();
    } catch {
      return part.toLowerCase();
    }
  });
}
