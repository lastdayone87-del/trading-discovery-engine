import type { EvidenceFieldType, LayeredKnowledgeContext } from './types';
import {
  classifyClaimPolarity,
  findScopedTermMatches,
  type ClaimPolarity,
} from './utils/claimPolarity';
import { normalizeMatchToken, textMatchesTerm } from './utils/textMatching';
import {
  MULTILINGUAL_CLASSIFICATION_PACKS,
  type MultilingualClassificationPack,
} from './multilingualClassificationPacks';

/**
 * Shared trading-signal taxonomy.
 *
 * Providers and C5 used to carry separate closed-world vocabularies. That made
 * a document trading for one layer and neutral for the other. This module is
 * the single source of truth: static market-specific patterns, context packs,
 * claim polarity, and the category/strength mapping used by composition,
 * providers, and diagnostics.
 *
 * Strength is deliberately narrow:
 * - TIER_A: market-specific activity, execution, journal, explicit creator
 *   identity, platform, or a governed native execution phrase.
 * - TIER_B: instrument references, market commentary, trading education and
 *   venue/context terms. They are trading-adjacent, not core activity.
 * - TIER_C: generic format words ("trading", "trader") that never establish a
 *   verdict on their own.
 */
export const TRADING_SIGNAL_TAXONOMY_VERSION = 'trading-signal-taxonomy-v1';

export type TradingSignalCategory =
  | 'CREATOR_IDENTITY'
  | 'INSTRUMENT'
  | 'MARKET_METHOD'
  | 'PLATFORM'
  | 'EDUCATION'
  | 'TRADE_JOURNAL'
  | 'MARKET_COMMENTARY'
  | 'HYPE'
  | 'NON_TRADING'
  | 'UNINFORMATIVE';

export type TradingSignalStrength = 'TIER_A' | 'TIER_B' | 'TIER_C';

export interface TradingSignalMatch {
  id: string;
  category: TradingSignalCategory;
  strength: TradingSignalStrength;
  term: string;
  start: number;
  end: number;
  polarity: ClaimPolarity;
  language?: string;
  /** Generic method/education/native phrases need independent market context. */
  generic?: boolean;
}

export type CompositionTextFocus =
  | 'TRADING_CORE'
  | 'TRADING_ADJACENT'
  | 'FINANCE_ADJACENT'
  | 'UNRELATED'
  | 'UNINFORMATIVE';

export interface TradingTextAssessment {
  focus: CompositionTextFocus;
  signals: TradingSignalMatch[];
  assertedSignals: TradingSignalMatch[];
  suppressedSignals: TradingSignalMatch[];
  tierASignals: string[];
  coreSignals: string[];
  adjacentSignals: string[];
  financeSignals: string[];
  unrelatedSignals: string[];
  hasExplicitCreatorIdentity: boolean;
  hasTradingContext: boolean;
}

interface PatternSignalDefinition {
  id: string;
  category: TradingSignalCategory;
  strength: TradingSignalStrength;
  pattern: RegExp;
  generic?: boolean;
}

/**
 * Explicit financial-market context. Generic workplace/education vocabulary
 * such as `gestion du risque`, `point d'entrée` or `riskhantering` is used
 * outside trading too, so those signals only count when the document also
 * names a financial market, instrument, or trading activity.
 */
export const FINANCIAL_CONTEXT_PATTERN = /\b(trad(?:e|ing|er|en)|stocks?|equit(?:y|ies)|crypto(?:currenc(?:y|ies))?|bitcoin|ethereum|forex|commodit(?:y|ies)|brokers?|bourse|börse|boerse|bolsa|borsa|beurs|aktien|aandelen|aksjer|osakkeet|azioni|acciones|titres|handelsplan|tradingdagboek|orderboek|finan(?:ce|cial)|invest(?:ing|ment)?|(?:stock|equity|financial|capital|forex|crypto|futures?|options?|bond|commodit(?:y|ies))\s+markets?)\b/iu;

/**
 * Explicit CJK/Arabic financial-market context. Bare `交易` (transaction),
 * `取引` (transaction/deal) and `注文` (order) are ordinary commercial words
 * too (for example 电商交易教学, 取引先, 商品注文), so they are not market
 * context on their own. Instrument and venue names remain valid context,
 * which keeps 股票交易, 期货交易, 期貨交易, 東京証券取引所 and 日経225 analysis
 * as trading. Both Simplified and Traditional Chinese forms are listed so
 * script choice does not decide whether a creator is recognised.
 */
export const FINANCIAL_CONTEXT_CJK_PATTERN = /(株(?!式会社)|仮想通貨|暗号資産|為替|先物|トレード|投資|板読み|日経|注文フロー|取引所|بورصة|الأسهم|股票|期货|期貨|外汇|外匯|证券|證券|债券|債券|基金|加密货币|加密貨幣|数字货币|數位貨幣|股市|港股|美股|A股|K线|K線|大盘|大盤)/u;

/**
 * Core market-specific signals. Existing IDs (DAY_TRADING,
 * FUTURES_FOREX_TRADING, ORDER_FLOW, EXECUTION, NATIVE_METHOD,
 * NATIVE_EDUCATION) are retained for compatibility with the provider-layer
 * aggregation that filters the three generic IDs.
 */
