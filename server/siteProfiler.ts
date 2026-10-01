/**
 * Site Profiler (P-A: discovery primitives + site inventory).
 *
 * Produces a deterministic, read-only site profile for one site identity:
 * robots state (RFC 9309 semantics), sitemap inventory, feed inventory,
 * structured-data presence, homepage page-type prior, and a politeness
 * baseline. The profiler never decides acquisition, never crawls beyond
 * its bounded inventory fetches, and never merges identities: canonical
 * declarations are recorded as corroborating hints only (see B1/B4), and
 * structured-data findings are observations, never verdicts (see B-corrections).
 *
 * Bounds below are conservative initial values pending frozen-fixture
 * derivation in implementation planning (TBD-for-planning). They are hard
 * caps, never targets: smaller is always acceptable, larger requires a
 * separately approved experiment.
 */
import * as cheerio from 'cheerio';
import { getAppSetting } from './dbCore';
import { MAX_CRAWL_RESPONSE_CHARS } from './crawlResponseBounds';

export const SITE_PROFILER_POLICY_VERSION = 'site-profiler-v1';
export const SITE_PROFILER_SETTING_KEY = 'site_profiler_enabled';

/** Conservative initial bounds (TBD-for-planning: derive from frozen-fixture
 * size/cost distributions; existing ceilings stay hard upper bounds). */
export const MAX_SITEMAP_INDEX_FILES = 10;
export const MAX_SITEMAP_URLS_ADMITTED = 500;
export const MAX_FEEDS_PER_SITE = 2;
export const MAX_FEED_ENTRIES = 100;
export const MAX_JSONLD_BLOCKS = 20;
/** RFC 9309 section 2.5 requires processing at least 500 KiB of robots.txt. */
export const ROBOTS_MAX_BYTES = 512 * 1024;
export const PROFILER_FETCH_TIMEOUT_MS = 10_000;

export type RobotsFetchState =
  | 'FETCHED'
  | 'UNAVAILABLE_4XX'
  | 'UNREACHABLE'
  | 'RATE_LIMITED';

export interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  /** True when any line could not be parsed; parsing continued regardless. */
  malformed: boolean;
}

export interface RobotsEvaluation {
  /** Null when no policy could be evaluated (unreachable/rate-limited/missing). Unknown is never negative. */
  allowed: boolean | null;
  crawlDelaySeconds: number | null;
  matchedRule: string | null;
}

export interface SitemapInventory {
  kind: 'index' | 'urlset' | 'unknown';
  sourceUrl: string;
  nestedSitemaps: string[];
  urls: Array<{ loc: string; lastmod?: string }>;
  droppedOffHost: number;
  droppedOverCap: number;
  /** True when the source body was cut by the fetch byte budget: the
   * inventory below may be missing entries the file actually contains. */
  bodyTruncated: boolean;
}

export interface FeedInventoryEntry {
  feedUrl: string;
  format: 'rss' | 'atom' | 'json' | 'unknown';
  title?: string;
  selfLink?: string;
  entries: Array<{ url: string; title?: string; published?: string }>;
  truncated: boolean;
  /** True when the source body was cut by the fetch byte budget: fewer
   * entries may be visible than the feed actually carries. ORed into
   * truncated so entry-count checks alone can never claim completeness. */
  bodyTruncated: boolean;
}

export interface HeadDiscovery {
  canonicalHrefs: string[];
  feedLinks: Array<{ href: string; type: string }>;
  robotsMeta: string | null;
  bodyTruncated: boolean;
  jsonLdTypes: string[];
  jsonLdSameAs: string[];
  jsonLdUnparsable: number;
  microdataItems: number;
  rdfaItems: number;
  navSameHostLinks: number;
}

export type PageTypePrior = 'HUB' | 'ARTICLE' | 'LISTING' | 'PROFILE' | 'UNKNOWN';

export interface CanonicalConflict {
  declaredHref: string;
  source: 'link-tag' | 'http-header';
  kind: 'self' | 'upward' | 'cross-host' | 'unresolvable';
  /** Null until compared against observed behavior (frontier/attribution work). Never assumed. */
  agreesWithObserved: boolean | null;
}

export interface FieldProvenance {
  sourceUrl: string;
  fetchedAt: string;
  method: string;
}

