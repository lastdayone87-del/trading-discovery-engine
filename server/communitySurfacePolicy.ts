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

const COMMON_BROKER_OR_EXCHANGE_HOSTS = [
  'binance.com',
  'degiro.',
  'refer.ig.com',
  'fortuneo.fr',
  'coinbase.com',
  'kraken.com',
  'bybit.com',
  'etoro.com',
];

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
  const isKnownBrokerOrExchange = COMMON_BROKER_OR_EXCHANGE_HOSTS.some(fragment => host.includes(fragment));
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
 * best effective coverage. A successful rendered inspection therefore
 * supersedes an earlier static acquisition failure without deleting the raw
 * audit observations.
 */
export function effectiveAcquisitionOutcomes<T extends AcquisitionObservationLike>(observations: T[]): T[] {
  const effective = new Map<string, { item: T; index: number }>();

  observations.forEach((item, index) => {
    const key = canonicalObservationKey(item);
    const existing = effective.get(key);
    if (!existing) {
      effective.set(key, { item, index });
      return;
    }

    const incomingPrecedence = OUTCOME_PRECEDENCE[item.outcome];
    const existingPrecedence = OUTCOME_PRECEDENCE[existing.item.outcome];
    if (incomingPrecedence > existingPrecedence || (incomingPrecedence === existingPrecedence && index > existing.index)) {
      effective.set(key, { item, index });
    }
  });

  return [...effective.values()]
    .sort((a, b) => a.index - b.index)
    .map(entry => entry.item);
}

/**
 * Ownership boundary for the Discord inspection lifecycle. Upstream YouTube
 * acquisition observations remain useful audit evidence, but they cannot turn
 * a completed Discord/community negative into an operational Discord failure.
 */
export function isDiscordCommunityAcquisitionSurface(surface: string): boolean {
  return new Set(['CHANNEL_EXTERNAL_LINKS', 'CREATOR_WEBSITES', 'SOCIAL_PROFILES']).has(surface);
}
