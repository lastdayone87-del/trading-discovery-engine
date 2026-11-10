/**
 * Pre-enrichment trading-focus assessment.
 *
 * This is a routing gate, not creator evidence. It uses only already-available
 * channel metadata and search-result content to decide whether the expensive
 * enrichment/semantic path is justified. It deliberately has three outcomes:
 *
 * - ADMIT: a concrete, high-specificity trading hypothesis is present.
 * - WITHHOLD: a competing non-trading domain is present, or the only signal is
 *   a polysemous market word.
 * - DEFER: there is not enough evidence to either spend enrichment quota or
 *   discard the creator. The pipeline persists the channel for review.
 *
 * The previous implementation admitted every candidate whose name or matched
 * document contained at least two letters of a non-Latin script. That turned
 * unfamiliar language into proof of trading relevance and is the direct cause
 * of the MPSC/exam/village channels entering enrichment.
 */
export const INTAKE_TRADING_FOCUS_POLICY_VERSION = 'intake-trading-focus-v1';

export type IntakeTradingFocusDecision = 'ADMIT' | 'WITHHOLD' | 'DEFER';

export interface IntakeTradingFocusInput {
  channelName?: string;
  description?: string;
  matchedDocument?: {
    type?: 'VIDEO' | 'CHANNEL' | 'PLAYLIST' | 'EXTERNAL' | 'MANUAL' | 'UNKNOWN';
    title?: string;
    description?: string;
  } | null;
  videoTitles?: string[];
  videoDescriptions?: string[];
}

export interface IntakeTradingFocusAssessment {
  decision: IntakeTradingFocusDecision;
  reasonCodes: string[];
  matchedSignals: string[];
  positiveFamilies: string[];
  negativeFamilies: string[];
  policyVersion: string;
}

