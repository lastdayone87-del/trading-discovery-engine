export interface CommunitySurfaceCandidate {
  url: string;
  contextMatches: boolean;
  source: string;
}

export interface AcquisitionObservationLike {
  requestedUrl: string;
  surface: string;
  outcome: 'FOUND' | 'INSPECTED_NO_MATCH' | 'PARTIALLY_INSPECTED' | 'ACQUISITION_FAILED';
  observedAt?: string;
}

const LINK_HUB_HOSTS = new Set([
  'linktr.ee',
  'www.linktr.ee',
  'beacons.ai',
  'www.beacons.ai',
  'bio.link',
  'www.bio.link',
  'solo.to',
  'www.solo.to',
  'campsite.bio',
  'www.campsite.bio',
  'lnk.bio',
  'www.lnk.bio',
]);

const COMMUNITY_PLATFORM_HOSTS = new Set([
  'skool.com',
  'www.skool.com',
  'whop.com',
  'www.whop.com',
  'circle.so',
  'www.circle.so',
  'patreon.com',
  'www.patreon.com',
]);

const BROKER_EXACT_HOSTS = new Set([
  'refer.ig.com',
]);

// Broker/exchange identity is matched per hostname label, never by substring:
// `notbinance.com` (label `notbinance`) must NOT match `binance.com`.
const BROKER_HOST_LABELS = new Set([
  'binance',
  'degiro',
  'coinbase',
  'kraken',
  'bybit',
  'etoro',
  'fortuneo',
]);

export const MESSAGING_PREVIEW_HOSTS = new Set([
  't.me',
  'www.t.me',
  'telegram.me',
  'www.telegram.me',
  'telegram.dog',
  'www.telegram.dog',
  'wa.me',
  'www.wa.me',
  'whatsapp.com',
  'www.whatsapp.com',
  'chat.whatsapp.com',
]);

const COMMUNITY_HINT = /(?:discord|community|join|members?|membership|group|private|vip|trading[-_ ]?(?:room|floor)|chat|links?)/i;
const AFFILIATE_HINT = /(?:\/|[?&_-])(?:ref(?:erral)?|affiliate|partner|parrainage|cpa|campaign|promo|coupon)(?:\/|=|[?&_-]|$)/i;

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Scores a discovered external surface by how likely it is to lead to the
 * creator's own community. This only changes crawl order; it never rejects a
 * lower-scoring URL.
 */
export function scoreCommunitySurface(candidate: CommunitySurfaceCandidate): number {
  const url = candidate.url.toLowerCase();
  const host = hostOf(candidate.url);
  let score = 0;

  if (candidate.contextMatches) score += 120;

  if (candidate.source === 'CHANNEL_LINKS') score += 65;
  else if (candidate.source === 'CHANNEL_ABOUT') score += 50;
  else if (candidate.source === 'PINNED_COMMENT') score += 45;
  else if (/^VIDEO_\d+_DESCRIPTION$/.test(candidate.source)) score += 10;

  if (COMMUNITY_HINT.test(url)) score += 70;
  if (LINK_HUB_HOSTS.has(host)) score += 60;
  if (COMMUNITY_PLATFORM_HOSTS.has(host)) score += 55;
  if (/tradingview\.com\/u\//i.test(url)) score += 35;

  // Creator-owned/custom domains are generally more useful than generic
  // campaign destinations. This is deliberately a modest boost because domain
  // ownership is not known with certainty at this stage.
  const isKnownHubOrPlatform = LINK_HUB_HOSTS.has(host) || COMMUNITY_PLATFORM_HOSTS.has(host);
  const isKnownBrokerOrExchange = isKnownBrokerOrExchangeHost(host);
  if (host && !isKnownHubOrPlatform && !isKnownBrokerOrExchange) score += 20;

  if (AFFILIATE_HINT.test(url)) score -= 75;
  if (isKnownBrokerOrExchange) score -= 45;

  return score;
}

export function rankCommunitySurfaces<T extends CommunitySurfaceCandidate>(candidates: T[]): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: scoreCommunitySurface(candidate) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(item => item.candidate);
}

