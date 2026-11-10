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
export const TERMINOLOGY_SEARCHABILITY_VERSION = 'terminology-searchability-v2';

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
  /** Bounded standalone-query allowance (2–6 words) for extracted queries. */
  maxTokens?: number;
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
  Singapore: new Set(['Latn', 'Hani', 'Taml']),
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
  ['Taml', /\p{Script=Tamil}/u],
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

/**
 * Short surfaces that are valid inside a longer explicit phrase but are too
 * ambiguous to use as learned modifiers on their own. `ES` is both the E-mini
 * S&P ticker and Spanish "is"; `SL` is stop-loss jargon and an abbreviation
 * with many unrelated meanings; `LIVE` is a format word, not a topic.
 */
const AMBIGUOUS_SHORT_MODIFIERS = new Set(['es', 'sl', 'live']);

export function isAmbiguousShortModifier(term: string): boolean {
  const key = phraseKey(term);
  return AMBIGUOUS_SHORT_MODIFIERS.has(key);
}

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
  de: ['liquiditätszone', 'liquiditätszonen', 'charttechnik', 'chartanalyse', 'marktstruktur', 'handelsstrategie', 'dax eröffnung'],
  fr: ['structure du marché', 'analyse boursière', 'carnet d ordres', 'carnet d\'ordres'],
  es: ['análisis bursátil', 'estructura de mercado', 'flujo de órdenes'],
  it: ['analisi ciclica', 'analisi tecnica borsa italiana'],
  nl: ['opties handelen'],
  ja: ['トレード', 'デイトレード', 'オーダーフロー', '板読み', '歩み値', '裁量トレード', 'システムトレード', 'スキャルピング', '東京セッション'],
};

/**
 * Reviewed native multi-word surfaces that are genuine local search phrases
 * but exceed the default 3-token precision cap. This is a bounded allowlist,
 * not a general relaxation: the term still has to pass script and semantic
 * gates.
 */
const REVIEWED_NATIVE_PHRASES: Record<string, string[]> = {
  es: ['análisis bursátil', 'estructura de mercado'],
  it: ['analisi tecnica borsa italiana', 'analisi ciclica'],
  nl: ['opties handelen'],
  de: ['marktstruktur', 'handelsstrategie', 'dax eröffnung'],
  fr: ['structure du marché', 'analyse boursière', 'carnet d ordres'],
};

/** Language codes of the reviewed phrases matching this exact surface. */
export function reviewedNativePhraseLanguages(term: string): string[] {
  const key = phraseKey(term);
  return Object.entries(REVIEWED_NATIVE_PHRASES)
    .filter(([, values]) => values.some(value => phraseKey(value) === key))
    .map(([language]) => language);
}

export function isReviewedNativePhrase(term: string): boolean {
  return reviewedNativePhraseLanguages(term).length > 0;
}

/** True when the surface contains a reviewed native phrase, not just equals it. */
export function containsReviewedNativePhrase(term: string): boolean {
  const key = phraseKey(term);
  if (!key) return false;
  return Object.values(REVIEWED_NATIVE_PHRASES)
    .some(values => values.some(value => key.includes(phraseKey(value))));
}

/**
 * Compounds whose local reading is not trading intent. `トレード` is a
 * reviewed Japanese semantic, but `トレードオフ` (trade-off) and
 * `トレードマーク` (trademark) are ordinary words, so boundary-free matching
 * must not admit them as search surfaces. Separators are allowed between
 * characters (`トレード・オフ`) and the compounds may be embedded in a longer
 * phrase (`トレードオフ分析`).
 */
const NON_TRADING_COMPOUND_PATTERNS = ['トレードオフ', 'トレードマーク'].map(compound =>
  new RegExp([...compound].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'gu'),
);

