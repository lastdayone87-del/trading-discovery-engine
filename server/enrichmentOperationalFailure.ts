import type { EvidenceCollectionReport, VerificationDecision } from './evidenceEngine';
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
export function hasDecisionGradeEvidenceWithoutFailedProviders(decision: VerificationDecision): boolean {
  const failedProviders = new Set(
    decision.evidenceCollection.providers
      .filter(provider => provider.availability === 'FAILED')
      .map(provider => provider.provider)
  );
  const staged = decision.stagedClassification;
  if (!staged) return false;
  const expectedStages = staged.lifecycleAction === 'CONFIRM'
    ? [['CANDIDATE_DETECTION', 'PASS'], ['CORROBORATION', 'PASS']] as const
    : staged.lifecycleAction === 'REJECT'
      ? [['CONTRADICTION', 'FAIL']] as const
      : [];
  if (!expectedStages.length) return false;
  const evidenceById = new Map(
    [...decision.positiveEvidence, ...decision.negativeEvidence].map(item => [item.id, item])
  );
  return expectedStages.every(([stageName, disposition]) => {
    const stage = staged.stages.find(item => item.stage === stageName);
    if (!stage || stage.disposition !== disposition || stage.evidenceIds.length === 0) return false;
    return stage.evidenceIds.every(id => {
      const evidence = evidenceById.get(id);
      return !!evidence && !failedProviders.has(evidence.source);
    });
  });
}

export function enrichmentOperationalFailure(
  report: EvidenceCollectionReport,
  isEnrichmentPass: boolean,
  decisionReadyWithoutFailedProvider: boolean = false
): ProviderCallError | null {
  if (!isEnrichmentPass || !report.degraded || decisionReadyWithoutFailedProvider) return null;
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
