import {
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
]);

function inferScript(value: string): string {
  if (/\p{Script=Han}/u.test(value)) return 'Hani';
  if (/\p{Script=Katakana}|\p{Script=Hiragana}/u.test(value)) return 'Jpan';
  if (/\p{Script=Cyrillic}/u.test(value)) return 'Cyrl';
  if (/\p{Script=Arabic}/u.test(value)) return 'Arab';
  if (/\p{Script=Hangul}/u.test(value)) return 'Hang';
  if (/\p{Script=Devanagari}/u.test(value)) return 'Deva';
  if (/\p{Script=Hebrew}/u.test(value)) return 'Hebr';
  if (/\p{Script=Thai}/u.test(value)) return 'Thai';
  return /\p{Script=Latin}/u.test(value) ? 'Latn' : 'Zyyy';
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

function buildTradingSemantics(): Set<string> {
  const out = new Set<string>();
  const add = (value: string | undefined | null) => {
    const key = phraseKey(String(value || ''));
    if (key) out.add(key);
  };
  GLOBAL_INSTRUMENTS.forEach(add);
  GLOBAL_ADVANCED_CONCEPTS.forEach(add);
  GLOBAL_PLATFORMS_BROKERS_PROPFIRMS.forEach(add);
  for (const pack of Object.values(MULTILINGUAL_CLASSIFICATION_PACKS)) {
    pack.executionTerms.forEach(add);
    pack.educationalTerms.forEach(add);
    pack.businessNewsTerms.forEach(add);
  }
  for (const pack of Object.values(LANGUAGE_KNOWLEDGE_PACKS)) {
    pack.positiveTerms.forEach(add);
    pack.commonPhrases.forEach(add);
  }
  return out;
}

/**
 * Reviewed vocabulary additions that are genuinely trading-specific but are
 * not yet present in every language pack. These are still governed phrases,
 * not an automatic promotion path for arbitrary unknown terms.
 */
const REVIEWED_TRADING_SEMANTICS = [
  'liquiditätszone',
  'liquiditätszonen',
  'liquidity zone',
  'liquidity zones',
  'charttechnik',
  'chartanalyse',
  'p2p',
  'peer-to-peer',
];

const TRADING_SEMANTICS = new Set([
  ...buildTradingSemantics(),
  ...REVIEWED_TRADING_SEMANTICS.map(phraseKey),
]);

/**
 * True when the term contains a governed trading semantic token/phrase.
 * Matching is token/phrase bounded: `live` alone does not match `live trading`,
 * and `ES` does not match inside `heroes`.
 */
export function hasGovernedTradingSemantics(term: string): boolean {
  const key = phraseKey(term);
  if (!key) return false;
  const padded = ` ${key} `;
  for (const semantic of TRADING_SEMANTICS) {
    if (semantic === key) return true;
    if (padded.includes(` ${semantic} `)) return true;
  }
  return false;
}

function scriptCompatible(country: string | null | undefined, script: string, languages: string[]): boolean {
  if (!country) return true;
  if (script === 'Latn') return true;
  const configured = COUNTRY_SCRIPTS[country];
  if (configured) return configured.has(script);
  if (LATIN_COUNTRIES.has(country)) return false;
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
  const script = inferScript(normalizedTerm);
  const shape: SearchabilityShape = { letters: letters.length, tokens: termTokens.length, script };
  const reasons: string[] = [];
  const add = (reason: string) => { if (!reasons.includes(reason)) reasons.push(reason); };
  const termType = String(input.termType || 'TERMINOLOGY').toUpperCase();

  if (MATH_ALPHANUMERIC.test(normalizedTerm) || letters.length === 0) add('no-letters');
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
  if (termTokens.length > 3) add('too-many-tokens');
  if (input.requireTradingSemantics !== false && !hasGovernedTradingSemantics(normalizedTerm)) add('no-trading-semantics');

  const languages = input.language ? [input.language.toLocaleLowerCase('und').split('-')[0]] : [];
  if (!scriptCompatible(input.country, script, languages)) add('script-incompatible');

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