export interface SiteProfile {
  siteIdentity: string;
  identityTier: string;
  seedUrl: string;
  robotsFetch: { state: RobotsFetchState; status?: number; fetchedAt: string };
  robotsEvaluation: RobotsEvaluation;
  robotsSitemaps: string[];
  sitemaps: SitemapInventory[];
  /** Advertised sitemap locations never fetched because the fetch budget
   * was exhausted first. Distinct from per-file dropped counts. */
  sitemapLocationsSkipped: number;
  feeds: FeedInventoryEntry[];
  head: HeadDiscovery | null;
  canonicalConflicts: CanonicalConflict[];
  pageType: PageTypePrior;
  politeness: { crawlDelaySeconds: number | null; sameHostDelayHint: boolean };
  provenance: Record<string, FieldProvenance>;
  policyVersion: string;
}

export async function isSiteProfilerEnabled(
  readSetting: (key: string, fallback: string) => Promise<string> = getAppSetting,
): Promise<boolean> {
  return (await readSetting(SITE_PROFILER_SETTING_KEY, 'false')) === 'true';
}

/** Minimal RFC 9309 record parser: user-agent groups with Allow/Disallow
 * plus Sitemap records. Unknown records never break defined-record parsing;
 * unparsable lines set malformed (fetch continues). Case-insensitive keys. */
export function parseRobotsTxt(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let malformed = false;
  let current: RobotsGroup | null = null;
  let currentHasRules = false;
  const flush = () => {
    if (current) groups.push(current);
    current = null;
    currentHasRules = false;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0].trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) {
      malformed = true;
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (currentHasRules) flush();
      if (!current) current = { agents: [], allow: [], disallow: [] };
      current.agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      if (!current) {
        malformed = true;
        continue;
      }
      currentHasRules = true;
      if (value) (key === 'allow' ? current.allow : current.disallow).push(value);
    } else if (key === 'sitemap') {
      if (value) sitemaps.push(value);
    } else if (key === 'crawl-delay') {
      // Voluntary politeness input only (not part of RFC 9309); surfaced
      // separately, never a correctness requirement. Parsed per group below.
      if (current) (current as RobotsGroup & { crawlDelayRaw?: string }).crawlDelayRaw = value;
    } else {
      // Unknown records (including vendor extensions) are ignored without
      // affecting defined-record parsing, per RFC 9309.
    }
  }
  flush();
  return { groups, sitemaps, malformed };
}

/** Longest-match Allow/Disallow evaluation for one user-agent and path.
 * Group selection is most-specific-token-wins (a longer matching product
 * token beats an earlier shorter one); the `*` group applies only when no
 * product token matches. Returns nulls (unknown, never negative) when no
 * group applies. */
export function evaluateRobotsForPath(
  parsed: ParsedRobots,
  userAgent: string,
  path: string,
): RobotsEvaluation {
  const agent = userAgent.toLowerCase();
  let group: RobotsGroup | null = null;
  let bestSpecificity = -1;
  for (const candidate of parsed.groups) {
    for (const token of candidate.agents) {
      if (token === '*') continue;
      if (agent !== token && !agent.startsWith(token)) continue;
      if (token.length > bestSpecificity) {
        bestSpecificity = token.length;
        group = candidate;
      }
    }
  }
  if (!group) group = parsed.groups.find(g => g.agents.includes('*')) || null;
  if (!group) return { allowed: null, crawlDelaySeconds: null, matchedRule: null };
  const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchLen = (pattern: string): number => {
    if (!pattern) return -1;
    // RFC 9309 path matching: `*` spans any sequence, trailing `$` anchors
    // the end; otherwise patterns match from the start. The remainder of a
    // wildcard pattern still constrains the match — `/public/*.html` must
    // not match `/public/secret`.
    let anchored = false;
    let core = pattern;
    if (core.endsWith('$')) {
      anchored = true;
      core = core.slice(0, -1);
    }
    let re: RegExp;
    try {
      re = new RegExp(`^${core.split('*').map(escapeRegExp).join('.*')}${anchored ? '$' : ''}`);
    } catch {
      return -1;
    }
    const hit = re.exec(path);
    if (!hit) return -1;
    return hit[0].length;
  };
  let best = -1;
  let allowed = true;
  let matchedRule: string | null = null;
  for (const rule of group.disallow) {
    const len = matchLen(rule);
    if (len > best) {
      best = len;
      allowed = false;
      matchedRule = `Disallow: ${rule}`;
    }
  }
  for (const rule of group.allow) {
    const len = matchLen(rule);
    if (len > best) {
      best = len;
      allowed = true;
      matchedRule = `Allow: ${rule}`;
    }
  }
  if (best < 0) return { allowed: true, crawlDelaySeconds: crawlDelayOf(group), matchedRule: null };
  return { allowed, crawlDelaySeconds: crawlDelayOf(group), matchedRule };
}

