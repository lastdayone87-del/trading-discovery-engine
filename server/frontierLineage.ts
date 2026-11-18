import type { DiscoveryNeighborhoodDimensions } from './discoveryNeighborhood';

/**
 * Frontier and materialized-generated allocations carry immutable target
 * neighborhood lineage. Legacy queries without lineage do not.
 */
export function usesNeighborhoodLineage(
  allocationOrigin: string,
  nativeLineage: Record<string, unknown> | null | undefined,
): boolean {
  return allocationOrigin === 'FRONTIER_CANARY' || nativeLineage?.materialized === true;
}

/**
 * Returns the dimensions that must be used for lineage validation. Callers
 * still validate that the returned key equals nativeLineage.targetNeighborhoodKey.
 */
export function lineageBoundDimensions(
  allocationOrigin: string,
  nativeLineage: Record<string, unknown> | null | undefined,
  targetDimensions: DiscoveryNeighborhoodDimensions | undefined,
): DiscoveryNeighborhoodDimensions | undefined {
  if (!usesNeighborhoodLineage(allocationOrigin, nativeLineage)) return undefined;
  if (!nativeLineage?.targetNeighborhoodKey) return undefined;
  return targetDimensions;
}


/**
 * A preserved library row that carries frontier-only neighborhood lineage
 * cannot be scheduled through the normal selector: normal runs have LEGACY
 * allocation origin, so lineageBoundDimensions() would return undefined and
 * scheduling would reject FRONTIER_ALLOCATION_NEIGHBORHOOD_LINEAGE_MISMATCH.
 * Materialization must defer rather than consume the proposal in that case.
 */
export function preservedRowBlocksNormalScheduling(
  generationMetadata: Record<string, any> | null | undefined,
): boolean {
  const lineage = generationMetadata?.countryNativeAllocation;
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage)) return false;
  return Boolean(lineage.targetNeighborhoodKey) && lineage.materialized !== true;
}


export type PreservedCollisionAction = 'NONE' | 'PROTECTED' | 'DEFER';

/**
 * Decides what to do when materialization collides with a preserved row.
 * Terminal rows remain protected; runnable rows are reused; frontier-only
 * lineage is deferred because the normal scheduler cannot execute it.
 */
export function preservedCollisionAction(input: {
  preservedExistingRow: boolean;
  collection: string;
  storedGenerationMetadata?: Record<string, any> | null;
}): PreservedCollisionAction {
  if (!input.preservedExistingRow) return 'NONE';
  if (input.collection === 'REJECTED' || input.collection === 'PROVEN') return 'PROTECTED';
  if (preservedRowBlocksNormalScheduling(input.storedGenerationMetadata)) return 'DEFER';
  return 'NONE';
}


/** Materialized generated surfaces may execute through any supported lane/order. */
export function laneAgnosticGeneratedLineage(nativeLineage: Record<string, any> | null | undefined): boolean {
  return nativeLineage?.materialized === true && nativeLineage?.laneAgnostic === true;
}

/**
 * Generated lane-agnostic lineage keeps country/language/intent/term/source
 * identity but treats retrieval lane/order as an execution arm, not an
 * immutable allocation dimension. Frontier allocations still use the exact key.
 */
export function lineageBaseDimensionsMatch(
  target: DiscoveryNeighborhoodDimensions | null | undefined,
  actual: DiscoveryNeighborhoodDimensions | null | undefined,
): boolean {
  if (!target || !actual) return false;
  const normalize = (value: unknown) => {
    const normalized = String(value ?? 'none').normalize('NFKC').trim().toLowerCase();
    return normalized.length > 0 ? normalized : 'none';
  };
  return normalize(target.country) === normalize(actual.country)
    && normalize(target.language) === normalize(actual.language)
    && normalize(target.queryIntent) === normalize(actual.queryIntent)
    && normalize(target.primaryTermFamily) === normalize(actual.primaryTermFamily)
    && normalize(target.instrumentOrTheme) === normalize(actual.instrumentOrTheme)
    && normalize(target.sourceFamily) === normalize(actual.sourceFamily);
}
