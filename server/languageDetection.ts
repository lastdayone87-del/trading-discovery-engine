/**
 * Deterministic, dependency-free language identification for the languages the
 * discovery engine supports. The detector is deliberately conservative: a
 * short or ambiguous surface returns `und` rather than guessing. Callers may
 * supply the expected country as a tie-breaker for markets whose languages
 * share vocabulary (Denmark/Sweden/Norway) and for Kanji-only Japanese text.
 *
 * This is the language-identity foundation for native discovery. It is used
 * when evidence is persisted and when terminology observations are written;
 * it does not itself change country assignment or trading classification.
 */

export type SupportedLanguage =
  | 'en' | 'fr' | 'de' | 'nl' | 'da' | 'sv' | 'no' | 'es' | 'it' | 'pt' | 'lb'
  | 'ja' | 'zh' | 'ar' | 'ko' | 'ru' | 'hi' | 'und';

export type LanguageScript = 'Latn' | 'Jpan' | 'Hani' | 'Arab' | 'Hang' | 'Cyrl' | 'Deva' | 'Zyyy';

export interface LanguageDetection {
  language: SupportedLanguage;
  confidence: number;
  script: LanguageScript;
  method: 'SCRIPT' | 'LEXICON' | 'UNDETERMINED';
}

export interface DetectLanguageOptions {
  /** Expected country, used only as a tie-breaker / Kanji disambiguator. */
  countryHint?: string | null;
}

