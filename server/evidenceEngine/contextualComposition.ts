import type { EvidenceFieldRef, EvidenceFieldType, LayeredKnowledgeContext, RawChannelInput } from './types';
import { textMatchesTerm } from './utils/textMatching';

/**
 * C5 contextual composition.
 *
 * A creator is not a bag of additive term weights. This module classifies each
 * creator-owned document on its own text, collapses fields that share one
 * underlying item into a family, and asks whether the observed output is
 * coherently trading. The channel title is retained only as a name prior; it
 * is never an observed family or the required non-title Tier A dimension.
 *
 * `search_match_context` is retrieval provenance and is excluded entirely.
 */
export const CONTEXTUAL_COMPOSITION_VERSION = 'contextual-composition-v1';

export type CreatorFocus =
  | 'TRADING_DOMINANT'
  | 'ALTERNATIVE_DOMINANT'
  | 'MIXED'
  | 'INSUFFICIENT_COVERAGE'
  | 'QUERY_ONLY';

export type CompositionDocumentFocus = 'TRADING' | 'ALTERNATIVE' | 'NEUTRAL';

export interface CompositionDocument {
  field: EvidenceFieldType;
  text: string;
  sourceFamilyId: string;
  publishedAt?: string;
}

export interface ContextualCompositionReport {
  version: string;
  focus: CreatorFocus;
  observedFamilies: number;
  tradingFamilies: number;
  alternativeFamilies: number;
  neutralFamilies: number;
  recentTradingFamilies: number;
  recentAlternativeFamilies: number;
  tradingCoverage: number;
  alternativeCoverage: number;
  temporalCoverage: 'KNOWN' | 'UNKNOWN';
  nonTitleTierAFamilies: number;
  explicitCreatorTrading: boolean;
  explicitCreatorAlternative: boolean;
  namePriorTrading: boolean;
  familyClassifications: Array<{ sourceFamilyId: string; field: EvidenceFieldType; focus: CompositionDocumentFocus; recent: boolean; tierA: boolean }>;
  reasonCodes: string[];
}

/** Tier A: high-specificity financial-market activity. */
const TIER_A_PATTERNS: Array<[string, RegExp]> = [
  ['DAY_TRADING', /\b(day\s*trading|day\s*trade|intraday|scalp(?:ing|er)|swing\s*trading)\b/iu],
  ['FUTURES_FOREX_TRADING', /\b(futures?\s*trading|forex\s*trading|fx\s*trading|options?\s*trading|commodit(?:y|ies)\s*trading|prop\s*firm|funded\s*trader|funded\s*account)\b/iu],
  ['ORDER_FLOW', /\b(order\s*flow|volume\s*profile|market\s*structure|price\s*action|liquidity\s*sweep|fair\s*value\s*gap|order\s*block|smart\s*money\s*concepts?|break\s*of\s*structure|footprint\s*chart|delta\s*divergence)\b/iu],
  ['EXECUTION', /\b(live\s*trading|trading\s*live|trade\s*review|trade\s*setup|risk\s*management|position\s*sizing|trading\s*journal|backtest(?:ing)?|trading\s*strategy|execution)\b/iu],
  ['NATIVE_METHOD', /(analyse\s*technique|analisi\s*tecnica|an[aá]lisis\s*t[eé]cnico|technische\s*analyse|teknisk\s*analys|teknisk\s*analyse|b[oö]rsen?analyse|beursanalyse|aktiehandel|daghandel|trading\s*futures|futuros\s*trading|opciones\s*trading|strategia\s*(?:di\s*)?trading|plan\s*(?:de\s*)?trading|piano\s*(?:di\s*)?trading|gestione\s*della\s*posizione|gestion\s*de\s*la\s*position|positionsverwaltung|トレード|デイトレード|先物取引|テクニカル分析|板読み|オーダーフロー)/iu],
  // C5 multilingual education/execution vocabulary. These are the same
  // governed language-pack phrases used by the deterministic providers; they
  // classify a document as trading, not an entire creator as confirmed.
  ['NATIVE_EDUCATION', /(trading\s*lernen|trading\s*strateg(?:y|ies|ien|ie)|strategie\s*erkl[aä]rt|chartanalyse|trade\s*analyse|fehleranalyse|trading\s*ausbildung|trade\s*einstieg|stop\s*loss|positionsgr[oö][sß]e|risiko\s*pro\s*trade|markttechnik|orderflow|trading\s*journal|strategie\s*backtest|gestion\s*du\s*risque|journal\s*de\s*trading|carnet\s*d.ordres|point\s*d.entr[eé]e|backtest\s*strat[eé]gie|formation\s*trading|strat[eé]gie\s*expliqu[eé]e|analyse\s*de\s*trade|cours\s*de\s*trading|gesti[oó]n\s*de\s*riesgo|diario\s*de\s*trading|punto\s*de\s*entrada|flujo\s*de\s*[oó]rdenes|backtest\s*de\s*estrategia|curso\s*de\s*trading|estrategia\s*explicada|an[aá]lisis\s*de\s*operaciones|clase\s*de\s*trading|gestione\s*del\s*rischio|diario\s*di\s*trading|punto\s*di\s*ingresso|book\s*ordini|backtest\s*strategia|corso\s*di\s*trading|strategia\s*spiegata|analisi\s*delle\s*operazioni|lezione\s*di\s*trading|risicomanagement|tradingdagboek|instappunt|orderboek|leren\s*traden|strategie\s*uitgelegd|technische\s*analyse|trading\s*cursus|risikostyring|inngangspunkt|ing[aå]ngspunkt|aksjehandel|handelsstrategi|riskhantering|handelsplan|l[aæ]r\s*(?:dig\s*)?trading|teknisk\s*analys|エントリーポイント|損切り|資金管理|トレード日誌|ストラテジー検証|トレード講座|手法解説|トレード振り返り|初心者向けfx|خطة\s*التداول|إدارة\s*المخاطر|نقطة\s*الدخول|وقف\s*الخسارة|تعليم\s*التداول|تحليل\s*فني|交易计划|风险管理|入场点|止损|股票交易|策略回测|交易教学|技术分析|交易策略|pelan\s*dagangan|pengurusan\s*risiko|titik\s*masuk|henti\s*rugi|dagangan\s*saham|belajar\s*berdagang|analisis\s*teknikal|strategi\s*dagangan)/iu],
];

