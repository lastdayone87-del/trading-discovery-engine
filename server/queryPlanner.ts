import type { CountryVocabulary, ExtractedTermRecord, QueryIntent, QueryRecord } from '../src/types';
import type { DiscoveryNeighborhoodDimensions } from './discoveryNeighborhood';
import { admitOrganicQueryCandidates, type OrganicQueryCandidate } from './organicQueryExpansion';
import { assessLanguageCapability, type GlobalLanguageContext } from './globalLanguageModel';
import {evaluateRetrievalSpecificity,type RetrievalSpecificityDecision} from './retrievalSpecificity';
import { countrySearchLanguageCandidates, normalizeLanguageCode } from './countrySearchHints';
import { capFreeSignalCandidates, type FreeSignalQueryCandidate, type FreeSignalType } from './freeQuerySignals';
import { isAmbiguousShortModifier, isExtractedStandaloneQuery, isReviewedNativePhrase, isSearchableTradingTerm, reviewedNativePhraseLanguages, TERMINOLOGY_SEARCHABILITY_VERSION } from './terminologySearchability';
import { isProductionConfiguredCountry } from './queryQuality/profiles';

export type QueryKnowledgeTier = 1 | 2 | 3;
export type QueryGenerationMode = 'EXPLORATION' | 'EXPLOITATION' | 'COLD_START';
export type SearchAtomType = 'INSTRUMENT' | 'METHOD' | 'MARKET' | 'FORMAT' | 'LEARNED' | 'CONCEPT' | 'ENTITY' | 'TOPIC' | 'NEIGHBORHOOD' | 'COVERAGE';
export type QueryCandidateSource = 'TERMINOLOGY' | 'FREE_SIGNAL' | 'SEED' | 'MIXED' | 'DEMAND_SIGNAL';

/** Per-query cap for the repeated searchability-gate audit snapshot. */
const PLANNER_GATE_METADATA_LIMIT = 20;

export interface SearchAtom {
  term: string;
  type: SearchAtomType;
  intent: QueryIntent;
  tier: QueryKnowledgeTier;
  origin: 'CURATED' | 'COUNTRY_VOCABULARY' | 'LEARNED' | 'EXTRACTED_STANDALONE' | 'ORGANIC' | 'FREE_SIGNAL' | 'DEMAND_SIGNAL';
  retrievalPolicy:RetrievalSpecificityDecision;
}

export interface DemandSignalQueryCandidate {
  surface: string;
  language: string;
  demandScore: number;
  sourceIds: string[];
}

export interface PlannedQuery {
  query: string;
  intent: QueryIntent;
  primaryTerm: string;
  knowledgeTiers: QueryKnowledgeTier[];
  generationMode: QueryGenerationMode;
  generationReason: string;
  discoveryObjective: string;
  metadata: Record<string, unknown>;
}

export interface ProvenTerminologyAtom { id: number; term: string; score: number; lifecycle: 'SEARCH_TRIAL' | 'PROVEN_SEARCH_TERM' }

const COUNTRY_SEARCH_ATOMS: Record<string, Array<[string, SearchAtomType, QueryIntent]>> = {
  'United States': [['NQ Futures', 'INSTRUMENT', 'futures'], ['ES Futures', 'INSTRUMENT', 'futures'], ['Order Flow', 'METHOD', 'strategy'], ['Footprint Chart', 'METHOD', 'indicators'], ['ICT', 'METHOD', 'strategy'], ['Volume Profile', 'METHOD', 'indicators'], ['Premarket', 'FORMAT', 'premarket_prep']],
  'United Kingdom': [['FTSE Trading', 'INSTRUMENT', 'stocks'], ['GBPUSD', 'INSTRUMENT', 'forex'], ['Spread Betting', 'METHOD', 'strategy'], ['London Session', 'MARKET', 'session_analysis'], ['Price Action', 'METHOD', 'strategy'], ['Trading Psychology', 'METHOD', 'psychology']],
  Germany: [['DAX Analyse', 'INSTRUMENT', 'market_analysis'], ['DAX Trading', 'INSTRUMENT', 'futures'], ['Order Flow', 'METHOD', 'strategy'], ['Footprint Trading', 'METHOD', 'indicators'], ['Börsenanalyse', 'MARKET', 'market_analysis'], ['Technische Analyse', 'METHOD', 'education'], ['Futures Handel', 'METHOD', 'futures']],
  France: [['CAC40 Analyse', 'INSTRUMENT', 'market_analysis'], ['Analyse Technique', 'METHOD', 'education'], ['Trading Futures', 'METHOD', 'futures'], ['Smart Money', 'METHOD', 'strategy'], ['Euronext', 'MARKET', 'stocks'], ['Journal Trading', 'FORMAT', 'trading_journals'], ['Flux Ordres', 'METHOD', 'strategy']],
  Spain: [['IBEX35', 'INSTRUMENT', 'stocks'], ['Análisis Técnico', 'METHOD', 'education'], ['Trading Forex', 'METHOD', 'forex'], ['Order Flow', 'METHOD', 'strategy'], ['Trading Intradía', 'METHOD', 'live_trading'], ['Futuros Trading', 'METHOD', 'futures']],
  Netherlands: [['AEX Trading', 'INSTRUMENT', 'stocks'], ['Technische Analyse', 'METHOD', 'education'], ['Opties Handelen', 'METHOD', 'options'], ['Beurs Analyse', 'MARKET', 'market_analysis'], ['Daghandel', 'METHOD', 'live_trading'], ['Order Flow', 'METHOD', 'strategy']],
  Italy: [['FTSE MIB', 'INSTRUMENT', 'stocks'], ['Analisi Tecnica', 'METHOD', 'education'], ['Trading Futures', 'METHOD', 'futures'], ['Order Flow', 'METHOD', 'strategy'], ['Diario Trading', 'FORMAT', 'trading_journals'], ['Trading Intraday', 'METHOD', 'live_trading']],
  Australia: [['ASX Trading', 'INSTRUMENT', 'stocks'], ['ASX 200', 'INSTRUMENT', 'stocks'], ['AUDUSD', 'INSTRUMENT', 'forex'], ['Sydney Session', 'MARKET', 'session_analysis'], ['Price Action', 'METHOD', 'strategy'], ['Order Flow', 'METHOD', 'strategy']],
  Canada: [['TSX Trading', 'INSTRUMENT', 'stocks'], ['TSX 60', 'INSTRUMENT', 'stocks'], ['USDCAD', 'INSTRUMENT', 'forex'], ['Oil Trading', 'INSTRUMENT', 'futures'], ['Toronto Open', 'MARKET', 'premarket_prep'], ['Technical Analysis', 'METHOD', 'education']],
  Japan: [['日経225', 'INSTRUMENT', 'futures'], ['FX トレード', 'INSTRUMENT', 'forex'], ['オーダーフロー', 'METHOD', 'strategy'], ['テクニカル分析', 'METHOD', 'education'], ['板読み', 'METHOD', 'strategy'], ['デイトレード', 'METHOD', 'live_trading'], ['東京セッション', 'MARKET', 'session_analysis']],
  Switzerland: [['SMI Analyse', 'INSTRUMENT', 'market_analysis'], ['USDCHF', 'INSTRUMENT', 'forex'], ['Börsenanalyse Schweiz', 'METHOD', 'education']],
  Denmark: [['OMXC25', 'INSTRUMENT', 'stocks'], ['Teknisk Analyse', 'METHOD', 'education'], ['Aktiehandel', 'METHOD', 'strategy']],
  Sweden: [['OMXS30', 'INSTRUMENT', 'stocks'], ['Teknisk Analys', 'METHOD', 'education'], ['Börsanalys', 'MARKET', 'market_analysis']],
  'United Arab Emirates': [['DFM Trading', 'INSTRUMENT', 'stocks'], ['ADX Trading', 'INSTRUMENT', 'stocks'], ['Dubai Market', 'MARKET', 'market_analysis']],
  Singapore: [['STI Trading', 'INSTRUMENT', 'stocks'], ['SGX Trading', 'MARKET', 'market_analysis'], ['USDSGD', 'INSTRUMENT', 'forex']],
  'New Zealand': [['NZX50', 'INSTRUMENT', 'stocks'], ['NZDUSD', 'INSTRUMENT', 'forex'], ['NZX Trading', 'MARKET', 'market_analysis']],
  Belgium: [['BEL20', 'INSTRUMENT', 'stocks'], ['Beursanalyse', 'METHOD', 'education'], ['Euronext Brussels', 'MARKET', 'market_analysis']],
  Luxembourg: [['LuxX', 'INSTRUMENT', 'stocks'], ['Bourse Luxembourg', 'MARKET', 'market_analysis'], ['Börsenanalyse', 'METHOD', 'education']],
  Ireland: [['ISEQ20', 'INSTRUMENT', 'stocks'], ['Euronext Dublin', 'MARKET', 'market_analysis'], ['Irish Trading', 'METHOD', 'strategy']],
  Norway: [['OBX', 'INSTRUMENT', 'stocks'], ['Aksjehandel', 'METHOD', 'strategy'], ['Teknisk Analyse', 'METHOD', 'education']]
};

