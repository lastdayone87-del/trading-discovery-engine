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
 * Selects an explicit language signal without inferring one from creator country.
 * Conflicting signals are deliberately left unknown rather than guessed.
 */
export function selectExplicitTerminologyLanguageContext(
  evidence: LanguageBearingCreatorEvidence
): ExplicitTerminologyLanguageContext | undefined {
  const detected = (evidence.detectedLanguages || [])
    .map(item => ({ language: normalized(item.language), confidence: Number.isFinite(item.confidence) ? Number(item.confidence) : 0 }))
    .filter(item => item.language && item.language !== 'und');

  if (detected.length > 0) {
    const highestConfidence = Math.max(...detected.map(item => item.confidence));
    const winners = uniqueLanguages(detected.filter(item => item.confidence === highestConfidence).map(item => item.language));
    return winners.length === 1 ? { language: winners[0] } : undefined;
  }

  const documentLanguages = uniqueLanguages([
    ...(evidence.videos || []).map(video => video.language || ''),
    ...(evidence.transcriptExcerpts || []).map(excerpt => excerpt.language || '')
  ]);
  return documentLanguages.length === 1 ? { language: documentLanguages[0] } : undefined;
}