function canonicalObservationKey(item: AcquisitionObservationLike): string {
  let url = item.requestedUrl.trim().toLowerCase();
  try {
    const parsed = new URL(item.requestedUrl);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/$/, '') || '/';
    url = parsed.toString().toLowerCase();
  } catch {
    url = url.replace(/\/$/, '');
  }
  // One canonical key per surface+URL (required-agnostic): collapsing happens
  // in effectiveAcquisitionOutcomes with required-dominance, so a required
  // rendered result and a non-required static note for the same URL always
  // resolve to a single effective outcome instead of coexisting.
  return `${item.surface}\u0000${url}`;
}

const OUTCOME_PRECEDENCE: Record<AcquisitionObservationLike['outcome'], number> = {
  ACQUISITION_FAILED: 0,
  PARTIALLY_INSPECTED: 1,
  INSPECTED_NO_MATCH: 2,
  FOUND: 3,
};
/**
 * Collapses multiple acquisition attempts for the same surface+URL into the
 * single correct effective outcome. A successful rendered inspection therefore
 * supersedes an earlier static acquisition failure without deleting the raw
 * audit observations.
 *
 * Selection within a group, in order:
 * 0. Shared terminal-success evidence shortcut: a terminal-success shared
 *    row (`sharedEvidenceFrom`) defeats vacuous-only failures outright —
 *    rows with zero processed evidence of any kind, which proved nothing and
 *    therefore cannot erase genuine inspection. Runs before rules 2-4; any
 *    FOUND row or any row with real processed evidence still dominates
 *    normally, so genuine failures are never hidden.
 * 1. Any FOUND wins — a discovered candidate must never be lost to collapse.
 * 2. Required (retry-eligible, operational) observations dominate auxiliary
 *    notes: a required rendered failure overrides an earlier non-required
 *    static clean, and a required rendered success supersedes an earlier
 *    non-required static failure/partial — regardless of observation order.
 * 3. An unevidenced clean never beats a real signal: an INSPECTED_NO_MATCH
 *    carrying explicit zero-evidence telemetry loses to a failure/partial (or
 *    an evidenced clean) in the same pool. Observations predating telemetry
 *    count as evidenced (absence of a signal is not a signal of absence).
 * 4. Otherwise the best outcome wins, ties broken by latest observation.
 */
export function effectiveAcquisitionOutcomes<T extends AcquisitionObservationLike>(observations: T[]): T[] {
  const groups = new Map<string, Array<{ item: T; index: number }>>();
  observations.forEach((item, index) => {
    const key = canonicalObservationKey(item);
    const group = groups.get(key);
    if (group) group.push({ item, index });
    else groups.set(key, [{ item, index }]);
  });

  const hasProcessedEvidence = (entry: { item: T }): boolean => {
    const telemetry = (
      entry.item as {
        telemetry?: { pagesInspected?: unknown; requestsStarted?: unknown; redirectsFollowed?: unknown };
      }
    ).telemetry;
    if (!telemetry) return true;
    return (
      (Number(telemetry.pagesInspected) || 0) > 0 ||
      (Number(telemetry.requestsStarted) || 0) > 0 ||
      (Number(telemetry.redirectsFollowed) || 0) > 0
    );
  };

  const pick = (entries: Array<{ item: T; index: number }>): { item: T; index: number } => {
    const found = entries.filter((entry) => entry.item.outcome === 'FOUND');
    const pool = found.length > 0 ? found : entries;
    // Shared-evidence authority (v2): a terminal-success shared row for this
    // URL defeats vacuous failures outright — rows with zero processed
    // evidence of any kind, which proved nothing and therefore cannot erase
    // genuine inspection. Evidenced signals (FOUND, or any row with real
    // processed evidence) still dominate through the normal path below, so
    // genuine failures are never hidden.
    const sharedClean = pool.find(
      (entry) =>
        entry.item.outcome === 'INSPECTED_NO_MATCH' &&
        typeof (entry.item as { sharedEvidenceFrom?: unknown }).sharedEvidenceFrom === 'string' &&
        (entry.item as { sharedEvidenceFrom?: unknown }).sharedEvidenceFrom !== '',
    );
    if (sharedClean && !pool.some((entry) => entry !== sharedClean && (entry.item.outcome === 'FOUND' || hasProcessedEvidence(entry)))) {
      return sharedClean;
    }
    const required = pool.filter((entry) => (entry.item as { required?: unknown }).required === true);
    const eligible = required.length > 0 ? required : pool;
    const evidenced = eligible.filter(
      (entry) => entry.item.outcome !== 'INSPECTED_NO_MATCH' || hasProcessedEvidence(entry),
    );
    const finalists = evidenced.length > 0 ? evidenced : eligible;
    const winner = finalists.reduce((best, entry) => {
      const precedence = OUTCOME_PRECEDENCE[entry.item.outcome];
      const bestPrecedence = OUTCOME_PRECEDENCE[best.item.outcome];
      return precedence > bestPrecedence || (precedence === bestPrecedence && entry.index > best.index)
        ? entry
        : best;
    });
    // A required fallback failure that processed zero evidence (e.g. gate
    // saturation, zero-page result, unadmitted seed) must not blindly erase
    // statically inspected evidence for the same URL: the static pages were
    // Discord-scanned and remain usable. Collapse to a retryable
    // PARTIALLY_INSPECTED instead — partial, retry-owned, never "unavailable".
    if (
      winner.item.outcome === 'ACQUISITION_FAILED' &&
      (winner.item as { required?: unknown }).required === true &&
      !hasProcessedEvidence(winner)
    ) {
      const evidencedFallback = pool.find(
        (entry) =>
          (entry.item.outcome === 'INSPECTED_NO_MATCH' ||
            entry.item.outcome === 'PARTIALLY_INSPECTED') &&
          hasProcessedEvidence(entry),
      );
      if (evidencedFallback) {
        return {
          item: {
            ...evidencedFallback.item,
            outcome: 'PARTIALLY_INSPECTED',
            required: true,
            retryable: true,
            failureClass:
              (winner.item as { failureClass?: unknown }).failureClass ||
              'RENDERED_FALLBACK_NO_EVIDENCE',
          } as T,
          index: evidencedFallback.index,
        };
      }
    }
    return winner;
  };

  return [...groups.values()]
    .map(pick)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.item);
}