function crawlDelayOf(group: RobotsGroup): number | null {
  const raw = (group as RobotsGroup & { crawlDelayRaw?: string }).crawlDelayRaw;
  if (raw === undefined) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** Parse a sitemap index or urlset. Same-host rule enforced against the
 * sitemap's own host (off-host entries dropped and counted, never followed).
 * Counts capped; truncation recorded, never silent. */
export function parseSitemapXml(xml: string, sourceUrl: string, bodyTruncated = false): SitemapInventory {
  const empty: SitemapInventory = {
    kind: 'unknown', sourceUrl, nestedSitemaps: [], urls: [], droppedOffHost: 0, droppedOverCap: 0,
    bodyTruncated,
  };
  let sourceHost = '';
  try {
    sourceHost = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return empty;
  }
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(xml, { xmlMode: true });
  } catch {
    return empty;
  }
  const sameHost = (raw: string): boolean => {
    try {
      return new URL(raw).hostname.toLowerCase() === sourceHost;
    } catch {
      return false;
    }
  };
  if ($('sitemapindex').length > 0) {
    const nested: string[] = [];
    let droppedOffHost = 0;
    let droppedOverCap = 0;
    $('sitemap > loc').each((_, el) => {
      const loc = $(el).text().trim();
      if (!loc) return;
      if (!sameHost(loc)) {
        droppedOffHost += 1;
        return;
      }
      if (nested.length < MAX_SITEMAP_INDEX_FILES) nested.push(loc);
      else droppedOverCap += 1;
    });
    return { ...empty, kind: 'index', nestedSitemaps: nested, droppedOffHost, droppedOverCap };
  }
  if ($('urlset').length > 0) {
    const urls: Array<{ loc: string; lastmod?: string }> = [];
    let droppedOffHost = 0;
    let droppedOverCap = 0;
    $('url').each((_, el) => {
      const loc = $(el).find('loc').first().text().trim();
      if (!loc) return;
      if (!sameHost(loc)) {
        droppedOffHost += 1;
        return;
      }
      if (urls.length >= MAX_SITEMAP_URLS_ADMITTED) {
        droppedOverCap += 1;
        return;
      }
      const lastmod = $(el).find('lastmod').first().text().trim() || undefined;
      urls.push(lastmod ? { loc, lastmod } : { loc });
    });
    return { ...empty, kind: 'urlset', urls, droppedOffHost, droppedOverCap };
  }
  return empty;
}

/** Parse RSS 2.0 / Atom / JSON Feed payloads into bounded entry lists.
 * Entry content is NOT extracted here: entries are discovery nominations
 * (URLs), and item bodies become evidence only through the normal
 * acquisition → extraction → attribution pipeline with feed provenance. */
