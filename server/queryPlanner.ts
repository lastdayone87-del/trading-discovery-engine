import type { CountryVocabulary, ExtractedTermRecord, QueryIntent, QueryRecord } from '../src/types';

export type QueryKnowledgeTier = 1 | 2 | 3;
export type QueryGenerationMode = 'EXPLORATION' | 'EXPLOITATION' | 'COLD_START';

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

export function normalizeQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

export function queriesOutsideCooldown(queries: QueryRecord[], now: Date, cooldownMinutes: number): QueryRecord[] {
  const cutoff = now.getTime() - cooldownMinutes * 60_000;
  const blocked = new Set(queries
    .filter(query => query.last_executed && new Date(query.last_executed).getTime() > cutoff)
    .map(query => normalizeQuery(query.query)));
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
  const mostRecent = history
    .filter(query => query.last_executed)
    .sort((a, b) => new Date(b.last_executed!).getTime() - new Date(a.last_executed!).getTime())[0];
  if (!mostRecent || !eligible.some(query => query.intent !== mostRecent.intent)) return eligible;
  return eligible.filter(query => query.intent !== mostRecent.intent);
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
  const { country, countryVocabulary, existingQueries } = args;
  const count = Math.max(1, args.count);
  const mode = args.mode || (existingQueries.length ? 'EXPLORATION' : 'COLD_START');
  const existingNormalized = new Set(existingQueries.map(item => normalizeQuery(item.query)));
  const generatedNormalized = new Set<string>();
  const tier2 = args.learnedVocabulary.filter(term => term.trust_tier === 2 && (term.validation_count || 0) >= 2);
  const tier3 = args.learnedVocabulary.filter(term => term.trust_tier !== 2);
  const localTier1 = [
    ...(INSTITUTIONAL_ENTITIES[country] || INSTITUTIONAL_ENTITIES.GLOBAL),
    ...INSTITUTIONAL_ENTITIES.GLOBAL,
    ...(countryVocabulary?.popular_instruments || []),
    ...(countryVocabulary?.local_market_phrases || []),
    ...(countryVocabulary?.native_trading_terminology || [])
  ].filter(Boolean);
  const formats = countryVocabulary?.common_content_format_names?.length
    ? countryVocabulary.common_content_format_names
    : ['market breakdown', 'educational analysis', 'trade review'];
  const intents = orderedIntents(existingQueries);
  const planned: PlannedQuery[] = [];

  for (let attempt = 0; planned.length < count && attempt < count * 30; attempt++) {
    const intentPack = intents[attempt % intents.length];
    const primaryTerm = intentPack.primaryTerms[Math.floor(attempt / intents.length) % intentPack.primaryTerms.length];
    const localTerm = localTier1[attempt % Math.max(1, localTier1.length)] || country;
    const format = formats[attempt % formats.length];
    const useTier2 = tier2.length > 0 && attempt % 3 === 1;
    // Candidate vocabulary is deliberately sparse and can only modify a Tier-1-led query.
    const useTier3 = !useTier2 && tier3.length > 0 && attempt % 5 === 4;
    const learned = useTier2 ? tier2[attempt % tier2.length] : useTier3 ? tier3[attempt % tier3.length] : undefined;
    const query = [localTerm, primaryTerm, learned?.term, format].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const normalized = normalizeQuery(query);
    if (existingNormalized.has(normalized) || generatedNormalized.has(normalized)) continue;

    const knowledgeTiers: QueryKnowledgeTier[] = learned ? [1, learned.trust_tier === 2 ? 2 : 3] : [1];
    planned.push({
      query,
      intent: intentPack.intent,
      primaryTerm,
      knowledgeTiers,
      generationMode: mode,
      generationReason: learned
        ? `Diversified an underused ${intentPack.intent} objective using Tier 1 institutional knowledge plus constrained Tier ${learned.trust_tier === 2 ? 2 : 3} vocabulary '${learned.term}'.`
        : `Diversified an underused ${intentPack.intent} objective using Tier 1 curated products, concepts, and local market knowledge.`,
      discoveryObjective: intentPack.objective,
      metadata: {
        country,
        institutionalCategory: intentPack.intent,
        localTier1Term: localTerm,
        contentFormat: format,
        learnedTerm: learned?.term,
        learnedTermOccurrences: learned?.occurrences,
        tier3Constrained: useTier3
      }
    });
    generatedNormalized.add(normalized);
  }
  return planned;
}
