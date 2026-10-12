import { normalizeLanguageCode } from './countrySearchHints';

export interface ExplicitTerminologyLanguageContext {
  language?: string;
  locale?: string;
}

export interface LanguageBearingCreatorEvidence {
  detectedLanguages?: Array<{ language: string; confidence?: number }>;
  videos?: Array<{ language?: string }>;
  transcriptExcerpts?: Array<{ language?: string }>;
}

function normalized(value: string | undefined): string {
  if (!value || !value.trim()) return '';
  return normalizeLanguageCode(value);
}

function uniqueLanguages(values: string[]): string[] {
  return [...new Set(values.map(normalized).filter(language => language && language !== 'und'))];
}

/**
 * Canonical full tag via Intl.Locale: language, script, and region subtags
 * normalized per BCP 47 (script title-case, region upper-case). Script-only
 * tags ('zh-Hans') and bare languages collapse to the primary language —
 * they carry no region and must never read as regional locales. Invalid tags
 * yield '' so malformed input can never fabricate a locale.
 */
function canonicalTag(value: string): string {
  try {
    const locale = new Intl.Locale(value.trim().replace(/_/g, '-'));
    return locale.region ? locale.toString() : locale.language;
  } catch {
    return '';
  }
}

/**
 * Preserves an explicit regional locale only when EVERY agreeing signal
 * carries the SAME full regional tag. A bare language tag alongside a
 * regional one (fr + fr-FR) is ambiguity, not agreement — no locale is
 * inferred. Never inferred from country, never guessed across conflicts.
 */
function explicitLocale(tags: string[]): string | undefined {
  const full = [...new Set(tags.map(canonicalTag).filter(Boolean))];
  return full.length === 1 && full[0].includes('-') ? full[0] : undefined;
}

/**
 * Selects an explicit language signal without inferring one from creator country.
 * Conflicting signals are deliberately left unknown rather than guessed.
 */
export function selectExplicitTerminologyLanguageContext(
  evidence: LanguageBearingCreatorEvidence
): ExplicitTerminologyLanguageContext | undefined {
  const detected = (evidence.detectedLanguages || [])
    .map(item => ({ tag: (item.language || '').trim(), language: normalized(item.language), confidence: Number.isFinite(item.confidence) ? Number(item.confidence) : 0 }))
    .filter(item => item.language && item.language !== 'und');

  if (detected.length > 0) {
    const highestConfidence = Math.max(...detected.map(item => item.confidence));
    const top = detected.filter(item => item.confidence === highestConfidence);
    const winners = uniqueLanguages(top.map(item => item.language));
    if (winners.length !== 1) return undefined;
    const locale = explicitLocale(top.filter(item => item.language === winners[0]).map(item => item.tag));
    return locale ? { language: winners[0], locale } : { language: winners[0] };
  }

  const documents = [
    ...(evidence.videos || []).map(video => video.language || ''),
    ...(evidence.transcriptExcerpts || []).map(excerpt => excerpt.language || '')
  ];
  const documentLanguages = uniqueLanguages(documents);
  if (documentLanguages.length !== 1) return undefined;
  // Consensus runs over signals agreeing with the selected language only:
  // 'und'/unknown entries carry no information and must not veto an explicit
  // regional tag (nor smuggle one in).
  const locale = explicitLocale(documents.filter(value => normalized(value) === documentLanguages[0]));
  return locale ? { language: documentLanguages[0], locale } : { language: documentLanguages[0] };
}