export function tierATradingSignals(text: string, context?: LayeredKnowledgeContext): string[] {
  const normalized = String(text || '').normalize('NFKC');
  const signals = TIER_A_PATTERNS.filter(([, pattern]) => pattern.test(normalized)).map(([name]) => name);
  if ((context?.globalAdvancedConcepts || []).some(term => !/technical\s*analysis|market\s*analysis/i.test(term) && textMatchesTerm(normalized, term))) {
    signals.push('KNOWN_METHOD');
  }
  return [...new Set(signals)];
}

export function isTierATradingText(text: string, context?: LayeredKnowledgeContext): boolean {
  return tierATradingSignals(text, context).length > 0;
}

/** Format/generic words that never establish trading by themselves. */
const TIER_C_PATTERN = /\b(trading|trader|market|invest|crypto|live|stream|session|finance)\b/iu;

/** Explicit governed alternative-focus signals (not a single ambiguous word). */
const ALTERNATIVE_PATTERNS: Array<[string, RegExp]> = [
  ['MUSIC', /\b(official\s*music\s*video|music\s*video|official\s*audio|lyrics?\s*video|album|single|singer|song|record\s*label|clip\s*officiel|chanson|artiste)\b/iu],
  ['GAMING', /\b(gameplay|walkthrough|playthrough|minecraft|roblox|fortnite|valorant|league\s*of\s*legends|gta\s*v?|call\s*of\s*duty|pokemon|pokémon|genshin|esports?|gaming)\b/iu],
  ['COOKING', /\b(recipe|recipes|cooking|kitchen|bake|baking|chef|cuisine|mukbang|street\s*food)\b/iu],
  ['FILM_TV', /\b(movie\s*review|film\s*review|trailer\s*reaction|series\s*recap|anime|k-drama|tv\s*show)\b/iu],
  ['SPORTS', /\b(match\s*highlights|football|soccer|nba|cricket|tennis|golf|sports?\s*news)\b/iu],
  ['BEAUTY_LIFESTYLE', /\b(makeup\s*tutorial|beauty\s*vlog|fashion\s*haul|travel\s*vlog|unboxing|prank|asmr)\b/iu],
  ['PERSONAL_FINANCE', /\b(personal\s*finance|budgeting|credit\s*card\s*points|save\s*money|paying\s*off\s*debt|mortgage\s*calculator|retirement\s*planning)\b/iu],
];

const EXPLICIT_ALTERNATIVE_IDENTITY = /\b(official\s*music(?:\s*videos)?|music\s*artist|gaming\s*channel|cooking\s*channel|food\s*channel|beauty\s*channel|film\s*&\s*tv|movie\s*channel)\b/iu;

const CREATOR_LEVEL_FIELDS: EvidenceFieldType[] = ['channel_bio', 'transcript_excerpt', 'pinned_comment'];