const HIGH_SPECIFICITY_TRADING_SIGNALS: Array<[string, RegExp]> = [
  ['TRADING_LITERAL', /\b(trading|trader|day\s*trading|swing\s*trading|intraday|scalping|scalper)\b/iu],
  ['TECHNICAL_METHOD', /\b(technical\s*analysis|price\s*action|order\s*flow|footprint|market\s*structure|volume\s*profile|liquidity\s*sweep|fair\s*value\s*gap|smart\s*money|ict\b|smc\b)\b/iu],
  ['TRADING_VENUE_OR_PROGRAM', /\b(fx\s*trading|futures?\s*trading|options?\s*trading|cfd\s*trading|spread\s*betting|prop\s*firm|funded\s*trader)\b/iu],
  ['LOCAL_TECHNICAL_ANALYSIS', /\b(analyse\s*technique|analisi\s*tecnica|an[aá]lisis\s*t[eé]cnico|technische\s*analyse|teknisk\s*analys|teknisk\s*analyse|b[oö]rsen?analyse|beursanalyse|aktiehandel|daghandel|futuros\s*trading|opciones\s*trading)\b/iu],
  ['JAPANESE_TRADING', /(トレード|デイトレード|先物取引|テクニカル分析|板読み|オーダーフロー)/u],
  // C1b precision-first Latin-market lexicon. Generic "market"/"trade" is
  // deliberately absent: a shared Latin script does not make an unrelated
  // creator a trading hypothesis. These are high-specificity finance terms in
  // production market languages.
  ['LATIN_MARKET_FINANCE', /\b(börse|aandelen|aktien|aktiehandel|aksjer|aksjehandel|osakkeet|osakekaupank[aä]ynti|børs|borsen|gielda|giełda|bolsa\s+de\s+valores|borsa\s+italiana|borsa\s+di\s+(?:milano|tokyo|londra|new\s+york|francoforte|parigi|madrid|zurigo|hong\s+kong)|mercado\s*de\s*valores|investir\s*en\s*bourse|bourse\s+(?:en\s*ligne|de\s*paris|de\s*bruxelles|de\s*luxembourg|de(?:s)?\s*valeurs?)|analyse\s*boursi[eè]re|cours\s*de\s*bourse|march[eé]\s*boursier|trading\s*boursier|beurs\s*(?:analyse|handel|nieuws|beleggen|strategie|video'?s?)|aandelenbeurs|effectenbeurs|beursbeleggen|beurshandel|analyse\s*technique|analisi\s*tecnica|an[aá]lisis\s*t[eé]cnico|piano\s*di\s*trading|plan\s*de\s*trading|plan\s*de\s*inversi[oó]n)\b/iu],
  // High-specificity trading vocabulary in the production Indic and other
  // non-Latin markets. These are explicit market/trading concepts, not generic
  // script presence. They let a genuine creator pass without requiring English.
  ['HINDI_TRADING', /(ट्रेडिंग|शेयर\s*बाजार|शेयर\s*मार्केट|निफ्टी|सेंसेक्स|स्टॉक\s*मार्केट|स्टॉक|क्रिप्टो|फॉरेक्स|तकनीकी\s*विश्लेषण|प्राइस\s*एक्शन|इंट्राडे|डे\s*ट्रेडिंग|म्यूचुअल\s*फंड)/u],
  ['MARATHI_TRADING', /(ट्रेडिंग|शेअर\s*बाजार|शेअर\s*मार्केट|निफ्टी|सेन्सेक्स|स्टॉक\s*मार्केट|स्टॉक|क्रिप्टो|फॉरेक्स|तांत्रिक\s*विश्लेषण|चार्ट|इंट्राडे)/u],
  ['GUJARATI_TRADING', /(ટ્રેડિંગ|શેર\s*બજાર|નિફ્ટી|સેન્સેક્સ|સ્ટોક\s*માર્કેટ|સ્ટોક|ક્રિપ્ટો|ફોરેક્સ|ટેકનિકલ\s*વિશ્લેષણ|ચાર્ટ)/u],
  ['BENGALI_TRADING', /(শেয়ার\s*বাজার|ট্রেডিং|নিফটি|সেনসেন্স|স্টক\s*মার্কেট|স্টক|ক্রিপ্টো|ফরেক্স|বিনিয়োগ\s*পরামর্শ)/u],
  ['TELUGU_TRADING', /(స్టాక్\s*మార్కెట్|స్టాక్|ట్రేడింగ్|షేర్\s*మార్కెట్|నిఫ్టీ|సెన్సెక్స్|క్రిప్టో|ఫారెక్స్|పెట్టుబడి\s*మార్గదర్శనం)/u],
  ['KANNADA_TRADING', /(ಸ್ಟಾಕ್\s*ಮಾರ್ಕೆಟ್|ಸ್ಟಾಕ್|ಟ್ರೇಡಿಂಗ್|ಷೇರ್\s*ಮಾರ್ಕೆಟ್|ನಿಫ್ಟಿ|ಸೆನ್ಸೆಕ್ಸ್|ಕ್ರಿಪ್ಟೋ|ಫಾರೆಕ್ಸ್|ಹೂಡಿಕೆ\s*ಮಾರ್ಗದರ್ಶನ)/u],
  ['MALAYALAM_TRADING', /(സ്റ്റോക്ക്\s*മാർക്കറ്റ്|സ്റ്റോക്ക്|ട്രേഡിംഗ്|ഓഹരി\s*വിപണി|നിഫ്റ്റി|സെൻസെക്സ്|ക്രിപ്റ്റോ|ഫോറെക്സ്|നിക്ഷേപ\s*മാർഗ്ഗനിർദ്ദേശം)/u],
  ['PUNJABI_TRADING', /(ਸ਼ੇਅਰ\s*ਬਾਜ਼ਾਰ|ਟ੍ਰੇਡਿੰਗ|ਨਿਫਟੀ|ਸੈਂਸੈਕਸ|ਸਟਾਕ\s*ਮਾਰਕੀਟ|ਸਟਾਕ|ਕ੍ਰਿਪਟੋ|ਫੋਰੈਕਸ)/u],
  ['ARABIC_TRADING', /(تداول|أسهم|الأسهم|بورصة|البورصة|فوركس|تحليل\s*فني|عملات\s*رقمية)/u],
  ['TURKISH_TRADING', /(?<![\p{L}\p{N}])(borsa\s+istanbul|bist\s*100|hisse|hisseler|yatırım|yatirim|döviz|doviz|kripto|teknik\s*analiz)(?![\p{L}\p{N}])/iu],
  ['INDONESIAN_MALAY_TRADING', /(?<![\p{L}\p{N}])(saham|investasi|investor|kripto|analisis\s+teknikal)(?![\p{L}\p{N}])/iu],
  ['VIETNAMESE_TRADING', /(?<![\p{L}\p{N}])(chứng\s*khoán|chung\s*khoan|giao\s*dịch|giao\s*dich|cổ\s*phiếu|co\s*phieu|tiền\s*điện\s*tử|tien\s*dien\s*tu)(?![\p{L}\p{N}])/iu],
  ['THAI_TRADING', /(หุ้น|การลงทุน|เทรด|คริปโต|ฟอเร็กซ์)/u],
  ['KOREAN_TRADING', /(주식|트레이딩|선물|외환)/u],
  ['CHINESE_TRADING', /(股票|期货|外汇|加密货币|技术分析)/u],
  ['CYRILLIC_TRADING', /(трейдинг|акции|форекс|биржа|криптовалюта)/u],
];

/**
 * Market/product names are useful corroboration but are deliberately weaker.
 * Words such as "options", "shares", "futures" and "crypto" are polysemous
 * and must not independently turn an unrelated creator into a trading
 * candidate.
 */
const MARKET_CONTEXT_SIGNALS: Array<[string, RegExp]> = [
  ['FOREX_MARKET', /\b(forex|eurusd|gbpusd|usdcad|audusd|nzdusd|usdchf|usdjpy)\b/iu],
  ['DERIVATIVES_MARKET', /\b(futures?|options?|0dte|cfd)\b/iu],
  ['EQUITY_MARKET', /\b(stocks?|equities|shares?|nasdaq|s&p\s*500|sp500|dax(?:\s*40)?|cac\s*40|ftse\s*100|ibex\s*35|aex|bel\s*20|smi|omx(?:c25|s30)?|tsx(?:\s*60)?|asx(?:\s*200)?)\b/iu],
  ['CRYPTO_MARKET', /\b(crypto|bitcoin|ethereum|btc|eth)\b/iu],
  ['FUTURES_CONTRACT', /\b(nq\s*futures?|es\s*futures?)\b/iu],
];

/** Strong domain contradictions. These beat accidental market-word matches. */
const HARD_NON_TRADING_SIGNALS: Array<[string, RegExp]> = [
  ['GAMING', /\b(gameplay|walkthrough|playthrough|minecraft|roblox|fortnite|valorant|league\s*of\s*legends|gta\s*v|gta\s*5|call\s*of\s*duty|pokemon|pokémon|genshin|esports?|gaming\s*channel)\b/iu],
  ['COOKING_RECIPES', /\b(recipe|recipes|cooking|kitchen|bake|baking|chef|cuisine|mukbang|delicious\s*food|street\s*food)\b/iu],
  ['MUSIC_ARTIST', /\b(official\s*music\s*video|music\s*video|official\s*audio|lyrics?|lyric\s*video|album|singer|musician|record\s*label|clip\s*officiel|chanson|artiste|zouk)\b/iu],
  ['BEAUTY_ENTERTAINMENT', /\b(celebrity\s*gossip|makeup\s*tutorial|beauty\s*vlog|toy\s*review)\b/iu],
  ['GENERIC_PERSONAL_FINANCE', /\b(personal\s*finance|budgeting|credit\s*card\s*points|save\s*money|paying\s*off\s*debt|mortgage\s*calculator)\b/iu],
];

/**
 * High-precision non-trading domains observed in production search results.
 * The exam/recruitment family is deliberately broad across Latin
 * transliterations and the major Indian scripts. It is not a list of
 * prohibited words: it is one competing-domain feature, and a channel with
 * genuine high-specificity trading evidence is routed to DEFER rather than
 * rejected.
 */
const ADDITIONAL_NON_TRADING_SIGNALS: Array<[string, RegExp]> = [
  ['EDUCATION_EXAM_RECRUITMENT', /(?:\b(?:mpsc|upsc|gpsc|psi|aso|neet|jee|exam|exams|syllabus|admit\s*card|question\s*paper|competitive\s*exam|government\s*exam|government\s*job|recruitment|sarkari|naukri|bharti|scholarship|ntse|mtse|talathi|gramsevak)\b|परीक्षा|स्पर्धा|भरती|नोकरी|प्रश्नपत्र|निकाल|तयारी|राज्यसेवा|तलाठी|ग्रामसेवक|पोलीस|ભરતી|પરીક્ષા|સ્પર્ધાત્મક|તૈયારી|સરકારી|નોકરી|પરિણામ|ਪਰੀਖਿਆ|ਭਰਤੀ|ਤਿਆਰੀ|পরীক্ষা|চাকরি|প্রস্তুতি|పరీక్ష|ఉద్యోగం|సిద్ధత|ಪರೀಕ್ಷೆ|ಉದ್ಯೋಗ|ತಯಾರಿ|പരീക്ഷ|ജോലി|തയ്യാറെടുപ്പ്)/iu],
  ['VEHICLE_SALE', /(?:\b(?:bolero|mahindra|car\s*sale|vehicle\s*sale|second\s*hand|for\s*sale|bikau)\b|गाड़ी|ગાડી|ਗੱਡੀ|বিক্রি|విక్రయం|ಮಾರಾಟ|വിൽപ്പന)/iu],
  ['HEALTH_MEDICAL', /\b(epidemiologist|sexually\s*transmitted|\bsti\s+(?:symptoms|infection|test)|hiv|health\s*center|symptoms|infection|biology)\b/iu],
  ['RELIGION_DEVOTION', /(?:\b(?:jai\s*shri\s*ram|bhajan|devotional|puja|mandir|temple|quran|bible)\b|जय\s*श्री\s*राम|भजन|मंदिर|पूजा|જય\s*શ્રી\s*રામ|ભજન|మందిర్|பஜனை)/iu],
  ['VILLAGE_FAMILY_VLOG', /(?:\b(?:village|family\s*vlog|daily\s*vlog|samajsevi)\b|गांव|ग्रामीण|समाजसेवी|गाँव|ગામ|ਪਿੰਡ|গ্রাম|గ్రామం|ಹಳ್ಳಿ|ഗ്രാമം)/iu],
];

/** Softer format cues are only contradictions when no real trading signal exists. */
const SOFT_NON_TRADING_SIGNALS: Array<[string, RegExp]> = [
  ['EDUCATION_FORMAT', /\b(coaching|preparation|course|courses|tutorial|lesson|classes)\b/iu],
  ['GENERAL_VLOG', /\b(vlog|vlogging|prank|pranks|unboxing|reaction\s*video)\b/iu],
];

const NON_LATIN_SCRIPT_PATTERNS: RegExp[] = [
  /\p{Script=Han}/u, /\p{Script=Hiragana}/u, /\p{Script=Katakana}/u,
  /\p{Script=Hangul}/u, /\p{Script=Arabic}/u, /\p{Script=Cyrillic}/u,
  /\p{Script=Hebrew}/u, /\p{Script=Thai}/u, /\p{Script=Devanagari}/u,
  /\p{Script=Greek}/u, /\p{Script=Kannada}/u,
  /\p{Script=Bengali}/u, /\p{Script=Tamil}/u, /\p{Script=Telugu}/u,
  /\p{Script=Malayalam}/u, /\p{Script=Gujarati}/u, /\p{Script=Gurmukhi}/u,
  /\p{Script=Sinhala}/u, /\p{Script=Khmer}/u, /\p{Script=Lao}/u,
  /\p{Script=Myanmar}/u, /\p{Script=Georgian}/u, /\p{Script=Armenian}/u,
  /\p{Script=Ethiopic}/u,
];

export function hasCoveredNonLatinScript(value: string): boolean {
  // Strip Mathematical Alphanumeric Symbols before NFKC: normalization would
  // otherwise fold them into ordinary Greek/Latin letters and defeat the
  // decorative-symbol exclusion.
  const normalized = String(value || '').replace(/[\u{1D400}-\u{1D7FF}]/gu, ' ').normalize('NFKC');
  return NON_LATIN_SCRIPT_PATTERNS.some(pattern => {
    const matches = normalized.match(new RegExp(pattern.source, 'gu')) || [];
    return matches.length >= 2;
  });
}

function textOf(input: IntakeTradingFocusInput): { channelText: string; retrievalText: string } {
  const document = input.matchedDocument;
  const channelText = [
    input.channelName,
    input.description,
    document?.title,
    document?.description,
    ...(input.videoTitles || []),
    ...(input.videoDescriptions || []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ').normalize('NFKC');
  const retrievalText = [
    input.channelName,
    document?.title,
    document?.description,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ').normalize('NFKC');
  return { channelText, retrievalText };
}

function matchAny(text: string, signals: Array<[string, RegExp]>): string[] {
  return signals.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function decision(
  decisionValue: IntakeTradingFocusDecision,
  reasonCodes: string[],
  positiveFamilies: string[],
  negativeFamilies: string[],
  matchedSignals: string[],
): IntakeTradingFocusAssessment {
  return {
    decision: decisionValue,
    reasonCodes: unique(reasonCodes),
    matchedSignals: unique(matchedSignals),
    positiveFamilies: unique(positiveFamilies),
    negativeFamilies: unique(negativeFamilies),
    policyVersion: INTAKE_TRADING_FOCUS_POLICY_VERSION,
  };
}

/**
 * Pure, deterministic pre-enrichment assessment. The caller owns persistence
 * and must map DEFER to a review/no-enrichment path, never to automatic
 * admission.
 */
export function assessIntakeTradingFocus(input: IntakeTradingFocusInput): IntakeTradingFocusAssessment {
  const { channelText, retrievalText } = textOf(input);
  if (!channelText.trim()) {
    return decision('DEFER', ['INSUFFICIENT_CHANNEL_EVIDENCE', 'DO_NOT_SPEND_ENRICHMENT_QUOTA'], [], [], []);
  }

  const high = matchAny(channelText, HIGH_SPECIFICITY_TRADING_SIGNALS);
  const market = matchAny(channelText, MARKET_CONTEXT_SIGNALS);
  const hard = matchAny(channelText, HARD_NON_TRADING_SIGNALS);
  const additional = matchAny(channelText, ADDITIONAL_NON_TRADING_SIGNALS);
  const soft = matchAny(channelText, SOFT_NON_TRADING_SIGNALS);
  const positiveFamilies = unique([
    ...high,
    ...(new Set(market).size >= 2 ? market : []),
  ]);
  const negativeFamilies = unique([...hard, ...additional, ...soft]);
  const matchedSignals = unique([...high, ...market, ...hard, ...additional, ...soft]);

  // A channel with explicit trading evidence and a competing domain is
  // ambiguous. Preserve it for review rather than withholding it outright: one
  // incidental music/recipe word in an otherwise genuine trading channel must
  // not discard the creator. A hard-only result still withholds.
  if (high.length && (hard.length || additional.length)) {
    return decision('DEFER', [
      'CONFLICTING_TRADING_AND_UNRELATED_EVIDENCE',
      'ROUTE_TO_REVIEW',
      'DO_NOT_SPEND_ENRICHMENT_QUOTA',
    ], positiveFamilies, negativeFamilies, matchedSignals);
  }

  if (hard.length) {
    return decision('WITHHOLD', [
      'EXPLICIT_NON_TRADING_DOMAIN_DETECTED',
      'EXPLICIT_NON_TRADING_SIGNAL_DETECTED',
      'DO_NOT_SPEND_ENRICHMENT_QUOTA',
    ], positiveFamilies, negativeFamilies, matchedSignals);
  }

  if (high.length) {
    return decision('ADMIT', [
      'RETRIEVAL_DOCUMENT_HAS_HIGH_SPECIFICITY_TRADING_SIGNAL',
      'RETRIEVAL_DOCUMENT_HAS_EXPLICIT_TRADING_SIGNAL',
    ], positiveFamilies, negativeFamilies, matchedSignals);
  }

  // Multiple independent market-context families can establish a bounded
  // hypothesis (for example NQ futures + options), but one broad product word
  // alone is intentionally insufficient for canonical admission.
  if (new Set(market).size >= 2 && !soft.length && !additional.length) {
    return decision('ADMIT', ['MULTIPLE_MARKET_CONTEXT_SIGNALS_CORROBORATE_RETRIEVAL'], positiveFamilies, negativeFamilies, matchedSignals);
  }

  if (additional.length) {
    return decision('WITHHOLD', [
      'EXPLICIT_NON_TRADING_DOMAIN_DETECTED',
      'EXPLICIT_NON_TRADING_SIGNAL_DETECTED',
      'DO_NOT_SPEND_ENRICHMENT_QUOTA',
    ], positiveFamilies, negativeFamilies, matchedSignals);
  }

  // A single broad market word or soft format cue is still ambiguous. The
  // retrieval document is provenance, not evidence, so it cannot by itself
  // authorize enrichment spend.
  if (market.length || soft.length) {
    return decision('WITHHOLD', [
      'AMBIGUOUS_RETRIEVAL_CONTEXT',
      'ROUTE_TO_UNCERTAIN',
      'DO_NOT_SPEND_ENRICHMENT_QUOTA',
    ], positiveFamilies, negativeFamilies, matchedSignals);
  }

  // Non-Latin script is no longer proof of trading relevance. If the cheap
  // lexicon cannot establish either domain, preserve the channel for review
  // instead of spending enrichment quota on a guess.
  if (hasCoveredNonLatinScript(channelText)) {
    return decision('DEFER', [
      'NON_LATIN_INSUFFICIENT_TRADING_EVIDENCE',
      'ROUTE_TO_REVIEW',
      'DO_NOT_SPEND_ENRICHMENT_QUOTA',
    ], positiveFamilies, negativeFamilies, matchedSignals);
  }

  // Retrieval text with no recognizable trading domain is not enough to admit,
  // but it is also not proof that the creator is unrelated. Preserve it for
  // review rather than spending the expensive path.
  if (retrievalText.trim()) {
    return decision('DEFER', [
      'NO_CONFIDENT_TRADING_EVIDENCE',
      'ROUTE_TO_REVIEW',
      'DO_NOT_SPEND_ENRICHMENT_QUOTA',
    ], positiveFamilies, negativeFamilies, matchedSignals);
  }

  return decision('WITHHOLD', [
    'NO_EXPLICIT_TRADING_SIGNAL_IN_RETRIEVAL_DOCUMENT',
    'DO_NOT_SPEND_ENRICHMENT_QUOTA',
  ], positiveFamilies, negativeFamilies, matchedSignals);
}