/**
 * Ownership boundary for the Discord inspection lifecycle. Upstream YouTube
 * acquisition observations remain useful audit evidence, but they cannot turn
 * a completed Discord/community negative into an operational Discord failure.
 */
export function isDiscordCommunityAcquisitionSurface(surface: string): boolean {
  return new Set(['CHANNEL_EXTERNAL_LINKS', 'CREATOR_WEBSITES', 'SOCIAL_PROFILES']).has(surface);
}

/**
 * Recall-safe acquisition tiers (PR #434 §7A). These never discard a candidate
 * and never decide eligibility: every discovered URL remains eligible for the
 * normal acquisition path. They only inform attempt ordering (static-first),
 * cheap-evidence triage, and operability labels. Ranking
 * (`rankCommunitySurfaces`) still only reorders.
 */
export function isMessagingPreviewUrl(raw: string): boolean {
  return MESSAGING_PREVIEW_HOSTS.has(hostOf(raw));
}

export function isDotlessHostnameUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    // Bracketed IP literals (notably IPv6, e.g. `[2606:4700:4700::1111]`) are
    // genuine website targets, never single-label garbage: the WHATWG hostname
    // keeps its brackets and any colons, and must not be read as "dotless".
    if (host.startsWith('[')) return false;
    return host.length > 0 && !host.includes('.');
  } catch {
    return false;
  }
}

/**
 * Page-asset infrastructure hosts captured by indiscriminate page scraping
 * (thumbnail/playback/telemetry/schema/font endpoints embedded in channel
 * page data). These can never be creator sites and can never carry Discord
 * invites, so they are filtered at link-collection time and never become
 * crawl seeds. Dotless single-label hosts are NOT filtered here: they are
 * rejected earlier by the crawl admission boundary
 * (`assessCrawlAdmission`, DOTLESS_HOST), which runs before scoring and
 * crawling. Valid creator, affiliate, social, and messaging hosts are
 * unaffected.
 */
