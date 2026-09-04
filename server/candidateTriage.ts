import type { DiscoverySource } from '../src/types';
import type { VerificationDecision } from './evidenceEngine';
import type { DiscoveredChannelRaw } from './youtube';

export const CANDIDATE_TRIAGE_POLICY_VERSION = 'candidate-triage-v4-contextual-admission';

export type SearchCandidateTriageDisposition = 'PLAUSIBLE_TRADING_HYPOTHESIS' | 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS' | 'NOT_APPLICABLE';

export interface SearchCandidateTriageDecision {
  disposition: SearchCandidateTriageDisposition;
  reasonCodes: string[];
  matchedSignals: string[];
}

/**
 * High-specificity trading signals are strong enough to establish a cheap
 * retrieval hypothesis by themselves. They describe trading activity/methods,
 * rather than merely naming a financial product that can occur in unrelated
 * content.
 */
const HIGH_SPECIFICITY_TRADING_SIGNALS: Array<[string, RegExp]> = [
  ['TRADING_LITERAL', /\b(trading|trader|day\s*trading|swing\s*trading|intraday|scalping|scalper)\b/iu],
  ['TECHNICAL_METHOD', /\b(technical\s*analysis|price\s*action|order\s*flow|footprint|market\s*structure|volume\s*profile|liquidity\s*sweep|fair\s*value\s*gap|smart\s*money|ict\b|smc\b)\b/iu],
  ['TRADING_VENUE_OR_PROGRAM', /\b(fx\s*trading|futures?\s*trading|options?\s*trading|cfd\s*trading|spread\s*betting|prop\s*firm|funded\s*trader)\b/iu],
  ['LOCAL_TECHNICAL_ANALYSIS', /\b(analyse\s*technique|analisi\s*tecnica|an[aá]lisis\s*t[eé]cnico|technische\s*analyse|teknisk\s*analys|teknisk\s*analyse|b[oö]rsen?analyse|beursanalyse|aktiehandel|daghandel|futuros\s*trading|opciones\s*trading)\b/iu],
  ['JAPANESE_TRADING', /(トレード|デイトレード|先物取引|テクニカル分析|板読み|オーダーフロー)/u]
];

/**
 * Market/product names are useful corroboration but are deliberately weaker.
 * Words such as "options", "shares", "futures" and "crypto" are polysemous
 * and must not independently turn an unrelated creator into a trading candidate.
 */
const MARKET_CONTEXT_SIGNALS: Array<[string, RegExp]> = [
  ['FOREX_MARKET', /\b(forex|eurusd|gbpusd|usdcad|audusd|nzdusd|usdchf|usdjpy)\b/iu],
  ['DERIVATIVES_MARKET', /\b(futures?|options?|0dte|cfd)\b/iu],
  ['EQUITY_MARKET', /\b(stocks?|equities|shares?|nasdaq|s&p\s*500|sp500|dax(?:\s*40)?|cac\s*40|ftse\s*100|ibex\s*35|aex|bel\s*20|smi|omx(?:c25|s30)?|tsx(?:\s*60)?|asx(?:\s*200)?)\b/iu],
  ['CRYPTO_MARKET', /\b(crypto|bitcoin|ethereum|btc|eth)\b/iu],
  ['FUTURES_CONTRACT', /\b(nq\s*futures?|es\s*futures?)\b/iu]
];

/** Strong domain contradictions. These beat accidental market-word matches. */
const HARD_NON_TRADING_SIGNALS: Array<[string, RegExp]> = [
  ['GAMING', /\b(gameplay|walkthrough|playthrough|minecraft|roblox|fortnite|valorant|league\s*of\s*legends|gta\s*v|gta\s*5|call\s*of\s*duty|pokemon|pokémon|genshin|esports?|gaming\s*channel)\b/iu],
  ['COOKING_RECIPES', /\b(recipe|recipes|cooking|kitchen|bake|baking|chef|cuisine|mukbang|delicious\s*food|street\s*food)\b/iu],
  ['MUSIC_ARTIST', /\b(official\s*music\s*video|music\s*video|official\s*audio|lyrics?|lyric\s*video|album|single|singer|song|musician|record\s*label|clip\s*officiel|chanson|artiste|zouk)\b/iu],
  ['BEAUTY_ENTERTAINMENT', /\b(celebrity\s*gossip|makeup\s*tutorial|beauty\s*vlog|toy\s*review)\b/iu],
  ['GENERIC_PERSONAL_FINANCE', /\b(personal\s*finance|budgeting|credit\s*card\s*points|save\s*money|paying\s*off\s*debt|mortgage\s*calculator)\b/iu]
];

