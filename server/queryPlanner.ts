import type { CountryVocabulary, ExtractedTermRecord, QueryIntent, QueryRecord } from '../src/types';

export type QueryKnowledgeTier = 1 | 2 | 3;
export type QueryGenerationMode = 'EXPLORATION' | 'EXPLOITATION' | 'COLD_START';
export type SearchAtomType = 'INSTRUMENT' | 'METHOD' | 'MARKET' | 'FORMAT' | 'LEARNED';

export interface SearchAtom {
  term: string;
  type: SearchAtomType;
  intent: QueryIntent;
  tier: QueryKnowledgeTier;
  origin: 'CURATED' | 'COUNTRY_VOCABULARY' | 'LEARNED';
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
  Japan: [['日経225', 'INSTRUMENT', 'futures'], ['FX トレード', 'INSTRUMENT', 'forex'], ['オーダーフロー', 'METHOD', 'strategy'], ['テクニカル分析', 'METHOD', 'education'], ['板読み', 'METHOD', 'strategy'], ['デイトレード', 'METHOD', 'live_trading'], ['東京セッション', 'MARKET', 'session_analysis']]
};

const OBJECTIVES: Partial<Record<QueryIntent, string>> = {
  futures: 'Find active futures trading creators.', forex: 'Find foreign-exchange trading creators.', stocks: 'Find active equity-market creators.',
  options: 'Find options trading creators.', strategy: 'Find creators demonstrating trading methods.', indicators: 'Find creators using technical market tools.',
  education: 'Find creators teaching market analysis.', market_analysis: 'Find creators publishing current market analysis.',
  premarket_prep: 'Find creators publishing pre-session preparation.', session_analysis: 'Find session-specific market analysts.',
  live_trading: 'Find creators showing active trade execution.', trading_journals: 'Find creators documenting trades and lessons.',
  psychology: 'Find creators focused on trader discipline and psychology.'
};

const FORBIDDEN_PROSE = /\b(investor education|regulated trading|stock exchange|rate decision|weekly trade breakdown|market update)\b/i;
const NON_LATIN = /[\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Devanagari}\p{Script=Hangul}]/u;
const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function normalizeQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

export function queryTokenCount(query: string): number {
  return query.normalize('NFKC').trim().split(/\s+/u).filter(Boolean).length;
}

export function isCountryScriptCompatible(country: string, query: string): boolean {
  if (NON_LATIN.test(query)) return false;
  if (country !== 'Japan') return !JAPANESE.test(query);
  if (JAPANESE.test(query)) return true;
  return /^[A-Z0-9./ -]{1,12}$/.test(query.trim());
}

export function isRetrievalOrientedQuery(country: string, query: string): boolean {
  const normalized = query.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return normalized.length >= 2 && normalized.length <= 40 && queryTokenCount(normalized) <= 3 &&
    !FORBIDDEN_PROSE.test(normalized) && isCountryScriptCompatible(country, normalized);
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
  return queries.filter(query => !query.primary_term || (usage.get(normalizeQuery(query.primary_term)) || 0) < maxUses);
}

export function rotateAwayFromMostRecentIntent(eligible: QueryRecord[], history: QueryRecord[]): QueryRecord[] {
  const mostRecent = history.filter(query => query.last_executed).sort((a, b) => new Date(b.last_executed!).getTime() - new Date(a.last_executed!).getTime())[0];
  if (!mostRecent || !eligible.some(query => query.intent !== mostRecent.intent)) return eligible;
  return eligible.filter(query => query.intent !== mostRecent.intent);
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
  return { term: term.normalize('NFKC').trim().replace(/\s+/g, ' '), type, intent: inferIntent(term, intent), tier, origin };
}