export function parseFeedXml(xml: string, feedUrl: string, bodyTruncated = false): FeedInventoryEntry {
  const trimmed = xml.trim();
  if (trimmed.startsWith('{')) return parseJsonFeed(trimmed, bodyTruncated);
  const isAtom = /<\s*feed[\s>]/.test(trimmed);
  const isRss = /<\s*rss[\s>]/.test(trimmed) || /<\s*(rdf:)?RDF[\s>]/.test(trimmed) || /<\s*channel[\s>]/.test(trimmed);
  if (!isAtom && !isRss) return { feedUrl, format: 'unknown', entries: [], truncated: bodyTruncated, bodyTruncated };
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(xml, { xmlMode: true });
  } catch {
    return { feedUrl, format: 'unknown', entries: [], truncated: bodyTruncated, bodyTruncated };
  }
  const entries: Array<{ url: string; title?: string; published?: string }> = [];
  let truncated = false;
  const push = (url: string | undefined, title?: string, published?: string) => {
    if (!url) return;
    if (entries.length >= MAX_FEED_ENTRIES) {
      truncated = true;
      return;
    }
    entries.push({ url, ...(title ? { title } : {}), ...(published ? { published } : {}) });
  };
  if ($('feed').length > 0) {
    const title = $('feed > title').first().text().trim() || undefined;
    const selfLink = $('feed > link[rel="self"]').attr('href') || undefined;
    $('feed > entry').each((_, el) => {
      const alternate = $(el).find('link[rel="alternate"]').attr('href') || $(el).find('link:not([rel])').attr('href');
      push(
        alternate,
        $(el).find('title').first().text().trim() || undefined,
        $(el).find('published').first().text().trim() || $(el).find('updated').first().text().trim() || undefined,
      );
    });
    return { feedUrl, format: 'atom', ...(title ? { title } : {}), ...(selfLink ? { selfLink } : {}), entries, truncated: truncated || bodyTruncated, bodyTruncated };
  }
  if ($('rss, rdf\\:RDF, RDF').length > 0 || $('channel').length > 0) {
    const title = $('channel > title').first().text().trim() || undefined;
    $('item').each((_, el) => {
      const link = $(el).find('link').first().text().trim();
      push(
        link || undefined,
        $(el).find('title').first().text().trim() || undefined,
        $(el).find('pubDate').first().text().trim() || undefined,
      );
    });
    return { feedUrl, format: 'rss', ...(title ? { title } : {}), entries, truncated: truncated || bodyTruncated, bodyTruncated };
  }
  return { feedUrl, format: 'unknown', entries: [], truncated: bodyTruncated, bodyTruncated };
}

function parseJsonFeed(text: string, bodyTruncated = false): FeedInventoryEntry {
  let parsed: { version?: unknown; title?: unknown; home_page_url?: unknown; items?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { feedUrl: '', format: 'unknown', entries: [], truncated: bodyTruncated, bodyTruncated };
  }
  if (typeof parsed.version !== 'string' || !parsed.version.includes('jsonfeed.org')) {
    return { feedUrl: '', format: 'unknown', entries: [], truncated: bodyTruncated, bodyTruncated };
  }
  const entries: Array<{ url: string; title?: string; published?: string }> = [];
  let truncated = false;
  if (Array.isArray(parsed.items)) {
    for (const item of parsed.items) {
      const record = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const url = typeof record.url === 'string' ? record.url : undefined;
      if (!url) continue;
      if (entries.length >= MAX_FEED_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push({
        url,
        ...(typeof record.title === 'string' ? { title: record.title } : {}),
        ...(typeof record.date_published === 'string' ? { published: record.date_published } : {}),
      });
    }
  }
  return {
    feedUrl: '',
    format: 'json',
    ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
    entries,
    truncated: truncated || bodyTruncated,
    bodyTruncated,
  };
}

/** Head-level discovery inventory: canonical declarations (recorded, never
 * resolved here), feed autolinks, robots meta, JSON-LD type presence,
 * microdata/RDFa counts, same-host nav volume. Deterministic over bytes. */
export function extractHeadDiscovery(html: string, pageUrl: string, bodyTruncated = false): HeadDiscovery {
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return {
      canonicalHrefs: [], feedLinks: [], robotsMeta: null, bodyTruncated: false, jsonLdTypes: [],
      jsonLdSameAs: [], jsonLdUnparsable: 0, microdataItems: 0, rdfaItems: 0, navSameHostLinks: 0,
    };
  }
  const canonicalHrefs: string[] = [];
  $('link[rel="canonical"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !canonicalHrefs.includes(href)) canonicalHrefs.push(href);
  });
  const feedLinks: Array<{ href: string; type: string }> = [];
  $('link[rel="alternate"]').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    const href = $(el).attr('href');
    if (!href) return;
    if (type.includes('rss') || type.includes('atom') || type.includes('feed') || type.includes('json')) {
      feedLinks.push({ href, type });
    }
  });
  const robotsMeta = $('meta[name="robots"]').attr('content') || null;
  const jsonLdTypes: string[] = [];
  const jsonLdSameAs: string[] = [];
  let jsonLdUnparsable = 0;
  $('script[type="application/ld+json"]').slice(0, MAX_JSONLD_BLOCKS).each((_, el) => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse($(el).html() || 'null');
    } catch {
      jsonLdUnparsable += 1;
      return;
    }
    collectJsonLdTypes(parsed, jsonLdTypes);
    collectJsonLdSameAs(parsed, pageUrl, jsonLdSameAs);
  });
  const microdataItems = $('[itemscope]').length;
  const rdfaItems = $('[typeof][vocab], [property][typeof]').length;
  let pageHost = '';
  try {
    pageHost = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    pageHost = '';
  }
  let navSameHostLinks = 0;
  $('header a[href], nav a[href], main a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      if (new URL(href, pageUrl).hostname.toLowerCase() === pageHost) navSameHostLinks += 1;
    } catch {
      // Unresolvable hrefs contribute nothing to the inventory.
    }
  });
  return {
    canonicalHrefs, feedLinks, robotsMeta, bodyTruncated, jsonLdTypes, jsonLdSameAs, jsonLdUnparsable,
    microdataItems, rdfaItems, navSameHostLinks,
  };
}