export function classifyCompositionDocument(text: string, context?: LayeredKnowledgeContext): CompositionDocumentFocus {
  const normalized = String(text || '').normalize('NFKC');
  if (!normalized.trim()) return 'NEUTRAL';
  if (isTierATradingText(normalized, context)) return 'TRADING';
  const alternative = ALTERNATIVE_PATTERNS.some(([, pattern]) => pattern.test(normalized))
    || (context?.globalNegativeTerms || []).some(term => textMatchesTerm(normalized, term) && !/^trading$/i.test(term));
  if (alternative && !TIER_C_PATTERN.test(normalized)) return 'ALTERNATIVE';
  // An explicit alternative identity is still alternative even when a generic
  // trading word appears elsewhere in the same document.
  if (EXPLICIT_ALTERNATIVE_IDENTITY.test(normalized)) return 'ALTERNATIVE';
  return 'NEUTRAL';
}

export function isCompositionTradingText(text: string, context?: LayeredKnowledgeContext): boolean {
  return classifyCompositionDocument(text, context) === 'TRADING';
}

/**
 * Fields that can form a composition family. Registry metadata (country,
 * language, activity) is contextual, not creator output, and cannot make a
 * retrieval-only observation look like an observed family.
 */
const COMPOSITION_FIELDS: ReadonlySet<EvidenceFieldType> = new Set<EvidenceFieldType>([
  'channel_title',
  'channel_bio',
  'video_title',
  'video_description',
  'playlist_name',
  'playlist_description',
  'external_link_label',
  'external_link_domain',
  'transcript_excerpt',
  'visual_evidence',
  'discord_invite',
  'pinned_comment',
]);

export function creatorOwnedDocuments(input: RawChannelInput): CompositionDocument[] {
  return (input.evidence_corpus || [])
    .filter(document => COMPOSITION_FIELDS.has(document.field))
    .map(document => ({
      field: document.field,
      text: document.text,
      sourceFamilyId: document.sourceFamilyId,
      publishedAt: document.publishedAt,
    }));
}

function isRecent(publishedAt: string | undefined, now: Date): boolean {
  if (!publishedAt) return false;
  const timestamp = Date.parse(publishedAt);
  if (!Number.isFinite(timestamp)) return false;
  return now.getTime() - timestamp <= 365 * 86_400_000;
}

/**
 * Build the C5 composition from the creator-owned corpus. The title is a name
 * prior only; families are counted from bio, videos, playlists, links,
 * transcripts, pinned comments and visual evidence.
 */
