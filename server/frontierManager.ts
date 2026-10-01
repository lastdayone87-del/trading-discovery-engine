/**
 * Frontier Manager + Stopping Arbiter (P-C: per-site ordered navigation).
 *
 * The frontier orders candidate pages by expected evidence value under
 * politeness and attempt history; the stopping arbiter ends acquisition on
 * coverage, marginal-yield exhaustion, budget exhaustion, or
 * inaccessibility — never on page counts alone. Hard caps always bind
 * regardless of yield estimates. All decisions are deterministic and logged;
 * learned weights arrive only as versioned data (P-D), defaulting to the
 * deterministic base scorer until then.
 *
 * Bounds below are conservative initial values pending frozen-fixture
 * derivation in implementation planning (TBD-for-planning). They never
 * exceed existing acquisition ceilings without a separately approved
 * experiment.
 */
import { communityNavigationScore } from './inspector';
import { getAppSetting } from './dbCore';

export const FRONTIER_POLICY_VERSION = 'frontier-manager-v1';
export const FRONTIER_SETTING_KEY = 'frontier_manager_enabled';

/** Conservative initial bounds (TBD-for-planning). Never above the
 * corresponding acquisition ceilings without approved evidence. */
export const MAX_FRONTIER_QUEUE_PER_SITE = 50;
export const MAX_FRONTIER_PAGES_PER_SITE = 12;
export const MAX_FRONTIER_DEPTH = 2;

export interface FrontierCandidateSignals {
  url: string;
  hintScore: number;
  depth: number;
  attempts: number;
  sitemapListed: boolean;
  structuredNominated: boolean;
}

export interface ScoredCandidate extends FrontierCandidateSignals {
  expectedValue: number;
  scorerVersion: string;
}

/** Deterministic base scorer: hint score discounted by depth and prior
 * failed attempts, with small priors for sitemap/structured nomination.
 * Weights are fixed documentation of the base policy, not tuned values;
 * learned weights (P-D) arrive as versioned data through this same shape. */
export function scoreFrontierCandidate(
  signals: FrontierCandidateSignals,
  weights: { hint?: number; depthPenalty?: number; attemptPenalty?: number; sitemapPrior?: number; structuredPrior?: number } = {},
): ScoredCandidate {
  const w = {
    hint: weights.hint ?? 1,
    depthPenalty: weights.depthPenalty ?? 0.25,
    attemptPenalty: weights.attemptPenalty ?? 0.5,
    sitemapPrior: weights.sitemapPrior ?? 0.1,
    structuredPrior: weights.structuredPrior ?? 0.1,
  };
  const depthDiscount = Math.max(0, 1 - Math.max(0, signals.depth) * w.depthPenalty);
  const attemptDiscount = Math.max(0, 1 - Math.max(0, signals.attempts) * w.attemptPenalty);
  const expectedValue =
    Math.max(0, signals.hintScore) * w.hint * depthDiscount * attemptDiscount +
    (signals.sitemapListed ? w.sitemapPrior : 0) +
    (signals.structuredNominated ? w.structuredPrior : 0);
  return { ...signals, expectedValue, scorerVersion: FRONTIER_POLICY_VERSION };
}

/** Score a URL with the shared community-navigation scorer (single source
 * of hint truth with the crawl loop) for frontier admission. */
export function hintScoreFor(url: string, label = ''): number {
  try {
    const parsed = new URL(url);
    return communityNavigationScore(parsed.pathname + parsed.search, label);
  } catch {
    return 0;
  }
}

export type FrontierDecision =
  | { action: 'ACQUIRE'; url: string; reason: string }
  | { action: 'STOP'; reason: string };

/** Per-crawl frontier controls threaded through the static crawl loop
 * (trailing optional param; absent means legacy fixed caps exactly).
 * All behavior is fail-open toward legacy crawling. */
export interface FrontierCrawlOptions {
  enabled: boolean;
  siteIdentity?: string;
  budgetCap?: number;
  marginalFloor?: number;
  remainingValueFloor?: number;
  marginalWindow?: number;
  weightVersion?: string;
}

export async function isFrontierEnabled(
  readSetting: (key: string, fallback: string) => Promise<string> = getAppSetting,
): Promise<boolean> {
  return (await readSetting('frontier_manager_enabled', 'false')) === 'true';
}

export interface FrontierState {
  queued: ScoredCandidate[];
  acquiredPages: number;
  evidenceUnits: number;
  /** Trailing per-page evidence yields (most recent last), for marginal estimates. */
  yieldHistory: number[];
  blockedTerminals: number;
  spentBudget: number;
  budgetCap: number;
}

