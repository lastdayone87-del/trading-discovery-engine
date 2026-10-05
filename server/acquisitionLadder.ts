/**
 * Acquisition Method Ladder (P-B: cheapest-sufficient escalation policy).
 *
 * Methods are a cost-ordered set, not a rigid sequence: the engine always
 * attempts the cheapest method whose sufficiency signal is not yet met and
 * escalates only on recorded insufficiency, with the justification logged.
 * Structured extraction is a per-response operation (it runs on every
 * acquired response); sitemap/RSS processing yields discovery nominations,
 * never evidence. Rendered escalation preserves the existing
 * static-first/render-when-insufficient doctrine by delegating to the
 * established escalation predicate (differentially tested for equality).
 *
 * Cost ranks are ordinal documentation for ordering, not tuned weights.
 * Numeric bounds are conservative initial values pending frozen-fixture
 * derivation in implementation planning (TBD-for-planning); smaller is
 * always acceptable, larger requires a separately approved experiment.
 */
import { shouldEscalateToRenderedFallback } from './browserCommunityFallback';
import { getAppSetting } from './dbCore';
import { communityNavigationScore } from './inspector';
import { assessCrawlAdmission } from './communitySurfacePolicy';
import { canonicalSiteIdentity } from './siteIdentity';
import type { HeadDiscovery } from './siteProfiler';

export const ACQUISITION_LADDER_POLICY_VERSION = 'acquisition-ladder-v1';
export const ACQUISITION_LADDER_SETTING_KEY = 'acquisition_ladder_enabled';

/** Conservative initial bounds (TBD-for-planning: derive from frozen-fixture
 * cost/yield measurements; existing crawl ceilings stay hard upper bounds). */
export const MAX_LADDER_SITEMAP_SEEDS = 5;
export const MAX_LADDER_STRUCTURED_URLS = 10;
/** Conservative initial bound (TBD-for-planning): profiler runs per
 * inspection when the ladder is enabled. Smaller is always acceptable. */
export const MAX_LADDER_PROFILE_RUNS_PER_INSPECTION = 3;

export type AcquisitionMethod =
  | 'HTTP_STATIC'
  | 'STRUCTURED_EXTRACTION'
  | 'SITEMAP_DISCOVERY'
  | 'INTERNAL_NAVIGATION'
  | 'RENDERED_BROWSER'
  | 'PUBLIC_ALTERNATIVE';

/** Ordinal cost classes (ordering documentation, not tuned weights):
 * structured extraction piggybacks an acquired response (0 marginal fetch);
 * HTTP/sitemap/navigation cost one bounded fetch each; rendered is an
 * order of magnitude more expensive (concurrency-1, 60s budgets);
 * alternatives are last-resort only (blockage-gated, never speculative). */
export const ACQUISITION_METHOD_COST_RANK: Record<AcquisitionMethod, number> = {
  STRUCTURED_EXTRACTION: 0,
  HTTP_STATIC: 1,
  SITEMAP_DISCOVERY: 1,
  INTERNAL_NAVIGATION: 1,
  PUBLIC_ALTERNATIVE: 100,
  RENDERED_BROWSER: 10,
};

export async function isAcquisitionLadderEnabled(
  readSetting: (key: string, fallback: string) => Promise<string> = getAppSetting,
): Promise<boolean> {
  return (await readSetting(ACQUISITION_LADDER_SETTING_KEY, 'false')) === 'true';
}

export interface LadderSufficiencyState {
  staticOutcome: 'FOUND' | 'INSPECTED_NO_MATCH' | 'PARTIALLY_INSPECTED' | 'ACQUISITION_FAILED';
  creatorLikelyTrading: boolean;
  hasCreatorOwnedEvidence: boolean;
  /** True when a rendered run already achieved sufficient coverage. */
  renderedCovered: boolean;
}

