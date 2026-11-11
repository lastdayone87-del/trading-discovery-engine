/**
 * Integrated extracted-query discovery.
 *
 * The extractor returns candidate search phrases, not title fragments or mere
 * tickers. Deterministic segmentation and a strict trading-intent gate run on
 * every candidate before it enters the durable ledger or the planner. Rejected
 * surfaces are reported through the same assessment so the LCB can explain
 * what was discarded and why.
 */
import { createHash } from 'node:crypto';
import { detectLanguage } from './languageDetection';
import { containsReviewedNativePhrase, hasGovernedTradingSemantics, isSearchableTradingTerm } from './terminologySearchability';

export type ExtractedCandidateSourceKind = 'VIDEO_TITLE' | 'PLAYLIST_TITLE' | 'PLAYLIST_DESCRIPTION' | 'DESCRIPTION';

export interface ExtractedQuerySource {
  kind: ExtractedCandidateSourceKind;
  index: number;
  text: string;
  videoId?: string | null;
}

export interface ExtractedQueryCandidate {
  candidateKey: string;
  candidateText: string;
  normalizedText: string;
  country: string;
  language: string;
  script: string;
  sourceKind: ExtractedCandidateSourceKind;
  sourceIndex: number;
  sourceVideoId: string | null;
  sourceTitle: string;
  intent: string;
  confidence: number;
  accepted: boolean;
  standaloneEligible: boolean;
  reasons: string[];
}

export interface ExtractedQueryAssessment {
  candidate: ExtractedQueryCandidate | null;
  candidateText: string;
  language: string;
  script: string;
  reasons: string[];
}

