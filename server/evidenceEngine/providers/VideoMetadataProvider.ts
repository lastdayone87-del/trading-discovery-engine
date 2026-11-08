import { EvidenceItem, EvidenceProvider, RawChannelInput, LayeredKnowledgeContext } from '../types';
import { pushUniqueMatch } from '../utils/textMatching';
import { findScopedTermMatches } from '../utils/claimPolarity';
import { affirmedTierATradingSignals, assessTradingText, hasIndependentMarketFrame, requiresMarketFrameForProvider } from '../tradingSignalTaxonomy';
import { isTradingFocusedText } from '../multilingualTerminology';

/**
 * Cheap creator-owned upload signal used only after enrichment. The broader
 * multilingual classifier intentionally uses narrow phrases, which meant obvious
 * titles such as "Trading Strategia" / "Live Trading" could fail the repeated-
 * upload route. Repeated upload evidence is already guarded by the 70% + three
 * independent-video requirement upstream, so this helper may safely recognize
 * explicit active-trading language while excluding common non-financial uses.
 */
/**
 * Financial qualifiers turn the otherwise ambiguous literal "trading"/"trader"
 * into a bounded creator hypothesis. They do not stand alone: the generic
 * literal must also be present. Card/game/skin usage still requires an
 * explicit financial-market literal, known method/platform or local term.
 */
const FINANCIAL_QUALIFIER_PATTERN = /\b(strateg(?:y|ies|ia|ie|i[ae]?)|analysis|analys[ei]?|analisi|analyse|setup|setups|market|markets|mercato|mercati|marche|march[eé]s|markt|markten|sessione|session|séance|sitzung|apertura|opening|ouvert|live|chart|charts|grafico|graphique|chartanalyse|risk|risiko|risque|rischio|riesgo|position|posizione|position|portfolio|portefeuille|journal|routine|mentality|mindset|course|corso|cours|kurs|lezione|leçon|lesson|signal|segnali|señales|signaux|outlook|forecast|previsione|previsi[oó]n|prognose|price|prezzo|prix|preis|entry|ingresso|entrée|einstieg|exit|uscita|sortie|ausstieg)\b/iu;
const TRADER_DOMAIN_PHRASE = /\b(?:del|della|da|di|per|come|of|for|as)\s+trad(?:er|ing)\b/iu;
// Language packs list useful generic phrases, but they are ordinary words on
// their own ("workplace risk management", "housing market analysis"). They
// must not qualify a creator without trading context.
const GENERIC_TRADING_TERM = /^(trading|trader|trade|market analysis|risk management|technical analysis)$/i;

function hasAssertedTerm(text: string, term: string): boolean {
  return findScopedTermMatches(text, [term]).some(match => match.polarity === 'ASSERTED');
}