/** Whether the rendered rung is justified. Delegates to the established
 * escalation predicate so ladder policy and legacy behavior agree exactly;
 * the ladder adds justification logging, never a different answer. */
export function resolveRenderEscalation(input: {
  staticOutcome: LadderSufficiencyState['staticOutcome'];
  creatorLikelyTrading: boolean;
  surface: 'CREATOR_WEBSITES' | 'SOCIAL_PROFILES' | 'OTHER';
  hasCreatorOwnedEvidence: boolean;
}): { escalate: boolean; justification: string } {
  // Exact legacy semantics (differentially tested): ownership only decides
  // on FOUND; every other outcome delegates to the established predicate,
  // which already encodes trading-likelihood gating.
  if (input.staticOutcome === 'FOUND') {
    if (input.hasCreatorOwnedEvidence) {
      return { escalate: false, justification: 'FOUND with creator-owned evidence; no rendered rung needed' };
    }
    return { escalate: true, justification: 'FOUND without creator-owned evidence; rendered rung justified to establish ownership' };
  }
  const escalate = shouldEscalateToRenderedFallback({
    staticOutcome: input.staticOutcome,
    creatorLikelyTrading: input.creatorLikelyTrading,
    surface: input.surface,
  });
  return {
    escalate,
    justification: escalate
      ? `static outcome ${input.staticOutcome} insufficient without creator-owned evidence; rendered rung justified`
      : `static outcome ${input.staticOutcome} sufficient or trading likelihood absent; rendered rung not justified`,
  };
}

export interface SitemapSeedCandidate {
  url: string;
  score: number;
  sitemapUrl: string;
}

/** Select sitemap-inventoried URLs as seed nominations: scored by the same
 * community-navigation scorer as observed links, deduped, capped. Seeds
 * carry their nominating sitemap for provenance; ranking and budgets
 * downstream treat them identically to observed seeds.
 *
 * Same-site enforcement lives with the caller (inspector's seed loop via
 * isSameSiteSitemapSeed): this selector stays a pure scorer so its
 * scoring/dedupe/cap contract is unchanged. */
export function selectSitemapSeedCandidates(
  sitemapUrls: Array<{ loc: string }>,
  sitemapSourceUrl: string,
  cap: number = MAX_LADDER_SITEMAP_SEEDS,
): SitemapSeedCandidate[] {
  const seen = new Set<string>();
  const scored: SitemapSeedCandidate[] = [];
  for (const entry of sitemapUrls) {
    let absolute: URL;
    try {
      absolute = new URL(entry.loc);
    } catch {
      continue;
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') continue;
    // R6 admission boundary (shared): rejected inventory URLs are dropped
    // BEFORE scoring and capping so they can never consume one of the
    // MAX_LADDER_SITEMAP_SEEDS slots.
    if (!assessCrawlAdmission(absolute.toString()).eligible) continue;
    const url = absolute.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const score = communityNavigationScore(absolute.pathname + absolute.search, '');
    if (score <= 0) continue;
    scored.push({ url, score, sitemapUrl: sitemapSourceUrl });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, Math.trunc(cap)));
}

/**
 * Same-site gate for P-B sitemap seeds (P1: Unchecked Sitemap Seed
 * Destinations). Sitemap inventories are site-advertised (robots + sitemap
 * files), so a stored profile can carry an off-site inventory whose
 * positively-scored URLs must never become website seeds for another site.
 * A candidate is admissible only when its canonical site identity equals
 * the seed's identity; unidentifiable URLs (dotless, IP literals, unknown
 * suffix, unparsable) fail closed and are dropped. Pure and deterministic
 * (no DNS/fetch) so flag-off behavior is byte-identical and the hot path
 * stays deterministic.
 */
export function isSameSiteSitemapSeed(seedUrl: string, candidateUrl: string): boolean {
  try {
    const seedIdentity = canonicalSiteIdentity(seedUrl)?.siteIdentity;
    if (!seedIdentity) return false;
    const candidateIdentity = canonicalSiteIdentity(candidateUrl)?.siteIdentity;
    return candidateIdentity === seedIdentity;
  } catch {
    return false;
  }
}