const PROMO_PATTERNS: RegExp[] = [
  /\b(free\s+(signals?|money|course|group|access|training|webinar)|gratis|gratuit|kostenlos|gratuita)\b/iu,
  /\b(subscribe|abonne|abonnieren|suscr[ií]bete|rejoindre|beitreten|follow me|join (my|our|the) (group|channel|telegram|discord))\b/iu,
  /\b(follow\s+(me|us|for|to)|like\s+(and|this|for)|join\s+(now|us|for|my|our|the))\b/iu,
  /\b(telegram|whatsapp|discord|link in bio|giveaway|promo|discount|offer)\b/iu,
  /\b(episode|ep|part|pt|vol|volume|season|saison|temporada|staffel)\s*#?\d+/iu,
  // Two-part dates require two-digit day/month so prices such as 1.5 or
  // ranges such as 20-30 are not misclassified as promotional dates.
  /\b(?:0[1-9]|[12]\d|3[01])[\/-](?:0[1-9]|1[0-2])\b/u,
  /\b(?:0?[1-9]|[12]\d|3[01])[\/.-](?:0?[1-9]|1[0-2])[\/.-]\d{2,4}\b/u,
  /\b(20\d{2})\b/u,
  // Native promotional markers matter most on unspaced scripts, where the
  // Latin word-boundary patterns above cannot see them.
  /(免费|免費|订阅|訂閱|点赞|點讚|加入|链接|連結|优惠|優惠)/u,
];
const CLICKBAIT_PATTERNS: RegExp[] = [
  /\b(blow up|blow-up|you(?:'ve| have) been warned|guaranteed|get rich|easy money|1000x|moonshot|secret hack|copy my trades)\b/iu,
  /[!]{2,}/u,
  /\b(uh oh|oh no|wait for it)\b/iu,
];
const CTA_FORMAT = /\b(click|watch|download|notification|bell|button|shorts|reels?|vlog|podcast|interview)\b/iu;
const EMOJI_OR_SYMBOL = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/u;
const EMOJI_OR_SYMBOL_GLOBAL = new RegExp(EMOJI_OR_SYMBOL.source, 'gu');
const LEADING_STOPWORDS = new Set([
  'uh', 'oh', 'is', 'the', 'a', 'an', 'how', 'to', 'of', 'in', 'on', 'for', 'with', 'and', 'or',
  'de', 'la', 'le', 'les', 'du', 'des', 'et', 'der', 'die', 'das', 'und', 'het', 'een', 'van', 'en',
  'el', 'los', 'las', 'y', 'il', 'gli', 'di', 'e', 'para', 'por', 'con', 'sur', 'dans',
]);
// Function words that are safe to trim from either edge of a window. Keep this
// list to prepositions/articles/conjunctions: content words such as "order",
// "volume" or "support" are trading vocabulary and must never be trimmed.
const TRAILING_STOPWORDS = new Set([
  ...LEADING_STOPWORDS,
  'at', 'by', 'from', 'as', 'than', 'that', 'this', 'these', 'those', 'what', 'why', 'when', 'where',
  'who', 'which', 'into', 'over', 'under', 'after', 'before', 'about', 'around', 'through', 'during',
  'without', 'within', 'across', 'between', 'among', 'per', 'via', 'versus', 'vs', 'is', 'are', 'was',
  'were', 'be', 'been', 'being',
  'für', 'mit', 'von', 'oder', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'einen', 'zu',
  'zum', 'zur', 'auf', 'aus', 'bei', 'nach', 'vor', 'über', 'unter', 'im', 'am', 'an', 'um', 'als',
  'wie', 'wer', 'wo', 'wann', 'warum', 'dass', 'ob',
  'pour', 'avec', 'ou', 'au', 'aux', 'dans', 'sous', 'par', 'vers', 'chez', 'entre', 'sans', 'avant',
  'après', 'pendant', 'depuis', 'contre', 'comme', 'que', 'qui', 'quoi', 'où', 'quand', 'pourquoi',
  'comment',
  'para', 'por', 'o', 'del', 'al', 'a', 'sobre', 'bajo', 'sin', 'antes', 'después', 'durante', 'desde',
  'contra', 'como', 'que', 'quien', 'donde', 'cuando', 'porque', 'cómo',
  'per', 'e', 'di', 'del', 'della', 'dei', 'degli', 'lo', 'i', 'gli', 'uno', 'una', 'su', 'sotto',
  'tra', 'fra', 'senza', 'prima', 'dopo', 'da', 'contro', 'che', 'chi', 'dove', 'quando', 'perché',
  'voor', 'met', 'of', 'van', 'het', 'aan', 'bij', 'naar', 'uit', 'tussen', 'zonder', 'na', 'tijdens',
  'sinds', 'tegen', 'dat', 'die', 'wat', 'wie', 'waar', 'wanneer', 'waarom', 'hoe',
]);
const STRONG_INTENT_TOKENS = new Set([
  'trade', 'trading', 'trader', 'trades', 'traden', 'handel', 'handelsstrategie',
  'technical', 'technische', 'tecnica', 'técnica', 'technique', 'chartanalyse', 'charttechnik',
  'orderflow', 'footprint', 'breakout', 'scalp', 'scalping', 'futures', 'forex', 'crypto',
  'bitcoin', 'btc', 'eth', 'nasdaq', 'nq', 'dax', 'gold', 'silver', 'oil', 'stock', 'stocks',
  'options', 'strategy', 'strategie', 'stratégie', 'strategi', 'liquidity', 'gex', 'gamma',
  'delta', 'vwap', 'seasonality', 'bourse', 'bolsa', 'aandelen', 'aktien', 'aktie', 'aktier',
  'aksi', 'aksje', 'aksjer', 'acciones', 'azioni', 'titoli', 'mercado', 'mercato', 'markt',
  'beurs', 'intradia', 'intradía', 'intraday', 'daytrading', 'portefeuille', 'portfolio',
  'haussier', 'baissier', 'bullish', 'bearish', 'elliott', 'fibonacci', 'hedge', 'arbitrage',
  'bonds', 'yields', 'commodities', 'etf', 'candlestick', 'backtest', 'backtesting',
  'algorithmic', 'quant', 'leverage', 'volatility', 'fundamental', 'fundamentals',
  'börse', 'boerse',
]);
// Ambiguous words are not enough on their own. Two weak trading words
// ("volume profile", "price action", "market analysis") still form a useful
// query, while "movie review tonight" or "customer support tips" do not.
const WEAK_INTENT_TOKENS = new Set([
  'analysis', 'analyse', 'analisi', 'analisis', 'market', 'markets', 'mercado', 'mercato',
  'markt', 'price', 'action', 'volume', 'profile', 'order', 'flow', 'day', 'swing',
  'review', 'recap', 'chart', 'charts', 'risk', 'management', 'support', 'resistance',
  'soporte', 'resistencia', 'widerstand', 'unterstutzung', 'unterstützung', 'index',
  'indices', 'position', 'sizing', 'margin', 'structure', 'outlook', 'trend', 'signal',
  'signals', 'pattern', 'patterns', 'zone', 'zones', 'level', 'levels', 'sentiment',
  'invest', 'investing', 'investir', 'inversión', 'inversion', 'comercio', 'operar',
  'operativa', 'negociación', 'negociacion', 'négociation', 'investisse',
]);


// Script-scoped trading intent for native surfaces the English token list
// cannot see. Substring matching is intentional: Han/Kana/Hangul are unspaced,
// and Tamil/Arabic inflect their trading nouns. The list is deliberately
// narrow (finance/market nouns only), not a generic native-language pass.
// Numbered instrument roots (DAX40, NQ100, SPX500). Only these may drop a
// trailing number when matching intent; stripping digits from every strong
// word would admit brands such as Delta2024 Airlines.
const NUMBERED_TICKER_BASES = new Set([
  'dax', 'nq', 'es', 'ym', 'rty', 'spx', 'ndx', 'nasdaq', 'sp', 'dow', 'russell', 'vix', 'ftse', 'cac', 'ibex', 'omx',
  'stoxx', 'hsi', 'nikkei', 'usd', 'eur', 'gbp', 'jpy', 'aud', 'cad', 'chf',
  'btc', 'eth', 'xau', 'xag', 'wti', 'brent',
]);

const SCRIPT_INTENT_TOKENS: Array<{ script: RegExp; tokens: string[] }> = [
  {
    script: /[\p{Script=Han}]/u,
    tokens: [
      '股票', '股市', '交易', '黄金', '外匯', '外汇', '期貨', '期货', '比特幣', '比特币',
      '加密', '趨勢', '趋势', '支撐', '支撑', '阻力', '基金', '期權', '期权',
      '港股', '美股', '行情', 'K線', 'K线', '技術分析', '技术分析', '短線', '短线', '波段',
      // Kanji-only Japanese surfaces share Han; include specific trading
      // compounds rather than generic finance nouns (投資, 株主, 金利, 相場)
      // that occur in ordinary phrases such as 投資詐欺 or 株主総会.
      '日経', '先物', '日足', '時間足', '板読み', '板情報', '前場', '後場', '東京市場', '株式取引', '株価',
      '株価指数', '日経平均', '高配当株', '株主優待', '証券', '為替', '銘柄', 'チャート',
      '投資信託', '株式投資', 'オプション取引', '先物取引', '信用取引', '空売り', '損切り', '利確',
      'ナンピン', 'レバレッジ', '移動平均', '金利見通し', '金利政策', '相場分析', '相場見通し',
      '仮想通貨', '暗号資産',
    ],
  },
  {
    script: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
    tokens: [
      'トレード', '先物', 'チャート', 'テクニカル', '日足', '時間足', 'ローソク足',
      '板読み', '板情報', 'デイトレード', 'スイング', '株式取引', '株価', '株価指数',
      '日経平均', 'ビットコイン', 'イーサリアム', '仮想通貨', '暗号資産',
      'レバレッジ', 'ナンピン', 'サポートライン', 'レジスタンスライン', 'ファンダメンタルズ',
    ],
  },
  {
    script: /[\p{Script=Hangul}]/u,
    tokens: ['주식', '시장', '거래', '분석', '전략', '투자', '비트코인', '이더리움', '암호화폐', '선물', '옵션', '차트', '주가', '코스피', '코스닥', '환율', '원화', '매매', '금값', '금시세', '금투자', '주식거래', '주식시장', '주식투자', '주식매매', '주식분석', '주식전략'],
  },
  {
    script: /[\p{Script=Tamil}]/u,
    tokens: ['பங்கு', 'சந்தை', 'வர்த்தகம்', 'விலை', 'தங்கம்', 'பகுப்பாய்வு', 'முதலீடு', 'நாணயம்', 'சரக்கு', 'வர்த்தக'],
  },
  {
    script: /[\p{Script=Arabic}]/u,
    tokens: ['تداول', 'سوق', 'أسهم', 'الذهب', 'سعر الذهب', 'أسعار الذهب', 'تداول الذهب', 'تحليل', 'استراتيجية', 'عملات', 'نفط', 'مؤشر', 'استثمار', 'فوركس'],
  },
];

export function normalizeExtractedCandidate(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/[@#]\S*/gu, ' ')
    .replace(EMOJI_OR_SYMBOL_GLOBAL, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s\-–—:|•·!?.,]+|[\s\-–—:|•·!?.,]+$/gu, '')
    .trim();
}

function rawSegments(title: string): string[] {
  const raw = String(title || '')
    .replace(/\([^)]*\)/gu, ' ')
    .replace(/\[[^\]]*\]/gu, ' ')
    .replace(/\s*&\s*/gu, ' ')
    .split(/[|:;•·]+|\s[-–—]\s|\s\+\s/gu)
    .map(normalizeExtractedCandidate)
    .filter(Boolean);
  return [...new Set(raw)];
}