const SCRIPT_PATTERNS: Array<[LanguageScript, RegExp, SupportedLanguage]> = [
  ['Jpan', /[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'ja'],
  ['Hang', /\p{Script=Hangul}/u, 'ko'],
  ['Arab', /\p{Script=Arabic}/u, 'ar'],
  ['Cyrl', /\p{Script=Cyrillic}/u, 'ru'],
  ['Deva', /\p{Script=Devanagari}/u, 'hi'],
  ['Hani', /\p{Script=Han}/u, 'zh'],
];

const COUNTRY_LANGUAGE: Record<string, SupportedLanguage> = {
  'United States': 'en', 'United Kingdom': 'en', Ireland: 'en', Australia: 'en',
  'New Zealand': 'en', Canada: 'en', Singapore: 'en',
  France: 'fr', Germany: 'de', Netherlands: 'nl', Denmark: 'da', Sweden: 'sv',
  Norway: 'no', Spain: 'es', Italy: 'it', Portugal: 'pt', Brazil: 'pt',
  Switzerland: 'de', Belgium: 'nl', Luxembourg: 'lb',
  Japan: 'ja', China: 'zh', 'United Arab Emirates': 'ar', 'Saudi Arabia': 'ar',
};

const TOKENS: Partial<Record<SupportedLanguage, Set<string>>> = {
  en: new Set(['the', 'and', 'for', 'with', 'this', 'that', 'trading', 'trader', 'market', 'analysis', 'technical', 'price', 'action', 'breakout', 'futures', 'forex', 'stocks', 'options', 'crypto', 'strategy', 'volume', 'support', 'resistance', 'chart', 'indicator', 'risk', 'management', 'liquidity', 'structure', 'order', 'flow']),
  fr: new Set(['le', 'la', 'les', 'des', 'du', 'une', 'et', 'pour', 'avec', 'sur', 'dans', 'analyse', 'technique', 'bourse', 'marche', 'marché', 'action', 'actions', 'ordre', 'ordres', 'carnet', 'seance', 'séance', 'haussier', 'baissier', 'trading', 'investir', 'portefeuille', 'graphique', 'unite', 'unité']),
  de: new Set(['der', 'die', 'das', 'und', 'mit', 'fur', 'für', 'auf', 'von', 'den', 'dem', 'ist', 'analyse', 'borse', 'börse', 'markt', 'technische', 'chart', 'charttechnik', 'chartanalyse', 'handel', 'aktie', 'aktien', 'strategie', 'unterstutzung', 'unterstützung', 'widerstand', 'eroffnung', 'eröffnung', 'schlusskurs', 'tagesrading', 'marktstruktur', 'handelsstrategie']),
  nl: new Set(['de', 'het', 'een', 'van', 'en', 'met', 'voor', 'op', 'is', 'beurs', 'analyse', 'technische', 'handel', 'aandeel', 'aandelen', 'opties', 'weerstand', 'steun', 'daghandel', 'marktanalyse', 'opening', 'koersdoel', 'beleggen']),
  da: new Set(['og', 'ikke', 'med', 'for', 'aktie', 'aktier', 'teknisk', 'analyse', 'bors', 'børs', 'handel', 'strategi', 'risikostyring', 'omxc25', 'kobenhavn', 'københavn', 'marked']),
  sv: new Set(['och', 'att', 'inte', 'med', 'for', 'för', 'aktie', 'aktier', 'teknisk', 'analys', 'bors', 'börs', 'handel', 'strategi', 'riskhantering', 'omxs30', 'stockholm', 'marknad']),
  no: new Set(['og', 'ikke', 'med', 'for', 'aksje', 'aksjer', 'teknisk', 'analyse', 'bors', 'børs', 'handel', 'strategi', 'risikostyring', 'obx', 'oslo', 'marked']),
  es: new Set(['el', 'la', 'los', 'las', 'de', 'del', 'y', 'para', 'con', 'en', 'analisis', 'análisis', 'tecnica', 'técnica', 'tecnico', 'técnico', 'bolsa', 'mercado', 'acciones', 'trading', 'intradia', 'intradía', 'velas', 'soporte', 'resistencia', 'apertura', 'fondos', 'apalancamiento']),
  it: new Set(['il', 'la', 'i', 'gli', 'di', 'del', 'e', 'per', 'con', 'in', 'analisi', 'tecnica', 'borsa', 'mercato', 'azioni', 'trading', 'intraday', 'candele', 'supporto', 'resistenza', 'apertura', 'ciclica', 'titoli']),
  pt: new Set(['o', 'a', 'os', 'as', 'de', 'do', 'da', 'e', 'para', 'com', 'em', 'analise', 'análise', 'tecnica', 'técnica', 'bolsa', 'mercado', 'acoes', 'ações', 'negociacao', 'negociação', 'day', 'trade', 'mini', 'indice', 'índice', 'suporte', 'resistencia', 'resistência', 'abertura']),
};

const DIACRITIC_HINTS: Partial<Record<SupportedLanguage, RegExp>> = {
  fr: /[àâçéèêëîïôùûüÿœ]/u,
  de: /[äöüß]/u,
  es: /[ñáéíóú¿¡]/u,
  pt: /[ãõáâêôç]/u,
  it: /[àèéìòù]/u,
  da: /[æøå]/u,
  sv: /[åäö]/u,
  no: /[æøå]/u,
  nl: /[ëïé]/u,
};

function normalize(text: string): string {
  return String(text || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function tokens(text: string): string[] {
  return normalize(text).toLocaleLowerCase('und').match(/[\p{L}\p{N}]+/gu) || [];
}

function detectScript(text: string): { script: LanguageScript; language: SupportedLanguage | null } {
  for (const [script, pattern, language] of SCRIPT_PATTERNS) {
    if (pattern.test(text)) return { script, language };
  }
  return { script: 'Latn', language: null };
}

function countryHintLanguage(countryHint: string | null | undefined): SupportedLanguage | null {
  if (!countryHint) return null;
  return COUNTRY_LANGUAGE[countryHint] || null;
}

/**
 * Detect the language of a short trading surface or a longer metadata text.
 * Never throws; malformed input returns `und`.
 */
export function detectLanguage(text: string, options: DetectLanguageOptions = {}): LanguageDetection {
  const value = normalize(text);
  if (!value) return { language: 'und', confidence: 0, script: 'Zyyy', method: 'UNDETERMINED' };

  const script = detectScript(value);
  const hint = countryHintLanguage(options.countryHint);

  if (script.language) {
    // Japanese and Chinese share Han. Kana is decisive for Japanese; a
    // Kanji-only surface is Chinese unless the country hint says Japan, in
    // which case Japanese is the better market-scoped reading.
    if (script.language === 'zh' && hint === 'ja') {
      return { language: 'ja', confidence: 0.7, script: 'Hani', method: 'SCRIPT' };
    }
    return { language: script.language, confidence: 0.98, script: script.script, method: 'SCRIPT' };
  }

  const words = tokens(value);
  if (!words.length) return { language: 'und', confidence: 0, script: script.script, method: 'UNDETERMINED' };

  const scores = new Map<SupportedLanguage, number>();
  for (const [language, lexicon] of Object.entries(TOKENS) as Array<[SupportedLanguage, Set<string>]>) {
    let score = 0;
    for (const word of words) if (lexicon.has(word)) score += 1;
    if (DIACRITIC_HINTS[language]?.test(value)) score += 2;
    if (score > 0) scores.set(language, score);
  }
  // A country hint breaks ties between languages that already have textual
  // evidence. It must never assign a language on its own: country is not
  // language, and doing so would fabricate identity for unrelated text.
  if (hint && scores.has(hint)) scores.set(hint, (scores.get(hint) || 0) + 3);

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!ranked.length) return { language: 'und', confidence: 0, script: script.script, method: 'UNDETERMINED' };
  const [language, top] = ranked[0];
  const second = ranked[1]?.[1] || 0;
  // A one-token surface whose score is also achieved by another language is
  // ambiguous. Country hints already break the common Scandinavian ties.
  if (top <= 1 && second === top && !hint) {
    return { language: 'und', confidence: 0.2, script: script.script, method: 'UNDETERMINED' };
  }
  const total = ranked.reduce((sum, [, score]) => sum + score, 0);
  const confidence = Math.max(0.3, Math.min(0.99, total > 0 ? top / total : 0));
  return { language, confidence: Number(confidence.toFixed(3)), script: script.script, method: 'LEXICON' };
}

export function languageScript(language: string): LanguageScript {
  switch (String(language || '').toLowerCase()) {
    case 'ja': return 'Jpan';
    case 'zh': return 'Hani';
    case 'ar': return 'Arab';
    case 'ko': return 'Hang';
    case 'ru': return 'Cyrl';
    case 'hi': return 'Deva';
    case 'en': case 'fr': case 'de': case 'nl': case 'da': case 'sv': case 'no':
    case 'es': case 'it': case 'pt': case 'lb': return 'Latn';
    default: return 'Zyyy';
  }
}