/**
 * Native query phrases and local platform/broker names. These are not
 * translations of English atoms: they are the surfaces local traders actually
 * use (live autocomplete and public YouTube results, 2026-11-08). They are
 * merged into the country atom set and can be selected as compact standalone
 * queries, so they do not need to be paired with a global instrument.
 */
const COUNTRY_NATIVE_QUERY_ATOMS: Record<string, Array<[string, SearchAtomType, QueryIntent]>> = {
  'United States': [['premarket analysis', 'MARKET', 'premarket_prep'], ['opening bell', 'MARKET', 'session_analysis'], ['Topstep', 'MARKET', 'strategy'], ['Apex Trader', 'MARKET', 'strategy']],
  'United Kingdom': [['London open', 'MARKET', 'session_analysis'], ['spread betting', 'METHOD', 'strategy'], ['IG Index', 'MARKET', 'stocks'], ['Trading 212', 'MARKET', 'stocks']],
  Germany: [['DAX Analyse heute', 'MARKET', 'market_analysis'], ['DAX Analyse aktuell', 'MARKET', 'market_analysis'], ['Charttechnik DAX', 'MARKET', 'market_analysis'], ['Orderflow DAX', 'MARKET', 'strategy'], ['Trade Republic', 'MARKET', 'stocks'], ['XTB DAX', 'MARKET', 'stocks']],
  France: [['analyse technique CAC', 'MARKET', 'market_analysis'], ["CAC 40 aujourd'hui", 'MARKET', 'market_analysis'], ['carnet ordres CAC', 'MARKET', 'strategy'], ['Boursorama CAC 40', 'MARKET', 'stocks'], ['Bourse Direct', 'MARKET', 'stocks'], ['PEA bourse', 'MARKET', 'stocks']],
  Spain: [['análisis técnico IBEX', 'MARKET', 'market_analysis'], ['IBEX 35 hoy', 'MARKET', 'market_analysis'], ['bolsa española análisis', 'MARKET', 'market_analysis'], ['velas japonesas', 'METHOD', 'indicators'], ['operativa intradía', 'METHOD', 'live_trading'], ['Bolsamanía IBEX', 'MARKET', 'market_analysis']],
  Netherlands: [['technische analyse AEX', 'MARKET', 'market_analysis'], ['AEX opening', 'MARKET', 'session_analysis'], ['opties AEX', 'MARKET', 'options'], ['Daghandel AEX', 'MARKET', 'live_trading'], ['Nico Bakker', 'MARKET', 'market_analysis'], ['Tostrams AEX', 'MARKET', 'market_analysis']],
  Italy: [['analisi tecnica FTSE', 'MARKET', 'market_analysis'], ['FTSE MIB oggi', 'MARKET', 'market_analysis'], ['analisi ciclica', 'METHOD', 'market_analysis'], ['titoli FTSE MIB', 'MARKET', 'stocks'], ['Milano Finanza', 'MARKET', 'market_analysis'], ['Teleborsa FTSE', 'MARKET', 'market_analysis']],
  Japan: [['日経225先物', 'MARKET', 'futures'], ['日経225 デイトレード', 'MARKET', 'live_trading'], ['日経225 チャート分析', 'MARKET', 'market_analysis'], ['ドル円 デイトレード', 'MARKET', 'forex'], ['板読み トレード', 'MARKET', 'strategy'], ['東京市場 オープン', 'MARKET', 'session_analysis']],
  Denmark: [['OMXC25 analyse', 'MARKET', 'market_analysis'], ['teknisk analyse aktier', 'MARKET', 'market_analysis'], ['aktiehandel Danmark', 'MARKET', 'stocks'], ['Nordnet Danmark', 'MARKET', 'stocks']],
  Sweden: [['OMXS30 analys', 'MARKET', 'market_analysis'], ['teknisk analys aktier', 'MARKET', 'market_analysis'], ['börsanalys Stockholm', 'MARKET', 'market_analysis'], ['Avanza aktier', 'MARKET', 'stocks']],
  Norway: [['OBX analyse', 'MARKET', 'market_analysis'], ['teknisk analyse aksjer', 'MARKET', 'market_analysis'], ['Oslo Børs analyse', 'MARKET', 'market_analysis'], ['Nordnet aksjer', 'MARKET', 'stocks']],
  Switzerland: [['Schweizer Börse Analyse', 'MARKET', 'market_analysis'], ['Charttechnik SMI', 'MARKET', 'market_analysis'], ['Swissquote SMI', 'MARKET', 'stocks']],
  Belgium: [['BEL20 analyse', 'MARKET', 'market_analysis'], ['beursanalyse België', 'MARKET', 'market_analysis'], ['Euronext Brussels analyse', 'MARKET', 'market_analysis'], ['Bolero aandelen', 'MARKET', 'stocks']],
  Luxembourg: [['LuxX Analyse', 'MARKET', 'market_analysis'], ['Bourse Luxembourg analyse', 'MARKET', 'market_analysis'], ['Swissquote Luxembourg', 'MARKET', 'stocks']],
  Ireland: [['ISEQ 20 analyse', 'MARKET', 'market_analysis'], ['Euronext Dublin', 'MARKET', 'market_analysis'], ['Davy Select', 'MARKET', 'stocks']],
  Singapore: [['STI analysis', 'MARKET', 'market_analysis'], ['SGX analysis', 'MARKET', 'market_analysis'], ['Singapore market outlook', 'MARKET', 'market_analysis'], ['DBS Vickers', 'MARKET', 'stocks']],
  'New Zealand': [['NZX 50 analysis', 'MARKET', 'market_analysis'], ['NZX market wrap', 'MARKET', 'market_analysis'], ['Sharesies investing', 'MARKET', 'stocks']],
  'United Arab Emirates': [['تداول الأسهم الإمارات', 'MARKET', 'stocks'], ['تحليل فني دبي', 'MARKET', 'market_analysis'], ['DFM trading', 'MARKET', 'stocks'], ['ADX trading', 'MARKET', 'stocks'], ['Sarwa investing', 'MARKET', 'stocks']],
};

export function getCuratedQueryCountries(): string[] {
  return Object.keys(COUNTRY_SEARCH_ATOMS);
}

/** Keep a replenishment floor per country so a rejected library can recover. */
export const NATIVE_QUERY_REFRESH_MIN_ACTIVE = 10;
export const NATIVE_QUERY_REFRESH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * The original selector only generated when the country had zero queries or
 * the eligible pool was empty. A country whose whole library had been rejected
 * therefore starved forever, and a healthy country never gained new native
 * phrases. Generate when the permanently eligible inventory is below the
 * floor. The cooldown is keyed to a persisted replenishment attempt rather
 * than an arbitrary row's created_at, so legacy/manual inserts cannot
 * suppress native generation and empty attempts still enter the cooldown.
 */
export function shouldGenerateNativeQueries(input: {
  active: number;
  lastAttemptAt?: string | Date | null;
  now: Date;
  minActive?: number;
  cooldownMs?: number;
}): boolean {
  const minActive = Math.max(1, input.minActive ?? NATIVE_QUERY_REFRESH_MIN_ACTIVE);
  const cooldownMs = Math.max(0, input.cooldownMs ?? NATIVE_QUERY_REFRESH_COOLDOWN_MS);
  if (Math.max(0, Math.trunc(input.active)) >= minActive) return false;
  if (!input.lastAttemptAt) return true;
  const attemptedAt = input.lastAttemptAt instanceof Date
    ? input.lastAttemptAt.getTime()
    : Date.parse(String(input.lastAttemptAt));
  if (!Number.isFinite(attemptedAt)) return true;
  return attemptedAt <= input.now.getTime() - cooldownMs;
}

