/**
 * Canonical language-code normalization shared by discovery routing.
 *
 * This module deliberately has no database or country-profile imports so it
 * can be used by the planner, dashboard, autocomplete and language detector
 * without creating a cycle. Named languages are normalized before BCP 47
 * parsing because the country registry stores human-readable language names.
 */

const LANGUAGE_CODES: Record<string, string> = {
  english: 'en', french: 'fr', german: 'de', dutch: 'nl', italian: 'it',
  danish: 'da', swedish: 'sv', norwegian: 'no', finnish: 'fi', portuguese: 'pt',
  spanish: 'es', japanese: 'ja', korean: 'ko', arabic: 'ar', hindi: 'hi',
  'mandarin chinese': 'zh', chinese: 'zh', malay: 'ms', tamil: 'ta', irish: 'ga',
  maori: 'mi', 'māori': 'mi', luxembourgish: 'lb',
  // Excluded-country languages (forensic: full language names previously
  // normalized to '' and silently dropped from declared-language routing).
  vietnamese: 'vi', tagalog: 'tl', filipino: 'tl', urdu: 'ur',
  bengali: 'bn', bangla: 'bn', nepali: 'ne', sinhala: 'si', sinhalese: 'si',
  indonesian: 'id', punjabi: 'pa', telugu: 'te', marathi: 'mr', thai: 'th'
};

const NON_INFORMATIVE_PRIMARIES = new Set(['und', 'mul', 'zxx']);

/**
 * Platform-grounded registry check: the primary subtag is treated as assigned
 * when the locale resolves to itself instead of falling back to the default
 * locale. Unassigned codes (qzz, zzz, xx) and uncoded content fall back and
 * are rejected; assigned codes — including three-letter ISO 639-2/3 primaries
 * like fil, yue, or ckb — resolve to themselves. Codes without display data
 * (e.g. tlh) fail closed. Deterministic for a fixed ICU version.
 */
function isAssignedLanguagePrimary(primary: string): boolean {
  try {
    const resolved = new Intl.DisplayNames([primary], { type: 'language' }).resolvedOptions().locale;
    return resolved.toLowerCase().startsWith(primary);
  } catch {
    return false;
  }
}

/**
 * Prototype-safe language-name lookup: plain-object indexing returns
 * inherited members (constructor, __proto__) for malformed tags, which are
 * truthy non-strings that downstream code could mistake for a language.
 */
function lookupLanguageName(key: string): string {
  if (!Object.hasOwn(LANGUAGE_CODES, key)) return '';
  const mapped: unknown = LANGUAGE_CODES[key];
  return typeof mapped === 'string' ? mapped : '';
}

export function normalizeLanguageCode(value: string): string {
  if (typeof value !== 'string') return '';
  // Providers use hyphens and underscores interchangeably; BCP 47 is hyphens.
  const dashed = value.trim().replace(/_/g, '-');
  if (!dashed) return '';
  // Named languages first (names contain spaces/scripts the tag rule rejects).
  const lowered = dashed.toLocaleLowerCase('en');
  const named = lookupLanguageName(lowered);
  if (named) return named;
  // Structural BCP 47: malformed tags (de-!!, de-12, trailing dashes) die
  // here, while valid extensions (de-u-co-phonebk) and private use survive.
  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(dashed)[0];
  } catch {
    return '';
  }
  const primary = canonical.split('-')[0].toLowerCase();
  // Specials carry no usable language signal for context selection.
  if (NON_INFORMATIVE_PRIMARIES.has(primary)) return '';
  if (!isAssignedLanguagePrimary(primary)) return '';
  // ICU canonicalizes the ISO 639-1 `tl` primary to `fil`. The registry and
  // the named language map use `tl` for Tagalog, so preserve that primary to
  // avoid equivalent Tagalog inputs normalizing to different codes. `fil` is
  // a distinct assigned primary and remains `fil`.
  const requestedPrimary = dashed.split('-')[0].toLowerCase();
  if (requestedPrimary === 'tl') return 'tl';
  return primary;
}
