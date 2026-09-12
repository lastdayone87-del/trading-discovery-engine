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
  const seen = new Set<string>();
  let duplicates = 0;
  let wrongMarket = 0;
  let wrongLanguage = 0;
  for (const hit of payload.results) {
    if (seen.has(hit.channelId)) {
      duplicates += 1;
      continue;
    }
    seen.add(hit.channelId);
    if (!expected.has(hit.channelId)) continue;
    if (hit.market && hit.market.toLowerCase() !== expectedMarket.toLowerCase()) {
      verdicts[hit.channelId] = 'WRONG_MARKET';
      wrongMarket += 1;
      continue;
    }
    if (hit.language && hit.language.toLowerCase() !== expectedLanguage.toLowerCase()) {
      verdicts[hit.channelId] = 'WRONG_LANGUAGE';
      wrongLanguage += 1;
      continue;
    }
    verdicts[hit.channelId] = hit.page >= 1 && hit.page <= 3 ? 'FOUND' : 'NOT_FOUND';
  }
  for (const id of expected) {
    if (!(id in verdicts)) verdicts[id] = 'NOT_FOUND';
  }
  const found = Object.values(verdicts).filter(v => v === 'FOUND').length;
  const missed = Object.entries(verdicts)
    .filter(([, v]) => v === 'NOT_FOUND')
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