const PAGE_ASSET_INFRASTRUCTURE_HOSTS = [
  'ytimg.com',
  'googlevideo.com',
  'googleapis.com',
  'schema.org',
  'w3.org',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'youtubei-att.googleapis.com',
  'gstatic.com',
];
export function isPageAssetInfrastructureUrl(rawUrl: string): boolean {
  // Scheme-less links get the same https fallback as normalizeExternalUrl so
  // valid creator links (e.g. `example.com/community`) are never dropped;
  // only unparseable strings and asset hosts are filtered. A single trailing
  // dot is DNS-equivalent noise and is stripped before comparison.
  const candidates = [rawUrl, /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`];
  for (const candidate of candidates) {
    try {
      const host = new URL(candidate).hostname.toLowerCase().replace(/\.$/, '');
      if (!host) return true;
      if (PAGE_ASSET_INFRASTRUCTURE_HOSTS.some(entry => host === entry || host.endsWith(`.${entry}`))) return true;
      return false;
    } catch {
      continue;
    }
  }
  return true;
}

/**
 * Crawl admission boundary (R6). Generic, deterministic, and pre-scoring:
 * `EXTRACT → NORMALIZE → VALIDATE → ASSET/RESOURCE CHECK → (safe truncation
 * recovery/signal) → SCORE/RANK → CRAWL`.
 *
 * This is the single shared validity boundary for website crawl seeds. Every
 * admission path (`normalizeExternalUrl`, `crawlExternalLinks`, the Step 4/5
 * seed loops, and the retry-eligibility predicate) consults it, so future
 * callers cannot bypass it. It is deliberately NOT a relevance ranker and
 * NOT a domain blacklist/whitelist: dotted hosts of any kind — including
 * unfamiliar, commercial, or affiliate hosts — stay eligible here. Only
 * candidates whose invalidity or resource status is deterministically
 * established from the URL itself are rejected. Scoring (`scoreCommunitySurface`)
 * only orders eligible candidates and never decides admission.
 */
export const CRAWL_ADMISSION_POLICY_VERSION = 'crawl-admission-v1';

export type CrawlAdmissionReasonCode =
  | 'ELIGIBLE'
  | 'INVALID_URL'
  | 'INVALID_SCHEME'
  | 'EMPTY_HOST'
  | 'DOTLESS_HOST'
  | 'EMPTY_LABEL'
  | 'ASSET_HOST'
  | 'RESOURCE_EXTENSION';

export interface CrawlAdmissionDecision {
  eligible: boolean;
  reasonCode: CrawlAdmissionReasonCode;
}

// Page-resource path suffixes that can never be community websites,
// regardless of host. Mirrors the extraction-time asset-extension filter so
// stored links cannot bypass it; document/feed types (pdf/rss/xml) are
// intentionally NOT in this list and stay eligible.
const RESOURCE_PATH_EXTENSION = /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|mp4|webm|mp3|wav|ogg|avi|mov|zip|gz|rar|7z|exe|dmg)(?:$)/i;

export function assessCrawlAdmission(rawUrl: string): CrawlAdmissionDecision {
  // Same scheme handling as `normalizeExternalUrl`: scheme-less input gets
  // the https fallback BEFORE parsing, so `example.com:8080/path` is read as
  // a host:port URL rather than an opaque `example.com:` scheme. A present
  // scheme is honored as-is (dots excluded from scheme detection so dotted
  // host:port pairs are never misread as schemes): explicit non-HTTP schemes
  // (ftp:, mailto:, ...) fail closed below, and admission never disagrees
  // with normalization about the same candidate.
  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z0-9+-]*:/.test(rawUrl);
  const candidate = hasExplicitScheme ? rawUrl : `https://${rawUrl}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { eligible: false, reasonCode: 'INVALID_URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { eligible: false, reasonCode: 'INVALID_SCHEME' };
  }
  const rawHost = parsed.hostname;
  // A single trailing dot is DNS-equivalent noise (same stripping as the
  // asset filter) and must not turn a single-label host into a dotted one.
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  if (!host) return { eligible: false, reasonCode: 'EMPTY_HOST' };
  // Bracketed IP literals (IPv6) are genuine website targets under the
  // existing URL model (same carve-out as `isDotlessHostnameUrl`).
  if (!rawHost.startsWith('[')) {
    // Same dotless semantic as `isDotlessHostnameUrl`: a single-label host
    // has no public domain. No second validation system.
    if (!host.includes('.')) return { eligible: false, reasonCode: 'DOTLESS_HOST' };
    if (host.split('.').some(label => label.length === 0)) {
      return { eligible: false, reasonCode: 'EMPTY_LABEL' };
    }
  }
  if (isPageAssetInfrastructureUrl(parsed.toString())) {
    return { eligible: false, reasonCode: 'ASSET_HOST' };
  }
  if (RESOURCE_PATH_EXTENSION.test(decodeResourcePathname(parsed.pathname))) {
    return { eligible: false, reasonCode: 'RESOURCE_EXTENSION' };
  }
  return { eligible: true, reasonCode: 'ELIGIBLE' };
}

