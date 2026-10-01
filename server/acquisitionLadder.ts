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
 * downstream treat them identically to observed seeds. */
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
