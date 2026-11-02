import {
  COUNTRY_KNOWLEDGE_PACKS,
  GLOBAL_ADVANCED_CONCEPTS,
  GLOBAL_INSTRUMENTS,
  GLOBAL_PLATFORMS_BROKERS_PROPFIRMS,
  LANGUAGE_KNOWLEDGE_PACKS,
} from './evidenceEngine/knowledgePacks';
import { MULTILINGUAL_CLASSIFICATION_PACKS } from './evidenceEngine/multilingualTerminology';

/**
 * Q0 terminology searchability gate.
 *
 * A terminology observation is evidence; it is not automatically a search
 * surface. This pure, versioned gate is the one place that decides whether an
 * extracted term may become a planner atom. It is shared by native admission,
 * the terminology lifecycle and both planner learned paths so a previously
 * promoted row cannot bypass it.
 *
 * The gate is intentionally precision-first: unknown local terms remain
 * observable evidence (`no-trading-semantics`) until a reviewed, provenance-
 * backed override supplies the missing context. It never changes a channel's
 * trading status.
 */
export const TERMINOLOGY_SEARCHABILITY_VERSION = 'terminology-searchability-v1';

/**
 * Pre-admission query rows predate atomized composition, so the whole stored
 * query is their only atom. They still need the semantic, script and shape
 * gates, but the 3-token atom limit would reject every legacy query of four
 * or more words even when its trading context is valid. The compatibility
 * bridge therefore allows a bounded longer surface; new atoms never use it.
 */
export const LEGACY_COMPATIBILITY_TOKEN_LIMIT = 8;

export type SearchabilityTermType = 'TERMINOLOGY' | 'INSTRUMENT' | 'PHRASE' | 'FORMAT' | 'BRAND' | string;

export interface SearchabilityInput {
  term: string;
  termType?: SearchabilityTermType | null;
  country?: string | null;
  language?: string | null;
  /**
   * Learned/extracted terminology must carry governed trading semantics.
   * Curated or country-registry surfaces are already authorized by their
   * producer contract (Q1 retrieval-specificity policy); they still pass the
   * shape, script, CTA and term-type checks but are not required to repeat
   * the semantic lexicon match.
   */
  requireTradingSemantics?: boolean;
  /**
   * Set only for the legacy whole-query compatibility atom. It raises the
   * atom token ceiling to LEGACY_COMPATIBILITY_TOKEN_LIMIT; it does not
   * relax any semantic, script or shape gate.
   */
  allowExtendedTokens?: boolean;
}

export interface SearchabilityShape {
  letters: number;
  tokens: number;
  script: string;
}

export interface SearchabilityResult {
  eligible: boolean;
  reasons: string[];
  shape: SearchabilityShape;
  normalizedTerm: string;
  version: string;
}

const CTA_TOKENS = new Set([
  'subscribe', 'like', 'button', 'comment', 'comments', 'share', 'notification',
  'notifications', 'bell', 'follow', 'click', 'link', 'links', 'bio', 'join',
  'download', 'watch', 'abo', 'abonnieren', 'abonnez', 'suscribete', 'suscríbete',
]);
const FORMAT_TOKENS = new Set([
  'episode', 'ep', 'part', 'pt', 'vol', 'volume', 'video', 'clip', 'short',
  'shorts', 'replay', 'podcast', 'interview', 'interviews', 'stream', 'live',
  'session', 'channel', 'free', 'gratuit', 'gratis', 'kostenlos', 'gratuita',
]);
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'with', 'at',
  'de', 'la', 'le', 'les', 'du', 'des', 'en', 'et', 'el', 'los', 'las', 'un',
  'una', 'y', 'o', 'para', 'por', 'con', 'der', 'die', 'das', 'und', 'oder',
  'von', 'zu', 'im', 'mit', 'het', 'een', 'van', 'en', 'og', 'av', 'til', 'på',
]);