export function buildContextualComposition(
  input: RawChannelInput,
  context?: LayeredKnowledgeContext,
  now = new Date(),
): ContextualCompositionReport {
  const documents = creatorOwnedDocuments(input).filter(document => document.field !== 'channel_title');
  const titleDocument = (input.evidence_corpus || []).find(document => document.field === 'channel_title');
  const namePriorTrading = titleDocument ? isCompositionTradingText(titleDocument.text, context) : isCompositionTradingText(input.channel_name, context);

  // Collapse multiple fields of one underlying item into one family. Canonical
  // documents already carry the source family; legacy fixtures fall back to a
  // stable field/index key.
  const byFamily = new Map<string, CompositionDocument[]>();
  documents.forEach((document, index) => {
    const key = document.sourceFamilyId || `${document.field}:${index}`;
    byFamily.set(key, [...(byFamily.get(key) || []), document]);
  });

  let tradingFamilies = 0;
  let alternativeFamilies = 0;
  let neutralFamilies = 0;
  let recentTradingFamilies = 0;
  let recentAlternativeFamilies = 0;
  let nonTitleTierAFamilies = 0;
  let explicitCreatorTrading = false;
  let explicitCreatorAlternative = false;
  const temporalKnown = documents.some(document => Boolean(document.publishedAt));
  const familyClassifications: ContextualCompositionReport['familyClassifications'] = [];

  for (const [sourceFamilyId, familyDocuments] of byFamily) {
    const text = familyDocuments.map(document => document.text).join('\n');
    const focus = classifyCompositionDocument(text, context);
    const tierA = isTierATradingText(text, context);
    const recent = familyDocuments.some(document => isRecent(document.publishedAt, now));
    if (focus === 'TRADING') {
      tradingFamilies++;
      if (recent) recentTradingFamilies++;
      if (tierA) nonTitleTierAFamilies++;
    } else if (focus === 'ALTERNATIVE') {
      alternativeFamilies++;
      if (recent) recentAlternativeFamilies++;
    } else {
      neutralFamilies++;
    }
    if (familyDocuments.some(document => CREATOR_LEVEL_FIELDS.includes(document.field))) {
      if (focus === 'TRADING') explicitCreatorTrading = true;
      if (focus === 'ALTERNATIVE') explicitCreatorAlternative = true;
    }
    familyClassifications.push({ sourceFamilyId, field: familyDocuments[0].field, focus, recent, tierA });
  }

  const observedFamilies = byFamily.size;
  const tradingCoverage = observedFamilies ? tradingFamilies / observedFamilies : 0;
  const alternativeCoverage = observedFamilies ? alternativeFamilies / observedFamilies : 0;
  const reasons: string[] = [];
  let focus: CreatorFocus;

  if (observedFamilies === 0) {
    // Retrieval provenance alone is QUERY_ONLY. A creator-owned title with no
    // other observed family is thin coverage, not query-only: the title is a
    // name prior and the channel still has creator-owned input to evaluate.
    focus = input.search_match_context ? 'QUERY_ONLY' : 'INSUFFICIENT_COVERAGE';
    reasons.push(input.search_match_context ? 'NO_CREATOR_OWNED_OBSERVED_FAMILY' : 'INSUFFICIENT_INDEPENDENT_TRADING_COVERAGE');
  } else if (explicitCreatorTrading && !explicitCreatorAlternative && alternativeCoverage < 0.34) {
    focus = 'TRADING_DOMINANT';
    reasons.push('EXPLICIT_CREATOR_TRADING_STATEMENT');
  } else if (tradingFamilies >= 2 && tradingCoverage >= 0.5 && alternativeCoverage < 0.34) {
    focus = 'TRADING_DOMINANT';
    reasons.push('TRADING_COVERAGE_DOMINANT');
  } else if (explicitCreatorAlternative && !explicitCreatorTrading) {
    focus = 'ALTERNATIVE_DOMINANT';
    reasons.push('EXPLICIT_CREATOR_ALTERNATIVE_STATEMENT');
  } else if (alternativeFamilies >= 2 && alternativeCoverage >= 0.6 && tradingCoverage <= 0.2) {
    focus = 'ALTERNATIVE_DOMINANT';
    reasons.push('ALTERNATIVE_COVERAGE_DOMINANT');
  } else if ((tradingFamilies > 0 && alternativeFamilies > 0)) {
    focus = 'MIXED';
    reasons.push('TRADING_AND_ALTERNATIVE_CONFLICT');
  } else if (recentAlternativeFamilies > recentTradingFamilies && alternativeFamilies > 0 && tradingFamilies > 0) {
    focus = 'MIXED';
    reasons.push('RECENT_ALTERNATIVE_OUTPUT_CONFLICTS_WITH_TRADING_HISTORY');
  } else {
    focus = 'INSUFFICIENT_COVERAGE';
    reasons.push('INSUFFICIENT_INDEPENDENT_TRADING_COVERAGE');
  }

  if (explicitCreatorTrading && explicitCreatorAlternative) {
    focus = 'MIXED';
    reasons.push('EXPLICIT_CREATOR_STATEMENTS_CONFLICT');
  }

  return {
    version: CONTEXTUAL_COMPOSITION_VERSION,
    focus,
    observedFamilies,
    tradingFamilies,
    alternativeFamilies,
    neutralFamilies,
    recentTradingFamilies,
    recentAlternativeFamilies,
    tradingCoverage,
    alternativeCoverage,
    temporalCoverage: temporalKnown ? 'KNOWN' : 'UNKNOWN',
    nonTitleTierAFamilies,
    explicitCreatorTrading,
    explicitCreatorAlternative,
    namePriorTrading,
    familyClassifications,
    reasonCodes: reasons,
  };
}

/** Provenance-aware replacement for the old input-shape hydration guard. */
export function isThinRetrievalComposition(input: RawChannelInput, composition: ContextualCompositionReport): boolean {
  if (Number(input.enrichment_stage || 0) !== 0) return false;
  if (composition.focus === 'QUERY_ONLY') return true;
  // Abstain from terminal rejection only when the negative evidence is not
  // creator-owned. A bio/transcript/pinned-comment negative is creator-level
  // and may reject at stage 0.
  return composition.observedFamilies === 0 && Boolean(input.search_match_context);
}

export function compositionFieldRefs(report: ContextualCompositionReport): EvidenceFieldRef[] {
  return report.familyClassifications
    .filter(family => family.focus === 'TRADING')
    .map(family => ({ field: family.field, sourceFamilyId: family.sourceFamilyId }));
}