/**
 * Same-site-filtered sitemap seed selection (P1: Valid Tenant Pages Lose
 * Seed Slots). Filtering happens BEFORE scoring/capping so a valid tenant
 * URL is never crowded out of the 5-seed cap by higher-scoring other-tenant
 * or off-site URLs: those are dropped first, then the survivors are scored
 * and capped identically to selectSitemapSeedCandidates. Security boundary
 * preserved: off-site, cross-tenant (Tier B/C), and private-literal
 * candidates never survive the pre-filter.
 *
 * Performance: the seed identity is resolved once per call (not once per
 * URL). Callers that already hold the canonical site identity for the seed
 * (e.g. inspector's seedIdentities map) may pass it as cachedSeedIdentity
 * to avoid recomputing it; when omitted it is derived from seedUrl. An
 * empty cached identity fails closed to no seeds, exactly like an
 * unidentifiable seedUrl. Candidate checks remain per-URL identity
 * comparisons — never weakened.
 */
export function selectSameSiteSitemapSeedCandidates(
  seedUrl: string,
  sitemapUrls: Array<{ loc: string }>,
  sitemapSourceUrl: string,
  cap: number = MAX_LADDER_SITEMAP_SEEDS,
  cachedSeedIdentity?: string | null,
): SitemapSeedCandidate[] {
  let seedIdentity: string | null;
  if (cachedSeedIdentity !== undefined) {
    seedIdentity = cachedSeedIdentity || null;
  } else {
    try {
      seedIdentity = canonicalSiteIdentity(seedUrl)?.siteIdentity ?? null;
    } catch {
      seedIdentity = null;
    }
  }
  if (!seedIdentity) return [];
  const filtered = (sitemapUrls || []).filter(entry => {
    try {
      const loc = String((entry as { loc?: unknown })?.loc || '');
      if (!loc) return false;
      return canonicalSiteIdentity(loc)?.siteIdentity === seedIdentity;
    } catch {
      return false;
    }
  });
  return selectSitemapSeedCandidates(filtered, sitemapSourceUrl, cap);
}

export interface StructuredNavigationCandidate {
  url: string;
  score: number;
  source: 'json-ld-sameas' | 'canonical';
}

/** Navigation candidates from structured page data: JSON-LD sameAs URLs and
 * same-host canonical declarations. Cross-host canonicals are never
 * admitted here (recorded as conflicts by the profiler, not followed).
 * Scored and capped identically to observed links; downstream crawl budgets
 * bound total acquisition regardless of source. */
export function selectStructuredNavigationCandidates(
  head: Pick<HeadDiscovery, 'canonicalHrefs'> & { jsonLdSameAs?: string[] },
  pageUrl: string,
  cap: number = MAX_LADDER_STRUCTURED_URLS,
): StructuredNavigationCandidate[] {
  let pageHost = '';
  try {
    pageHost = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const scored: StructuredNavigationCandidate[] = [];
  const consider = (raw: string | undefined, source: StructuredNavigationCandidate['source'], sameHostOnly: boolean) => {
    if (!raw) return;
    let absolute: URL;
    try {
      absolute = new URL(raw, pageUrl);
    } catch {
      return;
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return;
    if (sameHostOnly && absolute.hostname.toLowerCase() !== pageHost) return;
    const url = absolute.toString();
    if (seen.has(url)) return;
    seen.add(url);
    const score = communityNavigationScore(absolute.pathname + absolute.search, '');
    if (score <= 0) return;
    scored.push({ url, score, source });
  };
  for (const href of head.canonicalHrefs) consider(href, 'canonical', true);
  for (const sameAs of head.jsonLdSameAs || []) consider(sameAs, 'json-ld-sameas', false);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, Math.trunc(cap)));
}