export function isExplicitCreatorTradingText(text: string, context: LayeredKnowledgeContext): boolean {
  const normalized = text.normalize('NFKC');
  const unrelatedTradingUsage = /\b(trading\s*cards?|card\s*trading|pok[eé]mon|yugioh|steam\s*trading|skin\s*trading|sports?\s*card)\b/iu;
  // "Trader Joe's" is a grocery brand, not a trading creator. Excluding the
  // brand avoids both the generic-literal path and the "of Trader" domain
  // phrase path ("Best of Trader Joe's").
  const traderJoes = /\btrader\s+joe'?s?\b/iu.test(normalized);
  const genericTradingLiteral = /\b(trading|trader)\b/iu;
  const explicitFinancialTradingLiteral = /\b(day\s*trad(?:e|ing)|swing\s*trad(?:e|ing)|intraday|scalp(?:ing|er)|forex|fx\s*trading|futures?|options?|0dte|prop\s*firm|funded\s*trader|stocks?|equities|shares?|crypto|bitcoin|ethereum|btc|eth|nasdaq|s&p\s*500|sp500)\b/iu;
  const nativeTradingLiteral = /(トレード|デイトレード|先物|株式取引|تداول|交易|交易策略|交易计划)/u;

  const hasGenericTradingLiteral = genericTradingLiteral.test(normalized);
  const hasExplicitFinancialLiteral = explicitFinancialTradingLiteral.test(normalized) || nativeTradingLiteral.test(normalized);
  const hasKnownMethod = context.globalAdvancedConcepts.some(term => hasAssertedTerm(normalized, term));
  const hasKnownPlatform = context.globalPlatformsPropFirms.some(term => hasAssertedTerm(normalized, term));
  const languagePositiveTerms = (context.languageKnowledgePacks || [context.languageKnowledge])
    .flatMap(pack => pack?.positiveTerms || [])
    // The bare English language-pack literal is not a signal by itself.
    .filter(term => !GENERIC_TRADING_TERM.test(term.trim()));
  const hasLanguageTradingSignal = languagePositiveTerms.some(term => hasAssertedTerm(normalized, term));
  const hasCountryTradingSignal = (context.countryKnowledge?.nativeTradingTerminology || []).some(term => hasAssertedTerm(normalized, term));
  // Generic method/education phrases (including native ones) are not Tier A
  // evidence by themselves; the independent-context checks below handle them.
  const hasTierASignal = affirmedTierATradingSignals(normalized, context).some(signal => !['KNOWN_METHOD', 'NATIVE_METHOD', 'NATIVE_EDUCATION'].includes(signal));
  const hasFinancialQualifier = FINANCIAL_QUALIFIER_PATTERN.test(normalized) || TRADER_DOMAIN_PHRASE.test(normalized);
  // "Trader Joe's" is a grocery brand, not a trading creator. Excluding the
  // brand before any other signal avoids both the generic-literal path and
  // the "of Trader" domain phrase path ("Best of Trader Joe's").
  if (traderJoes) return hasExplicitFinancialLiteral || hasCountryTradingSignal;
  // Generic methods such as "candlestick", "chart patterns", "risk management"
  // or "market analysis" are not trading evidence on their own
  // ("candlestick making tutorial", "workplace risk management"). They count
  // only alongside an independent financial/market dimension. Do not let the
  // broad qualifier pattern satisfy this check: "risk management" would then
  // supply its own qualifier ("risk") and qualify itself.
  const hasMethodContext = hasExplicitFinancialLiteral || hasKnownPlatform || hasLanguageTradingSignal
    || hasCountryTradingSignal;

  // Generic uses of the word "trading" are ambiguous. When the same text is
  // clearly about cards, game items, or skins, only explicit financial-market
  // evidence may override the exclusion. Broad language-pack terms such as the
  // literal word "trading" are intentionally not sufficient for that override.
  if (unrelatedTradingUsage.test(normalized)) {
    return hasExplicitFinancialLiteral || hasKnownPlatform || hasCountryTradingSignal;
  }

  // A negated or disclaimed occurrence is not an explicit creator claim. Run
  // this only after the brand/card guards so an instrument mention cannot
  // bypass those exclusions.
  const assessment = assessTradingText(normalized, context);
  if (assessment.focus === 'TRADING_CORE' || assessment.focus === 'TRADING_ADJACENT') return true;
  const assertedTradingSignals = assessment.assertedSignals.filter(match =>
    match.category !== 'NON_TRADING' && !assessment.financeSignals.includes(match.id));
  if (assessment.signals.length > 0 && assertedTradingSignals.length === 0) return false;

  return hasTierASignal
    || hasExplicitFinancialLiteral
    || (hasKnownMethod && hasMethodContext)
    || hasKnownPlatform
    || hasLanguageTradingSignal
    || hasCountryTradingSignal
    // Bare generic "trading"/"trader" only counts with a financial qualifier
    // in the same text (e.g. "trading strategy", "strategia di trading").
    || (hasGenericTradingLiteral && hasFinancialQualifier);
}

export class VideoMetadataProvider implements EvidenceProvider {
  name = 'video_metadata' as const;

  availability(input: RawChannelInput) {
    return input.video_titles?.length
      ? { availability: 'AVAILABLE' as const }
      : { availability: 'NOT_APPLICABLE' as const, reason: 'No recent video titles were supplied.' };
  }

