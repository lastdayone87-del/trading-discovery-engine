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
 * Canonical full tag (BCP 47 shape: language lower, region upper when present).
 */
function canonicalTag(value: string): string {
  const parts = value.trim().split(/[-_]/);
  if (parts.length < 2 || !parts[0] || !parts[1]) return (parts[0] || '').toLowerCase();
  return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
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
  const locale = explicitLocale(documents);
  return locale ? { language: documentLanguages[0], locale } : { language: documentLanguages[0] };
}