/** Softer format cues are only contradictions when no real trading signal exists. */
const SOFT_NON_TRADING_SIGNALS: Array<[string, RegExp]> = [
  ['GENERAL_VLOG', /\b(vlog|vlogging|prank|pranks|unboxing|reaction\s*video)\b/iu]
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
  if (staleMatchedVideo(candidate)) {
    return {
      disposition: 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS',
      reasonCodes: ['STALE_RETRIEVAL_DOCUMENT', 'DO_NOT_SPEND_ENRICHMENT_QUOTA'],
      matchedSignals: []
    };
  }

  // Bounded relationship-canary admission. Candidates discovered by traversing
  // creator relationships inside an explicitly designated canary cohort carry
  // relationshipProvenance; the relationship itself establishes a bounded
  // hypothesis WITHOUT any keyword requirement, so the keyword admission
  // bottleneck below does not apply to this cohort. This is hypothesis only:
  // relationship evidence never proves trading identity — downstream gates
  // (country exclusion, audience, semantic classification, Discord, quality)
  // remain the verifiers. Depth is capped so traversal cannot run away.
  const relationship = candidate.relationshipProvenance;
  if (
    relationship &&
    typeof relationship.cohortId === 'string' && relationship.cohortId.trim().length > 0 &&
    (relationship.kind === 'featured' || relationship.kind === 'playlist') &&
    Number.isInteger(relationship.depth) && relationship.depth >= 1 && relationship.depth <= 2
  ) {
    return {
      disposition: 'PLAUSIBLE_TRADING_HYPOTHESIS',
      reasonCodes: ['RELATIONSHIP_DERIVED_HYPOTHESIS', 'RELATIONSHIP_CORROBORATION_VIA_ENRICHMENT_PASS'],
      matchedSignals: [`RELATIONSHIP_${relationship.kind.toUpperCase()}`, `RELATIONSHIP_DEPTH_${relationship.depth}`]
    };
  }

  const retrievalText = [
    candidate.channelName,
    candidate.matchedDocument?.title,
    candidate.matchedDocument?.description
  ].filter(Boolean).join(' ').normalize('NFKC');

  const highSpecificity = HIGH_SPECIFICITY_TRADING_SIGNALS.filter(([, pattern]) => pattern.test(retrievalText)).map(([name]) => name);
  const marketContext = MARKET_CONTEXT_SIGNALS.filter(([, pattern]) => pattern.test(retrievalText)).map(([name]) => name);
  const hardNegative = HARD_NON_TRADING_SIGNALS.filter(([, pattern]) => pattern.test(retrievalText)).map(([name]) => name);
  const softNegative = SOFT_NON_TRADING_SIGNALS.filter(([, pattern]) => pattern.test(retrievalText)).map(([name]) => name);

  // Dominant unrelated-domain evidence wins over accidental finance vocabulary.
  // This is the key admission boundary that prevents artist/gaming/recipe hits
  // containing words such as "options" or "shares" from entering the canonical
  // creator pipeline and consuming enrichment/Discord quota.
  if (hardNegative.length) {
    return {
      disposition: 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS',
      reasonCodes: [
        highSpecificity.length ? 'CONFLICTING_RETRIEVAL_DOMAINS' : 'EXPLICIT_NON_TRADING_DOMAIN_DETECTED',
        'DO_NOT_SPEND_ENRICHMENT_QUOTA'
      ],
      matchedSignals: [...hardNegative, ...highSpecificity, ...marketContext]
    };
  }

  if (highSpecificity.length) {
    return {
      disposition: 'PLAUSIBLE_TRADING_HYPOTHESIS',
      reasonCodes: ['RETRIEVAL_DOCUMENT_HAS_HIGH_SPECIFICITY_TRADING_SIGNAL'],
      matchedSignals: [...highSpecificity, ...marketContext]
    };
  }

  // Multiple independent market-context families can establish a bounded
  // hypothesis (for example NQ futures + options), but one broad product word
  // alone is intentionally insufficient for canonical admission.
  if (new Set(marketContext).size >= 2 && !softNegative.length) {
    return {
      disposition: 'PLAUSIBLE_TRADING_HYPOTHESIS',
      reasonCodes: ['MULTIPLE_MARKET_CONTEXT_SIGNALS_CORROBORATE_RETRIEVAL'],
      matchedSignals: marketContext
    };
  }

  if (marketContext.length || softNegative.length) {
    return {
      disposition: 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS',
      reasonCodes: ['AMBIGUOUS_RETRIEVAL_CONTEXT', 'DO_NOT_SPEND_ENRICHMENT_QUOTA'],
      matchedSignals: [...marketContext, ...softNegative]
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