  async collectEvidence(input: RawChannelInput, knowledgeContext: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const items: EvidenceItem[] = [];
    const titles = input.video_titles || [];
    const descriptions = input.video_descriptions || [];
    const now = new Date().toISOString();
    const videoRef=(index:number,field:'video_title'|'video_description'='video_title')=>({field,index,sourceId:input.videos?.[index]?.id,publishedAt:input.videos?.[index]?.published_at,sourceFamilyId:input.videos?.[index]?.source_family_id,sourceEntityId:input.videos?.[index]?.source_entity_id||input.channel_entity_id});
    // Provenance must point at the document that actually matched: a term
    // found only in a video description is description evidence, not a title
    // match. A cross-boundary match (title + description joined) falls back to
    // the title reference used before field-level attribution.
    const matchRefs=(index:number,terms:string[])=>{
      const title=titles[index]||'';
      const desc=descriptions[index]||'';
      const refs=[
        ...(terms.some(term=>hasAssertedTerm(title,term))?[videoRef(index,'video_title')]:[]),
        ...(desc&&terms.some(term=>hasAssertedTerm(desc,term))?[videoRef(index,'video_description')]:[]),
      ];
      return refs.length?refs:terms.some(term=>hasAssertedTerm(`${title} ${desc}`,term))?[videoRef(index,'video_title')]:[];
    };

    if (titles.length === 0) {
      return items;
    }

    let tradingFocusedCount = 0;
    const tradingVideoIndexes = new Set<number>();
    const tierASignalVideos = new Map<string, Set<number>>();
    const matchedInstrumentsInVideos: string[] = [];
    const matchedPlatformsInVideos: string[] = [];
    const matchedConceptsInVideos: string[] = [];

    for (let i = 0; i < titles.length; i++) {
      const title = titles[i] || '';
      const desc = descriptions[i] || '';
      const combo = `${title} ${desc}`;
      const hasAssertedInFields = (term: string) =>
        hasAssertedTerm(title, term) || (Boolean(desc) && hasAssertedTerm(desc, term));

      // Assess title and description separately so a title negation cannot
      // suppress an asserted description claim.
      const isTrading = isTradingFocusedText(title, knowledgeContext)
        || isExplicitCreatorTradingText(title, knowledgeContext)
        || (Boolean(desc) && (isTradingFocusedText(desc, knowledgeContext)
          || isExplicitCreatorTradingText(desc, knowledgeContext)));
      if (!isTrading) continue;
      tradingFocusedCount++;
      tradingVideoIndexes.add(i);
      const assertedSignals = [
        ...affirmedTierATradingSignals(title, knowledgeContext),
        ...(desc ? affirmedTierATradingSignals(desc, knowledgeContext) : []),
      ];
      for (const signal of [...new Set(assertedSignals)]) {
        const videos = tierASignalVideos.get(signal) || new Set<number>();
        videos.add(i);
        tierASignalVideos.set(signal, videos);
      }

      // C2: a video is trading-focused at most once, and specific evidence is
      // only attributed to videos whose text met the corrected predicate.
      for (const inst of knowledgeContext.globalInstruments) {
        if (requiresMarketFrameForProvider(inst) && !hasIndependentMarketFrame(combo)) continue;
        if (hasAssertedInFields(inst)) {
          pushUniqueMatch(matchedInstrumentsInVideos, inst);
        }
      }
      for (const plat of knowledgeContext.globalPlatformsPropFirms) {
        if (hasAssertedInFields(plat)) {
          pushUniqueMatch(matchedPlatformsInVideos, plat);
        }
      }
      for (const concept of knowledgeContext.globalAdvancedConcepts) {
        if (hasAssertedInFields(concept)) {
          pushUniqueMatch(matchedConceptsInVideos, concept);
        }
      }
      for (const langTerm of (knowledgeContext.languageKnowledgePacks||[knowledgeContext.languageKnowledge]).flatMap(pack=>pack?.positiveTerms||[])) {
        if (GENERIC_TRADING_TERM.test(langTerm.trim())) continue;
        if (hasAssertedInFields(langTerm)) {
          pushUniqueMatch(matchedConceptsInVideos, langTerm);
        }
      }
      for (const countryTerm of knowledgeContext.countryKnowledge?.nativeTradingTerminology || []) {
        if (hasAssertedInFields(countryTerm)) {
          pushUniqueMatch(matchedConceptsInVideos, countryTerm);
        }
      }
    }

    const consistencyRatio = tradingFocusedCount / titles.length;
    // A term can appear in more than one knowledge list (e.g. DeFi is both an
    // instrument and an English concept); count the normalized union.
    const normalizedSignalKey = (term: string) => term.normalize('NFKC').toLocaleLowerCase('und');
    const distinctContextualSignals = new Set([
      ...matchedInstrumentsInVideos,
      ...matchedPlatformsInVideos,
      ...matchedConceptsInVideos,
    ].map(normalizedSignalKey)).size;
    // Tier A corroboration must come from more than one video. Generic
    // method/education phrases, bare platform literals and context-gated
    // risk/ICT terms are not high-specificity consistency signals.
    const nonSpecificTierASignals = new Set([
      'KNOWN_METHOD', 'NATIVE_METHOD', 'NATIVE_EDUCATION',
      'PLATFORM', 'EXECUTION_TERM', 'RISK_MANAGEMENT', 'ICT_METHOD',
    ]);
    const tierASignalsAcrossVideos = [...tierASignalVideos.entries()]
      .filter(([signal, videos]) => !nonSpecificTierASignals.has(signal) && videos.size >= 2).length;
    const coreSignalVideos = [...tierASignalVideos.entries()]
      .filter(([signal]) => !nonSpecificTierASignals.has(signal))
      .reduce((total, [, videos]) => total + videos.size, 0);
    // C2 aggregation: a repeated generic phrase is one signal, and a single
    // video cannot establish consistency. Require at least three videos and
    // either one corroborated high-specificity Tier A signal or a high
    // consistency ratio with distinct contextual signals plus at least one
    // core/identity signal. Adjacent-only market commentary cannot qualify.
    const consistencyEligible = titles.length >= 3
      && (tierASignalsAcrossVideos >= 1
        || (coreSignalVideos >= 1 && consistencyRatio >= 0.6 && distinctContextualSignals >= 2));

    // 1. Multi-Video Consistency Evidence
    if (consistencyEligible) {
      const reliabilityMultiplier = consistencyRatio >= 0.6 ? 1.0 : 0.85;
      items.push({
        id: `vid_meta_consist_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'video_metadata',
        polarity: 'POSITIVE',
        category: 'MULTI_VIDEO_CONSISTENCY',
        fact: `Multi-video consistency check: ${tradingFocusedCount}/${titles.length} recent videos (${Math.round(consistencyRatio * 100)}%) focused on trading topics & education`,
        rawMatches: titles.slice(0, 5),
        confidence: Math.round(consistencyRatio * 100),
        reliability: consistencyRatio >= 0.6 ? 'VERY_HIGH' : 'HIGH',
        reliabilityMultiplier,
        rawWeight: Math.round(30 * consistencyRatio),
        finalWeight: Math.round(30 * consistencyRatio) * reliabilityMultiplier,
        provenance: {
          provider: 'video_metadata',
          type: 'MULTI_VIDEO_CONSISTENCY',
          matchedTerm: `${tradingFocusedCount}/${titles.length} videos matching trading terms`,
          sourceRef: 'Sample Video Titles',
          fields:titles.map((_title,index)=>videoRef(index))
        },
        timestamp: now
      });
    }

    // 2. Specific Instrument References in Video Uploads
    if (matchedInstrumentsInVideos.length > 0) {
      items.push({
        id: `vid_meta_inst_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'video_metadata',
        polarity: 'POSITIVE',
        category: 'INSTRUMENT',
        fact: `Recent video uploads cover financial instruments: ${matchedInstrumentsInVideos.join(', ')}`,
        rawMatches: matchedInstrumentsInVideos,
        confidence: 90,
        reliability: 'VERY_HIGH',
        reliabilityMultiplier: 1.0,
        rawWeight: Math.min(25, matchedInstrumentsInVideos.length * 10),
        finalWeight: Math.min(25, matchedInstrumentsInVideos.length * 10) * 1.0 * 0.90,
        provenance: {
          provider: 'video_metadata',
          type: 'INSTRUMENT',
          matchedTerm: matchedInstrumentsInVideos.join(', '),
          sourceRef: 'Sample Video Titles & Descriptions',
          fields:titles.flatMap((_title,index)=>tradingVideoIndexes.has(index)?matchRefs(index,matchedInstrumentsInVideos):[])
        },
        timestamp: now
      });
    }

    // 3. Specific Platform/Broker References in Video Uploads
    if (matchedPlatformsInVideos.length > 0) {
      items.push({
        id: `vid_meta_plat_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'video_metadata',
        polarity: 'POSITIVE',
        category: 'PLATFORM_BROKER_PROPFIRM',
        fact: `Recent video uploads reference platforms/prop firms: ${matchedPlatformsInVideos.join(', ')}`,
        rawMatches: matchedPlatformsInVideos,
        confidence: 95,
        reliability: 'VERY_HIGH',
        reliabilityMultiplier: 1.0,
        rawWeight: Math.min(30, matchedPlatformsInVideos.length * 15),
        finalWeight: Math.min(30, matchedPlatformsInVideos.length * 15) * 1.0 * 0.95,
        provenance: {
          provider: 'video_metadata',
          type: 'PLATFORM_BROKER_PROPFIRM',
          matchedTerm: matchedPlatformsInVideos.join(', '),
          sourceRef: 'Sample Video Titles & Descriptions',
          fields:titles.flatMap((_title,index)=>tradingVideoIndexes.has(index)?matchRefs(index,matchedPlatformsInVideos):[])
        },
        timestamp: now
      });
    }

    // 4. Educational Concepts & Methodology in Video Uploads
    if (matchedConceptsInVideos.length > 0) {
      items.push({
        id: `vid_meta_concept_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'video_metadata',
        polarity: 'POSITIVE',
        category: 'METHODOLOGY_CONCEPT',
        fact: `Recent video titles & descriptions demonstrate educational trading concepts: ${matchedConceptsInVideos.join(', ')}`,
        rawMatches: matchedConceptsInVideos,
        confidence: 90,
        reliability: 'HIGH',
        reliabilityMultiplier: 0.90,
        rawWeight: Math.min(25, matchedConceptsInVideos.length * 8),
        finalWeight: Math.min(25, matchedConceptsInVideos.length * 8) * 0.90 * 0.90,
        provenance: {
          provider: 'video_metadata',
          type: 'METHODOLOGY_CONCEPT',
          matchedTerm: matchedConceptsInVideos.join(', '),
          sourceRef: 'Sample Video Titles & Descriptions',
          fields:titles.flatMap((_title,index)=>tradingVideoIndexes.has(index)?matchRefs(index,matchedConceptsInVideos):[])
        },
        timestamp: now
      });
    }

    return items;
  }
}