/** Collect sameAs URL inventory from JSON-LD blocks (absolute http(s) only,
 * deduped, capped by block budget upstream). Inventory only: following and
 * scoring happen in the ladder, merging never happens here. */
function collectJsonLdSameAs(node: unknown, pageUrl: string, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdSameAs(item, pageUrl, out);
    return;
  }
  const record = node as Record<string, unknown>;
  const sameAs = record['sameAs'];
  const values = Array.isArray(sameAs) ? sameAs : [sameAs];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    try {
      const absolute = new URL(value, pageUrl);
      if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') continue;
      if (!out.includes(absolute.toString())) out.push(absolute.toString());
    } catch {
      // Unresolvable sameAs values contribute nothing to the inventory.
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === '@context') continue;
    collectJsonLdSameAs(value, pageUrl, out);
  }
}

function collectJsonLdTypes(node: unknown, out: string[]): void {  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdTypes(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  const type = record['@type'];
  const types = Array.isArray(type) ? type : [type];
  for (const entry of types) {
    if (typeof entry === 'string' && !out.includes(entry)) out.push(entry);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === '@type' || key === '@context') continue;
    collectJsonLdTypes(value, out);
  }
}

/** Coarse deterministic page-type prior from inventory signals only.
 * UNKNOWN is the default: priors inform ordering, never verdicts. */
export function classifyPageType(input: {
  jsonLdTypes: string[];
  sitemapUrls: number;
  hasFeed: boolean;
  navSameHostLinks: number;
  pathDepth: number;
}): PageTypePrior {
  const types = new Set(input.jsonLdTypes);
  const has = (...names: string[]) => names.some(name => types.has(name));
  if (has('ProfilePage', 'Person') && input.pathDepth >= 1) return 'PROFILE';
  if (has('NewsArticle', 'BlogPosting', 'Article', 'Blog') && !has('ItemList', 'CollectionPage')) return 'ARTICLE';
  if (has('ItemList', 'CollectionPage', 'SearchResultsPage') || input.sitemapUrls >= 100) return 'LISTING';
  if (has('Organization', 'WebSite') || input.navSameHostLinks >= 10 || input.hasFeed) return 'HUB';
  return 'UNKNOWN';
}

/** Classify a canonical href against the declaring page. Cross-host and
 * unresolvable declarations are recorded, never followed or merged here. */
export function classifyCanonicalHref(declaredHref: string, declaringPageUrl: string): CanonicalConflict['kind'] {
  let declared: URL;
  let declaring: URL;
  try {
    declared = new URL(declaredHref, declaringPageUrl);
    declaring = new URL(declaringPageUrl);
  } catch {
    return 'unresolvable';
  }
  if (declared.hostname.toLowerCase() !== declaring.hostname.toLowerCase()) return 'cross-host';
  if (declared.href === declaring.href) return 'self';
  return 'upward';
}

export interface ProfilerFetch {
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
  finalUrl: string;
}

/** Bounded fetch shared by profiler inventory steps: timeout, byte budget,
 * and redirect following match the repository's static-acquisition
 * conventions. Returns null on transport failure (recorded as unreachable
 * by the caller, never as evidence). */