function countryAtoms(country: string, vocabulary?: CountryVocabulary): SearchAtom[] {
  const curated = (COUNTRY_SEARCH_ATOMS[country] || []).map(([term, type, intent]) => atom(term, type, intent, 1, 'CURATED'));
  const vocabularyAtoms = [
    ...(vocabulary?.popular_instruments || []).map(term => atom(term, 'INSTRUMENT', 'market_analysis', 1, 'COUNTRY_VOCABULARY')),
    ...(vocabulary?.native_trading_terminology || []).map(term => atom(term, 'METHOD', 'strategy', 1, 'COUNTRY_VOCABULARY')),
    ...(vocabulary?.local_market_phrases || []).map(term => atom(term, 'MARKET', 'session_analysis', 1, 'COUNTRY_VOCABULARY')),
    ...(vocabulary?.common_content_format_names || []).map(term => atom(term, 'FORMAT', 'education', 1, 'COUNTRY_VOCABULARY'))
  ];
  const unique = new Map<string, SearchAtom>();
  for (const candidate of [...curated, ...vocabularyAtoms]) {
    if (isRetrievalOrientedQuery(country, candidate.term) && !unique.has(normalizeQuery(candidate.term))) unique.set(normalizeQuery(candidate.term), candidate);
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
  mode?: QueryGenerationMode;
}): PlannedQuery[] {
  const count = Math.max(1, args.count);
  const mode = args.mode || (args.existingQueries.length ? 'EXPLORATION' : 'COLD_START');
  const blocked = new Set(args.existingQueries.map(item => normalizeQuery(item.query)));
  const generated = new Set<string>();
  const anchors = countryAtoms(args.country, args.countryVocabulary);
  const intentUsage = new Map<QueryIntent, number>();
  args.existingQueries.forEach(query => intentUsage.set(query.intent, (intentUsage.get(query.intent) || 0) + 1));
  const candidates: Array<{ atoms: SearchAtom[]; template: 'SINGLE_ATOM' | 'COMPACT_PAIR' | 'ANCHOR_LEARNED' }> = anchors.map(searchAtom => ({ atoms: [searchAtom], template: 'SINGLE_ATOM' }));

  // Only combine semantically compatible atoms: a concrete instrument/market
  // anchor plus one trading method. Formats and unrelated concepts never mix.
  const methods = anchors.filter(item => item.type === 'METHOD');
  const compatiblePairs = anchors
    .filter(item => item.type === 'INSTRUMENT' || item.type === 'MARKET')
    .flatMap(anchor => methods.map(method => ({ atoms: [anchor, method], template: 'COMPACT_PAIR' as const })))
    .filter(candidate => isRetrievalOrientedQuery(args.country, candidate.atoms.map(item => item.term).join(' ')));
  candidates.push(...compatiblePairs);

  const proven = (args.provenTerminology || []).map(term => ({
    atom: atom(term.term, 'LEARNED', 'strategy', term.lifecycle === 'PROVEN_SEARCH_TERM' ? 1 : 2, 'LEARNED'),
    terminology: term
  }));
  const provenByTerm = new Map(proven.map(item => [normalizeQuery(item.atom.term), item.terminology]));
  const legacyLearned = args.learnedVocabulary
    .filter(term => term.trust_tier === 2 ? (term.validation_count || 0) >= 2 : true)
    .filter(term => !proven.some(item => normalizeQuery(item.atom.term) === normalizeQuery(term.term)))
    .map(term => ({ atom: atom(term.term, 'LEARNED', 'strategy', term.trust_tier === 2 ? 2 : 3, 'LEARNED'), terminology: undefined }));
  const learnedCandidates = [...proven, ...legacyLearned].flatMap(({ atom: learnedAtom, terminology }, index) => {
    const rotated = [...anchors.slice(index), ...anchors.slice(0, index)];
    const anchor = rotated.find(item => isRetrievalOrientedQuery(args.country, `${item.term} ${learnedAtom.term}`));
    if (!anchor) return [];
    return [{ atoms: [anchor, learnedAtom], template: 'ANCHOR_LEARNED' as const, terminology }];
  });
  candidates.splice(Math.min(3, candidates.length), 0, ...learnedCandidates);
  candidates.sort((a, b) => (intentUsage.get(a.atoms[0].intent) || 0) - (intentUsage.get(b.atoms[0].intent) || 0));

  const planned: PlannedQuery[] = [];
  let tier3Used = 0;
  for (const candidate of candidates) {
    if (planned.length >= count) break;
    const query = candidate.atoms.map(item => item.term).join(' ');
    const normalized = normalizeQuery(query);
    const hasTier3 = candidate.atoms.some(item => item.tier === 3);
    if (blocked.has(normalized) || generated.has(normalized) || !isRetrievalOrientedQuery(args.country, query)) continue;
    if (hasTier3 && tier3Used >= Math.ceil(count / 5)) continue;
    if (hasTier3) tier3Used++;
    const tiers = [...new Set(candidate.atoms.map(item => item.tier))] as QueryKnowledgeTier[];
    const primary = candidate.atoms[0];
    planned.push({
      query,
      intent: primary.intent,
      primaryTerm: primary.term,
      knowledgeTiers: tiers,
      generationMode: mode,
      generationReason: candidate.template === 'SINGLE_ATOM'
        ? `Selected a compact ${primary.origin.toLowerCase()} ${primary.type.toLowerCase()} atom for YouTube retrieval.`
        : candidate.template === 'COMPACT_PAIR'
          ? 'Combined one concrete local instrument or market with one compatible trading method.'
          : `Combined one compact Tier 1 local anchor with constrained Tier ${candidate.atoms[1].tier} learned vocabulary.`,
      discoveryObjective: OBJECTIVES[primary.intent] || 'Find relevant trading creators using authentic local search vocabulary.',
      metadata: {
        country: args.country,
        queryTemplate: candidate.template,
        retrievalOptimized: true,
        tokenCount: queryTokenCount(query),
        scriptValidated: true,
        atoms: candidate.atoms.map((item, position) => ({ ...item, role: position === 0 ? 'ANCHOR' : 'MODIFIER', position })),
        localTier1Term: primary.term,
        learnedTerm: candidate.atoms.find(item => item.type === 'LEARNED')?.term,
        terminologyId: provenByTerm.get(normalizeQuery(candidate.atoms.find(item => item.type === 'LEARNED')?.term || ''))?.id,
        terminologyLifecycle: provenByTerm.get(normalizeQuery(candidate.atoms.find(item => item.type === 'LEARNED')?.term || ''))?.lifecycle,
        terminologyDecayedYield: provenByTerm.get(normalizeQuery(candidate.atoms.find(item => item.type === 'LEARNED')?.term || ''))?.score,
        selectionEvidence: provenByTerm.has(normalizeQuery(candidate.atoms.find(item => item.type === 'LEARNED')?.term || ''))
          ? `Canonical term ${provenByTerm.get(normalizeQuery(candidate.atoms.find(item => item.type === 'LEARNED')?.term || ''))!.id} ranked by time-decayed production yield.`
          : 'Curated or constrained legacy evidence.'
      }
    });
    generated.add(normalized);
  }
  return planned;
}
