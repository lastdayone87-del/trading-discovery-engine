export type DiscoveryCandidateDisposition = 'SCHEDULED' | 'SKIPPED' | 'FAILED';
export type DiscoveryCandidateReasonCode =
  | 'PHASE8_DISABLED'
  | 'PHASE8_NOT_AUTHORIZED'
  | 'QUERY_INTELLIGENCE_AUTHORITY_REJECTED'
  | 'PROVIDER_REGISTRY_NOT_ELIGIBLE'
  | 'RESERVATION_PRECONDITION_ZERO_ROWS'
  | 'RESERVATION_NOT_AUTHORIZED'
  | 'QUERY_RUN_ALREADY_ACTIVE'
  | 'COOLDOWN_OR_ELIGIBILITY_SKIP'
  | 'BATCH_DIVERSITY_GUARD'
  | 'SCHEDULING_SQL_FAILURE'
  | 'QUERY_RUN_INSERTION_FAILURE'
  | 'CHILD_JOB_INSERTION_FAILURE'
  | 'QUERY_RUN_LINKAGE_FAILURE'
  | 'DECISION_EVENT_PERSISTENCE_FAILURE'
  | 'SCHEDULED'
  | 'UNKNOWN_SCHEDULING_FAILURE';

export interface DiscoveryProviderDiagnostic {
  providerKey?: string;
  capability?: string;
  quotaDomain?: string;
}

export interface DiscoveryCandidateDiagnostic {
  cycleId: string;
  requestId?: string;
  targetCountry?: string;
  legacyCountry: string;
  attempt: number;
  phase8Result?: string;
  selectionSource?: string;
  selectedQueryId?: number;
  queryRunId?: string;
  jobId?: string;
  authorityOutcome?: 'ELIGIBLE' | 'REJECTED';
  authorityReasonCodes?: string[];
  provider?: DiscoveryProviderDiagnostic;
  providerRegistryOutcome?: 'ELIGIBLE' | 'INELIGIBLE' | 'NOT_REACHED';
  providerRegistryReasonCode?: string;
  phase9TreatmentOutcome?: 'AUTHORIZED' | 'NOT_AUTHORIZED' | 'NOT_REACHED';
  phase9TreatmentReasonCode?: string;
  reservationOutcome?: 'RESERVED' | 'SKIPPED' | 'NOT_REACHED';
  reservationRecoveryOutcome?: 'ORPHANED_TERMINAL_RUNS_RECONCILED' | 'RETRY_WAIT_OWNERSHIP_ALIGNED' | 'ORPHANED_FAILED_RUNS_RECONCILED';
  reservationReasonCode?: string;
  schedulingOutcome?: 'SCHEDULED' | 'FAILED' | 'NOT_REACHED';
  schedulingOperation?: string;
  sanitizedErrorClass?: string;
  disposition: DiscoveryCandidateDisposition;
  reasonCode: DiscoveryCandidateReasonCode;
}

export type DiscoveryCandidateDiagnosticPatch = Partial<Omit<DiscoveryCandidateDiagnostic, 'cycleId' | 'requestId' | 'targetCountry' | 'legacyCountry' | 'attempt'>>;

export interface DiscoveryCycleDiagnostics {
  cycleId: string;
  requestId?: string;
  targetCountry?: string;
  capacity: number;
  candidateAttempts: number;
  candidatesSelected: number;
  candidatesSkipped: number;
  candidateFailures: number;
  runsCreated: number;
  phase8Disabled: number;
  authorityRejections: number;
  providerRegistryRejections: number;
  reservationPreconditionSkips: number;
  schedulingTransactionErrors: number;
  candidates: DiscoveryCandidateDiagnostic[];
}

export function createDiscoveryCycleDiagnostics(input: { cycleId: string; requestId?: string; targetCountry?: string; capacity?: number }): DiscoveryCycleDiagnostics {
  return {
    cycleId: input.cycleId, requestId: input.requestId, targetCountry: input.targetCountry,
    capacity: input.capacity || 0, candidateAttempts: 0, candidatesSelected: 0, candidatesSkipped: 0,
    candidateFailures: 0, runsCreated: 0, phase8Disabled: 0, authorityRejections: 0,
    providerRegistryRejections: 0, reservationPreconditionSkips: 0, schedulingTransactionErrors: 0, candidates: []
  };
}