export async function fetchProfilerUrl(
  url: string,
  fetchImpl: typeof fetch,
  maxChars: number,
  timeoutMs: number = PROFILER_FETCH_TIMEOUT_MS,
): Promise<ProfilerFetch | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: profilerFetchHeaders(),
      redirect: 'follow',
    });
    const contentType = response.headers.get('content-type') || '';
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      return {
        status: response.status,
        contentType,
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        finalUrl: response.url || url,
      };
    }
    const decoder = new TextDecoder();
    let text = '';
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        truncated = true;
        text = text.slice(0, maxChars);
        try {
          await reader.cancel();
        } catch {
          // Best effort; the prefix is already retained.
        }
        break;
      }
    }
    text += decoder.decode();
    return { status: response.status, contentType, text, truncated, finalUrl: response.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Single declared fetch identity: the same user agent is sent on every
 * profiler request and used for robots group evaluation, so the recorded
 * policy decision always describes the requests the profiler makes. */
export const PROFILER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export function profilerFetchHeaders(): Record<string, string> {
  return {
    'User-Agent': PROFILER_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

export type DnsResolver = (hostname: string) => Promise<string[]>;

async function defaultDnsResolve(hostname: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const records = await lookup(hostname, { all: true });
  return records.map(record => record.address);
}

/** True only for globally routable unicast addresses. Everything else —
 * loopback, link-local, private, carrier-grade NAT, documentation,
 * multicast, reserved, unspecified — is non-public. Unparsable input
 * fails closed (false). IPv4-mapped IPv6 is judged by its inner address. */
export function isPublicIpAddress(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const v4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    if (octets.some(octet => octet > 255)) return false;
    const [a, b] = octets;
    if (a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 0) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && octets[2] === 100) return false;
    if (a === 203 && b === 0 && octets[2] === 113) return false;
    if (a >= 224) return false;
    return true;
  }
  if (!lower.includes(':')) return false;
  const bare = lower.split('%')[0];
  if (bare === '::' || bare === '::1') return false;
  if (bare.startsWith('ff')) return false;
  if (bare.startsWith('fc') || bare.startsWith('fd')) return false;
  const first = bare.split(':')[0];
  const firstValue = parseInt(first || '0', 16);
  if (Number.isFinite(firstValue) && firstValue >= 0xfe80 && firstValue <= 0xfebf) return false;
  const mapped = bare.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpAddress(mapped[1]);
  if (!/^[0-9a-f:]+$/.test(bare)) return false;
  return true;
}

/** Whether fetching this URL stays on the public internet. IP literals are
 * judged directly; hostnames resolve (every returned address must be
 * public); resolution failure or unparsable input fails closed. Used for
 * site-advertised discovery URLs (sitemaps, feeds) and redirect landing
 * checks so a compromised site cannot aim server-side fetches at private
 * services. Seed/homepage fetches keep the crawler-wide trust posture. */
export async function isPublicInternetUrl(raw: string, resolve: DnsResolver = defaultDnsResolve): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    return isPublicIpAddress(hostname);
  }
  let addresses: string[];
  try {
    addresses = await resolve(hostname.toLowerCase());
  } catch {
    return false;
  }
  if (!addresses.length) return false;
  return addresses.every(address => isPublicIpAddress(address));
}

export interface ProfilerInput {
  siteIdentity: string;
  identityTier: string;
  seedUrl: string;
}

export interface ProfilerDeps {
  fetchImpl: typeof fetch;
  now?: () => string;
  /** Hostname-to-address resolver for the SSRF destination guard. Defaults
   * to system DNS; tests inject fixed answers (never real lookups). */
  resolveHost?: DnsResolver;
}

function provenanceFor(sourceUrl: string, fetchedAt: string, method: string): FieldProvenance {
  return { sourceUrl, fetchedAt, method };
}

/** Run a deterministic site-profile inventory. Returns null (and fetches
 * nothing) when the profiler flag is off. All fetches are bounded and every
 * finding carries source URL + timestamp + method. Redirects, sitemap
 * entries, and feed items are inventoried as discovery nominations only —
 * this function crawls no further than its bounded inventory list. */