const OBJECTIVES: Partial<Record<QueryIntent, string>> = {
  futures: 'Find active futures trading creators.', forex: 'Find foreign-exchange trading creators.', stocks: 'Find active equity-market creators.',
  options: 'Find options trading creators.', strategy: 'Find creators demonstrating trading methods.', indicators: 'Find creators using technical market tools.',
  education: 'Find creators teaching market analysis.', market_analysis: 'Find creators publishing current market analysis.',
  premarket_prep: 'Find creators publishing pre-session preparation.', session_analysis: 'Find session-specific market analysts.',
  live_trading: 'Find creators showing active trade execution.', trading_journals: 'Find creators documenting trades and lessons.',
  psychology: 'Find creators focused on trader discipline and psychology.'
};

const FORBIDDEN_PROSE = /\b(investor education|regulated trading|stock exchange|rate decision|weekly trade breakdown|market update)\b/i;
/**
 * Anti-collision barrier for bare short tickers (P3-03): 2–4 ASCII
 * alphanumerics as a standalone query (NG, ES, NQ, AI, ICT, SMI) collide
 * across markets, languages, and country codes (search itself is
 * case-insensitive, so the barrier is too). Such tokens may only travel
 * with qualifying market context ("NQ Futures"); the pair templates provide
 * that, single-token queries never do. Non-Latin short terms (e.g. 板読み)
 * are genuine vocabulary, not tickers, and are unaffected.
 */
const BARE_SHORT_TICKER = /^[A-Z0-9]{2,4}$/i;

/** True for standalone short tickers (NG, ES, NQ, ICT): only pairable, never searchable alone. */
export function isBareShortTicker(query: string): boolean {
  const normalized = query.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return queryTokenCount(normalized) === 1 && BARE_SHORT_TICKER.test(normalized);
}
const NON_LATIN = /[\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Devanagari}\p{Script=Hangul}]/u;
const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function normalizeQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

export function queryTokenCount(query: string): number {
  return query.normalize('NFKC').trim().split(/\s+/u).filter(Boolean).length;
}

export function isCountryScriptCompatible(country: string, query: string): boolean {
  if (country === 'United Arab Emirates') return !/[\p{Script=Cyrillic}\p{Script=Devanagari}\p{Script=Hangul}]/u.test(query) && !JAPANESE.test(query);
  if (country === 'Singapore') return !NON_LATIN.test(query) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query);
  if (NON_LATIN.test(query)) return false;
  if (country !== 'Japan') return !JAPANESE.test(query);
  if (JAPANESE.test(query)) return true;
  return /^[A-Z0-9./ -]{1,12}$/.test(query.trim());
}

export function isRetrievalOrientedQuery(country: string, query: string, languageContext?: GlobalLanguageContext & { governed?: boolean }): boolean {
  const normalized = query.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const scriptCompatible = languageContext?.governed
    ? assessLanguageCapability([{ field: 'query', text: normalized, language: languageContext.contentLanguage }], languageContext).disposition !== 'ABSTAIN'
    : isCountryScriptCompatible(country, normalized);
  // A reviewed native phrase is a bounded whole-query exception to the token
  // cap. It is still subject to the length, ticker, prose and script gates.
  const tokenLimit = isReviewedNativePhrase(normalized) ? 6 : languageContext?.governed ? 4 : 3;
  return normalized.length >= 2 && normalized.length <= 40 && queryTokenCount(normalized) <= tokenLimit &&
    !isBareShortTicker(normalized) &&
    !FORBIDDEN_PROSE.test(normalized) && scriptCompatible;
}

export function queriesOutsideCooldown(queries: QueryRecord[], now: Date, cooldownMinutes: number): QueryRecord[] {
  const cutoff = now.getTime() - cooldownMinutes * 60_000;
  const blocked = new Set(queries.filter(query => query.last_executed && new Date(query.last_executed).getTime() > cutoff).map(query => normalizeQuery(query.query)));
  return queries.filter(query => !blocked.has(normalizeQuery(query.query)));
}

export function limitRepeatedPrimaryTerms(queries: QueryRecord[], allQueries: QueryRecord[], now: Date, cooldownMinutes: number, maxUses: number): QueryRecord[] {
  const cutoff = now.getTime() - cooldownMinutes * 60_000;
  const usage = new Map<string, number>();
  for (const query of allQueries) {
    if (!query.primary_term || !query.last_executed || new Date(query.last_executed).getTime() <= cutoff) continue;
    const key = normalizeQuery(query.primary_term);
    usage.set(key, (usage.get(key) || 0) + 1);
  }
  return queries.filter(query => !query.last_executed || !query.primary_term || (usage.get(normalizeQuery(query.primary_term)) || 0) < maxUses);
}

export function rotateAwayFromMostRecentIntent(eligible: QueryRecord[], history: QueryRecord[]): QueryRecord[] {
  const mostRecent = history.filter(query => query.last_executed).sort((a, b) => new Date(b.last_executed!).getTime() - new Date(a.last_executed!).getTime())[0];
  if (!mostRecent || !eligible.some(query => query.intent !== mostRecent.intent)) return eligible;
  return eligible.filter(query => query.intent !== mostRecent.intent);
}

/**
 * Constructs one governed query for an immutable COUNTRY_NATIVE allocation.
 * The learned native surface remains a modifier; the existing curated/country
 * vocabulary atom policy supplies the independently authorized retrieval anchor.
 */
export function planFrontierTargetedQuery(args: {
  country: string;
  target: DiscoveryNeighborhoodDimensions;
}): PlannedQuery | null {
  const targetTerm = args.target.primaryTermFamily.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (isAmbiguousShortModifier(targetTerm)) return null;
  const anchor = atom('trading', 'METHOD', (args.target.queryIntent || 'strategy') as QueryIntent, 1, 'CURATED');
  const neighborhood = atom(targetTerm, 'NEIGHBORHOOD', (args.target.queryIntent || 'strategy') as QueryIntent, 1, 'COUNTRY_VOCABULARY');
  const query = `${anchor.term} ${neighborhood.term}`.trim();
  if (!targetTerm || !isRetrievalOrientedQuery(args.country, query)) return null;
  return {
    query,
    intent: (args.target.queryIntent || 'strategy') as QueryIntent,
    primaryTerm: targetTerm,
    knowledgeTiers: [1],
    generationMode: 'EXPLORATION',
    generationReason: 'Governed frontier target fallback using an authorized trading anchor and canonical neighborhood modifier.',
    discoveryObjective: 'Test the selected frontier neighborhood while discovering relevant trading creators.',
    metadata: {
      country: args.country,
      queryTemplate: 'ANCHOR_LEARNED',
      retrievalOptimized: true,
      tokenCount: queryTokenCount(query),
      scriptValidated: true,
      retrievalSpecificity: { ...anchor.retrievalPolicy },
      atoms: [anchor, neighborhood].map((item, position) => ({ ...item, role: position === 0 ? 'ANCHOR' : 'MODIFIER', position })),
      localTier1Term: anchor.term,
      learnedTerm: targetTerm,
      targetNeighborhoodDimensions: args.target
    }
  };
}

