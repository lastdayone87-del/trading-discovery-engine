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
