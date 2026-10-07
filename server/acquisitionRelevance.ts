/**
 * R6 global pre-acquisition relevance/classification layer.
 *
 * Conservative, evidence-based, fail-open. Uses ONLY data already stored
 * before acquisition (no fetch/render/click/scroll to classify).
 *
 * Tiers:
 * - BLOCK: clearly unrelated with strong multi-signal evidence. Skipped
 *   (no crawl/render/budget/required/retry/failure/NO_MATCH). Discovery
 *   evidence preserved; audit logged.
 * - DEMOTE: low-value but potentially relevant. Crawled AFTER eligible,
 *   static-only, existing static caps (small bounded budget), no rendering /
 *   scrolling / clicking / interaction, no escalation merely because budget
 *   remains (escalation only on bridge/FOUND evidence per existing policy).
 * - ELIGIBLE: default. Normal acquisition path. Fail-open target for errors,
 *   missing data, unexpected state, or low confidence.
 *
 * Affiliate, tracking-query, broker/prop-firm, redirect, short-link,
 * Linktree/link-hub, social, messaging, community-platform, Substack,
 * Notion, GitHub, Spotify/creator-commerce, generic creator domains, and
 * /community|/join|/members|/register|/about|/contact paths are NEVER
 * blocked here: production shows legitimate community evidence via each.
 * The narrow target is only clearly unrelated with no plausible discovery
 * path (e.g. scheduling/form utility detail, single-purpose commerce
 * redirector detail) under strict multi-signal conjunctions.
 *
 * Enforcement behind `relevance_enforcement_enabled` (ships DISABLED
 * pending rule + replay review). When disabled/errored, everything is
 * ELIGIBLE (legacy behavior byte-identical).
 */
import { assessCrawlAdmission } from './communitySurfacePolicy';
import { canonicalSiteIdentity } from './siteIdentity';

export type RelevanceTier = 'BLOCK' | 'DEMOTE' | 'ELIGIBLE';

export const RELEVANCE_POLICY_VERSION = 'acquisition-relevance-v1';

export interface RelevanceSignals {
  rawUrl: string;
  hostname: string;
  registrable: string;
  path: string;
  queryKeys: string[];
  source: string;
  contextMatches: boolean;
  kind: 'WEBSITE' | 'SOCIAL' | 'MESSAGING' | 'OTHER';
  platformFamily:
    | 'APP_STORE'
    | 'UTILITY_SCHEDULING'
    | 'FORM'
    | 'SHORTENER_SINGLE_PURPOSE'
    | 'SHORTENER_GENERIC'
    | 'LINK_HUB'
    | 'COMMUNITY_PLATFORM'
    | 'SOCIAL'
    | 'MESSAGING'
    | 'BROKER'
    | 'GENERIC';
  communityHint: boolean;
  creatorCanonical: boolean;
  wrapperPresent: boolean;
  admissionEligible: boolean;
  admissionReason: string;
}

export interface RelevanceDecision {
  tier: RelevanceTier;
  reason: string;
  signals: Pick<
    RelevanceSignals,
    'hostname' | 'registrable' | 'path' | 'source' | 'kind' | 'platformFamily'
  > & { contextMatches: boolean; creatorCanonical: boolean; wrapperPresent: boolean };
  policyVersion: string;
}

const COMMUNITY_HINT = /(?:discord|community|join|members?|membership|group|private|vip|trading[-_ ]?(?:room|floor)|chat|links?)/i;
const MESSAGING_HOSTS = new Set([
  't.me', 'www.t.me', 'telegram.me', 'www.telegram.me', 'telegram.dog', 'www.telegram.dog',
  'wa.me', 'www.wa.me', 'whatsapp.com', 'www.whatsapp.com', 'chat.whatsapp.com',
]);
const SOCIAL_HOSTS = new Set([
  'twitter.com', 'www.twitter.com', 'x.com', 'www.x.com',
  'instagram.com', 'www.instagram.com', 'facebook.com', 'www.facebook.com',
  'tiktok.com', 'www.tiktok.com', 'linkedin.com', 'www.linkedin.com',
  'youtube.com', 'www.youtube.com', 'youtu.be', 'www.youtu.be',
  'twitch.tv', 'www.twitch.tv', 'kick.com', 'www.kick.com',
]);
const LINK_HUB_HOSTS = new Set([
  'linktr.ee', 'www.linktr.ee', 'beacons.ai', 'www.beacons.ai', 'bio.link', 'www.bio.link',
  'solo.to', 'www.solo.to', 'campsite.bio', 'www.campsite.bio', 'lnk.bio', 'www.lnk.bio',
]);
const COMMUNITY_PLATFORM_HOSTS = new Set([
  'skool.com', 'www.skool.com', 'whop.com', 'www.whop.com', 'circle.so', 'www.circle.so',
  'patreon.com', 'www.patreon.com',
]);
const BROKER_LABELS = new Set(['binance', 'degiro', 'coinbase', 'kraken', 'bybit', 'etoro', 'fortuneo']);
const APP_STORE_HOSTS = new Set([
  'apps.apple.com', 'itunes.apple.com', 'play.google.com', 'apps.microsoft.com',
]);
const UTILITY_SCHEDULING_HOSTS = new Set(['calendly.com', 'cal.com']);
const FORM_HOSTS = new Set(['forms.gle', 'typeform.com', 'docs.google.com']);
const SHORTENER_SINGLE_PURPOSE = new Set(['amzn.to', 'sjv.io']);