/** True when any letter in the value belongs to an unspaced script. */
function usesUnspacedScript(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

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
  const rawKey = phraseKey(term);
  if (!rawKey) return false;
  // Remove non-trading compound readings before matching. If a genuine
  // trading semantic remains elsewhere in the surface, it still passes.
  const key = NON_TRADING_COMPOUND_PATTERNS
    .reduce((value, pattern) => value.replace(pattern, ' '), rawKey)
    .replace(/\s+/gu, ' ')
    .trim();
  if (!key) return false;
  const out = new Set(GLOBAL_TRADING_SEMANTICS);
  const language = context.language ? String(context.language).toLocaleLowerCase('und').split('-')[0] : '';
  const country = context.country && context.country !== 'GLOBAL' ? context.country : '';
  if (!country && !language) {
    // No context: keep the legacy broad lexicon so callers that predate the
    // context-aware gate do not lose valid trading terms. Reviewed language
    // surfaces are part of that lexicon too; the English branch otherwise
    // cannot admit phrases such as `liquidity zone`.
    LANGUAGE_TRADING_SEMANTICS.forEach(values => values.forEach(value => out.add(value)));
    Object.values(REVIEWED_LANGUAGE_SEMANTICS).forEach(values => values.forEach(value => addPhrase(out, value)));
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
  // Japanese/Chinese/Korean do not delimit words with spaces, so a compound
  // surface (日経225先物) can never match a space-padded semantic (日経225).
  // Match reviewed multi-character semantics as substrings for unspaced
  // scripts; single-character semantics are excluded to avoid over-matching.
  const unspaced = usesUnspacedScript(key);
  for (const semantic of out) {
    if (semantic === key) return true;
    if (padded.includes(` ${semantic} `)) return true;
    // Boundary-free matching applies only to semantics written in an
    // unspaced script. Latin/ticker semantics keep word boundaries even when
    // the enclosing term contains CJK: `cooking動画` must not match `ng`.
    if (unspaced && usesUnspacedScript(semantic) && Array.from(semantic).length >= 2 && key.includes(semantic)) return true;
  }
  return false;
}

function scriptCompatible(country: string | null | undefined, scripts: Set<string>, languages: string[]): boolean {
  // GLOBAL atoms are deliberately not country-scoped; their language is
  // checked by the caller against the candidate country profile.
  if (!country || country === 'GLOBAL' || scripts.size === 0) return true;
  // Own-key check: a plain-object lookup would resolve inherited keys such as
  // "constructor" to a truthy non-Set value and make `.has` throw.
  const configured = Object.hasOwn(COUNTRY_SCRIPTS, country) ? COUNTRY_SCRIPTS[country] : undefined;
  if (configured) return [...scripts].every(script => script === 'Zyyy' || configured.has(script));
  if (LATIN_COUNTRIES.has(country)) return [...scripts].every(script => script === 'Zyyy' || script === 'Latn');
  // Unsupported/unknown country: script compatibility alone must not reject
  // the term. Country authorization is enforced separately by the registry.
  return true;
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
  const configuredMax = Number.isFinite(input.maxTokens) && (input.maxTokens as number) > 0
    ? Math.min(6, Math.max(2, Math.trunc(input.maxTokens as number)))
    : null;
  const tokenLimit = input.allowExtendedTokens
    ? LEGACY_COMPATIBILITY_TOKEN_LIMIT
    : configuredMax ?? (isReviewedNativePhrase(normalizedTerm) ? 6 : 3);
  if (termTokens.length > tokenLimit) add('too-many-tokens');
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


/**
 * Legacy-vocabulary surfaces that can never be a useful search atom. They are
 * still valid evidence/metadata, but must not enter the planner's learned
 * vocabulary path. Keep this deterministic so extraction and cleanup agree.
 */
export function isNuisanceVocabularySurface(term: string): boolean {
  // NFKC folds fullwidth markers; remove zero-width/format characters so a
  // hidden prefix such as U+200B + "#forex" cannot slip through.
  const value = normalize(term).replace(/[\u200B-\u200D\uFEFF]/gu, '');
  const letters = value.match(/\p{L}/gu)?.length ?? 0;
  return letters === 0 || /[#@]/u.test(value) || /^[0-9]+$/u.test(value);
}

export interface DashboardTerminologyEligibility {
  search_eligible: boolean;
  search_eligibility_reasons: string[];
}

/**
 * Display projection for the terminology dashboard. The raw database flag can
 * be stale after the gate tightens or a lifecycle refresh is missed; the
 * planner filters through this same pure gate at read time. Showing the
 * computed result prevents an emoji/hashtag/format-only row from appearing as
 * "search eligible" when it can never become a planner atom.
 */
export function dashboardSearchEligibility(row: {
  canonical_term: string;
  term_type?: string | null;
  country?: string | null;
  language?: string | null;
  lifecycle_status?: string | null;
  search_eligible?: boolean | null;
}): DashboardTerminologyEligibility {
  const gate = isSearchableTradingTerm({
    term: row.canonical_term,
    termType: row.term_type,
    country: row.country,
    language: row.language,
  });
  const lifecycleEligible = row.lifecycle_status === 'SEARCH_TRIAL' || row.lifecycle_status === 'PROVEN_SEARCH_TERM';
  return {
    // The planner requires the persisted flag too: a quality/lifecycle refresh
    // can revoke it while the row still carries SEARCH_TRIAL/PROVEN status.
    search_eligible: row.search_eligible === true && lifecycleEligible && gate.eligible,
    search_eligibility_reasons: gate.eligible ? [] : gate.reasons,
  };
}

/**
 * Stable dashboard ordering: computed planner eligibility first, then the
 * original SQL order (yield/last-observed). This prevents a stale flagged row
 * from occupying a page ahead of a genuinely eligible row.
 */
export function orderDashboardTerminologyRows<T extends { search_eligible: boolean }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => Number(b.row.search_eligible) - Number(a.row.search_eligible) || a.index - b.index)
    .map(({ row }) => row);
}


/**
 * Standalone extracted-query gate. This is the same Q0 precision gate with a
 * bounded 2–6 token allowance; it never grants anchor/query authority on its
 * own (that is still the composition/execution gates).
 */
export function isExtractedStandaloneQuery(input: {
  term: string;
  country?: string | null;
  language?: string | null;
}): boolean {
  return isSearchableTradingTerm({
    term: input.term,
    termType: 'PHRASE',
    country: input.country,
    language: input.language,
    maxTokens: 6,
    // Trading intent was already proven by the extraction ledger gate. That
    // gate is script-aware, so unspaced native surfaces (for example Japanese)
    // remain valid standalone queries even though the English lexicon cannot
    // attest their semantics.
    requireTradingSemantics: false,
  }).eligible;
}
