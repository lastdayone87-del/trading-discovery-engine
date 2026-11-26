import type { EvidenceCollectionReport, VerificationDecision } from './evidenceEngine';
import { ProviderCallError } from './providerResilience';

const OPERATIONAL_PROVIDER_REASONS = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_TRANSIENT_FAILURE',
  'PROVIDER_CREDENTIALS_EXHAUSTED',
  'PROVIDER_CANCELLED',
  'PROVIDER_EXECUTION_FAILED',
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_PERMISSION_DENIED',
  'PROVIDER_ROUTE_UNAUTHORIZED',
  'SEMANTIC_DEFERRED_RATE_PRESSURE',
  'GEMINI_CAPACITY_DEFERRED',
  'GEMINI_ORG_TOKEN_BUCKET_EMPTY',
  // Preserved (not filtered out) so retry scheduling can align with the
  // failed Groq org's cooldown via failedProviderOrg() instead of falling
  // back to a generic delay.
  'GROQ_RATE_LIMITED'
]);

const SEMANTIC_PROVIDER_KEYS = new Set(['gemini_semantic', 'groq_semantic', 'gemini_free_semantic']);

/**
 * True when a semantic fallback served this evaluation after an earlier
 * semantic provider failed (see executeSemanticChain: the winning report
 * carries SEMANTIC_FALLBACK_SUCCEEDED). The original failure stays in the
 * provider ledger for telemetry — this only records that coverage was
 * restored, so downstream gates treat the served result (including a valid
 * non-terminal one) as operationally successful instead of retrying a
 * provider outage that has already been routed around.
 */
export function isFallbackCovered(report: EvidenceCollectionReport): boolean {
  return (report.providers || []).some(provider => (provider.reasonCodes || []).includes('SEMANTIC_FALLBACK_SUCCEEDED'));
}

function isSemanticProviderKey(provider: string): boolean {
  return SEMANTIC_PROVIDER_KEYS.has(provider);
}

/**
 * Failed providers not covered by a served semantic fallback, by provider
 * name. Single source of truth for every degraded-coverage gate (enrichment,
 * manual recheck, VOI legacy action, review eligibility): a fallback covers
 * semantic failures only, so unrelated failed providers always remain
 * visible. Empty means coverage is operationally complete.
 */
export function uncoveredFailedProviders(
  report: Pick<EvidenceCollectionReport, 'providers'>
): string[] {
  const failed = (report.providers || []).filter(provider => provider.availability === 'FAILED');
  if (failed.length === 0) return [];
  const covered = isFallbackCovered(report as EvidenceCollectionReport);
  return failed
    .filter(provider => !covered || !isSemanticProviderKey(provider.provider))
    .map(provider => provider.provider);
}

export interface OperationalProviderFailure {
  provider: string;
  reasonCodes: string[];
  /**
   * Quota-organization that produced this failure, when the evidence report
   * carried one. Lets retry scheduling align with the failed account's
   * cooldown. Absent for legacy callers and non-scoped failures.
   */
  orgId?: string;
  /** Upstream quota/credential failure that opened the durable circuit. */
  providerCapacityExhausted?: boolean;
  /** Epoch milliseconds when the failed account may serve again. */
  retryAt?: number;
}

/**
 * Distinct error identity lets the investigation workflow preserve this exact
 * infrastructure retry across wall-clock deadline checks without weakening
 * deadlines for genuine ambiguity or unrelated failures.
 */
export class OperationalEnrichmentProviderError extends ProviderCallError {
  /**
   * Set when an uncovered failure came from a real upstream quota/credential
   * response. decideJobFailure parks these until retryAt without consuming an
   * attempt or hitting the generic six-hour transient terminal rule.
   */
  readonly providerCapacityExhausted: boolean;
  readonly retryAt?: number;

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
    const parked = providerFailures.filter(failure => failure.providerCapacityExhausted === true);
    this.providerCapacityExhausted = parked.length > 0;
    const resumeTimes = parked
      .map(failure => Number(failure.retryAt))
      .filter((ms): ms is number => Number.isFinite(ms) && ms > 0);
    // The earliest account reset is the first moment this evaluation can make
    // progress again; retrying then is cheap because the circuit is still
    // closed for the others and this error stays attempt-free.
    this.retryAt = resumeTimes.length ? Math.min(...resumeTimes) : undefined;
  }
}

