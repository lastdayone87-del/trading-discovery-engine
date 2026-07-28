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

interface IntentKnowledge {
  intent: QueryIntent;
  primaryTerms: string[];
  objective: string;
}

export const INSTITUTIONAL_KNOWLEDGE: IntentKnowledge[] = [
  { intent: 'beginner', primaryTerms: ['trading for beginners', 'risk management basics'], objective: 'Find beginner-focused creators teaching foundational market skills.' },
  { intent: 'strategy', primaryTerms: ['price action strategy', 'market structure strategy'], objective: 'Find creators demonstrating repeatable trading strategies.' },
  { intent: 'news', primaryTerms: ['market news analysis', 'economic calendar outlook'], objective: 'Find creators interpreting current macro and market news.' },
  { intent: 'education', primaryTerms: ['trading education', 'technical analysis lesson'], objective: 'Find structured educational trading channels.' },
  { intent: 'indicators', primaryTerms: ['volume profile indicator', 'vwap indicator analysis'], objective: 'Find creators teaching indicator-based analysis.' },
  { intent: 'psychology', primaryTerms: ['trading psychology', 'trader discipline journal'], objective: 'Find creators focused on execution discipline and psychology.' },
  { intent: 'futures', primaryTerms: ['futures trading', 'index futures analysis'], objective: 'Find active futures-market creators.' },
  { intent: 'forex', primaryTerms: ['forex market analysis', 'currency trading education'], objective: 'Find educational foreign-exchange creators.' },
  { intent: 'crypto', primaryTerms: ['crypto market structure', 'bitcoin technical analysis'], objective: 'Find evidence-led crypto market educators.' },
  { intent: 'stocks', primaryTerms: ['stock market analysis', 'equity trading education'], objective: 'Find creators analyzing listed equities.' },
  { intent: 'options', primaryTerms: ['options trading education', 'options risk analysis'], objective: 'Find creators teaching options and derivatives risk.' },
  { intent: 'market_analysis', primaryTerms: ['institutional market analysis', 'daily market structure'], objective: 'Find creators publishing current market analysis.' },
  { intent: 'premarket_prep', primaryTerms: ['premarket preparation', 'opening session key levels'], objective: 'Find creators publishing pre-session preparation.' },
  { intent: 'live_trading', primaryTerms: ['live trade execution', 'live trading commentary'], objective: 'Find creators showing authentic live execution.' },
  { intent: 'weekly_reviews', primaryTerms: ['weekly market review', 'weekly trading recap'], objective: 'Find creators reviewing market and execution outcomes.' },
  { intent: 'trading_journals', primaryTerms: ['trading journal review', 'trade review process'], objective: 'Find creators documenting trades and lessons.' },
  { intent: 'session_analysis', primaryTerms: ['session analysis', 'opening range analysis'], objective: 'Find session-specific market analysts.' },
  { intent: 'strategy_breakdowns', primaryTerms: ['strategy breakdown', 'trade setup explanation'], objective: 'Find detailed setup and strategy breakdowns.' },
  { intent: 'prop_firm', primaryTerms: ['prop firm risk management', 'funded trader education'], objective: 'Find responsible proprietary-trading educators.' }
];

export const INSTITUTIONAL_ENTITIES: Record<string, string[]> = {
  GLOBAL: ['Interactive Brokers', 'CME futures', 'market microstructure', 'risk management'],
  'United States': ['SEC investor education', 'CFTC futures', 'NYSE', 'Nasdaq'],
  'United Kingdom': ['FCA regulated trading', 'London Stock Exchange', 'FTSE'],
  Germany: ['BaFin', 'Xetra', 'Frankfurt Stock Exchange', 'DAX futures'],
  France: ['AMF France', 'Euronext Paris', 'CAC 40'],
  Spain: ['CNMV', 'Bolsa de Madrid', 'IBEX 35'],
  Netherlands: ['AFM Netherlands', 'Euronext Amsterdam', 'AEX'],
  Italy: ['CONSOB', 'Borsa Italiana', 'FTSE MIB'],
  Australia: ['ASIC trading education', 'Australian Securities Exchange', 'ASX 200'],
  Canada: ['CIRO investor education', 'Toronto Stock Exchange', 'TSX'],
  Japan: ['JFSA', 'Japan Exchange Group', 'Nikkei 225']
};

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

function orderedIntents(existing: QueryRecord[]): IntentKnowledge[] {
  const counts = new Map<QueryIntent, number>();
  existing.forEach(query => counts.set(query.intent, (counts.get(query.intent) || 0) + 1));
  return [...INSTITUTIONAL_KNOWLEDGE].sort((a, b) => (counts.get(a.intent) || 0) - (counts.get(b.intent) || 0));
}