const CORE_PATTERN_DEFINITIONS: PatternSignalDefinition[] = [
  { id: 'DAY_TRADING', category: 'MARKET_METHOD', strength: 'TIER_A', pattern: /\b(day\s*trading|day\s*trade|intraday|scalp(?:ing|er)|swing\s*trading)\b/giu },
  { id: 'FUTURES_FOREX_TRADING', category: 'MARKET_METHOD', strength: 'TIER_A', pattern: /\b(futures?\s*trading|forex\s*trading|fx\s*trading|options?\s*trading|commodit(?:y|ies)\s*trading|prop\s*firm|funded\s*trader|funded\s*account)\b/giu },
  { id: 'ORDER_FLOW', category: 'MARKET_METHOD', strength: 'TIER_A', pattern: /\b(order\s*flow|volume\s*profile|market\s*structure|price\s*action|liquidity\s*sweep|fair\s*value\s*gap|order\s*block|smart\s*money\s*concepts?|break\s*of\s*structure|footprint\s*chart|delta\s*divergence)\b/giu },
  // Bare `execution`/`risk management` are workplace/legal terms too. They
  // only count when the surface itself supplies financial context (for
  // example "London session execution" or "trading risk management").
  { id: 'EXECUTION', category: 'MARKET_METHOD', strength: 'TIER_A', pattern: /\b(live\s*trading|trading\s*live|trade\s*review|trade\s*setup|position\s*sizing|trading\s*journal|backtest(?:ing)?|trading\s*strategy|trade\s*plan|trading\s*plan|stop\s*loss|take\s*profit|risk\s*[\/-]?\s*reward|(?:session|trade|trading|market|order)\s+execution|execution\s+(?:strategy|desk|venue)|(?:trade|trading|position|portfolio|market)\s+risk\s+management)\b/giu },
  { id: 'NATIVE_METHOD', category: 'MARKET_METHOD', strength: 'TIER_A', generic: true, pattern: /(analyse\s*technique|analisi\s*tecnica|an[aá]lisis\s*t[eé]cnico|technische\s*analyse|teknisk\s*analys|teknisk\s*analyse|b[oö]rsen?analyse|beursanalyse|aktiehandel|daghandel|trading\s*futures|futuros\s*trading|opciones\s*trading|strategia\s*(?:di\s*)?trading|plan\s*(?:de\s*)?trading|piano\s*(?:di\s*)?trading|gestione\s*della\s*posizione|gestion\s*de\s*la\s*position|positionsverwaltung|トレード|デイトレード|先物取引|テクニカル分析|板読み|オーダーフロー|تحليل\s*فني)/giu },
  // C5 multilingual education/execution vocabulary. These are the same
  // governed language-pack phrases used by the deterministic providers; they
  // classify a document as trading-adjacent, not an entire creator as
  // confirmed. Generic rules below require an independent market dimension.
  { id: 'NATIVE_EDUCATION', category: 'EDUCATION', strength: 'TIER_A', generic: true, pattern: /(trading\s*lernen|trading\s*strateg(?:y|ies|ien|ie)|strategie\s*erkl[aä]rt|chartanalyse|trade\s*analyse|fehleranalyse|trading\s*ausbildung|trade\s*einstieg|stop\s*loss|positionsgr[oö][sß]e|risiko\s*pro\s*trade|markttechnik|orderflow|trading\s*journal|strategie\s*backtest|gestion\s*du\s*risque|journal\s*de\s*trading|carnet\s*d.ordres|point\s*d.entr[eé]e|backtest\s*strat[eé]gie|formation\s*trading|strat[eé]gie\s*expliqu[eé]e|analyse\s*de\s*trade|cours\s*de\s*trading|gesti[oó]n\s*de\s*riesgo|diario\s*de\s*trading|punto\s*de\s*entrada|flujo\s*de\s*[oó]rdenes|backtest\s*de\s*estrategia|curso\s*de\s*trading|estrategia\s*explicada|an[aá]lisis\s*de\s*operaciones|clase\s*de\s*trading|gestione\s*del\s*rischio|diario\s*di\s*trading|punto\s*di\s*ingresso|book\s*ordini|backtest\s*strategia|corso\s*di\s*trading|strategia\s*spiegata|analisi\s*delle\s*operazioni|lezione\s*di\s*trading|risicomanagement|tradingdagboek|instappunt|orderboek|leren\s*traden|strategie\s*uitgelegd|technische\s*analyse|trading\s*cursus|risikostyring|inngangspunkt|ing[aå]ngspunkt|aksjehandel|handelsstrategi|riskhantering|handelsplan|l[aæ]r\s*(?:dig\s*)?trading|teknisk\s*analys|エントリーポイント|損切り|資金管理|トレード日誌|ストラテジー検証|トレード講座|手法解説|トレード振り返り|初心者向けfx|خطة\s*التداول|إدارة\s*المخاطر|نقطة\s*الدخول|وقف\s*الخسارة|تعليم\s*التداول|تحليل\s*فني|交易计划|风险管理|入场点|止损|股票交易|策略回测|交易教学|技术分析|交易策略|交易計劃|風險管理|入場點|止損|策略回測|交易教學|技術分析|期貨交易|外匯交易|pelan\s*dagangan|pengurusan\s*risiko|titik\s*masuk|henti\s*rugi|dagangan\s*saham|belajar\s*berdagang|analisis\s*teknikal|strategi\s*dagangan|ma\s+semaine\s+de\s+trading|trading\s+au\s+quotidien|trading\s+au\s+sens\s+large|les\s+bases\s+(?:de|du)\s+trading|trader\s+le\s+fondamental)/giu },
  { id: 'MARKET_METHOD_SHORTHAND', category: 'MARKET_METHOD', strength: 'TIER_A', pattern: /\b(?:smc|smart\s*money(?:\s*concepts?)?|price\s*action|fair\s*value\s*gap|fvg|order\s*block|liquidity\s*sweep|market\s*structure|break\s*of\s*structure)\b/giu },
  // `ICT` is also information-and-communications-technology. It only becomes
  // core trading evidence when the same document supplies market context.
  { id: 'ICT_METHOD', category: 'MARKET_METHOD', strength: 'TIER_A', pattern: /\bict\b/giu },
  // Risk/position vocabulary is execution practice, not generic education.
  // The multilingual forms are the same governed phrases the language packs
  // already contain, promoted to core because they describe trade management.
  { id: 'RISK_MANAGEMENT', category: 'MARKET_METHOD', strength: 'TIER_A', pattern: /(?:position\s*sizing|risk\s*per\s*trade|gestion\s*du\s*risque|gestion\s*de\s*riesgo|gestione\s*del\s*rischio|risikomanagement|risikostyring|riskhantering|risicomanagement|positionsgr[oö][sß]e|risiko\s*pro\s*trade|资金管理|リスク管理|リスクヘッジ|損切り)/giu },
  { id: 'TRADE_JOURNAL', category: 'TRADE_JOURNAL', strength: 'TIER_A', pattern: /(?:\btrades?\s+(?:for|from)\s+[^.!?\n]{0,48}?\d{4}\b|\btrade\s+journal\b|\btrading\s+journal\b|\bjournal\s+de\s+trading\b|\bdiario\s+de\s+trading\b|\bdiario\s+di\s+trading\b|\bcarnet\s*d['’]?ordres\b|\btradingdagboek\b|トレード日誌)/giu },
  { id: 'CREATOR_IDENTITY', category: 'CREATOR_IDENTITY', strength: 'TIER_A', pattern: /(?:\b(?:forex|crypto|stock|equity|futures?|options?|gold|silver|commodit(?:y|ies)|day|swing|prop|funded|professional)\s+trader\b|\b(?:trader|trading)\s+(?:since|depuis|desde|dal|sinds|seit)\s+\d{4}\b|\bfunded\s*(?:trader|account)\b|\b(?:je\s+(?:suis\s+)?(?:un\s+)?trader|ich\s+(?:bin\s+)?trader|sono\s+(?:un\s+)?trader|soy\s+(?:un\s+)?trader)\b)/giu },
  // A creator bio that declares trading as its subject ("Trading et
  // Investissement sur les marchés") is an explicit creator statement even
  // when no first-person "trader" noun appears.
  { id: 'CREATOR_TRADING_INVESTING', category: 'CREATOR_IDENTITY', strength: 'TIER_A', pattern: /\b(?:trading\s*(?:et|and|&|und|y|e)\s*(?:investing|investissement|investimenti|inversi[oó]n|investieren|investimento)|(?:investing|investissement|investimenti|inversi[oó]n)\s*(?:et|and|&|und|y|e)\s*trading)\b/giu },
  { id: 'TRADING_PSYCHOLOGY', category: 'MARKET_METHOD', strength: 'TIER_A', pattern: /(?:\b(?:trading|trader)\s+psychology\b|\btradingpsychologie\b|\bpsychologie\s+du\s+trader\b|\bpsicolog[ií]a\s+del\s+trader\b|\bpsicologia\s+del\s+trader\b|トレード心理)/giu },
  { id: 'INSTRUMENT_TRADING', category: 'MARKET_METHOD', strength: 'TIER_A', pattern: /\b(?:nq|es|ym|rty|dax|ftse|cac\s*40|cac40|spx|ndx|vix|eurusd|gbpusd|usdjpy|audusd|usdcad|usdchf|nzdusd|xauusd|xagusd|btc|eth|sol|nasdaq|s&p\s*500|sp500|dow\s*jones|aapl|tsla|msft|nvda|amzn|googl|meta|usoil|wti|brent|spy|qqq)\s+(?:futures?\s+)?(?:trading|trades?|analysis|analyse|chart(?:s)?|setup|setups|live)\b/giu },
];

/**
 * Trading-adjacent and finance-adjacent definitions. Instrument/venue and
 * commentary matches only become a trading composition family when an
 * independent trading dimension is present; finance terms never count toward
 * trading dominance.
 */
const CONTEXT_PATTERN_DEFINITIONS: PatternSignalDefinition[] = [
  { id: 'MARKET_ANALYSIS', category: 'MARKET_COMMENTARY', strength: 'TIER_B', generic: true, pattern: /\b(?:market\s*(?:analysis|update|outlook|recap|commentary|review|news)|premarket\s*analysis|daily\s*bias|technical\s*analysis|chart\s*analysis|analyse\s*technique|analisi\s*tecnica|an[aá]lisis\s*t[eé]cnico|technische\s*analyse|teknisk\s*analys|teknisk\s*analyse|b[oö]rsen?analyse|beursanalyse|marktanalyse|chartanalyse|marknadsanalys|markedsanalyse)\b/giu },
  { id: 'MARKET_VENUE', category: 'MARKET_COMMENTARY', strength: 'TIER_B', pattern: /\b(?:stock\s*market|equity\s*market|forex\s*market|fx\s*market|crypto\s*market|financial\s*markets?|bourse|börse|boerse|bolsa(?:\s+de\s+valores)?|borsa|beurs|wall\s*street|nasdaq|nyse|s&p\s*500|dow\s*jones|ftse|dax|cac\s*40|cac40|nikkei|ibex|aex|ftse\s*mib|tsx|asx|solana|bitcoin|ethereum)\b/giu },
  // Gold is written "or" in French. A bare conjunction is not an instrument
  // reference, so the commodity pattern requires a price/position frame.
  { id: 'COMMODITY', category: 'MARKET_COMMENTARY', strength: 'TIER_B', pattern: /(?:\bl['’]or\b|\bcours\s+de\s+l['’]or\b|\bor\s+(?:sous|au-dessus|au\s+dessus|en\s+dessous|prix)\b|\b(?:gold|silver|crude|brent|wti)\s+(?:price|chart|analysis|setup|position)\b)/giu },
  { id: 'MARKET_MOVEMENT', category: 'MARKET_COMMENTARY', strength: 'TIER_B', generic: true, pattern: /\b(?:rally|selloff|sell-off|crash|pullback|breakout|breakdown|panic|panique|opportunit[eé]|opportunity|hausse|baisse|bullish|bearish|support|resistance|forecast|outlook|price\s*(?:forecast|analysis|target))\b/giu },
  { id: 'BUSINESS_NEWS', category: 'MARKET_COMMENTARY', strength: 'TIER_B', pattern: /\b(?:business\s*news|company\s*earnings\s*news|economic\s*headlines|market\s*news\s*bulletin|economic\s*news|financial\s*news)\b/giu },
  { id: 'GENERIC_FINANCE', category: 'MARKET_COMMENTARY', strength: 'TIER_B', pattern: /\b(?:personal\s*finance|saving\s*money|passive\s*income|dividend\s*portfolio|dividends?|long\s*term\s*investing|invest(?:ing|ment|ments)?|retirement(?:\s*planning)?|budgeting|credit\s*card\s*points|paying\s*off\s*debt|mortgage\s*calculator|real\s*estate\s*investing|property\s*investing|wealth\s*building|financial\s*freedom)\b/giu },
  { id: 'MOTIVATION', category: 'MARKET_COMMENTARY', strength: 'TIER_B', pattern: /\b(?:millionaire\s*mindset|success\s*motivation|financial\s*freedom\s*motivation|hustle\s*motivation)\b/giu },
  { id: 'HYPE', category: 'HYPE', strength: 'TIER_B', pattern: /\b(?:100x\s*crypto|next\s*bitcoin|guaranteed\s*profits?|guaranteed\s*returns?|crypto\s*gem|moonshot|get\s*rich\s*quick|make\s*you\s*rich|guaranteed\s*gains?)\b/giu },
];

/** Governed non-trading domains. They are opposition only when creator-level. */
const NON_TRADING_PATTERN_DEFINITIONS: PatternSignalDefinition[] = [
  { id: 'NON_TRADING_MUSIC', category: 'NON_TRADING', strength: 'TIER_C', pattern: /\b(official\s*music\s*videos?|music\s*videos?|official\s*audio|lyrics?\s*videos?|album|single|singer|song|record\s*label|clip\s*officiel|chanson|artiste|music\s*artist|artist\s*interviews?)\b/giu },
  { id: 'NON_TRADING_GAMING', category: 'NON_TRADING', strength: 'TIER_C', pattern: /\b(gameplay|walkthrough|playthrough|minecraft|roblox|fortnite|valorant|league\s*of\s*legends|gta\s*v?|call\s*of\s*duty|pokemon|pokémon|genshin|esports?|gaming)\b/giu },
  { id: 'NON_TRADING_COOKING', category: 'NON_TRADING', strength: 'TIER_C', pattern: /\b(recipe|recipes|cooking|kitchen|bake|baking|chef|cuisine|mukbang|street\s*food)\b/giu },
  { id: 'NON_TRADING_FILM_TV', category: 'NON_TRADING', strength: 'TIER_C', pattern: /\b(movie\s*review|film\s*review|trailer\s*reaction|series\s*recap|anime|k-drama|tv\s*show)\b/giu },
  { id: 'NON_TRADING_SPORTS', category: 'NON_TRADING', strength: 'TIER_C', pattern: /\b(match\s*highlights|football|soccer|nba|cricket|tennis|golf|sports?\s*news)\b/giu },
  { id: 'NON_TRADING_LIFESTYLE', category: 'NON_TRADING', strength: 'TIER_C', pattern: /\b(makeup\s*tutorial|beauty\s*vlog|fashion\s*haul|travel\s*vlog|unboxing|prank|asmr)\b/giu },
  { id: 'NON_TRADING_CARDS', category: 'NON_TRADING', strength: 'TIER_C', pattern: /\b(trading\s*cards?|card\s*trading|skin\s*trading|steam\s*trading|sports?\s*cards?)\b/giu },
];

const EXPLICIT_ALTERNATIVE_IDENTITY = /\b(official\s*music(?:\s*videos)?|music\s*artist|gaming\s*channel|cooking\s*channel|food\s*channel|beauty\s*channel|film\s*&\s*tv|movie\s*channel)\b/iu;

const TIER_C_PATTERN = /\b(trading|trader|trade)\b/iu;

const GENERIC_CORE_IDS: ReadonlySet<string> = new Set([
  'KNOWN_METHOD',
  'NATIVE_METHOD',
  'NATIVE_EDUCATION',
]);

/** Tier A phrases that need independent market context before they are core. */
const CONTEXT_GATED_CORE_IDS: ReadonlySet<string> = new Set([
  'RISK_MANAGEMENT',
  'ICT_METHOD',
]);

const CORE_IDS: ReadonlySet<string> = new Set([
  'DAY_TRADING', 'FUTURES_FOREX_TRADING', 'ORDER_FLOW', 'EXECUTION',
  'MARKET_METHOD_SHORTHAND', 'RISK_MANAGEMENT', 'ICT_METHOD', 'TRADE_JOURNAL', 'CREATOR_IDENTITY',
  'CREATOR_TRADING_INVESTING', 'TRADING_PSYCHOLOGY', 'INSTRUMENT_TRADING', 'PLATFORM', 'EXECUTION_TERM',
  'KNOWN_METHOD', 'NATIVE_METHOD', 'NATIVE_EDUCATION',
]);

const ADJACENT_IDS: ReadonlySet<string> = new Set([
  'MARKET_ANALYSIS', 'MARKET_VENUE', 'MARKET_MOVEMENT', 'COMMODITY', 'INSTRUMENT',
  'EDUCATION_TERM', 'COUNTRY_NATIVE',
]);

const FINANCE_IDS: ReadonlySet<string> = new Set([
  'BUSINESS_NEWS', 'GENERIC_FINANCE', 'MOTIVATION', 'HYPE',
]);

const UNRELATED_IDS: ReadonlySet<string> = new Set([
  'NON_TRADING_MUSIC', 'NON_TRADING_GAMING', 'NON_TRADING_COOKING',
  'NON_TRADING_FILM_TV', 'NON_TRADING_SPORTS', 'NON_TRADING_LIFESTYLE',
  'NON_TRADING_CARDS', 'NON_TRADING_CONTEXT',
]);

function normalizeText(value: string): string {
  return String(value || '').normalize('NFKC');
}

function stripForComparison(value: string): string {
  return normalizeText(value)
    .toLocaleLowerCase('en')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/\b(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?/gu, ' ')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const GENERIC_BOILERPLATE = [
  /^share your videos with friends family and the world$/u,
  /^welcome to (?:my|our) channel$/u,
  /^subscribe(?: to (?:my|our) channel)?$/u,
  /^business inquiries?$/u,
  /^contact (?:me|us)(?: at .*)?$/u,
  /^(?:official|main) channel$/u,
  /^no videos? yet$/u,
];

/** Bare links, boilerplate and content-free text are absence, not opposition. */
export function isUninformativeText(text: string): boolean {
  const stripped = stripForComparison(text);
  if (!stripped) return true;
  if (!/\p{L}/u.test(stripped)) return true;
  if (GENERIC_BOILERPLATE.some(pattern => pattern.test(stripped))) return true;
  const raw = normalizeText(text).trim();
  if (/^(?:https?:\/\/|www\.)\S+$/iu.test(raw)) return true;
  // Bare link domains are routing metadata, not content. `t.me`, `g` and
  // `youtube.com/@creator` carry no affirmative or negative signal.
  if (/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[\w\-./?%&=#+@~]*)?$/iu.test(raw)) return true;
  if (/^(?:t\.me|discord\.gg|discord\.com|youtube\.com|youtu\.be|instagram\.com|linktr\.ee)\/\S*$/iu.test(raw)) return true;
  return false;
}

function addMatch(
  out: TradingSignalMatch[],
  seen: Set<string>,
  match: TradingSignalMatch,
): void {
  const key = `${match.id}:${match.start}:${match.end}:${normalizeMatchToken(match.term)}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(match);
}

function matchDefinitions(
  text: string,
  definitions: PatternSignalDefinition[],
  out: TradingSignalMatch[],
  seen: Set<string>,
  language?: string,
): void {
  for (const definition of definitions) {
    const pattern = new RegExp(definition.pattern.source, definition.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (end <= start) {
        pattern.lastIndex += 1;
        continue;
      }
      const polarity = classifyClaimPolarity(text, start, end, language);
      addMatch(out, seen, {
        id: definition.id,
        category: definition.category,
        strength: definition.strength,
        term: match[0],
        start,
        end,
        polarity: polarity.polarity,
        language,
        generic: definition.generic,
      });
    }
  }
}

function matchTerms(
  text: string,
  terms: string[],
  id: string,
  category: TradingSignalCategory,
  strength: TradingSignalStrength,
  out: TradingSignalMatch[],
  seen: Set<string>,
  options: { language?: string; generic?: boolean } = {},
): void {
  for (const term of [...new Set(terms.filter(Boolean))]) {
    for (const match of findScopedTermMatches(text, [term], options.language)) {
      addMatch(out, seen, {
        id,
        category,
        strength,
        term,
        start: match.start,
        end: match.end,
        polarity: match.polarity,
        language: options.language,
        generic: options.generic,
      });
    }
  }
}

const AMBIGUOUS_EXECUTION_TERM = /^(?:gestion\s+du\s+risque|gesti[oó]n\s+de\s+riesgo|gestione\s+del\s+rischio|risicomanagement|risikomanagement|risikostyring|riskhantering)$/iu;

/** Risk-management phrases used outside trading; context must come elsewhere. */
export function isAmbiguousExecutionTerm(term: string): boolean {
  return AMBIGUOUS_EXECUTION_TERM.test(term);
}

function languagePacks(context?: LayeredKnowledgeContext): MultilingualClassificationPack[] {
  const codes = new Set<string>();
  for (const pack of [
    ...(context?.languageKnowledgePacks || []),
    ...(context?.languageKnowledge ? [context.languageKnowledge] : []),
  ]) {
    if (pack?.languageCode) codes.add(pack.languageCode);
  }
  return [...codes]
    .map(code => MULTILINGUAL_CLASSIFICATION_PACKS[code as keyof typeof MULTILINGUAL_CLASSIFICATION_PACKS])
    .filter((pack): pack is MultilingualClassificationPack => Boolean(pack));
}

/**
 * All deterministic signal occurrences. Non-asserted matches are returned so
 * diagnostics can show suppressed disclaimers/quotes; callers must use
 * `assertedSignals` for classification.
 */
export function matchTradingSignals(
  text: string,
  context: LayeredKnowledgeContext,
  field?: EvidenceFieldType,
): TradingSignalMatch[] {
  const normalized = normalizeText(text);
  const matches: TradingSignalMatch[] = [];
  const seen = new Set<string>();

  matchDefinitions(normalized, CORE_PATTERN_DEFINITIONS, matches, seen);
  matchDefinitions(normalized, CONTEXT_PATTERN_DEFINITIONS, matches, seen);
  matchDefinitions(normalized, NON_TRADING_PATTERN_DEFINITIONS, matches, seen);

  // Context packs: governed instruments, platforms, country phrases, and the
  // 13 language packs shared with the deterministic providers.
  matchTerms(normalized, context.globalInstruments || [], 'INSTRUMENT', 'INSTRUMENT', 'TIER_B', matches, seen, { generic: true });
  matchTerms(normalized, context.countryKnowledge?.popularInstruments || [], 'INSTRUMENT', 'INSTRUMENT', 'TIER_B', matches, seen, { generic: true });
  matchTerms(normalized, context.globalPlatformsPropFirms || [], 'PLATFORM', 'PLATFORM', 'TIER_A', matches, seen);
  matchTerms(
    normalized,
    (context.globalAdvancedConcepts || []).filter(term => !/technical\s*analysis|market\s*analysis/i.test(term)),
    'KNOWN_METHOD',
    'MARKET_METHOD',
    'TIER_A',
    matches,
    seen,
    { generic: true },
  );
  matchTerms(normalized, context.countryKnowledge?.nativeTradingTerminology || [], 'COUNTRY_NATIVE', 'MARKET_COMMENTARY', 'TIER_B', matches, seen);
  matchTerms(
    normalized,
    (context.globalNegativeTerms || []).filter(term => !/^trading$/i.test(term)),
    'NON_TRADING_CONTEXT',
    'NON_TRADING',
    'TIER_C',
    matches,
    seen,
  );

  for (const pack of languagePacks(context)) {
    const language = pack.languageCode;
    matchTerms(normalized, pack.executionTerms.filter(term => !AMBIGUOUS_EXECUTION_TERM.test(term)), 'EXECUTION_TERM', 'MARKET_METHOD', 'TIER_A', matches, seen, { language });
    matchTerms(normalized, pack.educationalTerms, 'EDUCATION_TERM', 'EDUCATION', 'TIER_B', matches, seen, { language, generic: true });
    matchTerms(normalized, pack.businessNewsTerms, 'BUSINESS_NEWS', 'MARKET_COMMENTARY', 'TIER_B', matches, seen, { language });
    matchTerms(normalized, pack.genericFinanceTerms, 'GENERIC_FINANCE', 'MARKET_COMMENTARY', 'TIER_B', matches, seen, { language });
    matchTerms(normalized, pack.hypeTerms, 'HYPE', 'HYPE', 'TIER_B', matches, seen, { language });
    matchTerms(normalized, pack.motivationTerms, 'MOTIVATION', 'MARKET_COMMENTARY', 'TIER_B', matches, seen, { language });
  }

  return matches.sort((a, b) => a.start - b.start || a.end - b.end);
}

const AMBIGUOUS_TRADING_USAGE = /\b(?:trading\s*cards?|card\s*trading|skin\s*trading|steam\s*trading|sports?\s*cards?|pok[eé]mon|yugioh|yu-gi-oh)\b/iu;

const MARKET_SPECIFIC_CONTEXT = /\b(?:stocks?|equit(?:y|ies)|crypto(?:currenc(?:y|ies))?|bitcoin|ethereum|forex|commodit(?:y|ies)|brokers?|bourse|börse|boerse|bolsa|borsa|beurs|aktien|aandelen|aksjer|osakkeet|azioni|acciones|titres|handelsplan|tradingdagboek|orderboek|(?:stock|equity|financial|capital|forex|crypto|futures?|options?|bond|commodit(?:y|ies))\s+markets?)\b/iu;

function hasTradingContext(
  text: string,
  asserted: TradingSignalMatch[],
  context?: LayeredKnowledgeContext,
): boolean {
  if (asserted.some(match => match.id === 'INSTRUMENT')) return true;
  if (asserted.some(match => match.id === 'CREATOR_IDENTITY')) return true;
  const ambiguousTradingUsage = AMBIGUOUS_TRADING_USAGE.test(text);
  // Bare "trading" is card/skin/game vocabulary too. It supplies financial
  // context only when the document is not explicitly about those domains.
  if (!ambiguousTradingUsage && TIER_C_PATTERN.test(text)) return true;
  if (FINANCIAL_CONTEXT_CJK_PATTERN.test(text)) return true;
  // Do not let an ambiguous platform literal ("apex") supply its own
  // financial context for a gaming/card video.
  if (asserted.some(match => match.id === 'MARKET_VENUE')) return true;
  if (FINANCIAL_CONTEXT_PATTERN.test(text)) {
    // `investing`/`finance` alone come from the broad legacy pattern. They
    // make a document finance-adjacent, not trading. Require an explicit
    // market/trading word or instrument for trading context.
    if (MARKET_SPECIFIC_CONTEXT.test(text)) return true;
    return !ambiguousTradingUsage && /\b(?:trad(?:e|ing|er|en)|handelsplan|tradingdagboek|orderboek)\b/iu.test(text);
  }
  return false;
}

function strongestCore(matches: TradingSignalMatch[]): TradingSignalMatch[] {
  return matches.filter(match => !GENERIC_CORE_IDS.has(match.id));
}

/**
 * Classify a creator-owned document. This replaces the second closed-world
 * pattern set C5 used before; providers and composition now agree by
 * construction.
 */
export function assessTradingText(
  text: string,
  context?: LayeredKnowledgeContext,
  field?: EvidenceFieldType,
): TradingTextAssessment {
  const normalized = normalizeText(text);
  const signals = matchTradingSignals(normalized, context || {} as LayeredKnowledgeContext, field);
  const asserted = signals.filter(match => match.polarity === 'ASSERTED');
  const suppressed = signals.filter(match => match.polarity !== 'ASSERTED');

  if (isUninformativeText(normalized)) {
    return {
      focus: 'UNINFORMATIVE',
      signals,
      assertedSignals: asserted,
      suppressedSignals: suppressed,
      tierASignals: [],
      coreSignals: [],
      adjacentSignals: [],
      financeSignals: [],
      unrelatedSignals: [],
      hasExplicitCreatorIdentity: false,
      hasTradingContext: false,
    };
  }

  const tradingContext = hasTradingContext(normalized, asserted, context);
  const coreMatches = asserted.filter(match => CORE_IDS.has(match.id));
  const contextGatedCore = coreMatches.filter(match => !CONTEXT_GATED_CORE_IDS.has(match.id) || tradingContext);
  const specificCore = strongestCore(contextGatedCore);
  const adjacentMatches = asserted.filter(match => ADJACENT_IDS.has(match.id));
  const financeMatches = asserted.filter(match => FINANCE_IDS.has(match.id));
  const unrelatedMatches = asserted.filter(match => UNRELATED_IDS.has(match.id) || match.category === 'NON_TRADING');
  const tierASignals = [...new Set(asserted
    .filter(match => match.strength === 'TIER_A')
    .filter(match => !GENERIC_CORE_IDS.has(match.id) || tradingContext)
    .filter(match => !CONTEXT_GATED_CORE_IDS.has(match.id) || tradingContext)
    .map(match => match.id))];

  // A document that is explicitly about a non-trading domain must stay
  // non-trading unless it also carries specific market activity, not merely
  // the ambiguous literal "trading" (cards/skins) or an ambiguous platform.
  const strongSpecificCore = specificCore.filter(match => match.id !== 'PLATFORM');
  const onlyAmbiguousCore = specificCore.length > 0 && strongSpecificCore.length === 0;
  if (unrelatedMatches.length > 0 && !tradingContext && strongSpecificCore.length === 0) {
    return {
      focus: 'UNRELATED',
      signals,
      assertedSignals: asserted,
      suppressedSignals: suppressed,
      tierASignals,
      coreSignals: coreMatches.map(match => match.id),
      adjacentSignals: adjacentMatches.map(match => match.id),
      financeSignals: financeMatches.map(match => match.id),
      unrelatedSignals: unrelatedMatches.map(match => match.id),
      hasExplicitCreatorIdentity: asserted.some(match => match.id === 'CREATOR_IDENTITY'),
      hasTradingContext: tradingContext,
    };
  }
  if (unrelatedMatches.length > 0 && onlyAmbiguousCore && !tradingContext) {
    return {
      focus: 'UNRELATED',
      signals,
      assertedSignals: asserted,
      suppressedSignals: suppressed,
      tierASignals,
      coreSignals: coreMatches.map(match => match.id),
      adjacentSignals: adjacentMatches.map(match => match.id),
      financeSignals: financeMatches.map(match => match.id),
      unrelatedSignals: unrelatedMatches.map(match => match.id),
      hasExplicitCreatorIdentity: asserted.some(match => match.id === 'CREATOR_IDENTITY'),
      hasTradingContext: tradingContext,
    };
  }

  let focus: CompositionTextFocus;
  if (strongSpecificCore.length > 0) {
    focus = 'TRADING_CORE';
  } else if (specificCore.length > 0) {
    focus = tradingContext || unrelatedMatches.length === 0 ? 'TRADING_CORE' : 'UNRELATED';
  } else if (coreMatches.some(match => match.generic) && tradingContext) {
    focus = 'TRADING_ADJACENT';
  } else if (adjacentMatches.length > 0 && (tradingContext || adjacentMatches.some(match => match.id === 'MARKET_VENUE' || match.id === 'COMMODITY' || match.id === 'INSTRUMENT' || match.id === 'COUNTRY_NATIVE'))) {
    focus = 'TRADING_ADJACENT';
  } else if (financeMatches.length > 0) {
    focus = 'FINANCE_ADJACENT';
  } else if (unrelatedMatches.length > 0) {
    focus = 'UNRELATED';
  } else {
    focus = 'UNINFORMATIVE';
  }

  return {
    focus,
    signals,
    assertedSignals: asserted,
    suppressedSignals: suppressed,
    tierASignals,
    coreSignals: coreMatches.map(match => match.id),
    adjacentSignals: adjacentMatches.map(match => match.id),
    financeSignals: financeMatches.map(match => match.id),
    unrelatedSignals: unrelatedMatches.map(match => match.id),
    hasExplicitCreatorIdentity: asserted.some(match => match.id === 'CREATOR_IDENTITY'),
    hasTradingContext: tradingContext,
  };
}

/** Affirmative trading text = core activity or governed trading-adjacent content. */
export function isAffirmativeTradingText(
  text: string,
  context: LayeredKnowledgeContext,
  field?: EvidenceFieldType,
): boolean {
  const focus = assessTradingText(text, context, field).focus;
  return focus === 'TRADING_CORE' || focus === 'TRADING_ADJACENT';
}

/** Compatibility API retained for existing callers. */
export function classifyCompositionDocument(
  text: string,
  context?: LayeredKnowledgeContext,
): CompositionTextFocus {
  return assessTradingText(text, context).focus;
}

/** Compatibility API retained for existing callers. */
export function isCompositionTradingText(text: string, context?: LayeredKnowledgeContext): boolean {
  return isAffirmativeTradingText(text, context || {} as LayeredKnowledgeContext);
}

/**
 * Compatibility wrapper for C2 aggregation. Returns the distinct Tier A signal
 * IDs, including the three generic IDs that callers explicitly filter.
 */
export function tierATradingSignals(text: string, context?: LayeredKnowledgeContext): string[] {
  const normalized = normalizeText(text);
  const signals: string[] = [];
  // Context-gated phrases (bare risk-management vocabulary and the ambiguous
  // acronym `ICT`) require an independent market/trading word in this
  // compatibility predicate too.
  const hasExplicitContext = TIER_C_PATTERN.test(normalized)
    || FINANCIAL_CONTEXT_PATTERN.test(normalized)
    || FINANCIAL_CONTEXT_CJK_PATTERN.test(normalized);
  for (const definition of CORE_PATTERN_DEFINITIONS.filter(item => item.strength === 'TIER_A')) {
    if (CONTEXT_GATED_CORE_IDS.has(definition.id) && !hasExplicitContext) continue;
    const pattern = new RegExp(definition.pattern.source, definition.pattern.flags);
    if (pattern.test(normalized)) signals.push(definition.id);
  }
  if ((context?.globalAdvancedConcepts || []).some(term => !/technical\s*analysis|market\s*analysis/i.test(term) && textMatchesTerm(normalized, term))) {
    signals.push('KNOWN_METHOD');
  }
  return [...new Set(signals)];
}

/** Polarity-aware Tier A IDs; used where a negated claim must not count. */
export function affirmedTierATradingSignals(text: string, context?: LayeredKnowledgeContext): string[] {
  return [...new Set(matchTradingSignals(text, context || {} as LayeredKnowledgeContext)
    .filter(match => match.polarity === 'ASSERTED' && match.strength === 'TIER_A')
    .map(match => match.id))];
}

/** Compatibility wrapper: Tier A text with generic signals requiring context. */
export function isTierATradingText(text: string, context?: LayeredKnowledgeContext): boolean {
  const normalized = normalizeText(text);
  const signals = tierATradingSignals(normalized, context);
  if (signals.length === 0) return false;
  if (signals.some(signal => !GENERIC_CORE_IDS.has(signal))) return true;
  return FINANCIAL_CONTEXT_PATTERN.test(normalized) || FINANCIAL_CONTEXT_CJK_PATTERN.test(normalized);
}

/** Explicit non-trading identity is used for ALTERNATIVE_DOMINANT routing. */
export function hasExplicitAlternativeIdentity(text: string): boolean {
  return EXPLICIT_ALTERNATIVE_IDENTITY.test(normalizeText(text));
}
