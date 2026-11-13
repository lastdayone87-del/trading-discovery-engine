/**
 * Provider-independent provenance for generated discovery queries.
 *
 * This is deliberately stored inside query_library.generation_metadata rather
 * than in a new query source. Search admission remains governed by the existing
 * query source and composition policy; this object is audit and operator
 * visibility only.
 */

export type QueryGenerationSource =
  | 'LLM'
  | 'AUTOCOMPLETE'
  | 'CREATOR_CORPUS'
  | 'TEMPORAL'
  | 'EXTRACTED_QUERY';

export type QueryGenerationMode = 'OPEN_WORLD' | 'REAL_SIGNAL' | 'GROUNDED';

export interface QueryGenerationProvenance {
  source: QueryGenerationSource;
  mode: QueryGenerationMode;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  batchId: string | null;
  country: string;
  language: string;
  persona: string | null;
  scenario: string | null;
  prefix: string | null;
  generatedAt: string;
}

const SOURCES = new Set<QueryGenerationSource>([
  'LLM', 'AUTOCOMPLETE', 'CREATOR_CORPUS', 'TEMPORAL', 'EXTRACTED_QUERY',
]);
const MODES = new Set<QueryGenerationMode>(['OPEN_WORLD', 'REAL_SIGNAL', 'GROUNDED']);

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Defensive parse for JSONB/manual rows; malformed provenance is ignored. */
export function parseQueryGenerationProvenance(value: unknown): QueryGenerationProvenance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const source = String(row.source || '').toUpperCase() as QueryGenerationSource;
  const mode = String(row.mode || '').toUpperCase() as QueryGenerationMode;
  const country = stringOrNull(row.country);
  const language = stringOrNull(row.language);
  const generatedAt = stringOrNull(row.generatedAt);
  if (!SOURCES.has(source) || !MODES.has(mode) || !country || !language || !generatedAt) return null;
  return {
    source,
    mode,
    provider: stringOrNull(row.provider),
    model: stringOrNull(row.model),
    promptVersion: stringOrNull(row.promptVersion),
    batchId: stringOrNull(row.batchId),
    country,
    language,
    persona: stringOrNull(row.persona),
    scenario: stringOrNull(row.scenario),
    prefix: stringOrNull(row.prefix),
    generatedAt,
  };
}

/** Add provenance without dropping existing generation metadata. */
export function withQueryGenerationProvenance(
  metadata: Record<string, unknown> | null | undefined,
  provenance: QueryGenerationProvenance,
): Record<string, unknown> {
  return {
    ...(metadata || {}),
    generationProvenance: provenance,
  };
}

/** Human-readable source/mode label used by the Query Library surface. */
export function queryGenerationLabel(provenance: QueryGenerationProvenance): string {
  const mode = provenance.mode === 'OPEN_WORLD'
    ? 'Open-world'
    : provenance.mode === 'REAL_SIGNAL'
      ? 'Real-signal'
      : 'Grounded';
  if (provenance.source === 'LLM') return `AI · ${mode}`;
  if (provenance.source === 'AUTOCOMPLETE') return `Autocomplete · ${mode}`;
  if (provenance.source === 'CREATOR_CORPUS') return `Creator · ${mode}`;
  if (provenance.source === 'TEMPORAL') return `Event · ${mode}`;
  return `Extracted · ${mode}`;
}


/** Detailed tooltip text for the Query Library badge. */
export function formatQueryGenerationTooltip(provenance: QueryGenerationProvenance): string {
  return [
    queryGenerationLabel(provenance),
    provenance.provider ? `Provider: ${provenance.provider}` : null,
    provenance.model ? `Model: ${provenance.model}` : null,
    `Country: ${provenance.country}`,
    `Language: ${provenance.language}`,
    provenance.promptVersion ? `Prompt: ${provenance.promptVersion}` : null,
    provenance.batchId ? `Batch: ${provenance.batchId}` : null,
    provenance.persona ? `Persona: ${provenance.persona}` : null,
    provenance.scenario ? `Scenario: ${provenance.scenario}` : null,
    provenance.prefix ? `Prefix: ${provenance.prefix}` : null,
  ].filter(Boolean).join('\n');
}
