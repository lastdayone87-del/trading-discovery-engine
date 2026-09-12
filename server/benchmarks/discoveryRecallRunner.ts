export type DiscoveryVerdict = 'FOUND' | 'DUPLICATE' | 'NOT_FOUND' | 'WRONG_MARKET' | 'WRONG_LANGUAGE';

export interface FrozenSearchHit {
  channelId: string;
  page: number;
  /** Observed market attribution for the hit (when known). */
  market?: string;
  /** Observed content language code for the hit (when known). */
  language?: string;
}

export interface FrozenSearchPayload {
  query: string;
  country: string;
  language: string;
  results: FrozenSearchHit[];
}

export interface DiscoveryBenchResult {
  expected: number;
  found: number;
  duplicates: number;
  wrongMarket: number;
  wrongLanguage: number;
  missed: string[];
  recall: number | null;
  verdicts: Record<string, DiscoveryVerdict>;
}

/**
 * Deterministic discovery-recall classifier over frozen search payloads.
 * Ground rules: expected channels on pages 1–3 are FOUND; repeats are
 * DUPLICATE; expected-but-absent are NOT_FOUND (missed); hits attributed to
 * another market/language are WRONG_MARKET/WRONG_LANGUAGE. Pure offline.
 */
export function classifyDiscoveryRecall(
  payload: FrozenSearchPayload,
  expectedChannelIds: string[],
  expectedMarket: string,
  expectedLanguage: string,
): DiscoveryBenchResult {
  const expected = new Set(expectedChannelIds);
  const verdicts: Record<string, DiscoveryVerdict> = {};
  // Aggregate occurrences per channel first: page order in a frozen payload
  // is incidental, so a valid pages-1–3 hit counts even when a later-page
  // duplicate was recorded first. Duplicate hits still count separately.
  const byChannel = new Map<string, FrozenSearchHit[]>();
  for (const hit of payload.results) {
    const list = byChannel.get(hit.channelId);
    if (list) list.push(hit);
    else byChannel.set(hit.channelId, [hit]);
  }
  let duplicates = 0;
  let wrongMarket = 0;
  let wrongLanguage = 0;
  const wantMarket = expectedMarket.toLowerCase();
  const wantLang = expectedLanguage.toLowerCase();
  for (const [channelId, hits] of byChannel) {
    duplicates += Math.max(0, hits.length - 1);
    if (!expected.has(channelId)) continue;
    const inWindow = hits.some(
      hit =>
        hit.page >= 1 &&
        hit.page <= 3 &&
        (!hit.market || hit.market.toLowerCase() === wantMarket) &&
        (!hit.language || hit.language.toLowerCase() === wantLang),
    );
    if (inWindow) {
      verdicts[channelId] = 'FOUND';
      continue;
    }
    const wrongContext = hits.find(
      hit =>
        (hit.market && hit.market.toLowerCase() !== wantMarket) ||
        (hit.language && hit.language.toLowerCase() !== wantLang),
    );
    if (wrongContext) {
      if (wrongContext.market && wrongContext.market.toLowerCase() !== wantMarket) {
        verdicts[channelId] = 'WRONG_MARKET';
        wrongMarket += 1;
      } else {
        verdicts[channelId] = 'WRONG_LANGUAGE';
        wrongLanguage += 1;
      }
      continue;
    }
    verdicts[channelId] = 'NOT_FOUND';
  }
  for (const id of expected) {
    if (!(id in verdicts)) verdicts[id] = 'NOT_FOUND';
  }
  const found = Object.values(verdicts).filter(v => v === 'FOUND').length;
  // Wrong-context hits are misses for recall purposes: expected channels that
  // never surfaced cleanly belong on the diagnostic list alongside page misses.
  const missed = Object.entries(verdicts)
    .filter(([, v]) => v !== 'FOUND')
    .map(([id]) => id);
  return {
    expected: expected.size,
    found,
    duplicates,
    wrongMarket,
    wrongLanguage,
    missed,
    recall: expected.size > 0 ? found / expected.size : null,
    verdicts,
  };
}
