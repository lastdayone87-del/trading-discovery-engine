import { createHash } from 'node:crypto';

export const GLOBAL_LANGUAGE_POLICY_VERSION = 'global-language-capability-v1';
export const UNICODE_NORMALIZATION_VERSION = 'unicode-nfkc-casefold-v1';

export type ScriptCode = 'Latn' | 'Arab' | 'Cyrl' | 'Deva' | 'Hang' | 'Hani' | 'Hira' | 'Kana' | 'Zyyy' | 'Zinh' | 'MULTI' | 'UNKNOWN';
export type CapabilityDisposition = 'SUPPORTED' | 'CONTROLLED_TRIAL' | 'ABSTAIN';

export interface LanguageScriptObservation {
  field: string;
  language: string;
  scripts: ScriptCode[];
  primaryScript: ScriptCode;
  confidence: number;
  codeSwitched: boolean;
  transliterated: boolean;
  normalizedText: string;
}

export interface GlobalLanguageContext {
  creatorCountry?: string;
  declaredPlatformCountry?: string;
  contentLanguage?: string;
  contentScript?: string;
  targetAudienceLocale?: string;
  marketRegions?: string[];
  queryLocale?: string;
  providerRegion?: string;
}

export interface LanguageCapabilityDecision {
  disposition: CapabilityDisposition;
  reasonCodes: string[];
  context: GlobalLanguageContext;
  observations: LanguageScriptObservation[];
  policyVersion: string;
  normalizationVersion: string;
  provenanceChecksum: string;
}

const SCRIPT_TESTS: Array<[ScriptCode, RegExp]> = [
  ['Arab', /\p{Script=Arabic}/u], ['Cyrl', /\p{Script=Cyrillic}/u], ['Deva', /\p{Script=Devanagari}/u],
  ['Hang', /\p{Script=Hangul}/u], ['Hira', /\p{Script=Hiragana}/u], ['Kana', /\p{Script=Katakana}/u],
  ['Hani', /\p{Script=Han}/u], ['Latn', /\p{Script=Latin}/u]
];
const KNOWN_SCRIPTS = new Set<ScriptCode>(SCRIPT_TESTS.map(([script]) => script));
const LANGUAGE_SCRIPTS: Record<string, ScriptCode[]> = {
  ar: ['Arab'], fa: ['Arab'], ur: ['Arab'], ru: ['Cyrl'], uk: ['Cyrl'], bg: ['Cyrl'], hi: ['Deva'], mr: ['Deva'], ne: ['Deva'],
  ko: ['Hang'], ja: ['Hani', 'Hira', 'Kana'], zh: ['Hani']
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function normalizeGlobalText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
}

export function canonicalLanguage(value?: string): string {
  if (!value || value === 'und') return 'und';
  try { return new Intl.Locale(value.replace(/_/g, '-')).language.toLowerCase(); } catch { return 'und'; }
}

export function canonicalLocale(value?: string): string {
  if (!value || value === 'und') return 'und';
  try { return new Intl.Locale(value.replace(/_/g, '-')).toString(); } catch { return 'und'; }
}

export function detectScripts(text: string): ScriptCode[] {
  const scripts = SCRIPT_TESTS.filter(([, expression]) => expression.test(text)).map(([script]) => script);
  return scripts.length ? scripts : (/[^\p{Letter}\p{Number}]/u.test(text) ? ['Zyyy'] : ['UNKNOWN']);
}

export function observeLanguageField(field: string, text: string, language = 'und'): LanguageScriptObservation {
  const normalizedText = normalizeGlobalText(text);
  const scripts = detectScripts(normalizedText);
  const canonical = canonicalLanguage(language);
  const expected = LANGUAGE_SCRIPTS[canonical] || ['Latn'];
  const meaningful = scripts.filter(script => KNOWN_SCRIPTS.has(script));
  const transliterated = canonical !== 'und' && meaningful.length > 0 && !meaningful.some(script => expected.includes(script));
  return { field, language: canonical, scripts, primaryScript: meaningful.length > 1 ? 'MULTI' : scripts[0], confidence: normalizedText ? (meaningful.length ? 100 : 0) : 0, codeSwitched: meaningful.length > 1, transliterated, normalizedText };
}

/** A shared, deterministic capability boundary. Unknown language/script is abstention, never English fallback. */
export function assessLanguageCapability(
  fields: Array<{ field: string; text: string; language?: string }>,
  context: GlobalLanguageContext,
  options: { controlledTrial?: boolean } = {}
): LanguageCapabilityDecision {
  const observations = fields.filter(item => item.text.trim()).map(item => observeLanguageField(item.field, item.text, item.language || context.contentLanguage));
  const explicitScript = context.contentScript as ScriptCode | undefined;
  const detected = new Set(observations.flatMap(item => item.scripts).filter(script => KNOWN_SCRIPTS.has(script)));
  const mismatch = !!explicitScript && explicitScript !== 'MULTI' && explicitScript !== 'UNKNOWN' && detected.size > 0 && !detected.has(explicitScript);
  const unknown = !observations.length || observations.some(item => item.primaryScript === 'UNKNOWN') || canonicalLanguage(context.contentLanguage) === 'und';
  const reasonCodes: string[] = [];
  let disposition: CapabilityDisposition = 'SUPPORTED';
  if (mismatch) { disposition = 'ABSTAIN'; reasonCodes.push('DECLARED_DETECTED_SCRIPT_MISMATCH'); }
  else if (unknown) { disposition = 'ABSTAIN'; reasonCodes.push('LANGUAGE_OR_SCRIPT_UNSUPPORTED'); }
  else if (options.controlledTrial) { disposition = 'CONTROLLED_TRIAL'; reasonCodes.push('NEW_LANGUAGE_SCRIPT_CONTROLLED_TRIAL'); }
  else reasonCodes.push('LANGUAGE_SCRIPT_SUPPORTED');
  if (observations.some(item => item.codeSwitched)) reasonCodes.push('MULTISCRIPT_CONTENT_OBSERVED');
  if (observations.some(item => item.transliterated)) reasonCodes.push('TRANSLITERATED_CONTENT_OBSERVED');
  const normalizedContext = { ...context, contentLanguage: canonicalLanguage(context.contentLanguage), targetAudienceLocale: canonicalLocale(context.targetAudienceLocale), queryLocale: canonicalLocale(context.queryLocale), marketRegions: [...(context.marketRegions || [])].sort() };
  const base = { disposition, reasonCodes, context: normalizedContext, observations, policyVersion: GLOBAL_LANGUAGE_POLICY_VERSION, normalizationVersion: UNICODE_NORMALIZATION_VERSION };
  return { ...base, provenanceChecksum: createHash('sha256').update(stable(base)).digest('hex') };
}
