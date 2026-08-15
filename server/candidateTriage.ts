import type { DiscoverySource } from '../src/types';
import type { VerificationDecision } from './evidenceEngine';
import type { DiscoveredChannelRaw } from './youtube';

export const CANDIDATE_TRIAGE_POLICY_VERSION = 'candidate-triage-v3-freshness';

export type SearchCandidateTriageDisposition = 'PLAUSIBLE_TRADING_HYPOTHESIS' | 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS' | 'NOT_APPLICABLE';

export interface SearchCandidateTriageDecision {
  disposition: SearchCandidateTriageDisposition;
  reasonCodes: string[];
  matchedSignals: string[];
}

const STRONG_TRADING_SIGNALS: Array<[string, RegExp]> = [
  ['TRADING_LITERAL', /\b(trading|trader|day\s*trading|swing\s*trading|intraday|scalping|scalper)\b/iu],
  ['FOREX_FUTURES_OPTIONS', /\b(forex|fx\s*trading|futures?|options?|0dte|cfd|spread\s*betting|prop\s*firm|funded\s*trader)\b/iu],
  ['TECHNICAL_METHOD', /\b(technical\s*analysis|price\s*action|order\s*flow|footprint|market\s*structure|volume\s*profile|liquidity\s*sweep|fair\s*value\s*gap|smart\s*money|ict\b|smc\b)\b/iu],
  ['EQUITY_CRYPTO_MARKETS', /\b(stocks?|equities|shares?|crypto|bitcoin|ethereum|btc|eth|nasdaq|s&p\s*500|sp500)\b/iu],
  ['LOCAL_TECHNICAL_ANALYSIS', /\b(analyse\s*technique|analisi\s*tecnica|an[aá]lisis\s*t[eé]cnico|technische\s*analyse|technische\s*analyse|teknisk\s*analys|teknisk\s*analyse|b[oö]rsen?analyse|beursanalyse|bourse|bolsa|borsa|aktiehandel|daghandel|futuros|opciones)\b/iu],
  ['KNOWN_MARKET_INSTRUMENT', /\b(dax(?:\s*40)?|cac\s*40|ftse\s*100|ibex\s*35|aex|bel\s*20|smi|omx(?:c25|s30)?|tsx(?:\s*60)?|asx(?:\s*200)?|nq\s*futures?|es\s*futures?|eurusd|gbpusd|usdcad|audusd|nzdusd|usdchf|usdjpy)\b/iu],
  ['JAPANESE_TRADING', /(トレード|デイトレード|先物|テクニカル分析|板読み|オーダーフロー)/u]
];

const STRONG_NON_TRADING_SIGNALS: Array<[string, RegExp]> = [
  ['GAMING', /\b(gameplay|walkthrough|playthrough|minecraft|roblox|fortnite|valorant|league\s*of\s*legends|gta\s*v|gta\s*5|call\s*of\s*duty|pokemon|pokémon|genshin|esports?|gaming\s*channel)\b/iu],
  ['COOKING_RECIPES', /\b(recipe|recipes|cooking|kitchen|bake|baking|chef|cuisine|mukbang|delicious\s*food|street\s*food)\b/iu],
  ['ENTERTAINMENT_GOSSIP', /\b(celebrity|gossip|vlog|vlogging|prank|pranks|unboxing|toy\s*review|makeup\s*tutorial|beauty\s*vlog|reaction\s*video|music\s*video|official\s*music\s*video|mv\b)\b/iu],
  ['GENERIC_PERSONAL_FINANCE', /\b(personal\s*finance|budgeting|credit\s*card\s*points|save\s*money|paying\s*off\s*debt|mortgage\s*calculator)\b/iu]
];

function staleMatchedVideo(candidate: DiscoveredChannelRaw, now = Date.now()): boolean {
  if (candidate.matchedDocument?.type !== 'VIDEO' || !candidate.matchedDocument.publishedAt) return false;
  const publishedAt = Date.parse(candidate.matchedDocument.publishedAt);
  if (!Number.isFinite(publishedAt)) return false;
  const configured = Number(process.env.DISCOVERY_MAX_MATCH_AGE_DAYS ?? '730');
  const maxAgeDays = Number.isFinite(configured) ? Math.max(0, configured) : 730;
  if (maxAgeDays === 0) return false;
  return now - publishedAt > maxAgeDays * 86_400_000;
}

