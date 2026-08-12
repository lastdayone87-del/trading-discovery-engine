import { triageAutonomousSearchCandidate } from './candidateTriage';

export type ProviderShadowCandidate = {
  videoId?: string;
  channelId?: string;
  title?: string;
  channelTitle?: string;
  publishedAt?: string;
};

export type RetrievalFreshnessBucket = 'LE_30D' | 'LE_90D' | 'LE_365D' | 'LE_730D' | 'STALE_GT_730D' | 'UNKNOWN';

export interface ProviderShadowCandidateQuality {
  channelId?: string;
  tradingRoutingDisposition: 'PLAUSIBLE_TRADING_HYPOTHESIS' | 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS' | 'NOT_APPLICABLE';
  matchedSignals: string[];
  freshnessBucket: RetrievalFreshnessBucket;
  matchedVideoAgeDays: number | null;
  productionConfirmationMeasured: false;
  productionWrites: false;
}

export interface ProviderShadowQualitySummary {
  candidatesEvaluated: number;
  plausibleTradingCandidates: number;
  withheldCandidates: number;
  candidatesWithTradingSignals: number;
  knownFreshnessCandidates: number;
  recent30d: number;
  recent90d: number;
  recent365d: number;
  recent730d: number;
  staleOver730d: number;
  unknownFreshness: number;
  productionConfirmationMeasured: false;
  productionWrites: false;
}

function freshness(publishedAt: string | undefined, nowMs: number): { bucket: RetrievalFreshnessBucket; ageDays: number | null } {
  if (!publishedAt) return { bucket: 'UNKNOWN', ageDays: null };
  const parsed = Date.parse(publishedAt);
  if (!Number.isFinite(parsed)) return { bucket: 'UNKNOWN', ageDays: null };
  const ageDays = Math.max(0, (nowMs - parsed) / 86_400_000);
  if (ageDays <= 30) return { bucket: 'LE_30D', ageDays };
  if (ageDays <= 90) return { bucket: 'LE_90D', ageDays };
  if (ageDays <= 365) return { bucket: 'LE_365D', ageDays };
  if (ageDays <= 730) return { bucket: 'LE_730D', ageDays };
  return { bucket: 'STALE_GT_730D', ageDays };
}

/**
 * Read-only provider comparison using the exact production autonomous retrieval
 * firewall. This deliberately does NOT claim creator-level TRADING_CONFIRMED:
 * search-result text is routing evidence only and independent channel
 * enrichment remains required for production classification.
 */
export function evaluateProviderShadowCandidate(candidate: ProviderShadowCandidate, nowMs = Date.now()): ProviderShadowCandidateQuality {
  const triage = triageAutonomousSearchCandidate({
    channelId: candidate.channelId || '',
    channelName: candidate.channelTitle || '',
    youtubeUrl: candidate.channelId ? `https://youtube.com/channel/${candidate.channelId}` : '',
    description: '',
    videoTitles: candidate.title ? [candidate.title] : [],
    videoDescriptions: [],
    matchedDocument: {
      type: 'VIDEO',
      title: candidate.title || '',
      description: '',
      publishedAt: candidate.publishedAt
    }
  } as any, 'automated_query', false);
  const f = freshness(candidate.publishedAt, nowMs);
  return {
    channelId: candidate.channelId,
    tradingRoutingDisposition: triage.disposition,
    matchedSignals: triage.matchedSignals,
    freshnessBucket: f.bucket,
    matchedVideoAgeDays: f.ageDays === null ? null : Math.round(f.ageDays * 10) / 10,
    productionConfirmationMeasured: false,
    productionWrites: false
  };
}

export function summarizeProviderShadowQuality(items: ProviderShadowCandidateQuality[]): ProviderShadowQualitySummary {
  const count = (bucket: RetrievalFreshnessBucket) => items.filter(item => item.freshnessBucket === bucket).length;
  const recent30d = count('LE_30D');
  const recent90Only = count('LE_90D');
  const recent365Only = count('LE_365D');
  const recent730Only = count('LE_730D');
  return {
    candidatesEvaluated: items.length,
    plausibleTradingCandidates: items.filter(item => item.tradingRoutingDisposition === 'PLAUSIBLE_TRADING_HYPOTHESIS').length,
    withheldCandidates: items.filter(item => item.tradingRoutingDisposition === 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS').length,
    candidatesWithTradingSignals: items.filter(item => item.matchedSignals.length > 0).length,
    knownFreshnessCandidates: items.filter(item => item.freshnessBucket !== 'UNKNOWN').length,
    recent30d,
    recent90d: recent30d + recent90Only,
    recent365d: recent30d + recent90Only + recent365Only,
    recent730d: recent30d + recent90Only + recent365Only + recent730Only,
    staleOver730d: count('STALE_GT_730D'),
    unknownFreshness: count('UNKNOWN'),
    productionConfirmationMeasured: false,
    productionWrites: false
  };
}