export function planCountryNativeProposalQuery(args: {
  country: string;
  nativeTerm: string;
  countryVocabulary?: CountryVocabulary;
  targetIntent: string;
  allocationLineage: Record<string, unknown>;
  language?: string | null;
  locale?: string | null;
  dominantLocale?: string | null;
}): PlannedQuery | null {
  const nativeTerm = args.nativeTerm.normalize('NFKC').trim().replace(/\s+/g, ' ');
  // The country-native proposal path is separate from planDiverseQueries and
  // must enforce the same ambiguous-short-modifier rule before it creates a
  // LEARNED atom or receives allocation lineage.
  if (isAmbiguousShortModifier(nativeTerm)) return null;
  const reviewedPhrase = isReviewedNativePhrase(nativeTerm);
  // Unknown long surfaces stay rejected. A reviewed native phrase may exceed
  // the normal three-token atom cap because it is a bounded whole query.
  if (!nativeTerm || (!reviewedPhrase && queryTokenCount(nativeTerm) > 3)) return null;
  const learned = atom(nativeTerm, 'LEARNED', (args.targetIntent || 'strategy') as QueryIntent, 2, 'LEARNED');
  const languageEvidence = [args.language, args.locale, args.dominantLocale]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const supportedLanguages = countrySearchLanguageCandidates(args.country, args.countryVocabulary?.languages || []);
  const preferredLanguage = languageEvidence
    .map(normalizeLanguageCode)
    .find(language => language && supportedLanguages.includes(language));
  // The reviewed allowlist is language-owned. An Italian phrase must not be
  // authorized as a Japanese native surface merely because it is reviewed.
  const phraseLanguages = reviewedPhrase ? reviewedNativePhraseLanguages(nativeTerm) : [];
  const declaredLanguage = languageEvidence.map(normalizeLanguageCode).find(Boolean);
  if (reviewedPhrase && (
    !phraseLanguages.some(language => supportedLanguages.includes(language))
    || (declaredLanguage && !phraseLanguages.includes(declaredLanguage))
  )) {
    return null;
  }
  // A reviewed phrase that cannot fit beside an authorized anchor runs whole.
  // Mark it STANDALONE in both the top-level and atom policy so execution
  // authority does not quarantine it as an unanchored expansion surface.
  const reviewedPolicy = {
    ...learned.retrievalPolicy,
    eligibility: 'STANDALONE' as const,
    specificity: Math.max(learned.retrievalPolicy.specificity, 70),
    ambiguity: Math.min(learned.retrievalPolicy.ambiguity, 30),
    // The reviewed exception replaces the generic expansion warning; keeping
    // both would leave contradictory audit provenance.
    reasonCodes: [
      ...new Set([
        ...learned.retrievalPolicy.reasonCodes.filter(code => code !== 'EXPANSION_SURFACE_REQUIRES_TRADING_ANCHOR'),
        'REVIEWED_NATIVE_PHRASE',
      ]),
    ],
    requiredCompanionClasses: [],
  };
  const wholePhrase = (): PlannedQuery => ({
    query: nativeTerm,
    intent: (args.targetIntent || 'strategy') as QueryIntent,
    primaryTerm: nativeTerm,
    knowledgeTiers: [2],
    generationMode: 'EXPLORATION',
    generationReason: 'Reviewed native phrase executed as its own bounded retrieval surface.',
    discoveryObjective: 'Test the reviewed country-native phrase while discovering relevant trading creators.',
    metadata: {
      country: args.country,
      queryTemplate: 'REVIEWED_NATIVE_PHRASE',
      retrievalOptimized: true,
      tokenCount: queryTokenCount(nativeTerm),
      scriptValidated: true,
      retrievalSpecificity: reviewedPolicy,
      atoms: [{ ...learned, retrievalPolicy: reviewedPolicy, role: 'ANCHOR', position: 0 }],
      localTier1Term: nativeTerm,
      learnedTerm: nativeTerm,
      countryNativeAllocation: args.allocationLineage,
      language: args.language || undefined,
      locale: args.locale || undefined,
      dominantLocale: args.dominantLocale || undefined,
      preferredLanguage
    }
  });
  if (reviewedPhrase && queryTokenCount(nativeTerm) > 3) return wholePhrase();
  const anchor = countryAtoms(args.country, args.countryVocabulary)
    .filter(item => ['STANDALONE', 'ANCHOR_ONLY'].includes(item.retrievalPolicy.eligibility))
    .find(item => isRetrievalOrientedQuery(args.country, `${item.term} ${nativeTerm}`));
  if (!anchor) return reviewedPhrase ? wholePhrase() : null;
  const query = `${anchor.term} ${nativeTerm}`;
  // Even a short reviewed phrase can overflow once the anchor is added; in
  // that case the bounded whole-query reading is the only admissible shape.
  if (reviewedPhrase && !isRetrievalOrientedQuery(args.country, query)) return wholePhrase();
  return {
    query,
    intent: (args.targetIntent || anchor.intent) as QueryIntent,
    // Preserve the allocated neighborhood identity even though the native term
    // is safely executed as a governed modifier behind an authorized anchor.
    primaryTerm: nativeTerm,
    knowledgeTiers: [1, 2],
    generationMode: 'EXPLORATION',
    generationReason: 'Governed COUNTRY_NATIVE allocation combined with an authorized local retrieval anchor.',
    discoveryObjective: 'Test the selected country-native terminology while discovering relevant trading creators.',
    metadata: {
      country: args.country,
      queryTemplate: 'ANCHOR_LEARNED',
      retrievalOptimized: true,
      tokenCount: queryTokenCount(query),
      scriptValidated: true,
      retrievalSpecificity: { ...anchor.retrievalPolicy },
      atoms: [anchor, learned].map((item, position) => ({ ...item, role: position === 0 ? 'ANCHOR' : 'MODIFIER', position })),
      localTier1Term: anchor.term,
      learnedTerm: nativeTerm,
      countryNativeAllocation: args.allocationLineage,
      language: args.language || undefined,
      locale: args.locale || undefined,
      dominantLocale: args.dominantLocale || undefined,
      preferredLanguage
    }
  };
}

function inferIntent(term: string, fallback: QueryIntent): QueryIntent {
  const value = normalizeQuery(term);
  if (/future|fdax|bund|先物/.test(value)) return 'futures';
  if (/forex|eurusd|gbpusd|usdcad|audusd|usdjpy|fx|ドル円/.test(value)) return 'forex';
  if (/option|opties/.test(value)) return 'options';
  if (/journal|diario|bitácora|日記/.test(value)) return 'trading_journals';
  if (/live|intrad|daytrad|daghandel|デイトレ/.test(value)) return 'live_trading';
  if (/analyse|análisis|analisi|analysis|分析/.test(value)) return 'market_analysis';
  return fallback;
}

function atom(term: string, type: SearchAtomType, intent: QueryIntent, tier: QueryKnowledgeTier, origin: SearchAtom['origin']): SearchAtom {
  return { term: term.normalize('NFKC').trim().replace(/\s+/g, ' '), type, intent: inferIntent(term, intent), tier, origin,
    retrievalPolicy:evaluateRetrievalSpecificity({semanticClass:type,governed:origin==='CURATED'||origin==='ORGANIC'}) };
}

function freeSignalAtomType(signalType: FreeSignalType): SearchAtomType {
  switch (signalType) {
    case 'INSTRUMENT': return 'INSTRUMENT';
    case 'MARKET':
    case 'EXCHANGE': return 'MARKET';
    case 'METHOD': return 'METHOD';
    case 'FORMAT': return 'FORMAT';
    case 'REGULATOR':
    case 'ALIAS':
    case 'ENTITY':
    default: return 'ENTITY';
  }
}

function freeSignalIntent(signalType: FreeSignalType): QueryIntent {
  switch (signalType) {
    case 'INSTRUMENT': return 'market_analysis';
    case 'METHOD': return 'strategy';
    case 'MARKET':
    case 'EXCHANGE': return 'session_analysis';
    case 'FORMAT': return 'education';
    default: return 'market_analysis';
  }
}

/**
 * Paid demand is optional and default-off. When it is ever enabled, only 30%
 * of a country's portfolio may be demand-only; the remainder must come from
 * terminology, free signals, and seeds. This is a ranking cap, never evidence.
 */
export function capDemandSignalCandidates<T>(candidates: T[], count: number): T[] {
  if (!candidates.length) return [];
  const requested = Math.max(1, Math.trunc(count) || 1);
  // Demand signals are supplementary: a small portfolio may have no room for
  // them. Forcing one candidate violates the 30% share rather than enforcing it.
  return candidates.slice(0, Math.floor(requested * 0.3));
}

function countryAtoms(country: string, vocabulary?: CountryVocabulary): SearchAtom[] {
  const curated = (COUNTRY_SEARCH_ATOMS[country] || []).map(([term, type, intent]) => atom(term, type, intent, 1, 'CURATED'));
  const nativeQueries = (COUNTRY_NATIVE_QUERY_ATOMS[country] || []).map(([term, type, intent]) => {
    const nativeAtom = atom(term, type, intent, 1, 'COUNTRY_VOCABULARY');
    // These are reviewed local surfaces, not ambiguous generic markets. They
    // are allowed to stand alone; the generic MARKET specificity policy would
    // otherwise force a companion and lose the actual local search phrase.
    nativeAtom.retrievalPolicy = {
      ...nativeAtom.retrievalPolicy,
      eligibility: 'STANDALONE',
      reasonCodes: [...nativeAtom.retrievalPolicy.reasonCodes, 'REVIEWED_NATIVE_PHRASE'],
    };
    return nativeAtom;
  });
  const vocabularyAtoms = [
    ...(vocabulary?.popular_instruments || []).map(term => atom(term, 'INSTRUMENT', 'market_analysis', 1, 'COUNTRY_VOCABULARY')),
    ...(vocabulary?.native_trading_terminology || []).map(term => atom(term, 'METHOD', 'strategy', 1, 'COUNTRY_VOCABULARY')),
    ...(vocabulary?.local_market_phrases || []).map(term => atom(term, 'MARKET', 'session_analysis', 1, 'COUNTRY_VOCABULARY')),
    ...(vocabulary?.common_content_format_names || []).map(term => atom(term, 'FORMAT', 'education', 1, 'COUNTRY_VOCABULARY'))
  ];
  const unique = new Map<string, SearchAtom>();
  for (const candidate of [...curated, ...nativeQueries, ...vocabularyAtoms]) {
    // Bare short tickers stay pairable here: the ticker barrier applies to
    // final assembled queries (single-token gate above), so atoms like OBX
    // or ICT can still form qualified pairs such as "OBX Aksjehandel".
    if ((isRetrievalOrientedQuery(country, candidate.term) || isBareShortTicker(candidate.term)) && !unique.has(normalizeQuery(candidate.term))) unique.set(normalizeQuery(candidate.term), candidate);
  }
  return [...unique.values()];
}