export async function runSiteProfiler(
  input: ProfilerInput,
  deps: ProfilerDeps,
  isEnabled: () => Promise<boolean> = isSiteProfilerEnabled,
): Promise<{ status: 'DISABLED' | 'PROFILED'; profile: SiteProfile | null }> {
  if (!(await isEnabled())) return { status: 'DISABLED', profile: null };
  const now = deps.now ?? (() => new Date().toISOString());
  const provenance: Record<string, FieldProvenance> = {};
  const stamp = (field: string, sourceUrl: string, method: string) => {
    provenance[field] = provenanceFor(sourceUrl, now(), method);
  };

  let origin = '';
  try {
    origin = new URL(input.seedUrl).origin;
  } catch {
    origin = '';
  }
  const robotsUrl = origin ? `${origin}/robots.txt` : '';

  let robotsFetch: SiteProfile['robotsFetch'] = { state: 'UNREACHABLE', fetchedAt: now() };
  let parsedRobots: ParsedRobots = { groups: [], sitemaps: [], malformed: false };
  let robotsEvaluation: RobotsEvaluation = { allowed: null, crawlDelaySeconds: null, matchedRule: null };
  if (robotsUrl) {
    const fetched = await fetchProfilerUrl(robotsUrl, deps.fetchImpl, ROBOTS_MAX_BYTES);
    stamp('robots', robotsUrl, 'profiler:robots-fetch');
    if (!fetched) {
      robotsFetch = { state: 'UNREACHABLE', fetchedAt: now() };
    } else if (fetched.status === 429) {
      robotsFetch = { state: 'RATE_LIMITED', status: fetched.status, fetchedAt: now() };
    } else if (fetched.status >= 500) {
      robotsFetch = { state: 'UNREACHABLE', status: fetched.status, fetchedAt: now() };
    } else if (fetched.status >= 400) {
      // RFC 9309: 4xx means the policy file is unavailable — fetching is
      // permitted, but the absence of policy is recorded as its own state,
      // never as an explicit allow.
      robotsFetch = { state: 'UNAVAILABLE_4XX', status: fetched.status, fetchedAt: now() };
    } else {
      robotsFetch = { state: 'FETCHED', status: fetched.status, fetchedAt: now() };
      parsedRobots = parseRobotsTxt(fetched.text);
      try {
        robotsEvaluation = evaluateRobotsForPath(parsedRobots, PROFILER_USER_AGENT, new URL(input.seedUrl).pathname || '/');
      } catch {
        robotsEvaluation = { allowed: null, crawlDelaySeconds: null, matchedRule: null };
      }
    }
  }

  const allowUrl = (url: string): Promise<boolean> => isPublicInternetUrl(url, deps.resolveHost);
  const allowFetched = async (finalUrl: string): Promise<boolean> => {
    // Redirects can land anywhere regardless of where they started: a
    // private landing discards the body, never enters the inventory.
    if (!finalUrl) return true;
    return isPublicInternetUrl(finalUrl, deps.resolveHost);
  };

  // Robots-gated inventory: a disallowed seed path, a rate limit, or an
  // unreachable policy file stops further fetching. The policy outcome so
  // far is still recorded — the profiler reports what it learned, then
  // yields instead of requesting against the signal.
  const robotsBlocksFurther = robotsFetch.state === 'RATE_LIMITED' || robotsFetch.state === 'UNREACHABLE';
  const seedDisallowed = robotsFetch.state === 'FETCHED' && robotsEvaluation.allowed === false;

  let head: HeadDiscovery | null = null;
  let canonicalConflicts: CanonicalConflict[] = [];
  const sitemaps: SitemapInventory[] = [];
  let sitemapLocationsSkipped = 0;
  const feeds: FeedInventoryEntry[] = [];
  if (!robotsBlocksFurther && !seedDisallowed) {
    const homeFetched = await fetchProfilerUrl(input.seedUrl, deps.fetchImpl, MAX_CRAWL_RESPONSE_CHARS);
    stamp('homepage', input.seedUrl, 'profiler:homepage-fetch');
    if (homeFetched && homeFetched.status >= 200 && homeFetched.status < 300 && await allowFetched(homeFetched.finalUrl)) {
      head = extractHeadDiscovery(homeFetched.text, homeFetched.finalUrl, homeFetched.truncated);
      for (const href of head.canonicalHrefs) {
        canonicalConflicts.push({
          declaredHref: href,
          source: 'link-tag',
          kind: classifyCanonicalHref(href, homeFetched.finalUrl),
          agreesWithObserved: null,
        });
      }
    }
  }

  // Sitemap expansion as a bounded worklist: robots-advertised locations
  // first, then the conventional location, then discovered index children.
  // Total fetches capped; locations never reached count as skipped (never
  // silently absent); off-host entries dropped with counts, never followed.
  // Every location passes the destination guard; private landings discard.
  const pendingSitemaps: string[] = [];
  for (const location of parsedRobots.sitemaps) {
    if (!pendingSitemaps.includes(location)) pendingSitemaps.push(location);
  }
  if (origin && !pendingSitemaps.includes(`${origin}/sitemap.xml`)) pendingSitemaps.push(`${origin}/sitemap.xml`);
  const MAX_SITEMAP_FETCHES = MAX_SITEMAP_INDEX_FILES + 1;
  let sitemapFetches = 0;
  if (!robotsBlocksFurther && !seedDisallowed) {
    while (pendingSitemaps.length > 0 && sitemapFetches < MAX_SITEMAP_FETCHES) {
      const location = pendingSitemaps.shift()!;
      if (!(await allowUrl(location))) continue;
      sitemapFetches += 1;
      const fetched = await fetchProfilerUrl(location, deps.fetchImpl, MAX_CRAWL_RESPONSE_CHARS);
      stamp(`sitemap:${location}`, location, 'profiler:sitemap-fetch');
      if (!fetched || fetched.status < 200 || fetched.status >= 300) continue;
      if (!(await allowFetched(fetched.finalUrl))) continue;
      const parsed = parseSitemapXml(fetched.text, location, fetched.truncated);
      if (parsed.kind === 'unknown') continue;
      sitemaps.push(parsed);
      for (const nested of parsed.nestedSitemaps) {
        if (!pendingSitemaps.includes(nested) && !sitemaps.some(entry => entry.sourceUrl === nested)) pendingSitemaps.push(nested);
      }
    }
    sitemapLocationsSkipped = pendingSitemaps.length;
  } else {
    sitemapLocationsSkipped = pendingSitemaps.length;
  }

  // Feed inventory, bounded: autolinked feeds first (first = main feed),
  // then conventional locations. Entry bodies are never extracted here.
  // Same destination guard and truncation accounting as sitemaps.
  const feedCandidates: string[] = [];
  for (const link of head?.feedLinks || []) {
    try {
      const absolute = new URL(link.href, input.seedUrl).toString();
      if (!feedCandidates.includes(absolute)) feedCandidates.push(absolute);
    } catch {
      // Unresolvable autolinks contribute nothing to the inventory.
    }
  }
  if (origin) {
    for (const conventional of [`${origin}/feed`, `${origin}/rss.xml`, `${origin}/atom.xml`]) {
      if (!feedCandidates.includes(conventional)) feedCandidates.push(conventional);
    }
  }
  if (!robotsBlocksFurther && !seedDisallowed) {
    for (const location of feedCandidates) {
      if (feeds.length >= MAX_FEEDS_PER_SITE) break;
      if (!(await allowUrl(location))) continue;
      const fetched = await fetchProfilerUrl(location, deps.fetchImpl, MAX_CRAWL_RESPONSE_CHARS);
      stamp(`feed:${location}`, location, 'profiler:feed-fetch');
      if (!fetched || fetched.status < 200 || fetched.status >= 300) continue;
      if (!(await allowFetched(fetched.finalUrl))) continue;
      const parsed = parseFeedXml(fetched.text, location, fetched.truncated);
      if (parsed.format === 'unknown') continue;
      feeds.push({ ...parsed, feedUrl: location });
    }
  }

  const sitemapUrls = sitemaps.reduce((count, entry) => count + entry.urls.length, 0);
  let pathDepth = 0;
  try {
    pathDepth = new URL(input.seedUrl).pathname.split('/').filter(Boolean).length;
  } catch {
    pathDepth = 0;
  }
  const pageType = classifyPageType({
    jsonLdTypes: head?.jsonLdTypes || [],
    sitemapUrls,
    hasFeed: feeds.length > 0,
    navSameHostLinks: head?.navSameHostLinks || 0,
    pathDepth,
  });

  return {
    status: 'PROFILED',
    profile: {
      siteIdentity: input.siteIdentity,
      identityTier: input.identityTier,
      seedUrl: input.seedUrl,
      robotsFetch,
      robotsEvaluation,
      robotsSitemaps: parsedRobots.sitemaps,
      sitemaps,
      sitemapLocationsSkipped,
      feeds,
      head,
      canonicalConflicts,
      pageType,
      politeness: {
        crawlDelaySeconds: robotsEvaluation.crawlDelaySeconds,
        sameHostDelayHint: robotsEvaluation.crawlDelaySeconds !== null,
      },
      provenance,
      policyVersion: SITE_PROFILER_POLICY_VERSION,
    },
  };
}
