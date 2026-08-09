import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPhaseBObservationCompleteness,
  executePhaseBObservation,
  groundTruthLabelObservationKey,
  productionDiagnosticObservationKey,
  retrievalAssignmentObservationKey,
  type ProductionDiagnosticPayload,
  type RetrievalAssignmentPayload
} from './phaseBObservationOutbox';

const assignmentPayload = (): RetrievalAssignmentPayload => ({
  type: 'RETRIEVAL_ASSIGNMENT',
  input: { channelId: 'channel-1', targetCountry: 'France', discoveryOrigin: 'automated_query', language: 'fr', observedAt: '2026-08-09T00:00:00.000Z', context: { isManualScan: false, isEnrichmentPass: false } },
  policy: { policyKey: 'protected-audit', version: 1, salt: 'pinned-salt', protectedAuditBasisPoints: 100, targetedAuditBasisPoints: 0 }
});

const diagnosticPayload = (): ProductionDiagnosticPayload => ({
  type: 'PRODUCTION_DIAGNOSTIC',
  input: { channelId: 'channel-1', input: {} as any, decision: {} as any, jobId: 'job-1', queryRunId: 'run-1', nominationId: 'nomination-1' }
});

test('observation identities are deterministic, order-stable, and payload-sensitive', () => {
  const left = assignmentPayload(), reordered = { ...assignmentPayload(), input: { ...assignmentPayload().input, context: { isEnrichmentPass: false, isManualScan: false } } };
  assert.equal(retrievalAssignmentObservationKey(left), retrievalAssignmentObservationKey(reordered));
  assert.notEqual(retrievalAssignmentObservationKey(left), retrievalAssignmentObservationKey({ ...left, input: { ...left.input, channelId: 'channel-2' } }));
  assert.equal(productionDiagnosticObservationKey(diagnosticPayload()), productionDiagnosticObservationKey(diagnosticPayload()));
});

test('failed observations can be retried with the original payload and identity', async () => {
  let attempts = 0;
  const payload = assignmentPayload(), key = retrievalAssignmentObservationKey(payload);
  const dependencies = {
    recordAssignment: async () => { attempts++; if (attempts === 1) throw new Error('transient'); return { assignmentKey: 'assignment-1' } as any; },
    recordDiagnostic: async () => 'diagnostic-1', recordGroundTruth: async () => ({ id: 'label-1' } as any)
    recordDiagnostic: async () => 'diagnostic-1'
  };
  await assert.rejects(executePhaseBObservation(payload, key, dependencies), /transient/);
  assert.equal(await executePhaseBObservation(payload, key, dependencies), 'assignment-1');
  assert.equal(attempts, 2);
});

test('diagnostic retries receive the stable observation key and fail closed without an id', async () => {
  const payload = diagnosticPayload(), key = productionDiagnosticObservationKey(payload);
  let received: string | undefined;
  assert.equal(await executePhaseBObservation(payload, key, {
    recordAssignment: async () => ({ assignmentKey: 'unused' } as any),
    recordDiagnostic: async input => { received = input.observationKey; return 'diagnostic-1'; }, recordGroundTruth: async () => ({ id: 'label-1' } as any)
  }), 'diagnostic-1');
  assert.equal(received, key);
  await assert.rejects(executePhaseBObservation(payload, key, {
    recordAssignment: async () => ({ assignmentKey: 'unused' } as any), recordDiagnostic: async () => undefined, recordGroundTruth: async () => ({ id: 'label-1' } as any)
  }), /PRODUCTION_DIAGNOSTIC_ID_REQUIRED/);
});