export function planDiverseQueries(args: {
  country: string;
  count: number;
  countryVocabulary?: CountryVocabulary;
  learnedVocabulary: ExtractedTermRecord[];
  existingQueries: QueryRecord[];
  provenTerminology?: ProvenTerminologyAtom[];
  organicCandidates?: OrganicQueryCandidate[];
  /** Wikipedia/Wikidata aliases and entities (candidate vocabulary only). */
  freeSignalCandidates?: FreeSignalQueryCandidate[];
  /** Optional paid demand surfaces. Only supplied when the paid adapter is enabled. */
  demandSignalCandidates?: DemandSignalQueryCandidate[];
  /** Accepted standalone extracted-query candidates from the ledger. */
  standaloneExtractedCandidates?: Array<{
    id: number;
    candidateText: string;
    language: string;
    intent: string;
    confidence: number;
    sourceTitle?: string | null;
  }>;
  mode?: QueryGenerationMode;
  /**
   * Persistent-scope promotion basis. Set when the country was explicitly
   * selected by the operator ('PERSISTENT_SCOPE_SELECTION' for persistent
   * prioritized scope, 'DIRECT_TARGET' for a direct on-demand target). A
   * supported country with no authorized (curated/governed) anchor otherwise
   * plans zero candidates forever, so the dormant classification would
   * silently override the explicit selection every scheduler cycle. When
   * promotion applies, vocabulary INSTRUMENT atoms may anchor paired
   * templates only. They are never authorized standalone: bare unanchored
   * surfaces stay dormant and all retrieval-shape gates still apply. The
   * basis is stamped into planned metadata so audit records distinguish the
   * authorization source.
   */
  scopePromotionBasis?: 'PERSISTENT_SCOPE_SELECTION' | 'DIRECT_TARGET';
}): PlannedQuery[] {
  const count = Math.max(1, args.count);
  const mode = args.mode || (args.existingQueries.length ? 'EXPLORATION' : 'COLD_START');
  const blocked = new Set(args.existingQueries.map(item => normalizeQuery(item.query)));
  const generated = new Set<string>();
  const anchors = countryAtoms(args.country, args.countryVocabulary);
  const supportedLanguages = countrySearchLanguageCandidates(args.country, args.countryVocabulary?.languages || []);
  const intentUsage = new Map<QueryIntent, number>();
  args.existingQueries.forEach(query => intentUsage.set(query.intent, (intentUsage.get(query.intent) || 0) + 1));
  type FreePlanCandidate = {
    atoms: SearchAtom[];
    template: 'ANCHOR_FREE_SIGNAL' | 'FREE_SIGNAL_STANDALONE';
    freeSignal: FreeSignalQueryCandidate;
  };
  type DemandPlanCandidate = {
    atoms: SearchAtom[];
    template: 'ANCHOR_DEMAND_SIGNAL' | 'DEMAND_SIGNAL_STANDALONE';
    demand: DemandSignalQueryCandidate;
  };
  type ExtractedPlanCandidate = { atoms: SearchAtom[]; template: 'EXTRACTED_STANDALONE'; extracted: NonNullable<typeof args.standaloneExtractedCandidates>[number] };
  const candidates: Array<{
    atoms: SearchAtom[];
    template: 'SINGLE_ATOM' | 'COMPACT_PAIR' | 'INSTRUMENT_MARKET' | 'MARKET_INSTRUMENT' | 'METHOD_INSTRUMENT' | 'ANCHOR_LEARNED' | 'EXTRACTED_STANDALONE' | 'ORGANIC_STANDALONE' | 'ANCHOR_ORGANIC' | 'ANCHOR_FREE_SIGNAL' | 'FREE_SIGNAL_STANDALONE' | 'ANCHOR_DEMAND_SIGNAL' | 'DEMAND_SIGNAL_STANDALONE';
    organic?: ReturnType<typeof admitOrganicQueryCandidates>[number];
    freeSignal?: FreeSignalQueryCandidate;
    demand?: DemandSignalQueryCandidate;
    extracted?: ExtractedPlanCandidate['extracted'];
  }> = anchors.filter(searchAtom=>searchAtom.retrievalPolicy.eligibility==='STANDALONE'||searchAtom.retrievalPolicy.eligibility==='ANCHOR_ONLY').map(searchAtom => ({ atoms: [searchAtom], template: 'SINGLE_ATOM' }));

  // Accepted extracted queries are first-class standalone surfaces. They are
  // integrated with the same admission, execution authority and lifecycle as
  // every other query; the ledger gate already checked native intent/shape.
  const extractedStandaloneCandidates = (args.standaloneExtractedCandidates || [])
    .slice(0, Math.max(0, Math.floor(count * 0.4)))
    .map(extracted => {
      const standaloneAtom = atom(extracted.candidateText, 'LEARNED', (extracted.intent || 'strategy') as QueryIntent, 2, 'EXTRACTED_STANDALONE');
      standaloneAtom.retrievalPolicy = {
        ...standaloneAtom.retrievalPolicy,
        eligibility: 'STANDALONE',
        specificity: Math.max(standaloneAtom.retrievalPolicy.specificity, 70),
        ambiguity: Math.min(standaloneAtom.retrievalPolicy.ambiguity, 30),
        reasonCodes: [...new Set([...standaloneAtom.retrievalPolicy.reasonCodes.filter(code => code !== 'EXPANSION_SURFACE_REQUIRES_TRADING_ANCHOR'), 'EXTRACTED_STANDALONE_QUERY'])],
        requiredCompanionClasses: [],
      };
      return { atoms: [standaloneAtom], template: 'EXTRACTED_STANDALONE' as const, extracted };
    });
  candidates.splice(Math.min(2, candidates.length), 0, ...extractedStandaloneCandidates);

  // Only combine semantically compatible atoms: a concrete instrument/market
  // anchor plus one trading method. Formats and unrelated concepts never mix.
  const methods = anchors.filter(item => item.type === 'METHOD');
  const authorizedAnchors = anchors.filter(item => ['STANDALONE', 'ANCHOR_ONLY'].includes(item.retrievalPolicy.eligibility));
  // Scope-promoted fallback: a scope-selected country with no authorized anchor
  // (e.g. no curated atoms) borrows its own retrieval-oriented vocabulary
  // INSTRUMENT atoms as pairing anchors. Bare short tickers stay pairable
  // here (mirroring countryAtoms): the ticker barrier applies to the final
  // assembled pair below, so a ticker-only country can still bootstrap.
  // SINGLE_ATOM candidates above still use only truly-authorized atoms, so
  // promotion can never authorize a bare unanchored surface.
  const hasAuthorizedAnchor = authorizedAnchors.length > 0;
  const promotedAnchors = args.scopePromotionBasis != null && !hasAuthorizedAnchor
    ? anchors.filter(item => item.type === 'INSTRUMENT' && item.origin === 'COUNTRY_VOCABULARY' &&
        (isRetrievalOrientedQuery(args.country, item.term) || isBareShortTicker(item.term)))
    : [];
  const pairingAnchors = hasAuthorizedAnchor ? authorizedAnchors : promotedAnchors;
  const compatiblePairs = pairingAnchors
    .filter(item => item.type === 'INSTRUMENT' || item.type === 'MARKET')
    .flatMap(anchor => methods.map(method => ({ atoms: [anchor, method], template: 'COMPACT_PAIR' as const })))
    .filter(candidate => isRetrievalOrientedQuery(args.country, candidate.atoms.map(item => item.term).join(' ')));
  candidates.push(...compatiblePairs);

  // A concrete local instrument plus a local market/exchange is a safe,
  // country-specific retrieval shape when the finite method combinations have
  // all been used recently. It preserves the hard cooldown and deduplication
  // gates while providing a novel variant without inventing terminology.
  const instrumentMarketPairs = pairingAnchors
    .filter(item => item.type === 'INSTRUMENT')
    .flatMap(instrument => anchors
      .filter(item => item.type === 'MARKET')
      .map(market => ({ atoms: [instrument, market], template: 'INSTRUMENT_MARKET' as const })))
    .filter(candidate => isRetrievalOrientedQuery(args.country, candidate.atoms.map(item => item.term).join(' ')));
  candidates.push(...instrumentMarketPairs);

  // Preserve primary-term diversity when instrument-led variants have already
  // reached the recent-use cap: an authorized market anchor plus a concrete
  // instrument is an equally bounded country-specific retrieval shape.
  const marketInstrumentPairs = pairingAnchors
    .filter(item => item.type === 'MARKET')
    .flatMap(market => pairingAnchors
      .filter(item => item.type === 'INSTRUMENT')
      .map(instrument => ({ atoms: [market, instrument], template: 'MARKET_INSTRUMENT' as const })))
    .filter(candidate => isRetrievalOrientedQuery(args.country, candidate.atoms.map(item => item.term).join(' ')));
  candidates.push(...marketInstrumentPairs);

  // A governed method can also lead a compound query when paired with a
  // concrete instrument modifier. This is distinct from unsafe standalone
  // generic-method retrieval and prevents countries with one curated
  // instrument anchor from exhausting their finite query space.
  const methodInstrumentPairs = pairingAnchors
    .filter(item => item.type === 'METHOD')
    .flatMap(method => anchors
      .filter(item => item.type === 'INSTRUMENT')
      .map(instrument => ({ atoms: [method, instrument], template: 'METHOD_INSTRUMENT' as const })))
    .filter(candidate => isRetrievalOrientedQuery(args.country, candidate.atoms.map(item => item.term).join(' ')));
  candidates.push(...methodInstrumentPairs);

  // Q0d defence-in-depth: the same pure searchability gate applies to the
  // canonical PROVEN/TRIAL path and to the legacy tier-2 extracted-vocabulary
  // path, so a directly seeded bad row or a second-creator legacy promotion
  // can never become a planner atom.
  const terminatedByGate: Array<{ term: string; path: 'CANONICAL' | 'LEGACY'; reasons: string[] }> = [];
  const gateLearnedTerm = (term: string, termType: string | undefined, path: 'CANONICAL' | 'LEGACY') => {
    if (isAmbiguousShortModifier(term)) {
      terminatedByGate.push({ term, path, reasons: ['ambiguous-short-modifier'] });
      return false;
    }
    const gate = isSearchableTradingTerm({ term, termType, country: args.country });
    if (!gate.eligible) terminatedByGate.push({ term, path, reasons: gate.reasons });
    return gate.eligible;
  };
  const proven = (args.provenTerminology || [])
    .filter(term => gateLearnedTerm(term.term, term.lifecycle === 'PROVEN_SEARCH_TERM' ? 'TERMINOLOGY' : 'TERMINOLOGY', 'CANONICAL'))
    .map(term => ({
      atom: atom(term.term, 'LEARNED', 'strategy', term.lifecycle === 'PROVEN_SEARCH_TERM' ? 1 : 2, 'LEARNED'),
      terminology: term
    }));
  const provenByTerm = new Map(proven.map(item => [normalizeQuery(item.atom.term), item.terminology]));
  // Legacy extracted vocabulary is not the governed terminology lifecycle. Only
  // terms independently validated by at least two confirmed creators may remain
  // eligible here; CANDIDATE/OBSERVED tier-3 terms stay evidence-only until the
  // canonical terminology lifecycle promotes them into `provenTerminology`.
  const legacyLearned = args.learnedVocabulary
    .filter(term => term.trust_tier === 2 && (term.validation_count || 0) >= 2)
    .filter(term => !proven.some(item => normalizeQuery(item.atom.term) === normalizeQuery(term.term)))
    .filter(term => gateLearnedTerm(term.term, term.category?.toUpperCase(), 'LEGACY'))
    .map(term => ({ atom: atom(term.term, 'LEARNED', 'strategy', term.trust_tier === 2 ? 2 : 3, 'LEARNED'), terminology: undefined }));
  const learnedCandidates = [...proven, ...legacyLearned].flatMap(({ atom: learnedAtom, terminology }, index) => {
    const rotated = [...anchors.slice(index), ...anchors.slice(0, index)];
    const anchor = rotated.find(item => ['STANDALONE','ANCHOR_ONLY'].includes(item.retrievalPolicy.eligibility) && isRetrievalOrientedQuery(args.country, `${item.term} ${learnedAtom.term}`));
    if (!anchor) return [];
    return [{ atoms: [anchor, learnedAtom], template: 'ANCHOR_LEARNED' as const, terminology }];
  });
  candidates.splice(Math.min(3, candidates.length), 0, ...learnedCandidates);
  const organic = admitOrganicQueryCandidates(args.organicCandidates || []);
  type OrganicPlanCandidate = { atoms: SearchAtom[]; template: 'ORGANIC_STANDALONE' | 'ANCHOR_ORGANIC'; organic: ReturnType<typeof admitOrganicQueryCandidates>[number] };
  const organicCandidates = organic.flatMap<OrganicPlanCandidate>((candidate, index) => {
    const organicAtom = atom(candidate.surface, candidate.sourceType === 'RELATED_ENTITY' || candidate.sourceType === 'EXTERNAL_ENTITY' ? 'ENTITY' : candidate.sourceType === 'CREATOR_NEIGHBORHOOD' ? 'NEIGHBORHOOD' : candidate.sourceType === 'COVERAGE_GAP' ? 'COVERAGE' : candidate.sourceType === 'PLAYLIST_TOPIC' || candidate.sourceType === 'TRANSCRIPT_KEYPHRASE' ? 'TOPIC' : 'CONCEPT', candidate.intent, candidate.lifecycle === 'PROVEN' ? 1 : 2, 'ORGANIC');
    organicAtom.retrievalPolicy=evaluateRetrievalSpecificity({semanticClass:organicAtom.type,governed:true,proven:candidate.lifecycle==='PROVEN',validated:Object.values(candidate.validation).every(Boolean),independentSources:new Set(candidate.independentSourceIds).size});
    const globalContext = { ...candidate.languageCapability.context, governed: true };
    if (candidate.lifecycle === 'PROVEN' && organicAtom.retrievalPolicy.eligibility==='STANDALONE' && isRetrievalOrientedQuery(args.country, organicAtom.term, globalContext)) return [{ atoms: [organicAtom], template: 'ORGANIC_STANDALONE' as const, organic: candidate }];
    const rotated = [...anchors.slice(index), ...anchors.slice(0, index)];
    const anchor = rotated.find(item => ['STANDALONE','ANCHOR_ONLY'].includes(item.retrievalPolicy.eligibility) && isRetrievalOrientedQuery(args.country, `${item.term} ${organicAtom.term}`, globalContext));
    return anchor ? [{ atoms: [anchor, organicAtom], template: 'ANCHOR_ORGANIC' as const, organic: candidate }] : [];
  });
  candidates.splice(Math.min(2, candidates.length), 0, ...organicCandidates);

  // Free signals are candidate vocabulary only: they may bootstrap a country
  // with no creator evidence, but they can never crowd out creator-observed
  // terminology (capFreeSignalCandidates reserves the portfolio majority for
  // existing candidates). They never write an observation or lifecycle row.
  // Build corroboration from the already-gated `proven` set, never from the
  // raw input: a term rejected by the searchability gate must not attach a
  // terminology id to a free-signal query.
  const provenBySurface = new Map<string, ProvenTerminologyAtom>(
    proven.map(item => [normalizeQuery(item.atom.term), item.terminology]),
  );
  const freeSignalPlanCandidates = (args.freeSignalCandidates || []).flatMap<FreePlanCandidate>(candidate => {
    const surface = candidate.surface.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!surface) return [];
    const freeAtom = atom(surface, freeSignalAtomType(candidate.signalType), freeSignalIntent(candidate.signalType), 3, 'FREE_SIGNAL');
    if (!isRetrievalOrientedQuery(args.country, freeAtom.term) && !isBareShortTicker(freeAtom.term)) return [];
    const anchor = pairingAnchors.find(item =>
      ['STANDALONE', 'ANCHOR_ONLY'].includes(item.retrievalPolicy.eligibility)
      && isRetrievalOrientedQuery(args.country, `${item.term} ${freeAtom.term}`));
    if (anchor) return [{ atoms: [anchor, freeAtom], template: 'ANCHOR_FREE_SIGNAL' as const, freeSignal: candidate }];
    // Bootstrap-only: a free surface may stand alone only when no authorized
    // creator-observed anchor exists at all, its semantic class is concrete,
    // and it still passes the same retrieval-shape gate as every other query.
    if (!hasAuthorizedAnchor && (freeAtom.type === 'INSTRUMENT' || freeAtom.type === 'METHOD') && isRetrievalOrientedQuery(args.country, freeAtom.term)) {
      return [{ atoms: [freeAtom], template: 'FREE_SIGNAL_STANDALONE' as const, freeSignal: candidate }];
    }
    return [];
  });
  // Apply the cooldown/duplicate filters BEFORE the one-third free-signal cap:
  // otherwise the first cap candidates can all be blocked and later fresh free
  // signals are never considered. Deduplicate within this batch for the same
  // reason.
  const seenFreeSignalQueries = new Set<string>();
  const availableFreeSignalCandidates = freeSignalPlanCandidates.filter(candidate => {
    const queryText = normalizeQuery(candidate.atoms.map(item => item.term).join(' '));
    if (blocked.has(queryText) || seenFreeSignalQueries.has(queryText)) return false;
    seenFreeSignalQueries.add(queryText);
    return true;
  });
  const cappedFreeSignalCandidates = capFreeSignalCandidates(
    availableFreeSignalCandidates,
    count,
    Math.min(count, candidates.length),
  );
  candidates.splice(Math.min(1, candidates.length), 0, ...cappedFreeSignalCandidates);

  // Optional paid demand signals. The caller only supplies these when the
  // paid adapter is enabled; the 30% demand-only cap keeps them subordinate
  // to terminology, free signals, and seeds.
  const demandPlanCandidates = (args.demandSignalCandidates || []).flatMap<DemandPlanCandidate>(candidate => {
    const surface = candidate.surface.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!surface) return [];
    const demandAtom = atom(surface, 'ENTITY', 'market_analysis', 3, 'DEMAND_SIGNAL');
    const anchor = pairingAnchors.find(item =>
      ['STANDALONE', 'ANCHOR_ONLY'].includes(item.retrievalPolicy.eligibility)
      && isRetrievalOrientedQuery(args.country, `${item.term} ${demandAtom.term}`));
    if (anchor) return [{ atoms: [anchor, demandAtom], template: 'ANCHOR_DEMAND_SIGNAL' as const, demand: candidate }];
    if (!hasAuthorizedAnchor && isRetrievalOrientedQuery(args.country, demandAtom.term)) {
      return [{ atoms: [demandAtom], template: 'DEMAND_SIGNAL_STANDALONE' as const, demand: candidate }];
    }
    return [];
  });
  // Only demand-ONLY queries consume the 30% cap. An anchored demand surface
  // is a MIXED query (local anchor + demand modifier), not a demand-only one.
  const cappedStandaloneDemand = capDemandSignalCandidates(
    demandPlanCandidates.filter(candidate => candidate.template === 'DEMAND_SIGNAL_STANDALONE'),
    count,
  );
  const anchoredDemand = demandPlanCandidates.filter(candidate => candidate.template === 'ANCHOR_DEMAND_SIGNAL');
  candidates.splice(Math.min(2, candidates.length), 0, ...anchoredDemand, ...cappedStandaloneDemand);

  candidates.sort((a, b) => (intentUsage.get(a.atoms[0].intent) || 0) - (intentUsage.get(b.atoms[0].intent) || 0));

  // Creator-observed candidates must not be pushed past the final `count`
  // limit by free signals, seeds, or other filler. Reserve one portfolio slot
  // for each creator-derived candidate still ahead in the ordering; deferred
  // filler is retried after the first pass when a reserved candidate fails a
  // gate, so the portfolio is not underfilled.
  const CREATOR_DERIVED_TEMPLATES = new Set(['ANCHOR_LEARNED', 'ORGANIC_STANDALONE', 'ANCHOR_ORGANIC']);
  const isCreatorDerived = (candidate: (typeof candidates)[number]) => CREATOR_DERIVED_TEMPLATES.has(candidate.template);
  const creatorRemainingAfter = new Array<number>(candidates.length + 1).fill(0);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    creatorRemainingAfter[index] = creatorRemainingAfter[index + 1] + (isCreatorDerived(candidates[index]) ? 1 : 0);
  }

  const planned: PlannedQuery[] = [];
  let tier3Used = 0;
  const trySelect = (candidate: (typeof candidates)[number]): void => {
    if (planned.length >= count) return;
    const query = candidate.atoms.map(item => item.term).join(' ');
    const normalized = normalizeQuery(query);
    const hasTier3 = candidate.atoms.some(item => item.tier === 3);
    const globalContext = candidate.organic ? { ...candidate.organic.languageCapability.context, governed: true } : undefined;
    const extractedStandalone = candidate.template === 'EXTRACTED_STANDALONE';
    const retrievalOk = extractedStandalone
      ? isExtractedStandaloneQuery({ term: query, country: args.country, language: candidate.extracted?.language })
      : isRetrievalOrientedQuery(args.country, query, globalContext);
    if (blocked.has(normalized) || generated.has(normalized) || !retrievalOk) return;
    if (hasTier3 && tier3Used >= Math.ceil(count / 5)) return;
    if (hasTier3) tier3Used++;
    const tiers = [...new Set(candidate.atoms.map(item => item.tier))] as QueryKnowledgeTier[];
    const primary = candidate.atoms[0];
    const preferredLanguage = supportedLanguages.length ? supportedLanguages[planned.length % supportedLanguages.length] : undefined;
    const freeSignalTerminology = candidate.freeSignal
      ? provenBySurface.get(normalizeQuery(candidate.freeSignal.surface))
      : undefined;
    const learnedTerminology = provenByTerm.get(
      normalizeQuery(candidate.atoms.find(item => item.type === 'LEARNED')?.term || ''),
    );
    const atomSourceTypes = candidate.atoms.map(item =>
      (item.origin === 'LEARNED' || item.origin === 'EXTRACTED_STANDALONE') ? 'TERMINOLOGY' as const
        : item.origin === 'FREE_SIGNAL' ? 'FREE_SIGNAL' as const
        : item.origin === 'DEMAND_SIGNAL' ? 'DEMAND_SIGNAL' as const
        : 'SEED' as const);
    let sourceTypes: QueryCandidateSource[] = candidate.organic
      ? ['TERMINOLOGY']
      : [...new Set(atomSourceTypes)];
    if (candidate.freeSignal) {
      sourceTypes = [...new Set([
        ...sourceTypes,
        'FREE_SIGNAL' as const,
        // A matching proven term corroborates a standalone free surface but
        // does not turn it into an anchored/mixed query. Adding TERMINOLOGY
        // here would reclassify the source as MIXED and make the exact-shape
        // execution authority withhold the planner's own standalone output.
        ...(freeSignalTerminology && candidate.template !== 'FREE_SIGNAL_STANDALONE'
          ? ['TERMINOLOGY' as const]
          : []),
      ])];
    }
    if (candidate.demand) {
      sourceTypes = [...new Set([...sourceTypes, 'DEMAND_SIGNAL' as const])];
    }
    const demandOnly = candidate.template === 'DEMAND_SIGNAL_STANDALONE';
    const candidateSource: QueryCandidateSource = sourceTypes.length > 1
      ? 'MIXED'
      : sourceTypes[0];
    // Marker consumed by the execution-time authority gate: a promoted anchor
    // acts as anchor only inside this paired template, by operator selection.
    // An explicitly selected dormant country also needs the marker on its
    // reviewed native singles; otherwise admission rejects them even though
    // the operator authorized the market.
    const scopePromotedAnchor = !hasAuthorizedAnchor && promotedAnchors.includes(primary);
    const scopePromotedRegion = args.scopePromotionBasis != null && !isProductionConfiguredCountry(args.country);
    planned.push({
      query,
      intent: primary.intent,
      primaryTerm: primary.term,
      knowledgeTiers: tiers,
      generationMode: mode,
      generationReason: candidate.template === 'EXTRACTED_STANDALONE'
        ? 'Selected an accepted standalone extracted query from the terminology candidate ledger.'
        : candidate.template === 'SINGLE_ATOM'
        ? `Selected a compact ${primary.origin.toLowerCase()} ${primary.type.toLowerCase()} atom for YouTube retrieval.`
        : candidate.template === 'COMPACT_PAIR'
            ? 'Combined one concrete local instrument or market with one compatible trading method.'
            : candidate.template === 'INSTRUMENT_MARKET'
              ? 'Combined a concrete local instrument with a local market or exchange context.'
            : candidate.template === 'MARKET_INSTRUMENT'
              ? 'Combined an authorized local market or exchange anchor with a concrete instrument context.'
            : candidate.template === 'METHOD_INSTRUMENT'
              ? 'Combined an authorized local trading method anchor with a concrete instrument context.'
            : candidate.template === 'ANCHOR_LEARNED'
            ? `Combined one compact Tier 1 local anchor with constrained Tier ${candidate.atoms[1].tier} learned vocabulary.`
            : candidate.template === 'ORGANIC_STANDALONE'
              ? `Selected a published proven ${candidate.organic!.sourceType.toLowerCase()} surface with governed concept identity.`
              : candidate.template === 'ANCHOR_ORGANIC'
                ? `Combined a local control anchor with a quota-limited governed ${candidate.organic!.sourceType.toLowerCase()} trial surface.`
              : candidate.template === 'ANCHOR_FREE_SIGNAL'
                ? 'Combined a local retrieval anchor with a free Wikipedia/Wikidata candidate surface.'
              : candidate.template === 'FREE_SIGNAL_STANDALONE'
                ? 'Selected a free Wikipedia/Wikidata candidate surface to bootstrap a country with no creator-observed anchor.'
              : candidate.template === 'ANCHOR_DEMAND_SIGNAL'
                ? 'Combined a local retrieval anchor with an optional paid demand signal.'
                : 'Selected an optional paid demand signal to bootstrap a country with no creator-observed anchor.',
      discoveryObjective: OBJECTIVES[primary.intent] || 'Find relevant trading creators using authentic local search vocabulary.',
      metadata: {
        country: args.country,
        queryTemplate: candidate.template,
        retrievalOptimized: true,
        tokenCount: queryTokenCount(query),
        scriptValidated: true,
        source: candidateSource,
        sourceTypes,
        policyVersion: 'cdl-free-first-v1',
        demandOnly,
        ...(candidate.freeSignal ? {
          freeSignalIds: candidate.freeSignal.sourceIds,
          freeSignalType: candidate.freeSignal.signalType,
          language: candidate.freeSignal.language,
        } : {}),
        ...(candidate.demand ? {
          demandSignalIds: candidate.demand.sourceIds,
          demandScore: candidate.demand.demandScore,
        } : {}),
        ...(candidate.extracted ? {
          extractedCandidateId: candidate.extracted.id,
          extractedStandalone: true,
          extractedCandidateLanguage: candidate.extracted.language,
          extractedCandidateSourceTitle: candidate.extracted.sourceTitle || undefined,
        } : {}),
        ...(scopePromotedAnchor || scopePromotedRegion ? { scopePromoted: true, promotionBasis: args.scopePromotionBasis } : {}),
        retrievalSpecificity:{policyVersion:primary.retrievalPolicy.policyVersion,eligibility:primary.retrievalPolicy.eligibility,specificity:primary.retrievalPolicy.specificity,ambiguity:primary.retrievalPolicy.ambiguity,reasonCodes:primary.retrievalPolicy.reasonCodes},
        atoms: candidate.atoms.map((item, position) => ({ ...item, role: position === 0 ? 'ANCHOR' : 'MODIFIER', position })),
        localTier1Term: primary.term,
        learnedTerm: candidate.extracted ? undefined : candidate.atoms.find(item => item.type === 'LEARNED')?.term,
        preferredLanguage,
        languageLineage: preferredLanguage ? {
          policy: 'COUNTRY_SUPPORTED_LANGUAGE_ROTATION_V1',
          supportedLanguages,
          selectedLanguage: preferredLanguage,
          ordinal: planned.length + 1
        } : undefined,
        terminologyId: learnedTerminology?.id ?? freeSignalTerminology?.id,
        // The lifecycle and yield must come from the same source as the id.
        // Otherwise a free-signal query can be attributed to a proven term by
        // id while appearing to have no lifecycle at all.
        terminologyLifecycle: learnedTerminology?.lifecycle ?? freeSignalTerminology?.lifecycle,
        terminologyDecayedYield: learnedTerminology?.score ?? freeSignalTerminology?.score,
        ...(terminatedByGate.length ? {
          terminologyGate: {
            policy: TERMINOLOGY_SEARCHABILITY_VERSION,
            suppressedCount: terminatedByGate.length,
            // Cap the per-query audit copy: the same planning-run list is
            // repeated in every planned query's metadata, so an unbounded
            // vocabulary would multiply JSONB size and write volume.
            suppressed: terminatedByGate.slice(0, PLANNER_GATE_METADATA_LIMIT),
            ...(terminatedByGate.length > PLANNER_GATE_METADATA_LIMIT ? { suppressedTruncated: true } : {}),
          },
        } : {}),
        selectionEvidence: candidate.extracted
          ? `Accepted standalone extracted query from the LCB ledger (confidence ${candidate.extracted.confidence.toFixed(2)}).`
          : provenByTerm.has(normalizeQuery(candidate.atoms.find(item => item.type === 'LEARNED')?.term || ''))
          ? `Canonical term ${provenByTerm.get(normalizeQuery(candidate.atoms.find(item => item.type === 'LEARNED')?.term || ''))!.id} ranked by time-decayed production yield.`
          : candidate.freeSignal
            ? `Free-signal candidate from ${candidate.freeSignal.provider} (${candidate.freeSignal.sourceIds.join(', ')}); candidate vocabulary only, never evidence.`
            : candidate.demand
              ? `Optional paid demand surface (${candidate.demand.sourceIds.join(', ')}); ranking aid only, never evidence.`
            : candidate.organic
              ? `${candidate.organic.eligibilityReason}; independently corroborated by ${new Set(candidate.organic.independentSourceIds).size} sources.`
              : 'Curated or constrained legacy evidence.',
        organicProvenance: candidate.organic ? {
          candidateId: candidate.organic.candidateId, conceptId: candidate.organic.conceptId,
          sourceType: candidate.organic.sourceType, sourceRefs: candidate.organic.sourceRefs,
          independentSourceIds: [...new Set(candidate.organic.independentSourceIds)].sort(),
          language: candidate.organic.language, script: candidate.organic.script, locale: candidate.organic.locale,
          lifecycle: candidate.organic.lifecycle, validation: candidate.organic.validation,
          catalog: candidate.organic.catalog, trial: candidate.organic.trial,
          provenanceChecksum: candidate.organic.provenanceChecksum,
          languageCapability: candidate.organic.languageCapability
        } : undefined
      }
    });
    generated.add(normalized);
  };

  const deferred: Array<(typeof candidates)[number]> = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (planned.length >= count) break;
    const candidate = candidates[index];
    if (!isCreatorDerived(candidate) && planned.length + creatorRemainingAfter[index + 1] >= count) {
      deferred.push(candidate);
      continue;
    }
    trySelect(candidate);
  }
  // A reserved creator candidate may fail a gate (blocked, duplicate, tier
  // cap). Fill any remaining slots with the deferrals in their original order.
  for (const candidate of deferred) {
    if (planned.length >= count) break;
    trySelect(candidate);
  }
  return planned;
}

