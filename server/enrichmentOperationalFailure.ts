import type { EvidenceCollectionReport } from './evidenceEngine';
import { ProviderCallError } from './providerResilience';

const OPERATIONAL_PROVIDER_REASONS = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_TRANSIENT_FAILURE',
  'PROVIDER_CREDENTIALS_EXHAUSTED',
  'PROVIDER_CANCELLED',
  'PROVIDER_EXECUTION_FAILED'
]);

/**
 * An enrichment pass may only advance evidentiary uncertainty when provider
 * coverage was actually observed. Operational degradation is infrastructure,
 * not ambiguity, so surface it as an attempt-free durable retry instead.
 */
export function enrichmentOperationalFailure(
  report: EvidenceCollectionReport,
  isEnrichmentPass: boolean
): ProviderCallError | null {
  if (!isEnrichmentPass || !report.degraded) return null;
  const reasonCodes = report.providers
    .filter(provider => provider.availability === 'FAILED')
    .flatMap(provider => provider.reasonCodes || [])
    .filter(code => OPERATIONAL_PROVIDER_REASONS.has(code));
  if (!reasonCodes.length) return null;
  return new ProviderCallError(
    'Enrichment classification provider coverage is operationally degraded; retry after provider recovery.',
    'TRANSIENT',
    true,
    { providerReasons: [...new Set(reasonCodes)] }
  );
}