test('human ground truth is keyed only by immutable review decision and retries one label', async () => {
  const reviewDecisionId = '11111111-1111-4111-8111-111111111111';
  const key = groundTruthLabelObservationKey(reviewDecisionId);
  assert.equal(key, `phase-b:ground-truth:${reviewDecisionId}`);
  let attempts = 0;
  const payload = { type: 'GROUND_TRUTH_LABEL' as const, input: { channelId: 'channel-1', reviewDecisionId, label: 'TRADING_CONFIRMED' as const, provenance: 'HUMAN_REVIEW' as const, evidenceSnapshot: {} } };
  const dependencies = { recordAssignment: async () => ({ assignmentKey: 'unused' } as any), recordDiagnostic: async () => 'unused', recordGroundTruth: async () => { attempts++; if (attempts === 1) throw new Error('transient label failure'); return { id: 'label-1' } as any; } };
  await assert.rejects(executePhaseBObservation(payload, key, dependencies), /transient label failure/);
  assert.equal(await executePhaseBObservation(payload, key, dependencies), 'label-1');
  assert.equal(attempts, 2);
});

    recordDiagnostic: async input => { received = input.observationKey; return 'diagnostic-1'; }
  }), 'diagnostic-1');
  assert.equal(received, key);
  await assert.rejects(executePhaseBObservation(payload, key, {
    recordAssignment: async () => ({ assignmentKey: 'unused' } as any), recordDiagnostic: async () => undefined
  }), /PRODUCTION_DIAGNOSTIC_ID_REQUIRED/);
});

test('completeness report exposes pending loss instead of silently passing', () => {
  const incomplete = buildPhaseBObservationCompleteness([
    { observation_type: 'RETRIEVAL_ASSIGNMENT', captured: 10, completed: 9, pending: 1, oldest_pending_at: '2026-08-09T00:00:00Z' },
    { observation_type: 'PRODUCTION_DIAGNOSTIC', captured: 10, completed: 10, pending: 0 }
  ]);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.totals.RETRIEVAL_ASSIGNMENT.pending, 1);
  assert.equal(incomplete.totals.RETRIEVAL_ASSIGNMENT.missingResultReferences, 0);
  assert.equal(incomplete.servingAuthority, false);
  assert.equal(buildPhaseBObservationCompleteness([
    { observation_type: 'RETRIEVAL_ASSIGNMENT', captured: 10, completed: 10, pending: 0 },
    { observation_type: 'PRODUCTION_DIAGNOSTIC', captured: 10, completed: 10, pending: 0 }
  ]).complete, true);
  assert.equal(buildPhaseBObservationCompleteness([
    { observation_type: 'RETRIEVAL_ASSIGNMENT', captured: 1, completed: 1, pending: 0, missing_result_references: 1 }
  ]).complete, false);
  assert.equal(buildPhaseBObservationCompleteness([], { eligible: 1, labeled: 0, unreconciled: 1 }).complete, false);
});

test('migration and integration are idempotent, retryable, and observational only', () => {
  const migration = readFileSync('server/db/migrations/081_phase_b_observation_outbox.sql', 'utf8');
  const outbox = readFileSync(new URL('./phaseBObservationOutbox.ts', import.meta.url), 'utf8');
  const diagnostics = readFileSync(new URL('./classificationDiagnostics.ts', import.meta.url), 'utf8');
  const ingestion = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  const reviews = readFileSync(new URL('./reviewStore.ts', import.meta.url), 'utf8');
  assert.match(migration, /observation_key TEXT NOT NULL UNIQUE/);
  assert.match(migration, /never read by production decision paths/);
  const groundTruthMigration = readFileSync('server/db/migrations/082_phase_b_ground_truth_reconciliation.sql', 'utf8');
  assert.match(groundTruthMigration, /UNIQUE INDEX[^]*review_decision_id/i);
  assert.match(migration, /observation_key TEXT NOT NULL UNIQUE/);
  assert.match(migration, /never read by production decision paths/);
  assert.match(outbox, /ON CONFLICT\(observation_key\) DO NOTHING/);
  assert.match(outbox, /STALE_PROCESSING_RECOVERED/);
  assert.match(diagnostics, /ON CONFLICT\(observation_key\).*DO NOTHING/s);
  assert.match(ingestion, /observeRetrievalAssignmentReliably/);
  assert.match(ingestion, /observeProductionDiagnosticReliably/);
  assert.match(reviews, /void observeGroundTruthLabelReliably/);
  assert.match(outbox, /channel_review_decisions[^]*evaluation_ground_truth_labels[^]*phase_b_observation_outbox/s);
  assert.doesNotMatch(outbox, /UPDATE channels|UPDATE channel_reviews|trading_status|scan_status|discord_status/i);
});
