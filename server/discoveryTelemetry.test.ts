import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDiscoveryCycleDiagnostics,
  recordDiscoveryCandidateDiagnostic,
  sanitizeSchedulingError,
  type DiscoveryCandidateDiagnostic
} from './discoveryTelemetry';

function candidate(overrides: Partial<DiscoveryCandidateDiagnostic> = {}): DiscoveryCandidateDiagnostic {
  return {
    cycleId: 'cycle-1', requestId: 'request-1', targetCountry: 'Belgium', legacyCountry: 'Belgium', attempt: 1,
    disposition: 'SKIPPED', reasonCode: 'PHASE8_DISABLED', ...overrides
  };
}

test('diagnostic aggregation counts scheduled, skipped, failed, phase8, authority, provider, reservation, and transaction outcomes', () => {
  const diagnostics = createDiscoveryCycleDiagnostics({ cycleId: 'cycle-1', requestId: 'request-1', targetCountry: 'Belgium', capacity: 5 });
  recordDiscoveryCandidateDiagnostic(diagnostics, candidate({ disposition: 'SKIPPED', reasonCode: 'PHASE8_DISABLED', phase8Result: 'FRONTIER_ALLOCATION_DISABLED' }));
  recordDiscoveryCandidateDiagnostic(diagnostics, candidate({ attempt: 2, disposition: 'SKIPPED', reasonCode: 'QUERY_INTELLIGENCE_AUTHORITY_REJECTED', authorityOutcome: 'REJECTED' }));
  recordDiscoveryCandidateDiagnostic(diagnostics, candidate({ attempt: 3, disposition: 'SKIPPED', reasonCode: 'RESERVATION_PRECONDITION_ZERO_ROWS', reservationOutcome: 'SKIPPED' }));
  recordDiscoveryCandidateDiagnostic(diagnostics, candidate({ attempt: 4, disposition: 'FAILED', reasonCode: 'PROVIDER_REGISTRY_NOT_ELIGIBLE', providerRegistryOutcome: 'INELIGIBLE' }));
  recordDiscoveryCandidateDiagnostic(diagnostics, candidate({ attempt: 5, disposition: 'FAILED', reasonCode: 'QUERY_RUN_INSERTION_FAILURE', schedulingOutcome: 'FAILED' }));
  recordDiscoveryCandidateDiagnostic(diagnostics, candidate({ attempt: 6, disposition: 'SCHEDULED', reasonCode: 'SCHEDULED', schedulingOutcome: 'SCHEDULED' }));
  assert.deepEqual({
    attempts: diagnostics.candidates.length,
    selected: diagnostics.candidatesSelected,
    skipped: diagnostics.candidatesSkipped,
    failed: diagnostics.candidateFailures,
    scheduled: diagnostics.runsCreated,
    phase8Disabled: diagnostics.phase8Disabled,
    authorityRejected: diagnostics.authorityRejections,
    providerRejected: diagnostics.providerRegistryRejections,
    reservationSkipped: diagnostics.reservationPreconditionSkips,
    transactionErrors: diagnostics.schedulingTransactionErrors
  }, { attempts: 6, selected: 0, skipped: 3, failed: 2, scheduled: 1, phase8Disabled: 1, authorityRejected: 1, providerRejected: 1, reservationSkipped: 1, transactionErrors: 1 });
});

test('sanitized scheduling errors map only to stable reason classes and never retain payload text', () => {
  const secret = 'Bearer super-secret-token query=buy EURUSD';
  const cases = [
    [new Error('ALLOCATED_PROVIDER_NO_LONGER_ELIGIBLE'), 'PROVIDER_REGISTRY_NOT_ELIGIBLE'],
    [new Error('FRONTIER_ALLOCATION_COMMIT_FAILED: query text here'), 'SCHEDULING_SQL_FAILURE'],
    [Object.assign(new Error('duplicate'), { code: '23505' }), 'SCHEDULING_SQL_FAILURE'],
    [Object.assign(new Error(secret), { code: '42P01' }), 'SCHEDULING_SQL_FAILURE'],
    [new Error('ordinary scheduling failure'), 'UNKNOWN_SCHEDULING_FAILURE']
  ] as const;
  for (const [error, expected] of cases) {
    const sanitized = sanitizeSchedulingError(error);
    assert.equal(sanitized.reasonCode, expected);
    assert.doesNotMatch(JSON.stringify(sanitized), /super-secret-token|buy EURUSD|query text/i);
  }
});

test('provider-registry, reservation, authority, and phase8 reason codes remain distinct', () => {
  assert.equal(sanitizeSchedulingError(new Error('ALLOCATED_PROVIDER_NO_LONGER_ELIGIBLE')).reasonCode, 'PROVIDER_REGISTRY_NOT_ELIGIBLE');
  const diagnostics = createDiscoveryCycleDiagnostics({ cycleId: 'cycle-2', targetCountry: 'Belgium' });
  recordDiscoveryCandidateDiagnostic(diagnostics, candidate({ reasonCode: 'RESERVATION_PRECONDITION_ZERO_ROWS', reservationOutcome: 'SKIPPED' }));
  recordDiscoveryCandidateDiagnostic(diagnostics, candidate({ attempt: 2, reasonCode: 'QUERY_INTELLIGENCE_AUTHORITY_REJECTED', authorityOutcome: 'REJECTED' }));
  recordDiscoveryCandidateDiagnostic(diagnostics, candidate({ attempt: 3, reasonCode: 'PHASE8_DISABLED', phase8Result: 'FRONTIER_ALLOCATION_DISABLED' }));
  assert.deepEqual(diagnostics.candidates.map(item => item.reasonCode), [
    'RESERVATION_PRECONDITION_ZERO_ROWS', 'QUERY_INTELLIGENCE_AUTHORITY_REJECTED', 'PHASE8_DISABLED'
  ]);
});
