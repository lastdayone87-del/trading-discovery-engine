/**
 * Shared structural contract for a semantic-model result.
 *
 * The provider parser, the result cache, and the batch scheduler all need the
 * same answer to "is this a usable semantic verdict?" Treating a partial
 * object as a verdict would turn a malformed model reply into an AMBIGUOUS
 * abstention and let it be cached, so every boundary uses this guard instead
 * of checking a label in isolation.
 */
export const SEMANTIC_RESULT_LABELS = [
  'ACTIVE_TRADING',
  'INVESTING_EDUCATION',
  'FINANCIAL_NEWS',
  'PERSONAL_FINANCE',
  'HYPE',
  'UNRELATED',
  'AMBIGUOUS',
] as const;

export type SemanticResultLabel = typeof SEMANTIC_RESULT_LABELS[number];

export const SEMANTIC_RESULT_FIELD_NAMES: ReadonlySet<string> = new Set([
  'channel_title',
  'channel_bio',
  'video_title',
  'video_description',
  'playlist_name',
  'playlist_description',
  'external_link_label',
  'external_link_domain',
  'country',
  'language',
  'transcript_excerpt',
  'visual_evidence',
  'discord_invite',
  // Advertised by the canonical evidence corpus and therefore citable.
  'pinned_comment',
  'location',
]);

const LABELS: ReadonlySet<string> = new Set(SEMANTIC_RESULT_LABELS);

function isBoundedConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * True only for a complete result object with every field the providers
 * consume. Extra fields (for example the batch `index`) are ignored.
 */
export function isSemanticResultShape(value: unknown): value is {
  label: SemanticResultLabel;
  confidence: number;
  supportedLanguage: boolean;
  reasonCodes: string[];
  explanation: string;
  concepts: string[];
  languages: Array<{ language: string; script: string; confidence: number; field: string }>;
  citations: Array<{ field: string; index?: number; sourceId?: string }>;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (typeof result.label !== 'string' || !LABELS.has(result.label)) return false;
  if (!isBoundedConfidence(result.confidence)) return false;
  if (typeof result.supportedLanguage !== 'boolean') return false;
  if (typeof result.explanation !== 'string') return false;
  if (!Array.isArray(result.reasonCodes) || !result.reasonCodes.every(code => typeof code === 'string')) return false;
  if (!Array.isArray(result.concepts) || !result.concepts.every(concept => typeof concept === 'string')) return false;
  if (!Array.isArray(result.languages)) return false;
  for (const language of result.languages) {
    if (!language || typeof language !== 'object' || Array.isArray(language)) return false;
    const entry = language as Record<string, unknown>;
    // Check the declared type directly: String(['channel_title']) would pass
    // the set membership test even though it is not a valid field reference.
    if (typeof entry.field !== 'string' || !SEMANTIC_RESULT_FIELD_NAMES.has(entry.field)) return false;
    if (typeof entry.language !== 'string' || typeof entry.script !== 'string') return false;
    if (!isBoundedConfidence(entry.confidence)) return false;
  }
  if (!Array.isArray(result.citations)) return false;
  for (const citation of result.citations) {
    if (!citation || typeof citation !== 'object' || Array.isArray(citation)) return false;
    const entry = citation as Record<string, unknown>;
    if (typeof entry.field !== 'string' || !SEMANTIC_RESULT_FIELD_NAMES.has(entry.field)) return false;
    if (entry.index !== undefined && (!Number.isInteger(entry.index) || (entry.index as number) < 0)) return false;
    if (entry.sourceId !== undefined && typeof entry.sourceId !== 'string') return false;
  }
  return true;
}
