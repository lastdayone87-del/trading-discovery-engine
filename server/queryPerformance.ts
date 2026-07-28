import type { QueryCollection } from '../src/types';

export type FunnelOutcome = 'COUNTRY_REJECTED' | 'NON_TRADING' | 'UNCERTAIN' | 'NEEDS_REVIEW' | 'TRADING_CONFIRMED';

export interface QueryObservation {
  channelId: string;
  wasKnown: boolean;
  persisted: boolean;
  funnelOutcome: FunnelOutcome;
  qualityScore: number;
  hasCommunity: boolean;
}

export interface QueryFunnelMetrics {
  rawResults: number;
  distinctResults: number;
  duplicateResults: number;
  knownChannels: number;
  newChannels: number;
  countryRejected: number;
  nonTrading: number;
  uncertain: number;
  needsReview: number;
  tradingConfirmed: number;
  qualityChannels: number;
  communitiesDiscovered: number;
  averageQualityScore: number;
  noveltyRatio: number;
  countryPrecision: number;
  tradingPrecision: number;
  performanceScore: number;
}

const ratio = (numerator: number, denominator: number): number => denominator > 0 ? numerator / denominator : 0;

export function calculateQueryFunnel(rawResults: number, observations: QueryObservation[]): QueryFunnelMetrics {
  const distinct = new Map<string, QueryObservation>();
  for (const observation of observations) if (!distinct.has(observation.channelId)) distinct.set(observation.channelId, observation);
  const values = [...distinct.values()];
  const count = (outcome: FunnelOutcome) => values.filter(value => value.funnelOutcome === outcome).length;
  const countryRejected = count('COUNTRY_REJECTED');
  const nonTrading = count('NON_TRADING');
  const uncertain = count('UNCERTAIN');
  const needsReview = count('NEEDS_REVIEW');
  const tradingConfirmed = count('TRADING_CONFIRMED');
  const evaluated = nonTrading + uncertain + needsReview + tradingConfirmed;
  const persisted = values.filter(value => value.persisted);
  const qualityChannels = values.filter(value => value.funnelOutcome === 'TRADING_CONFIRMED' && value.qualityScore >= 55).length;
  const communitiesDiscovered = values.filter(value => value.funnelOutcome === 'TRADING_CONFIRMED' && value.hasCommunity).length;
  const averageQualityScore = persisted.length
    ? Math.round(persisted.reduce((sum, value) => sum + value.qualityScore, 0) / persisted.length)
    : 0;
  const noveltyRatio = ratio(values.filter(value => value.persisted && !value.wasKnown).length, values.length);
  const countryPrecision = ratio(values.length - countryRejected, values.length);
  const tradingPrecision = ratio(tradingConfirmed, evaluated);
  const qualityYield = ratio(qualityChannels, evaluated);
  const communityYield = ratio(communitiesDiscovered, evaluated);
  const performanceScore = Math.round(100 * (
    0.30 * tradingPrecision +
    0.25 * noveltyRatio +
    0.20 * qualityYield +
    0.15 * countryPrecision +
    0.10 * communityYield
  ));

  return {
    rawResults,
    distinctResults: values.length,
    duplicateResults: Math.max(0, rawResults - values.length),
    knownChannels: values.filter(value => value.wasKnown).length,
    newChannels: values.filter(value => value.persisted && !value.wasKnown).length,
    countryRejected,
    nonTrading,
    uncertain,
    needsReview,
    tradingConfirmed,
    qualityChannels,
    communitiesDiscovered,
    averageQualityScore,
    noveltyRatio,
    countryPrecision,
    tradingPrecision,
    performanceScore
  };
}

export function selectQueryCollection(current: QueryCollection, priorRuns: number, metrics: QueryFunnelMetrics): QueryCollection {
  const totalRuns = priorRuns + 1;
  if (metrics.performanceScore >= 60) return 'PROVEN';
  if (metrics.performanceScore < 25 && totalRuns >= 2) return 'REJECTED';
  return current === 'REJECTED' ? 'REJECTED' : 'EXPERIMENTAL';
}