const URL_HANDLE_HASHTAG = /(?:https?:\/\/|www\.|^@|^#)|(?:^|\s)#[^\s]+|(?:^|\s)@[a-z0-9_.-]+|\b[a-z0-9-]+\.(?:com|net|org|io|co|fr|de|uk|nl|se|no|dk|be|ch|au|ca|nz|sg)\b/iu;
const EPISODE_LABEL = /^(?:[ée]pisode|ep|part|pt|vol(?:ume)?|saison|season)\s*#?\d+\b/iu;
const MATH_ALPHANUMERIC = /[\u{1D400}-\u{1D7FF}]/u;

/** Scripts that are compatible with each supported market profile. */
const COUNTRY_SCRIPTS: Record<string, ReadonlySet<string>> = {
  Japan: new Set(['Jpan', 'Hani', 'Latn']),
  'United Arab Emirates': new Set(['Arab', 'Latn']),
  Singapore: new Set(['Latn', 'Hani']),
};
const LATIN_COUNTRIES = new Set([
  'United States', 'United Kingdom', 'Canada', 'Australia', 'New Zealand',
  'Ireland', 'France', 'Germany', 'Netherlands', 'Belgium', 'Luxembourg',
  'Switzerland', 'Denmark', 'Sweden', 'Norway',
  // Supported dormant countries also use Latin script. Omitting them made
  // their curated native terms fail the script gate once promoted.
  'Italy', 'Spain',
]);

const SCRIPT_PATTERNS: Array<[string, RegExp]> = [
  ['Hani', /\p{Script=Han}/u],
  ['Jpan', /[\p{Script=Katakana}\p{Script=Hiragana}]/u],
  ['Cyrl', /\p{Script=Cyrillic}/u],
  ['Arab', /\p{Script=Arabic}/u],
  ['Hang', /\p{Script=Hangul}/u],
  ['Deva', /\p{Script=Devanagari}/u],
  ['Hebr', /\p{Script=Hebrew}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Latn', /\p{Script=Latin}/u],
];

function inferScript(value: string): string {
  return SCRIPT_PATTERNS.find(([, pattern]) => pattern.test(value))?.[0] || 'Zyyy';
}

/** Every script used by a letter in the term, not just the first one found. */
function scriptsOf(value: string): Set<string> {
  const out = new Set<string>();
  for (const char of normalize(value)) {
    if (!/\p{L}/u.test(char)) continue;
    const script = SCRIPT_PATTERNS.find(([, pattern]) => pattern.test(char))?.[0];
    if (script) {
      out.add(script);
      continue;
    }
    // Common/Inherited letters are script extenders, not unknowns: U+30FC
    // (the katakana-hiragana prolonged sound mark) is a Common letter used in
    // `トレード`. Treat only genuinely unknown scripts as `Zzzz` so they fail
    // closed in scriptCompatible.
    out.add(/[\p{Script=Common}\p{Script=Inherited}]/u.test(char) ? 'Zyyy' : 'Zzzz');
  }
  return out;
}

function normalize(term: string): string {
  return String(term || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function tokens(term: string): string[] {
  return normalize(term).toLocaleLowerCase('und').split(/\s+/u).filter(Boolean);
}

function lettersOf(term: string): string[] {
  return [...normalize(term)].filter(char => /\p{L}/u.test(char));
}

/** Normalize a governed semantic phrase for boundary-aware comparison. */
function phraseKey(value: string): string {
  return normalize(value).toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Tickers that are also ordinary words in a configured market language. They
 * remain usable inside a longer governed phrase ("es futures") but never
 * satisfy Q0 on their own ("es tendencia").
 */
const AMBIGUOUS_STANDALONE_SEMANTICS = new Set(['es']);

function addPhrase(out: Set<string>, value: string | undefined | null): void {
  const key = phraseKey(String(value || ''));
  if (key && !AMBIGUOUS_STANDALONE_SEMANTICS.has(key)) out.add(key);
}

/**
 * Market-independent governed vocabulary. Country/language-owned terminology
 * is deliberately kept out of this set: `Börsenanalyse` is German trading
 * vocabulary, not a global token that may admit a Japanese or French surface.
 */
const GLOBAL_TRADING_SEMANTICS = (() => {
  const out = new Set<string>();
  GLOBAL_INSTRUMENTS.forEach(value => addPhrase(out, value));
  GLOBAL_ADVANCED_CONCEPTS.forEach(value => addPhrase(out, value));
  GLOBAL_PLATFORMS_BROKERS_PROPFIRMS.forEach(value => addPhrase(out, value));
  ['p2p', 'peer-to-peer'].forEach(value => addPhrase(out, value));
  return out;
})();

function addLanguageSemantics(out: Set<string>, language: string | undefined | null): void {
  const code = String(language || '').toLocaleLowerCase('und').split('-')[0];
  if (!code) return;
  for (const semantic of LANGUAGE_TRADING_SEMANTICS.get(code) || []) out.add(semantic);
  for (const semantic of REVIEWED_LANGUAGE_SEMANTICS[code] || []) addPhrase(out, semantic);
}

const LANGUAGE_TRADING_SEMANTICS = (() => {
  const out = new Map<string, Set<string>>();
  const add = (code: string, values: string[]) => {
    const set = out.get(code) || new Set<string>();
    values.forEach(value => addPhrase(set, value));
    out.set(code, set);
  };
  for (const pack of Object.values(MULTILINGUAL_CLASSIFICATION_PACKS)) {
    add(pack.languageCode, [...pack.executionTerms, ...pack.educationalTerms, ...pack.businessNewsTerms]);
  }
  for (const pack of Object.values(LANGUAGE_KNOWLEDGE_PACKS)) {
    add(pack.languageCode, [...pack.positiveTerms, ...pack.commonPhrases]);
  }
  return out;
})();

/**
 * Reviewed vocabulary additions that are genuinely trading-specific but are
 * not yet present in every language pack. These are still governed phrases,
 * not an automatic promotion path for arbitrary unknown terms.
 */
const REVIEWED_LANGUAGE_SEMANTICS: Record<string, string[]> = {
  // English is the universal retrieval language, so these reviewed phrases
  // must stay eligible for every English query surface.
  en: ['liquidity zone', 'liquidity zones'],
  de: ['liquiditätszone', 'liquiditätszonen', 'charttechnik', 'chartanalyse'],
  ja: ['トレード', 'デイトレード', 'オーダーフロー'],
};

const COUNTRY_NATIVE_SEMANTICS = new Map<string, Set<string>>(
  Object.entries(COUNTRY_KNOWLEDGE_PACKS).map(([country, pack]) => {
    const set = new Set<string>();
    (pack.nativeTradingTerminology || []).forEach(value => addPhrase(set, value));
    return [country, set];
  }),
);

const COUNTRY_LANGUAGES = new Map<string, string[]>(
  Object.entries(COUNTRY_KNOWLEDGE_PACKS).map(([country, pack]) => [
    country,
    [...new Set([pack.primaryLanguage, ...(pack.languageCodes || [])].filter((code): code is string => Boolean(code)))],
  ]),
);

/**
 * True when the term contains a governed trading semantic token/phrase.
 * Matching is token/phrase bounded: `live` alone does not match `live trading`,
 * and `ES` does not match inside `heroes`.
 *
 * With a country/language context, only global vocabulary plus that language
 * (and the country's own reviewed terms) is admitted. Country knowledge packs
 * are scoped by their declared language rather than flattened into a global
 * set, so a German term cannot become searchable for Japan. Calls without
 * context retain the broad legacy lexicon.
 */
export function hasGovernedTradingSemantics(
  term: string,
  context: { country?: string | null; language?: string | null } = {},
): boolean {
  const key = phraseKey(term);
  if (!key) return false;
  const out = new Set(GLOBAL_TRADING_SEMANTICS);
  const language = context.language ? String(context.language).toLocaleLowerCase('und').split('-')[0] : '';
  const country = context.country && context.country !== 'GLOBAL' ? context.country : '';
  if (!country && !language) {
    // No context: keep the legacy broad lexicon so callers that predate the
    // context-aware gate do not lose valid trading terms.
    LANGUAGE_TRADING_SEMANTICS.forEach(values => values.forEach(value => out.add(value)));
    COUNTRY_NATIVE_SEMANTICS.forEach(values => values.forEach(value => out.add(value)));
  } else {
    // English is the universal retrieval language: an English trading phrase
    // is a valid surface for any market even when the row did not declare a
    // language (legacy compound rows). Other language packs stay scoped.
    addLanguageSemantics(out, 'en');
    if (language) addLanguageSemantics(out, language);
    if (country) {
      (COUNTRY_NATIVE_SEMANTICS.get(country) || []).forEach(value => out.add(value));
      (COUNTRY_LANGUAGES.get(country) || []).forEach(code => addLanguageSemantics(out, code));
    }
    // A reviewed native term travels with its language (for example the
    // German `Börsenanalyse` curated under Luxembourg), not with every country.
    if (language) {
      for (const [candidate, languages] of COUNTRY_LANGUAGES) {
        if (!languages.includes(language)) continue;
        (COUNTRY_NATIVE_SEMANTICS.get(candidate) || []).forEach(value => out.add(value));
      }
    }
  }
  const padded = ` ${key} `;
  for (const semantic of out) {
    if (semantic === key) return true;
    if (padded.includes(` ${semantic} `)) return true;
  }
  return false;
}

function scriptCompatible(country: string | null | undefined, scripts: Set<string>, languages: string[]): boolean {
  // GLOBAL atoms are deliberately not country-scoped; their language is
  // checked by the caller against the candidate country profile.
  if (!country || country === 'GLOBAL' || scripts.size === 0) return true;
  const configured = COUNTRY_SCRIPTS[country];
  if (configured) return [...scripts].every(script => script === 'Zyyy' || configured.has(script));
  if (LATIN_COUNTRIES.has(country)) return [...scripts].every(script => script === 'Zyyy' || script === 'Latn');
  // Unsupported/unknown country: do not manufacture a false negative.
  return languages.length === 0 || languages.includes('und');
}

/**
 * Apply the Q0 gate. Pure and deterministic; never throws for malformed input.
 */
export function isSearchableTradingTerm(input: SearchabilityInput): SearchabilityResult {
  const normalizedTerm = normalize(input.term);
  const termTokens = tokens(normalizedTerm).filter(token => /\p{L}|\p{N}/u.test(token));
  const letters = lettersOf(normalizedTerm);
  const scripts = scriptsOf(normalizedTerm);
  const script = inferScript(normalizedTerm);
  const shape: SearchabilityShape = { letters: letters.length, tokens: termTokens.length, script };
  const reasons: string[] = [];
  const add = (reason: string) => { if (!reasons.includes(reason)) reasons.push(reason); };
  const termType = String(input.termType || 'TERMINOLOGY').toUpperCase();

  // Math-alphanumeric characters fold to ASCII under NFKC, so the raw input
  // must be checked: `𝕗𝕠𝕣𝕖𝕩` must not become `forex`.
  if (MATH_ALPHANUMERIC.test(String(input.term || '')) || letters.length === 0) add('no-letters');
  if ([...normalizedTerm].length < 2) add('too-short');
  if (termType === 'BRAND') add('brand');
  if (!['TERMINOLOGY', 'INSTRUMENT', 'PHRASE', 'FORMAT', 'BRAND'].includes(termType)) add('ineligible-type');
  if (URL_HANDLE_HASHTAG.test(normalizedTerm)) add('url-handle-hashtag');
  if (EPISODE_LABEL.test(normalizedTerm)) add('episode-label');

  const lowerTokens = termTokens.map(token => token.toLocaleLowerCase('und'));
  const contentTokens = lowerTokens.filter(token => !STOPWORDS.has(token));
  if (contentTokens.length > 0 && contentTokens.every(token => CTA_TOKENS.has(token))) add('cta-only');
  if (contentTokens.length > 0 && contentTokens.every(token => CTA_TOKENS.has(token) || FORMAT_TOKENS.has(token))) add('format-only');
  if (lowerTokens.length > 0 && lowerTokens.every(token => STOPWORDS.has(token))) add('stopword-only');
  if (termTokens.length > (input.allowExtendedTokens ? LEGACY_COMPATIBILITY_TOKEN_LIMIT : 3)) add('too-many-tokens');
  if (input.requireTradingSemantics !== false
    && !hasGovernedTradingSemantics(normalizedTerm, { country: input.country, language: input.language })) add('no-trading-semantics');

  const languages = input.language ? [input.language.toLocaleLowerCase('und').split('-')[0]] : [];
  if (!scriptCompatible(input.country, scripts, languages)) add('script-incompatible');

  return {
    eligible: reasons.length === 0,
    reasons,
    shape,
    normalizedTerm,
    version: TERMINOLOGY_SEARCHABILITY_VERSION,
  };
}

/**
 * Planner-facing helper: returns a suppression reason list, or an empty list
 * when the term may be used as a search atom.
 */
export function terminologySearchabilityReasons(input: SearchabilityInput): string[] {
  return isSearchableTradingTerm(input).reasons;
}

/** Read-only Q0 audit projection used by the audit helper and tests. */
export function auditSearchableTerms<T extends { term: string; term_type?: string | null; country?: string | null; language?: string | null }>(
  rows: T[],
): Array<T & SearchabilityResult> {
  return rows
    .map(row => ({ ...row, ...isSearchableTradingTerm({ term: row.term, termType: row.term_type, country: row.country, language: row.language }) }))
    .filter(row => !row.eligible);
}
