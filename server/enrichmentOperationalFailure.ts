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

export interface OperationalProviderFailure {
  provider: string;
  reasonCodes: string[];
}

/**
 * Distinct error identity lets the investigation workflow preserve this exact
 * infrastructure retry across wall-clock deadline checks without weakening
 * deadlines for genuine ambiguity or unrelated failures.
 */
export class OperationalEnrichmentProviderError extends ProviderCallError {
  constructor(public readonly providerFailures: OperationalProviderFailure[]) {
    const providerReasons = [...new Set(providerFailures.flatMap(failure => failure.reasonCodes))];
    const evidence = providerFailures
      .map(failure => `${failure.provider}[${failure.reasonCodes.join('|')}]`)
      .join(', ');
    super(
      `Enrichment classification provider coverage is operationally degraded (${evidence}); retry after provider recovery.`,
      'TRANSIENT',
      true,
      { providerReasons }
    );
    this.name = 'OperationalEnrichmentProviderError';
  }
}

/**
 * Runtime provider degradation is only blocking when the remaining evidence is
 * not sufficient to make a governed decision. The evidence engine deliberately
 * treats optional-provider loss as observable-but-non-vetoing when independent
 * evidence is already sufficient; retrying those cases turns a Gemini outage
 * into a global enrichment outage.
 */
export function enrichmentOperationalFailure(
  report: EvidenceCollectionReport,
  isEnrichmentPass: boolean
): ProviderCallError | null {
  if (!isEnrichmentPass || !report.degraded || report.sufficiency === 'SUFFICIENT') return null;
  const providerFailures = report.providers
    .filter(provider => provider.availability === 'FAILED')
    .map(provider => ({
      provider: provider.provider,
      reasonCodes: [...new Set((provider.reasonCodes || []).filter(code => OPERATIONAL_PROVIDER_REASONS.has(code)))]
    }))
    .filter(provider => provider.reasonCodes.length > 0);
  if (!providerFailures.length) return null;
  return new OperationalEnrichmentProviderError(providerFailures);
}