/** Only this machine-owned error identity may project PROVIDER_DEFERRED. */
export function isProviderDeferredEnrichmentError(error: unknown): boolean {
  return error instanceof OperationalEnrichmentProviderError
    || String((error as { name?: unknown } | null)?.name || '') === 'OperationalEnrichmentProviderError';
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
  const terminalStatusMatches = staged.lifecycleAction === 'CONFIRM'
    ? decision.status === 'TRADING_CONFIRMED'
    : staged.lifecycleAction === 'REJECT'
      ? decision.status === 'NON_TRADING'
      : false;
  if (!terminalStatusMatches) return false;
  const aiLedConfirmation = staged.stages.some(stage =>
    stage.stage === 'LIFECYCLE' && stage.reasonCodes.includes('AI_LED_CONFIRMATION'));
  const expectedStages = staged.lifecycleAction === 'CONFIRM'
    ? aiLedConfirmation
      ? [['CANDIDATE_DETECTION', 'PASS'], ['CONTRADICTION', 'PASS']] as const
      : [['CANDIDATE_DETECTION', 'PASS'], ['CORROBORATION', 'PASS']] as const
    : staged.lifecycleAction === 'REJECT'
      ? [['CONTRADICTION', 'FAIL']] as const
      : [];
  if (!expectedStages.length) return false;
  const evidenceById = new Map(
    [...decision.positiveEvidence, ...decision.negativeEvidence].map(item => [item.id, item])
  );
  return expectedStages.every(([stageName, disposition]) => {
    const stage = staged.stages.find(item => item.stage === stageName);
    if (!stage || stage.disposition !== disposition) return false;
    if (stage.evidenceIds.length === 0) {
      // An AI-led confirmation can legitimately have no contradiction evidence
      // to cite, but `[].every(...)` must not make an uncovered provider
      // failure look decision-grade.
      if (!(aiLedConfirmation && stageName === 'CONTRADICTION')) return false;
      return uncoveredFailedProviders(decision.evidenceCollection).length === 0;
    }
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
  // A served semantic fallback covers the semantic outage: the evaluation
  // proceeds on its merits (including UNCERTAIN → review/deeper stages)
  // instead of defer-retrying a routed-around failure. Non-semantic
  // operational failures still throw; the failed primary stays recorded.
  const uncovered = uncoveredFailedProviders(report);
  const providerFailures = report.providers
    .filter(provider => provider.availability === 'FAILED' && uncovered.includes(provider.provider))
    .map(provider => ({
      provider: provider.provider,
      reasonCodes: [...new Set((provider.reasonCodes || []).filter(code => OPERATIONAL_PROVIDER_REASONS.has(code)))],
      ...(typeof provider.orgId === 'string' && provider.orgId ? { orgId: provider.orgId } : {}),
      ...(provider.providerCapacityExhausted === true ? { providerCapacityExhausted: true } : {}),
      ...(Number.isFinite(Number(provider.retryAt)) && Number(provider.retryAt) > 0 ? { retryAt: Number(provider.retryAt) } : {})
    }))
    .filter(provider => provider.reasonCodes.length > 0);
  if (!providerFailures.length) return null;
  return new OperationalEnrichmentProviderError(providerFailures);
}

/**
 * Manual-recheck degraded-coverage gate, extracted for testability. Returns
 * the retryable error when failed providers remain uncovered, or null when
 * the evaluation may proceed. A served semantic fallback covers semantic
 * failures exactly like the enrichment gate above.
 */
export function manualRecheckDegradedError(
  collection: EvidenceCollectionReport
): (Error & { code?: string; retryable?: boolean; providerReasons?: string[] }) | null {
  if (!collection.degraded) return null;
  const uncoveredNames = uncoveredFailedProviders(collection);
  if (uncoveredNames.length === 0) return null;
  const uncovered = collection.providers.filter(
    provider => provider.availability === 'FAILED' && uncoveredNames.includes(provider.provider)
  );
  const reasonCodes = uncovered.flatMap(provider => provider.reasonCodes || []);
  return Object.assign(
    new Error(`Manual recheck classification provider coverage is degraded: ${uncovered.map(provider => provider.provider).join(', ') || 'unknown provider'}.`),
    { code: 'MANUAL_RESCAN_CLASSIFICATION_DEGRADED', retryable: true, providerReasons: reasonCodes }
  );
}