function hostOf(raw: string): string {
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function platformFamilyOf(host: string): RelevanceSignals['platformFamily'] {
  if (APP_STORE_HOSTS.has(host)) return 'APP_STORE';
  if (UTILITY_SCHEDULING_HOSTS.has(host)) return 'UTILITY_SCHEDULING';
  if (FORM_HOSTS.has(host)) return 'FORM';
  if (SHORTENER_SINGLE_PURPOSE.has(host)) return 'SHORTENER_SINGLE_PURPOSE';
  if (MESSAGING_HOSTS.has(host)) return 'MESSAGING';
  if (SOCIAL_HOSTS.has(host)) return 'SOCIAL';
  if (LINK_HUB_HOSTS.has(host)) return 'LINK_HUB';
  if (COMMUNITY_PLATFORM_HOSTS.has(host)) return 'COMMUNITY_PLATFORM';
  const labels = host.split('.');
  if (labels.length >= 2 && BROKER_LABELS.has(labels[labels.length - 2])) return 'BROKER';
  if (/(^|\.)(bit\.ly|tinyurl\.com|t\.co|goo\.gl|lc\.cx|is\.gd|cutt\.ly|rebrand\.ly|shorturl\.at|tr\.ee|dub\.sh)$/.test(host)) {
    return 'SHORTENER_GENERIC';
  }
  return 'GENERIC';
}

function kindOf(host: string, platformFamily: RelevanceSignals['platformFamily']): RelevanceSignals['kind'] {
  if (platformFamily === 'MESSAGING') return 'MESSAGING';
  if (platformFamily === 'SOCIAL') return 'SOCIAL';
  return 'WEBSITE';
}

function isLowTrustSource(source: string): boolean {
  return /^VIDEO_\d+_DESCRIPTION$/.test(source);
}

/**
 * Extract stored pre-acquisition signals only. Never fetches. Fail-open:
 * on any error returns null (caller maps to ELIGIBLE).
 */
export function extractRelevanceSignals(input: {
  url: string;
  source: string;
  contextMatches: boolean;
  wrapperUrl?: string;
  creatorCanonicalHosts?: Set<string> | string[];
}): RelevanceSignals | null {
  try {
    const rawUrl = String(input.url || '');
    if (!rawUrl) return null;
    const host = hostOf(rawUrl);
    if (!host) return null;
    let registrable = host;
    try {
      registrable = canonicalSiteIdentity(rawUrl)?.siteIdentity || host;
    } catch {
      registrable = host;
    }
    let path = '/';
    let queryKeys: string[] = [];
    try {
      const parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      path = parsed.pathname || '/';
      queryKeys = Array.from(parsed.searchParams.keys());
    } catch {
      return null;
    }
    const platformFamily = platformFamilyOf(host);
    const kind = kindOf(host, platformFamily);
    let admissionEligible = true;
    let admissionReason = 'ELIGIBLE';
    try {
      const admission = assessCrawlAdmission(rawUrl);
      admissionEligible = admission.eligible;
      admissionReason = admission.reasonCode;
    } catch {
      admissionEligible = true;
      admissionReason = 'ELIGIBLE';
    }
    const canonicalSet =
      input.creatorCanonicalHosts instanceof Set
        ? input.creatorCanonicalHosts
        : new Set(input.creatorCanonicalHosts || []);
    return {
      rawUrl,
      hostname: host,
      registrable,
      path,
      queryKeys,
      source: String(input.source || ''),
      contextMatches: input.contextMatches === true,
      kind,
      platformFamily,
      communityHint: COMMUNITY_HINT.test(`${path} ${input.url}`),
      creatorCanonical: canonicalSet.has(host) || canonicalSet.has(registrable),
      wrapperPresent: typeof input.wrapperUrl === 'string' && input.wrapperUrl.length > 0,
      admissionEligible,
      admissionReason,
    };
  } catch {
    return null;
  }
}

function isSchedulingDetailPath(path: string): boolean {
  return /(?:\/book|\/schedule|\/invite|\/event|\/meeting|\/appointment)/i.test(path);
}

function isFormDetailPath(path: string, queryKeys: string[]): boolean {
  if (/\/forms\/d\//.test(path)) return true;
  if (queryKeys.some(k => /^(entry|form|usp|viewform)$/i.test(k))) return true;
  return path.length > 1;
}

function isSinglePurposeDetail(signals: RelevanceSignals): boolean {
  // amzn.to/dp|gp|product, sjv.io tenant redirect paths: single-purpose
  // commerce redirector detail (opaque generic shorteners never qualify).
  if (signals.platformFamily !== 'SHORTENER_SINGLE_PURPOSE') return false;
  if (/amzn\.to$/i.test(signals.hostname)) {
    return /^\/(dp|gp|exec|ap)\//i.test(signals.path) || signals.path.length > 1;
  }
  return signals.path.length > 1;
}

/**
 * Pure classifier: BLOCK / DEMOTE / ELIGIBLE from stored signals only.
 * Fail-open: any error, missing data, or non-confident state → ELIGIBLE.
 *
 * BLOCK (narrow, multi-signal conjunctions only; replay must show 0 FOUND):
 * - B1 utility-scheduling detail: UTILITY_SCHEDULING + scheduling path +
 *   no community hint + no context + low-trust VIDEO_DESC source +
 *   not creator-canonical + no wrapper + WEBSITE kind.
 * - B2 form detail: FORM + form detail + same guards.
 * - B3 single-purpose commerce redirector: SHORTENER_SINGLE_PURPOSE detail +
 *   same guards.
 * App Store / Play, news/article, generic services, broker/affiliate/
 * tracking/transaction, social, link-hub, community-platform, Substack,
 * Notion, GitHub, Spotify/creator-commerce, generic shorteners, redirects,
 * generic creator domains, and /community|/join|/members|/register|/about|
 * /contact paths NEVER block here (production FOUND counterexamples).
 *
 * DEMOTE (static-only, order-last, no render unless bridge/FOUND):
 * - D1 news/article path shape + no hint + no context + not creator-canonical
 *   + low-trust source (0 FOUND obs in 7d; 3 FOUND sites need page-level
 *   proof before any block, so demote only).
 * App Store remains ELIGIBLE (2 FOUND rows prove render may matter).
 */
export function classifyRelevance(signals: RelevanceSignals | null): RelevanceDecision {
  const failOpen = (reason: string): RelevanceDecision => ({
    tier: 'ELIGIBLE',
    reason,
    signals: signals
      ? {
          hostname: signals.hostname,
          registrable: signals.registrable,
          path: signals.path,
          source: signals.source,
          kind: signals.kind,
          platformFamily: signals.platformFamily,
          contextMatches: signals.contextMatches,
          creatorCanonical: signals.creatorCanonical,
          wrapperPresent: signals.wrapperPresent,
        }
      : {
          hostname: '',
          registrable: '',
          path: '',
          source: '',
          kind: 'OTHER',
          platformFamily: 'GENERIC',
          contextMatches: false,
          creatorCanonical: false,
          wrapperPresent: false,
        },
    policyVersion: RELEVANCE_POLICY_VERSION,
  });
  try {
    if (!signals) return failOpen('missing-signals:fail-open-eligible');
    if (!signals.admissionEligible) return failOpen('admission-rejected:handled-by-admission-boundary');
    // Never block non-website kinds or high-recall families.
    if (signals.kind !== 'WEBSITE') return failOpen('non-website-kind:never-block');
    if (
      signals.platformFamily === 'LINK_HUB' ||
      signals.platformFamily === 'COMMUNITY_PLATFORM' ||
      signals.platformFamily === 'SOCIAL' ||
      signals.platformFamily === 'MESSAGING' ||
      signals.platformFamily === 'BROKER'
    ) {
      return failOpen('high-recall-family:never-block');
    }
    // Generic shorteners opaque: never block (78% FOUND in production).
    if (signals.platformFamily === 'SHORTENER_GENERIC') return failOpen('opaque-shortener:never-block');
    // Community/trading evidence or trusted source or creator-canonical or
    // redirect wrapper: never block (redirect target needs acquisition).
    if (signals.communityHint) return failOpen('community-hint:never-block');
    if (signals.contextMatches) return failOpen('context-match:never-block');
    if (signals.creatorCanonical) return failOpen('creator-canonical:never-block');
    if (signals.wrapperPresent) return failOpen('redirect-wrapper:needs-acquisition');
    if (!isLowTrustSource(signals.source)) {
      // BLOCK requires low-trust VIDEO_DESC source. Other sources fall
      // through to DEMOTE/ELIGIBLE below (never block on CHANNEL_LINKS/ABOUT).
      return demoteOrEligible(signals);
    }
    if (signals.platformFamily === 'UTILITY_SCHEDULING' && isSchedulingDetailPath(signals.path)) {
      return {
        tier: 'BLOCK',
        reason: 'utility-scheduling-detail:multi-signal-conjunction',
        signals: decisionSignals(signals),
        policyVersion: RELEVANCE_POLICY_VERSION,
      };
    }
    if (signals.platformFamily === 'FORM' && isFormDetailPath(signals.path, signals.queryKeys)) {
      return {
        tier: 'BLOCK',
        reason: 'form-detail:multi-signal-conjunction',
        signals: decisionSignals(signals),
        policyVersion: RELEVANCE_POLICY_VERSION,
      };
    }
    if (isSinglePurposeDetail(signals)) {
      return {
        tier: 'BLOCK',
        reason: 'single-purpose-commerce-redirector:multi-signal-conjunction',
        signals: decisionSignals(signals),
        policyVersion: RELEVANCE_POLICY_VERSION,
      };
    }
    return demoteOrEligible(signals);
  } catch {
    return failOpen('classifier-error:fail-open-eligible');
  }
}

function decisionSignals(signals: RelevanceSignals): RelevanceDecision['signals'] {
  return {
    hostname: signals.hostname,
    registrable: signals.registrable,
    path: signals.path,
    source: signals.source,
    kind: signals.kind,
    platformFamily: signals.platformFamily,
    contextMatches: signals.contextMatches,
    creatorCanonical: signals.creatorCanonical,
    wrapperPresent: signals.wrapperPresent,
  };
}

const NEWS_ARTICLE_PATH = /(?:\/|^)(?:news|articles?|blog|press|media|stories|story|insights?|opinion)(?:\/|$|[?#])/i;

function demoteOrEligible(signals: RelevanceSignals): RelevanceDecision {
  // DEMOTE: news/article path shape only (0 FOUND obs; site-level FOUND
  // needs page proof, so demote — never block). App Store stays ELIGIBLE
  // (2 FOUND rows). All other generic/utility without BLOCK conjunction
  // stays ELIGIBLE (fail-open).
  if (
    NEWS_ARTICLE_PATH.test(signals.path) &&
    !signals.communityHint &&
    !signals.contextMatches &&
    !signals.creatorCanonical
  ) {
    return {
      tier: 'DEMOTE',
      reason: 'news-article-path:demote-static-only',
      signals: decisionSignals(signals),
      policyVersion: RELEVANCE_POLICY_VERSION,
    };
  }
  return {
    tier: 'ELIGIBLE',
    reason: 'default-eligible:fail-open',
    signals: decisionSignals(signals),
    policyVersion: RELEVANCE_POLICY_VERSION,
  };
}

/**
 * Convenience: classify one URL from stored inputs. Never throws; fail-open
 * ELIGIBLE on any error. No fetch.
 */
export function classifyUrlRelevance(input: {
  url: string;
  source: string;
  contextMatches: boolean;
  wrapperUrl?: string;
  creatorCanonicalHosts?: Set<string> | string[];
}): RelevanceDecision {
  try {
    return classifyRelevance(extractRelevanceSignals(input));
  } catch {
    return {
      tier: 'ELIGIBLE',
      reason: 'classifier-error:fail-open-eligible',
      signals: {
        hostname: '',
        registrable: '',
        path: '',
        source: String(input.source || ''),
        kind: 'OTHER',
        platformFamily: 'GENERIC',
        contextMatches: false,
        creatorCanonical: false,
        wrapperPresent: false,
      },
      policyVersion: RELEVANCE_POLICY_VERSION,
    };
  }
}
