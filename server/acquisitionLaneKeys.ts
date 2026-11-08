/**
 * Closed acquisition lane/outcome vocabularies.
 *
 * Kept in a dependency-free module so both the pure classifier
 * (`acquisitionLaneTaxonomy`) and the process-local counters
 * (`operationsTelemetry`) share exactly one source of truth without creating a
 * module cycle. Persisted rows and the migration checks use the same values.
 */

export const ACQUISITION_LANES = [
  'DISCOVERY',
  'ENRICHMENT',
  'RETRY',
  'MANUAL',
  'MAINTENANCE',
  'UNKNOWN',
] as const;
export type AcquisitionLane = typeof ACQUISITION_LANES[number];
export function isAcquisitionLane(value: unknown): value is AcquisitionLane {
  return typeof value === 'string' && (ACQUISITION_LANES as readonly string[]).includes(value);
}

export const ACQUISITION_OUTCOMES = [
  'ACQUIRED',
  'INSPECTED_NO_MATCH',
  'PARTIALLY_INSPECTED',
  'EXTERNALLY_BLOCKED',
  'ACQUISITION_FAILED',
  'CAPACITY_DEFERRED',
  'RUNTIME_UNAVAILABLE',
  'NEVER_EXECUTED',
  'INCONCLUSIVE',
] as const;
export type AcquisitionOutcome = typeof ACQUISITION_OUTCOMES[number];
export function isAcquisitionOutcome(value: unknown): value is AcquisitionOutcome {
  return typeof value === 'string' && (ACQUISITION_OUTCOMES as readonly string[]).includes(value);
}