/**
 * Decodes a pathname for resource-extension classification only (never for
 * fetching): percent-encoded dots (`/app%2Ejs`) must not bypass the check.
 * Decodes repeatedly (bounded) so double-encoded suffixes are also caught;
 * malformed sequences throw and fall back to the last decodable form, never
 * out of this function.
 */
function decodeResourcePathname(pathname: string): string {
  let current = pathname;
  for (let i = 0; i < 3; i++) {
    if (!/%[0-9a-fA-F]{2}/.test(current)) break;
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

/**
 * Safe truncation recovery (R6 T-Q): recovers a cut affiliate-style query to
 * the valid host root, but ONLY under the approved high-confidence rule — the
 * query must be a single bare key (no `=value`, length ≥ 4) that is a strict
 * prefix of a longer value-taking key observed for the same host in the
 * current inspection's own candidate corpus (no keyword lists). Returns the
 * recovered root URL, or null when the rule is not satisfied (the candidate
 * stays eligible as-is). Corpus-free callers must not guess: without sibling
 * evidence there is no recovery.
 */
export function recoverTruncatedQueryToRoot(rawUrl: string, siblingValuedKeys: Set<string> | string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  if (!/^\?[A-Za-z0-9_]{4,64}$/.test(parsed.search)) return null;
  const token = parsed.search.slice(1);
  for (const key of siblingValuedKeys) {
    if (key !== token && key.startsWith(token)) return `${parsed.origin}/`;
  }
  return null;
}

/**
 * Possibly-truncated path signal (R6 T-P): detection/logging ONLY, never a
 * rewrite. True when the path (other than `/`) is a strict prefix of a longer
 * sibling path observed for the same host with a mid-token continuation
 * (e.g. `/day-tra` vs `/day-trading-guide`). Short slugs that merely share a
 * prefix at a segment boundary (e.g. `/books` vs `/bookstore`) also match, so
 * callers must keep the candidate eligible as-is and treat this as an
 * extraction-quality signal for the follow-up investigation.
 */
export function isPossiblyTruncatedPath(rawUrl: string, siblingPaths: Set<string> | string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return false;
  }
  const path = parsed.pathname || '/';
  if (path === '/' || path.length < 4 || path.endsWith('/')) return false;
  for (const sibling of siblingPaths) {
    if (sibling !== path && sibling.startsWith(path) && sibling[path.length] !== '/') return true;
  }
  return false;
}

/**
 * Affiliate/commerce meaning carried by a hostname itself, matched per
 * segment (split on '.' and '-'), never by substring: `investing-referral`
 * matches via segment `referral`, while `referralx`, `myreferral`, or
 * `preferrals` do not. Mirrors the label-exact discipline of
 * BROKER_HOST_LABELS. Generic lexemes only — no domain lists.
 */
const AFFILIATE_HOST_SEGMENTS = new Set([
  'referral',
  'referrals',
  'affiliate',
  'affiliates',
  'affiliation',
  'partner',
  'partners',
  'partnership',
  'promo',
  'promos',
  'promotion',
  'promotions',
  'coupon',
  'coupons',
  'cashback',
  'rebate',
  'rebates',
]);

/**
 * Transactional/product-unit path shapes: product-detail, checkout, cart,
 * and storefront buy units on ANY host. Generic path shapes only — no domain
 * lists. A creator funnel page that matches (e.g. a `/product` or `/shop`
 * page) is still crawled and its evidence still retained; only failure
 * ownership is affected (see `isAuxiliaryForOutcome`).
 */
const TRANSACTION_PATH_PATTERN = /(?:\/|^)(?:dp|gp\/product|gp\/aw|exec\/order|ap\/signin|checkout|check-out|cart|basket|stores?|shop|products?|buy(?:-now)?|purchase|order)(?:\/|$|[?#])/i;

/**
 * Affiliate-redirector/commerce platforms with no community function, matched
 * by suffix like the asset list. Each entry is grounded in production crawl
 * evidence; the list is intentionally minimal. Used ONLY for final-outcome
 * failure ownership and status — never admission, ranking, recall, or retry
 * classification of other hosts.
 * - sjv.io: Impact.com affiliate redirector infrastructure (tenant
 *   subdomains redirect to brand domains; production: tracking timeouts on
 *   `*.sjv.io` URLs, zero community function).
 * - amzn.to: Amazon's single-purpose product shortener (production:
 *   amzn.to/* product links; generic shorteners such as bit.ly stay
 *   eligible because their destinations are opaque).
 * - calendly.com: appointment scheduling pages (production: scheduling links,
 *   no community surface).
 * - teespring.com: merchandise storefront (production: `/stores/*` pages).
 * - payhip.com: digital storefront buy links (production: `/b/*` pages).
 * - open.spotify.com: media episodes (production: `/episode/*` podcast audio).
 * - streamyard.com: streaming tool links (production: `/pal/*` pages).
 * - forms.gle: generic form links (no community surface either way).
 */
const AUXILIARY_COMMERCE_SUFFIXES = [
  'sjv.io',
  'amzn.to', // Amazon's single-purpose product shortener (production: amzn.to/* product links; generic shorteners like bit.ly stay eligible as opaque)
  'calendly.com',
  'teespring.com',
  'payhip.com',
  'open.spotify.com',
  'streamyard.com',
  'forms.gle',
];

/**
 * Whether a URL is auxiliary/demoted for FINAL-OUTCOME purposes: its failure
 * must not independently own the channel-level Discord acquisition outcome
 * or retry. This is a failure-ownership boundary only — it never affects
 * admission, scoring/ranking, crawling, candidate recall, or evidence
 * retention: an auxiliary URL that succeeds keeps its evidence and
 * candidates exactly like any other URL.
 *
 * Deterministic and generic: broker/exchange identity (label-exact),
 * affiliate patterns (path/query + host segments), transactional units, and
 * the documented no-community commerce platforms above. Anything else —
 * including unfamiliar custom domains, opaque shorteners, social profiles,
 * link hubs, and community platforms — fails open to community-required,
 * so genuine creator surfaces always keep full outcome ownership.
 */
export function isAuxiliaryForOutcome(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (isKnownBrokerOrExchangeHost(host)) return true;
  if (AFFILIATE_HINT.test(rawUrl)) return true;
  const segments = host
    .split('.')
    .flatMap(label => label.split('-'))
    .filter(Boolean);
  if (segments.some(segment => AFFILIATE_HOST_SEGMENTS.has(segment))) return true;
  if (AUXILIARY_COMMERCE_SUFFIXES.some(entry => host === entry || host.endsWith(`.${entry}`))) return true;
  if (TRANSACTION_PATH_PATTERN.test(`${parsed.pathname}${parsed.search}`)) return true;
  return false;
}

export function isKnownBrokerOrExchangeHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (BROKER_EXACT_HOSTS.has(lower)) return true;
  // Exact hostname or safe subdomain matching on the registrable domain only:
  // `binance.com` and `www.binance.com` match, while `notbinance.com`
  // (distinct label) and `binance.com.evil.com` (different registrable domain)
  // do not. A miss here only fails open toward primary handling, which is the
  // recall-safe direction since this signal is triage-only.
  const labels = lower.split('.');
  return labels.length >= 2 && BROKER_HOST_LABELS.has(labels[labels.length - 2]);
}

/**
 * Auxiliary triage signal (PR #434; triage-only, never a crawl gate).
 * Messaging-preview, dotless, and broker/affiliate-pattern candidates are
 * attempted statically first and demoted in ranking, but classification here
 * never decides eligibility: every candidate remains fully eligible for deeper
 * acquisition under the existing policy. In particular, a legitimate creator
 * URL containing `/referral/` must never become ineligible merely because of
 * the affiliate pattern (in-repo golden `https://broker.test/referral/creator`
 * carries a FOUND candidate, so exclusion would violate Z = 0).
 */
export function isAuxiliaryTriageCandidate(candidate: { url: string }): boolean {
  const host = hostOf(candidate.url);
  if (!host) return true;
  if (MESSAGING_PREVIEW_HOSTS.has(host)) return true;
  if (!host.includes('.')) return true;
  if (isKnownBrokerOrExchangeHost(host)) return true;
  if (AFFILIATE_HINT.test(candidate.url)) return true;
  return false;
}

/**
 * Bridge evidence that justifies escalating a messaging preview to the bounded
 * rendered fallback even though messaging never receives default rendered
 * crawling. Deliberately broad (`discord` mention without an extractable
 * invite suggests JS-hidden content); absence means static-only completion.
 */
export function hasMessagingBridgeEvidence(html: string): boolean {
  return /discord/i.test(String(html || ''));
}