/**
 * Cheap routing-only firewall. Search-match content is never promoted to
 * creator-level evidence; it is used only to decide whether an autonomous
 * result is worth spending additional provider quota on.
 */
export function triageAutonomousSearchCandidate(
  candidate: DiscoveredChannelRaw,
  source: DiscoverySource,
  isEnrichmentPass: boolean
): SearchCandidateTriageDecision {
  if (source !== 'automated_query' || isEnrichmentPass || (candidate.enrichmentStage || 0) > 0) {
    return { disposition: 'NOT_APPLICABLE', reasonCodes: ['NON_INITIAL_AUTONOMOUS_RESULT'], matchedSignals: [] };
  }

  // A search hit from many years ago is weak evidence for the user's actual
  // target: active traders publishing now. Withhold stale VIDEO matches before
  // country hydration, semantic classification, enrichment, or Discord crawling.
  // CHANNEL-lane results are not rejected here because they have no trustworthy
  // publication timestamp and can still receive creator-level evidence later.
  if (staleMatchedVideo(candidate)) {
    return {
      disposition: 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS',
      reasonCodes: ['STALE_RETRIEVAL_DOCUMENT', 'DO_NOT_SPEND_ENRICHMENT_QUOTA'],
      matchedSignals: []
    };
  }

  const retrievalText = [
    candidate.channelName,
    candidate.matchedDocument?.title,
    candidate.matchedDocument?.description
  ].filter(Boolean).join(' ').normalize('NFKC');

  const matchedSignals = STRONG_TRADING_SIGNALS.filter(([, pattern]) => pattern.test(retrievalText)).map(([name]) => name);
  if (matchedSignals.length) {
    return {
      disposition: 'PLAUSIBLE_TRADING_HYPOTHESIS',
      reasonCodes: ['RETRIEVAL_DOCUMENT_HAS_EXPLICIT_TRADING_SIGNAL'],
      matchedSignals
    };
  }

  const negativeSignals = STRONG_NON_TRADING_SIGNALS.filter(([, pattern]) => pattern.test(retrievalText)).map(([name]) => name);
  if (negativeSignals.length) {
    return {
      disposition: 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS',
      reasonCodes: ['EXPLICIT_NON_TRADING_SIGNAL_DETECTED', 'DO_NOT_SPEND_ENRICHMENT_QUOTA'],
      matchedSignals: negativeSignals
    };
  }

  // Do not auto-withhold scripts for which this cheap lexical router has weak
  // coverage. They may still be legitimate creators in a supported market and
  // can receive one bounded enrichment pass rather than a false-negative stop.
  if (/[^\u0000-\u024F]/u.test(retrievalText)) {
    return {
      disposition: 'PLAUSIBLE_TRADING_HYPOTHESIS',
      reasonCodes: ['NON_LATIN_ROUTING_COVERAGE_CONSERVATIVE_PASS'],
      matchedSignals: []
    };
  }

  return {
    disposition: 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS',
    reasonCodes: ['NO_EXPLICIT_TRADING_SIGNAL_IN_RETRIEVAL_DOCUMENT', 'DO_NOT_SPEND_ENRICHMENT_QUOTA'],
    matchedSignals: []
  };
}

/**
 * Creator-level plausibility after enrichment. Unlike retrieval routing, this
 * uses only the independent evidence bundle produced by the classifier.
 */
export function hasIndependentTradingHypothesis(decision: VerificationDecision): boolean {
  if (decision.status === 'TRADING_CONFIRMED') return true;
  // Operational provider failure is not negative evidence. Preserve the case
  // for one bounded retry rather than converting missing provider output into a
  // durable "no trading hypothesis" withholding decision.
  if (decision.evidenceCollection.degraded) return true;
  const substantivePositive = decision.positiveEvidence.some(item =>
    item.rawMatches.length > 0 &&
    item.category !== 'SEMANTIC_ABSTENTION' &&
    Math.abs(item.finalWeight) > 0
  );
  if (substantivePositive) return true;
  const candidateStage = decision.stagedClassification?.stages.find(stage => stage.stage === 'CANDIDATE_DETECTION');
  return candidateStage?.disposition === 'PASS';
}