export interface StoppingPolicy {
  /** Stop when trailing-window mean yield falls below this. TBD-for-planning. */
  marginalFloor: number;
  /** Trailing window size for the marginal estimate. TBD-for-planning. */
  marginalWindow: number;
  /** Stop when remaining queued expected value is below this. TBD-for-planning. */
  remainingValueFloor: number;
}

/** Marginal expected yield: mean evidence units over the trailing window
 * (or all history when shorter). Pure and deterministic. */
export function marginalEvidenceYield(yieldHistory: number[], window: number): number {
  const winsize = Math.max(1, Math.trunc(window) || 1);
  const tail = yieldHistory.slice(-winsize);
  if (!tail.length) return 0;
  return tail.reduce((sum, value) => sum + value, 0) / tail.length;
}

/** Terminal blocked/unavailable classification for coverage records. Pure
 * mapping from already-acquired fetch signals — never an extra fetch, never
 * a bypass judgment. Unknown/unrecognized inputs resolve to INCOMPLETE
 * (fail open toward re-inspection, never toward a negative). HTTP semantics
 * outrank body markers: a 429 is rate-limited even on a login-looking page. */
export type BlockedTerminalState =
  | 'OK'
  | 'ROBOTS_DISALLOWED'
  | 'LOGIN_WALL'
  | 'PAYWALL'
  | 'WAF_MANAGED'
  | 'RATE_LIMITED'
  | 'UNREACHABLE'
  | 'INCOMPLETE';

export function classifyBlockedAcquisition(input: {
  httpStatus?: number;
  failureClass?: string;
  robotsState?: string;
  timedOut?: boolean;
  transportFailed?: boolean;
  hasLoginForm?: boolean;
  hasPaywallMarkers?: boolean;
  hasWafMarkers?: boolean;
  processedPages?: number;
}): BlockedTerminalState {
  if (input.robotsState === 'DISALLOWED') return 'ROBOTS_DISALLOWED';
  if (input.httpStatus === 429) return 'RATE_LIMITED';
  if (input.failureClass === 'RATE_LIMIT') return 'RATE_LIMITED';
  if (input.hasWafMarkers) return 'WAF_MANAGED';
  if (input.hasLoginForm) return 'LOGIN_WALL';
  if (input.hasPaywallMarkers) return 'PAYWALL';
  if (
    input.transportFailed ||
    input.timedOut ||
    input.failureClass === 'TIMEOUT' ||
    input.failureClass === 'NETWORK_FAILURE'
  ) {
    return 'UNREACHABLE';
  }
  if (typeof input.httpStatus === 'number' && input.httpStatus >= 500) return 'UNREACHABLE';
  if ((input.processedPages || 0) === 0) return 'INCOMPLETE';
  return 'OK';
}

/** Stopping arbiter: CONTINUE only while coverage is incomplete AND budget
 * remains AND marginal yield justifies AND valuable routes remain AND the
 * site is not terminally inaccessible. Every STOP carries its reason;
 * every decision is reproducible from the logged state. Hard caps bind
 * regardless of yield estimates. */
export function decideFrontierStep(
  state: FrontierState,
  policy: StoppingPolicy,
  maxPages: number = MAX_FRONTIER_PAGES_PER_SITE,
): FrontierDecision {
  const available = state.queued
    .filter(candidate => candidate.expectedValue > 0)
    .sort((a, b) => b.expectedValue - a.expectedValue || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  if (available.length === 0) {
    return { action: 'STOP', reason: 'frontier-exhausted: no valuable routes remain' };
  }
  if (state.acquiredPages >= maxPages) {
    return { action: 'STOP', reason: `page-cap-reached: ${state.acquiredPages} pages at cap ${maxPages}` };
  }
  if (state.spentBudget >= state.budgetCap) {
    return { action: 'STOP', reason: `budget-exhausted: spent ${state.spentBudget} of ${state.budgetCap}` };
  }
  const remainingValue = available.reduce((sum, candidate) => sum + candidate.expectedValue, 0);
  if (remainingValue < policy.remainingValueFloor) {
    return { action: 'STOP', reason: `remaining-value-below-floor: ${remainingValue} < ${policy.remainingValueFloor}` };
  }
  if (state.acquiredPages > 0) {
    const marginal = marginalEvidenceYield(state.yieldHistory, policy.marginalWindow);
    if (marginal < policy.marginalFloor) {
      return { action: 'STOP', reason: `marginal-yield-below-floor: ${marginal} < ${policy.marginalFloor}` };
    }
  }
  return { action: 'ACQUIRE', url: available[0].url, reason: `best-expected-value: ${available[0].expectedValue}` };
}