export function reformulatePollutedQuery(args: {
  pollutedQuery: string;
  country: string;
  intent: QueryIntent;
  countryVocabulary?: CountryVocabulary;
}): PlannedQuery | null {
  const normalizedBase = normalizeQuery(args.pollutedQuery);
  const anchors = countryAtoms(args.country, args.countryVocabulary);
  const tradingMethods = anchors.filter(item => item.type === 'METHOD' || item.type === 'INSTRUMENT');

  for (const method of tradingMethods) {
    const candidateTerm = `${normalizedBase} ${method.term}`;
    if (isRetrievalOrientedQuery(args.country, candidateTerm)) {
      const primaryAtom = method;
      return {
        query: candidateTerm,
        intent: args.intent,
        primaryTerm: primaryAtom.term,
        knowledgeTiers: [1],
        generationMode: 'EXPLORATION',
        generationReason: `Governed query reformulation from polluted term "${args.pollutedQuery}" toward specific trading anchor "${primaryAtom.term}".`,
        discoveryObjective: 'Reformulate polluted query toward concrete, authentic local trading vocabulary.',
        metadata: {
          country: args.country,
          queryTemplate: 'COMPACT_PAIR',
          retrievalOptimized: true,
          reformulatedFrom: args.pollutedQuery,
          retrievalSpecificity: {
            policyVersion: primaryAtom.retrievalPolicy.policyVersion,
            eligibility: primaryAtom.retrievalPolicy.eligibility,
            specificity: primaryAtom.retrievalPolicy.specificity,
            ambiguity: primaryAtom.retrievalPolicy.ambiguity,
            reasonCodes: primaryAtom.retrievalPolicy.reasonCodes
          }
        }
      };
    }
  }
  return null;
}
