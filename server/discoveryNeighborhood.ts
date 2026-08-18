import { createHash } from 'node:crypto';
import type { QueryRecord } from '../src/types';
import type { RetrievalLane } from './retrievalLanes';
import type { SearchOrdering } from './searchOrdering';

export interface DiscoveryNeighborhoodDimensions {
  country: string;
  language: string | null;
  queryIntent: string;
  primaryTermFamily: string;
  retrievalLane: RetrievalLane | string;
  searchOrdering: SearchOrdering | string;
  instrumentOrTheme: string | null;
  sourceFamily: string;
}

export interface DiscoveryNeighborhood {
  neighborhoodKey: string;
  neighborhoodChecksum: string;
  dimensions: DiscoveryNeighborhoodDimensions;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface RetrievalActionLineage {
  id?: string;
  queryRunId: string;
  queryId?: number | null;
  neighborhoodKey: string;
  retrievalActionKey: string;
  observedAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * Normalizes input text deterministically: NFKC unicode normalization, lowercased, trimmed.
 */
function normalizeDimensionText(value: string | null | undefined): string {
  if (!value) return 'none';
  const clean = value.normalize('NFKC').trim().toLowerCase();
  return clean.length > 0 ? clean : 'none';
}

/**
 * Generates a deterministic neighborhood key from dimensions.
 * Same canonical inputs always produce the exact same key.
 */
export function createNeighborhoodKey(dimensions: DiscoveryNeighborhoodDimensions): string {
  const c = normalizeDimensionText(dimensions.country);
  const lang = normalizeDimensionText(dimensions.language);
  const intent = normalizeDimensionText(dimensions.queryIntent);
  const termFamily = normalizeDimensionText(dimensions.primaryTermFamily);
  const lane = normalizeDimensionText(dimensions.retrievalLane);
  const ordering = normalizeDimensionText(dimensions.searchOrdering);
  const inst = normalizeDimensionText(dimensions.instrumentOrTheme);
  const source = normalizeDimensionText(dimensions.sourceFamily);

  return `${c}|${lang}|${intent}|${termFamily}|${lane}|${ordering}|${inst}|${source}`;
}

/**
 * Generates a SHA-256 checksum of the deterministic neighborhood key.
 */
export function createNeighborhoodChecksum(neighborhoodKey: string): string {
  return createHash('sha256').update(neighborhoodKey).digest('hex');
}

/**
 * Constructs a DiscoveryNeighborhood object from raw dimensions.
 */
export function buildDiscoveryNeighborhood(
  dimensions: DiscoveryNeighborhoodDimensions,
  metadata: Record<string, unknown> = {}
): DiscoveryNeighborhood {
  const neighborhoodKey = createNeighborhoodKey(dimensions);
  const neighborhoodChecksum = createNeighborhoodChecksum(neighborhoodKey);

  return {
    neighborhoodKey,
    neighborhoodChecksum,
    dimensions: {
      country: dimensions.country.trim(),
      language: dimensions.language ? dimensions.language.trim() : null,
      queryIntent: dimensions.queryIntent.trim(),
      primaryTermFamily: dimensions.primaryTermFamily.trim(),
      retrievalLane: dimensions.retrievalLane,
      searchOrdering: dimensions.searchOrdering,
      instrumentOrTheme: dimensions.instrumentOrTheme ? dimensions.instrumentOrTheme.trim() : null,
      sourceFamily: dimensions.sourceFamily.trim()
    },
    metadata
  };
}

/**
 * Maps a query run and its query record into a deterministic DiscoveryNeighborhood.
 */
export function mapQueryRunToNeighborhood(
  queryRun: {
    runId: string;
    queryId?: number;
    country: string;
    retrievalLane: string;
    searchOrdering: string;
    source?: string;
  },
  queryRecord: Partial<QueryRecord> & { query: string; intent?: string; primary_term?: string; country: string },
  options: {
    language?: string | null;
    instrumentOrTheme?: string | null;
    metadata?: Record<string, unknown>;
  } = {}
): {
  neighborhood: DiscoveryNeighborhood;
  lineage: RetrievalActionLineage;
} {
  const primaryTermFamily = queryRecord.primary_term || queryRecord.query || 'unknown';
  const queryIntent = queryRecord.intent || 'GENERAL';
  const sourceFamily = queryRun.source || 'automated_query';

  const neighborhood = buildDiscoveryNeighborhood({
    country: queryRun.country || queryRecord.country,
    language: options.language || null,
    queryIntent,
    primaryTermFamily,
    retrievalLane: queryRun.retrievalLane,
    searchOrdering: queryRun.searchOrdering,
    instrumentOrTheme: options.instrumentOrTheme || null,
    sourceFamily
  }, options.metadata || {});

  const retrievalActionKey = `retrieval_action:${queryRun.runId}:${neighborhood.neighborhoodKey}`;
  const now = new Date().toISOString();

  const lineage: RetrievalActionLineage = {
    queryRunId: queryRun.runId,
    queryId: queryRun.queryId ?? (queryRecord.id || null),
    neighborhoodKey: neighborhood.neighborhoodKey,
    retrievalActionKey,
    observedAt: now,
    metadata: {
      query: queryRecord.query,
      selectionStrategy: (queryRecord as any).selection_strategy || undefined,
      ...options.metadata
    }
  };

  return { neighborhood, lineage };
}