export function planDiverseQueries(args: {
  country: string;
  count: number;
  countryVocabulary?: CountryVocabulary;
  learnedVocabulary: ExtractedTermRecord[];
  existingQueries: QueryRecord[];
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
    .flatMap(anchor => methods.map(method => ({ atoms: [anchor, method], template: 'COMPACT_PAIR' })));

  // Combine anchors with learned vocabulary
  for (const learned of args.learnedVocabulary) {
    if (isRetrievalOrientedQuery(args.country, learned.term)) {
      candidates.push({ atoms: [atom(learned.term, 'LEARNED', inferIntent(learned.term, 'education'), learned.trust_tier, 'LEARNED')], template: 'SINGLE_ATOM' });
    }
  }

  // Generate queries
  const plannedQueries: PlannedQuery[] = [];
  const availableIntents = orderedIntents(args.existingQueries);

  for (const intentKnowledge of availableIntents) {
    if (plannedQueries.length >= count) break;

    // Try to generate queries based on institutional knowledge
    for (const primaryTerm of intentKnowledge.primaryTerms) {
      if (plannedQueries.length >= count) break;
      const query = `${primaryTerm} ${args.country === 'United States' ? '' : 'trading'}`.trim();
      if (!blocked.has(normalizeQuery(query)) && !generated.has(normalizeQuery(query))) {
        plannedQueries.push({
          query,
          intent: intentKnowledge.intent,
          primaryTerm,
          knowledgeTiers: [1],
          generationMode: mode,
          generationReason: `Institutional knowledge for ${intentKnowledge.intent} in ${args.country}`,
          discoveryObjective: intentKnowledge.objective,
          metadata: { source: 'INSTITUTIONAL_KNOWLEDGE' }
        });
        generated.add(normalizeQuery(query));
      }
    }

    // Try to generate queries based on country-specific institutional entities
    const countryEntities = INSTITUTIONAL_ENTITIES[args.country] || INSTITUTIONAL_ENTITIES.GLOBAL;
    for (const entity of countryEntities) {
      if (plannedQueries.length >= count) break;
      const query = `${entity} ${intentKnowledge.primaryTerms[0] || intentKnowledge.intent}`.trim();
      if (!blocked.has(normalizeQuery(query)) && !generated.has(normalizeQuery(query))) {
        plannedQueries.push({
          query,
          intent: intentKnowledge.intent,
          primaryTerm: entity,
          knowledgeTiers: [1],
          generationMode: mode,
          generationReason: `Country-specific institutional entity for ${intentKnowledge.intent} in ${args.country}`,
          discoveryObjective: intentKnowledge.objective,
          metadata: { source: 'INSTITUTIONAL_ENTITY' }
        });
        generated.add(normalizeQuery(query));
      }
    }
  }

  // Add queries from country-specific vocabulary (Tier 2)
  if (args.countryVocabulary) {
    const vocabTerms = [
      ...(args.countryVocabulary.native_trading_terminology || []).map(term => ({ term, type: 'METHOD', intent: inferIntent(term, 'strategy') })),
      ...(args.countryVocabulary.popular_instruments || []).map(term => ({ term, type: 'INSTRUMENT', intent: inferIntent(term, 'market_analysis') })),
      ...(args.countryVocabulary.local_market_phrases || []).map(term => ({ term, type: 'MARKET', intent: inferIntent(term, 'session_analysis') })),
      ...(args.countryVocabulary.common_content_format_names || []).map(term => ({ term, type: 'FORMAT', intent: inferIntent(term, 'education') })),
    ];

    for (const vt of vocabTerms) {
      if (plannedQueries.length >= count) break;
      const query = `${vt.term} trading`.trim();
      if (!blocked.has(normalizeQuery(query)) && !generated.has(normalizeQuery(query))) {
        plannedQueries.push({
          query,
          intent: vt.intent,
          primaryTerm: vt.term,
          knowledgeTiers: [1, 2],
          generationMode: mode,
          generationReason: `Country vocabulary term: ${vt.term}`,
          discoveryObjective: OBJECTIVES[vt.intent] || 'Discover relevant content',
          metadata: { source: 'COUNTRY_VOCABULARY' }
        });
        generated.add(normalizeQuery(query));
      }
    }
  }

  // Add queries from learned vocabulary (Tier 3)
  for (const lt of args.learnedVocabulary) {
    if (plannedQueries.length >= count) break;
    const query = `${lt.term} ${lt.category === 'instrument' ? 'analysis' : 'strategy'}`.trim();
    if (!blocked.has(normalizeQuery(query)) && !generated.has(normalizeQuery(query))) {
      plannedQueries.push({
        query,
        intent: inferIntent(lt.term, 'education'),
        primaryTerm: lt.term,
        knowledgeTiers: [1, 3],
        generationMode: mode,
        generationReason: `Learned vocabulary term: ${lt.term}`,
        discoveryObjective: OBJECTIVES.education || 'Discover educational content',
        metadata: { source: 'LEARNED_VOCABULARY' }
      });
      generated.add(normalizeQuery(query));
    }
  }

  // Fill with generic queries if needed
  while (plannedQueries.length < count) {
    const genericIntent = Array.from(intentUsage.keys()).sort((a, b) => (intentUsage.get(a) || 0) - (intentUsage.get(b) || 0))[0] || 'market_analysis';
    const genericQuery = `${genericIntent} trading in ${args.country}`;
    if (!blocked.has(normalizeQuery(genericQuery)) && !generated.has(normalizeQuery(genericQuery))) {
      plannedQueries.push({
        query: genericQuery,
        intent: genericIntent,
        primaryTerm: genericIntent,
        knowledgeTiers: [1],
        generationMode: mode,
        generationReason: 'Generic fill-in query',
        discoveryObjective: OBJECTIVES[genericIntent] || 'Discover relevant content',
        metadata: { source: 'GENERIC_FILL' }
      });
      generated.add(normalizeQuery(genericQuery));
    }
  }

  return plannedQueries.slice(0, count);
}