function isClickbait(text: string): boolean {
  return CLICKBAIT_PATTERNS.some(pattern => pattern.test(text));
}

function candidateSegments(title: string): string[] {
  return rawSegments(title).filter(segment => !isClickbait(segment));
}

function containsLiteralPhrase(source: string, candidate: string): boolean {
  if (!candidate) return false;
  // Unspaced native surfaces have no word boundary; substring grounding is
  // the only meaningful literal check. Spaced phrases use Unicode-aware
  // boundaries so "order flow" cannot match inside "disorder flow".
  if (!/\s/u.test(candidate)) return source.includes(candidate);
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(source);
}

function containsNativeToken(text: string, token: string): boolean {
  // Han/Kana are unspaced and Tamil inflects by suffix; substring matching is
  // the meaningful form there.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Tamil}]/u.test(token)) {
    return text.includes(token);
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/\p{Script=Arabic}/u.test(token)) {
    // Arabic attaches articles/particles (الذهب, للسوق, للتداول) but arbitrary
    // substrings such as التسوق ("shopping") must not match سوق. Pronoun
    // endings are allowed only on explicit trading nouns: تداولنا is trading,
    // while ذهبنا is the past-tense verb "we went".
    const allowsPronounEnding = /^(?:تداول|أسهم|استثمار|تحليل|عملات|نفط|مؤشر|فوركس)$/u.test(token);
    const suffix = allowsPronounEnding
      ? '(?:يات|تان|ات|ين|ون|ان|ية|ها|هم|هن|كم|نا|ك)?'
      : '(?:يات|تان|ات|ين|ون|ان|ية)?';
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:ال|لل|بال|كال|فال|وال|و|ف|ب|ل|ك)?${escaped}${suffix}(?![\\p{L}\\p{N}])`, 'iu').test(text);
  }
  // Hangul is spaced: require a real word boundary and rely on explicit
  // compounds (주식거래, 주식시장) instead of matching 주식 inside 주식회사.
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

function hasTradingIntent(text: string, country?: string | null, language?: string | null): boolean {
  const words = text
    .toLocaleLowerCase('en')
    .split(/\s+/gu)
    .map(word => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  let weakMatches = 0;
  for (const word of words) {
    if (STRONG_INTENT_TOKENS.has(word)) return true;
    if (WEAK_INTENT_TOKENS.has(word)) weakMatches += 1;
  }
  if (weakMatches >= 2) return true;
  // The governed multilingual lexicon is the authority for native finance
  // semantics. Restrict it to non-Latin scripts: Latin broker/person names
  // such as "Apex" must not turn a gaming title into a trading query. Latin
  // text still needs a strong term or two weak trading terms above.
  const hasNonLatinScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Tamil}\p{Script=Arabic}]/u.test(text);
  const hasReviewedLatinPhrase = containsReviewedNativePhrase(text);
  if ((hasNonLatinScript || hasReviewedLatinPhrase)
    && hasGovernedTradingSemantics(text, { country, language })) return true;
  // Mixed native titles often carry their instrument as an ASCII ticker
  // (ETHの見方, DAX Analyse). Treat a known strong ticker as intent without
  // widening the generic native token list.
  const asciiTerms = (text.match(/\b[A-Za-z][A-Za-z0-9]{1,}\b/gu) || []) as string[];
  if (asciiTerms.some(term => {
    const lower = term.toLocaleLowerCase('en');
    if (STRONG_INTENT_TOKENS.has(lower)) return true;
    const base = lower.replace(/\d+$/u, '');
    return base !== lower && NUMBERED_TICKER_BASES.has(base);
  })) return true;
  for (const { script, tokens } of SCRIPT_INTENT_TOKENS) {
    if (script.test(text) && tokens.some(token => containsNativeToken(text, token))) return true;
  }
  // Non-Latin surfaces must match a finance/market token. A blanket "any
  // unspaced script" pass would admit travel, gaming and lifestyle titles.
  return false;
}

function trimLeadingStopwords(words: string[]): string[] {
  let start = 0;
  while (start < words.length - 1 && LEADING_STOPWORDS.has(words[start].toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]/gu, ''))) start += 1;
  return words.slice(start);
}

function trimWindow(words: string[]): string[] {
  let start = 0;
  let end = words.length;
  const isStop = (word: string) => TRAILING_STOPWORDS.has(word.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]/gu, ''));
  while (start < end - 1 && isStop(words[start])) start += 1;
  while (end > start + 1 && isStop(words[end - 1])) end -= 1;
  return words.slice(start, end);
}

/** Deterministic 2–6 word windows from one informative segment. */
function segmentWindows(segment: string): string[] {
  const words = trimLeadingStopwords(segment.split(/\s+/gu).filter(Boolean));
  const out = new Set<string>();
  if (words.length < 2) {
    const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(segment);
    return unspaced && segment.length <= 40 ? [segment] : [];
  }
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 2; end <= Math.min(words.length, start + 6); end += 1) {
      const window = trimWindow(words.slice(start, end)).join(' ');
      if (window.split(/\s+/u).length >= 2) out.add(window);
    }
  }
  // Prefer the most complete informative windows; do not flood the ledger with
  // every 2-word fragment.
  return [...out]
    .sort((a, b) => b.split(/\s+/u).length - a.split(/\s+/u).length || b.length - a.length)
    .slice(0, 6);
}

function rejectedCandidate(input: {
  text: string;
  country: string;
  language?: string | null;
  script?: string;
  sourceKind: ExtractedCandidateSourceKind;
  sourceIndex: number;
  sourceVideoId?: string | null;
  sourceTitle: string;
  reasons: string[];
}): ExtractedQueryCandidate | null {
  let candidateText = normalizeExtractedCandidate(input.text);
  // Symbol/emoji-only surfaces normalize to nothing but still deserve an
  // audit row. Keep the original bounded surface and a stable synthetic key.
  let candidateKey = candidateText.toLocaleLowerCase('en');
  if (!candidateText) {
    const raw = String(input.sourceTitle || input.text || '').trim();
    if (!raw) return null;
    candidateText = Array.from(raw).slice(0, 80).join('');
    candidateKey = `nuisance:${createHash('sha1').update(raw).digest('hex').slice(0, 20)}`;
  }
  const detected = detectLanguage(candidateText, { countryHint: input.country });
  const language = detected.language !== 'und'
    ? detected.language
    : (input.language || detected.language);
  const normalizedText = candidateText.toLocaleLowerCase('en');
  return {
    candidateKey,
    candidateText,
    normalizedText,
    country: input.country,
    language,
    script: input.script || detected.script,
    sourceKind: input.sourceKind,
    sourceIndex: input.sourceIndex,
    sourceVideoId: input.sourceVideoId ?? null,
    sourceTitle: input.sourceTitle,
    intent: 'strategy',
    confidence: 0,
    accepted: false,
    standaloneEligible: false,
    reasons: input.reasons,
  };
}

/**
 * Full candidate assessment including the exact rejection reasons. Reasons are
 * stable, machine-readable codes because they are persisted in the ledger and
 * surfaced in the LCB.
 */
export function assessExtractedQueryCandidateDetailed(input: {
  text: string;
  country: string;
  language?: string | null;
  sourceKind: ExtractedCandidateSourceKind;
  sourceIndex: number;
  sourceVideoId?: string | null;
  sourceTitle: string;
  intent?: string;
  confidence?: number;
}): ExtractedQueryAssessment {
  const candidateText = normalizeExtractedCandidate(input.text);
  const detected = detectLanguage(candidateText, { countryHint: input.country });
  const language = detected.language !== 'und'
    ? detected.language
    : (input.language || detected.language);
  const reasons: string[] = [];

  if (!candidateText) {
    reasons.push('EMPTY');
  } else {
    const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(candidateText);
    if (candidateText.length < (unspaced ? 2 : 4)) reasons.push('TOO_SHORT');
    if (candidateText.length > 80) reasons.push('TOO_LONG');
    if (EMOJI_OR_SYMBOL.test(candidateText) || /[@#]/u.test(candidateText)) reasons.push('EMOJI_OR_HASHTAG');
    if (CTA_FORMAT.test(candidateText)) reasons.push('CTA_FORMAT');
    if (isClickbait(candidateText)) reasons.push('CLICKBAIT');
    if (PROMO_PATTERNS.some(pattern => pattern.test(candidateText))) reasons.push('PROMO');

    const words = candidateText.split(/\s+/gu).filter(Boolean);
    if (words.length < (unspaced ? 1 : 2)) reasons.push('TOO_FEW_WORDS');
    if (words.length > 6) reasons.push('TOO_MANY_WORDS');
    if (!/\p{L}/u.test(candidateText)) reasons.push('NO_LETTERS');
    if (!hasTradingIntent(candidateText, input.country, language === 'und' ? undefined : language)) reasons.push('NO_TRADING_INTENT');
    // A segment made only of generic tokens is noise even if it survived a title.
    if (words.every(word => /^(live|video|channel|session|analysis|analyse|trading)$/iu.test(word))) {
      reasons.push('GENERIC_ONLY');
    }

    if (!reasons.length) {
      const gate = isSearchableTradingTerm({
        term: candidateText,
        termType: 'PHRASE',
        country: input.country,
        language: language === 'und' ? undefined : language,
        maxTokens: 6,
        requireTradingSemantics: false,
      });
      if (!gate.eligible) {
        for (const reason of gate.reasons) reasons.push(`GATE_${reason.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`);
      }
    }
  }

  if (reasons.length) {
    return {
      candidate: null,
      candidateText,
      language,
      script: detected.script,
      reasons: [...new Set(reasons)],
    };
  }

  const normalizedText = candidateText.toLocaleLowerCase('en');
  return {
    candidate: {
      candidateKey: normalizedText,
      candidateText,
      normalizedText,
      country: input.country,
      language,
      script: detected.script,
      sourceKind: input.sourceKind,
      sourceIndex: input.sourceIndex,
      sourceVideoId: input.sourceVideoId ?? null,
      sourceTitle: input.sourceTitle,
      intent: input.intent || 'strategy',
      // Deterministic candidates are deliberately capped below the LLM maximum;
      // both must still pass the same strict gate.
      confidence: Math.max(0.5, Math.min(0.95, input.confidence ?? 0.65)),
      accepted: true,
      standaloneEligible: true,
      reasons: [],
    },
    candidateText,
    language,
    script: detected.script,
    reasons: [],
  };
}

export function assessExtractedQueryCandidate(input: {
  text: string;
  country: string;
  language?: string | null;
  sourceKind: ExtractedCandidateSourceKind;
  sourceIndex: number;
  sourceVideoId?: string | null;
  sourceTitle: string;
  intent?: string;
  confidence?: number;
}): ExtractedQueryCandidate | null {
  return assessExtractedQueryCandidateDetailed(input).candidate;
}

interface RejectionSink {
  onRejected?: (candidate: ExtractedQueryCandidate) => void;
  maxRejected: number;
  seen: Set<string>;
}

function emitRejection(
  sink: RejectionSink,
  input: {
    text: string;
    country: string;
    language?: string | null;
    sourceKind: ExtractedCandidateSourceKind;
    sourceIndex: number;
    sourceVideoId?: string | null;
    sourceTitle: string;
    reasons: string[];
  },
): void {
  if (!sink.onRejected || sink.seen.size >= sink.maxRejected) return;
  const rejected = rejectedCandidate(input);
  if (!rejected || sink.seen.has(rejected.candidateKey)) return;
  sink.seen.add(rejected.candidateKey);
  sink.onRejected(rejected);
}

export function deriveDeterministicQueryCandidates(args: {
  sources: ExtractedQuerySource[];
  country: string;
  language?: string | null;
  maxCandidates?: number;
  maxRejected?: number;
  onRejected?: (candidate: ExtractedQueryCandidate) => void;
}): ExtractedQueryCandidate[] {
  const out = new Map<string, ExtractedQueryCandidate>();
  const max = Math.max(1, Math.min(60, args.maxCandidates ?? 30));
  const sink: RejectionSink = {
    onRejected: args.onRejected,
    maxRejected: Math.max(0, Math.min(100, args.maxRejected ?? 40)),
    seen: new Set(),
  };
  for (const source of args.sources) {
    if (!normalizeExtractedCandidate(source.text)) {
      emitRejection(sink, {
        text: source.text, country: args.country, language: args.language,
        sourceKind: source.kind, sourceIndex: source.index, sourceVideoId: source.videoId,
        sourceTitle: source.text, reasons: ['NO_TEXT'],
      });
      continue;
    }
    if (source.kind === 'DESCRIPTION' || source.kind === 'PLAYLIST_DESCRIPTION') {
      // Descriptions are context, not standalone title candidates unless they
      // contain a compact phrase; use only short first segments.
      for (const segment of candidateSegments(source.text).slice(0, 2)) {
        if (segment.split(/\s+/u).length > 8) {
          emitRejection(sink, {
            text: segment, country: args.country, language: args.language,
            sourceKind: source.kind, sourceIndex: source.index, sourceVideoId: source.videoId,
            sourceTitle: source.text, reasons: ['DESCRIPTION_TOO_LONG'],
          });
          continue;
        }
        const assessment = assessExtractedQueryCandidateDetailed({
          text: segment, country: args.country, language: args.language,
          sourceKind: source.kind, sourceIndex: source.index, sourceVideoId: source.videoId,
          sourceTitle: source.text, confidence: 0.55,
        });
        if (assessment.candidate && !out.has(assessment.candidate.candidateKey)) {
          out.set(assessment.candidate.candidateKey, assessment.candidate);
        } else if (!assessment.candidate) {
          emitRejection(sink, {
            text: segment, country: args.country, language: args.language,
            sourceKind: source.kind, sourceIndex: source.index, sourceVideoId: source.videoId,
            sourceTitle: source.text, reasons: assessment.reasons,
          });
        }
      }
      continue;
    }
    const segments = candidateSegments(source.text);
    if (!segments.length && isClickbait(normalizeExtractedCandidate(source.text))) {
      emitRejection(sink, {
        text: source.text, country: args.country, language: args.language,
        sourceKind: source.kind, sourceIndex: source.index, sourceVideoId: source.videoId,
        sourceTitle: source.text, reasons: ['CLICKBAIT'],
      });
    }
    let perSource = 0;
    for (const segment of segments) {
      const windows = segmentWindows(segment);
      if (!windows.length) {
        emitRejection(sink, {
          text: segment, country: args.country, language: args.language,
          sourceKind: source.kind, sourceIndex: source.index, sourceVideoId: source.videoId,
          sourceTitle: source.text, reasons: ['NO_QUERY_WINDOW'],
        });
        continue;
      }
      for (const window of windows) {
        if (out.size >= max || perSource >= 4) break;
        const assessment = assessExtractedQueryCandidateDetailed({
          text: window, country: args.country, language: args.language,
          sourceKind: source.kind, sourceIndex: source.index, sourceVideoId: source.videoId,
          sourceTitle: source.text,
        });
        if (assessment.candidate && !out.has(assessment.candidate.candidateKey)) {
          out.set(assessment.candidate.candidateKey, assessment.candidate);
          perSource += 1;
        } else if (!assessment.candidate) {
          emitRejection(sink, {
            text: window, country: args.country, language: args.language,
            sourceKind: source.kind, sourceIndex: source.index, sourceVideoId: source.videoId,
            sourceTitle: source.text, reasons: assessment.reasons,
          });
        }
      }
      if (out.size >= max || perSource >= 4) break;
    }
    if (out.size >= max) break;
  }
  return [...out.values()].slice(0, max);
}

/** Admit LLM query strings through the same deterministic gate. */
export function assessLlmQueryCandidates(args: {
  queries: unknown[];
  sources: ExtractedQuerySource[];
  country: string;
  language?: string | null;
  maxCandidates?: number;
  maxRejected?: number;
  onRejected?: (candidate: ExtractedQueryCandidate) => void;
}): ExtractedQueryCandidate[] {
  const out = new Map<string, ExtractedQueryCandidate>();
  const max = Math.max(1, Math.min(60, args.maxCandidates ?? 30));
  const sink: RejectionSink = {
    onRejected: args.onRejected,
    maxRejected: Math.max(0, Math.min(100, args.maxRejected ?? 40)),
    seen: new Set(),
  };
  for (const raw of args.queries) {
    if (typeof raw !== 'string') continue;
    const normalizedRaw = normalizeExtractedCandidate(raw).toLocaleLowerCase('en');
    const literalSource = args.sources.find(item =>
      containsLiteralPhrase(normalizeExtractedCandidate(item.text).toLocaleLowerCase('en'), normalizedRaw));
    const source = literalSource || args.sources[0];
    if (!source) continue;
    const assessment = assessExtractedQueryCandidateDetailed({
      text: raw, country: args.country, language: args.language,
      sourceKind: source.kind, sourceIndex: source.index, sourceVideoId: source.videoId,
      sourceTitle: source.text, confidence: 0.8,
    });
    if (!assessment.candidate) {
      emitRejection(sink, {
        text: raw, country: args.country, language: args.language,
        sourceKind: source.kind, sourceIndex: source.index, sourceVideoId: source.videoId,
        sourceTitle: source.text, reasons: assessment.reasons,
      });
    } else if (!literalSource) {
      // The extractor is instructed to quote source text exactly. A clean but
      // ungrounded phrase is a model invention, not an extraction.
      emitRejection(sink, {
        text: raw, country: args.country, language: args.language,
        sourceKind: source.kind, sourceIndex: source.index, sourceVideoId: source.videoId,
        sourceTitle: source.text, reasons: ['NOT_LITERAL_SOURCE'],
      });
    } else if (!out.has(assessment.candidate.candidateKey)) {
      out.set(assessment.candidate.candidateKey, assessment.candidate);
    }
    if (out.size >= max) break;
  }
  return [...out.values()];
}