export function recordDiscoveryCandidateDiagnostic(diagnostics: DiscoveryCycleDiagnostics, candidate: DiscoveryCandidateDiagnostic): void {
  diagnostics.candidates.push(candidate);
  if (candidate.disposition === 'SKIPPED') diagnostics.candidatesSkipped++;
  if (candidate.disposition === 'FAILED') diagnostics.candidateFailures++;
  if (candidate.disposition === 'SCHEDULED') diagnostics.runsCreated++;
  if (candidate.phase8Result === 'FRONTIER_ALLOCATION_DISABLED') diagnostics.phase8Disabled++;
  if (candidate.authorityOutcome === 'REJECTED') diagnostics.authorityRejections++;
  if (candidate.providerRegistryOutcome === 'INELIGIBLE') diagnostics.providerRegistryRejections++;
  if (candidate.reservationOutcome === 'SKIPPED') diagnostics.reservationPreconditionSkips++;
  if (candidate.schedulingOutcome === 'FAILED' && candidate.reasonCode !== 'PROVIDER_REGISTRY_NOT_ELIGIBLE') diagnostics.schedulingTransactionErrors++;
}

export function sanitizeSchedulingError(error: unknown): { errorClass: string; reasonCode: DiscoveryCandidateReasonCode } {
  const message = String((error as { message?: unknown } | null)?.message || '').toUpperCase();
  const code = String((error as { code?: unknown } | null)?.code || '').toUpperCase();
  const combined = `${code} ${message}`;
  const exact: Array<[RegExp, DiscoveryCandidateReasonCode]> = [
    [/ALLOCATED_PROVIDER_NO_LONGER_ELIGIBLE|PROVIDER_INELIGIBLE_OR_CAPABILITY_MISMATCH/, 'PROVIDER_REGISTRY_NOT_ELIGIBLE'],
    [/FRONTIER_ALLOCATION_LINEAGE_MISSING|PROVIDER_ALLOCATION_LINEAGE_MISSING/, 'SCHEDULING_SQL_FAILURE'],
    [/RETRIEVAL_CANARY_COMMIT_FAILED/, 'SCHEDULING_SQL_FAILURE'],
    [/PHASE9_TREATMENT_CHANGED_PHASE8_NEIGHBORHOOD/, 'SCHEDULING_SQL_FAILURE'],
    [/FRONTIER_ALLOCATION_COMMIT_FAILED|FRONTIER_PROPOSAL_CONSUME_FAILED/, 'SCHEDULING_SQL_FAILURE'],
    [/FRONTIER_ALLOCATION_NEIGHBORHOOD_LINEAGE_MISMATCH/, 'SCHEDULING_SQL_FAILURE'],
    [/QUERY_RUN_LINKAGE|UPDATE QUERY_RUNS SET JOB_ID/, 'QUERY_RUN_LINKAGE_FAILURE'],
    [/INSERT INTO JOBS|CHILD_JOB/, 'CHILD_JOB_INSERTION_FAILURE'],
    [/INSERT INTO QUERY_RUNS/, 'QUERY_RUN_INSERTION_FAILURE'],
    [/QUERY_SELECTED|DECISION_EVENT/, 'DECISION_EVENT_PERSISTENCE_FAILURE']
  ];
  for (const [pattern, reasonCode] of exact) {
    if (pattern.test(combined)) return { errorClass: reasonCode, reasonCode };
  }
  if (code.startsWith('23')) return { errorClass: 'POSTGRES_CONSTRAINT_ERROR', reasonCode: 'SCHEDULING_SQL_FAILURE' };
  if (code.startsWith('42')) return { errorClass: 'POSTGRES_STATEMENT_ERROR', reasonCode: 'SCHEDULING_SQL_FAILURE' };
  if (code) return { errorClass: `POSTGRES_${code}`, reasonCode: 'SCHEDULING_SQL_FAILURE' };
  return { errorClass: 'SCHEDULING_ERROR', reasonCode: 'UNKNOWN_SCHEDULING_FAILURE' };
}
