import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluatePhaseBHistoryReadiness,
  PHASE_B_REQUIRED_IMMUTABLE_TABLES,
  PHASE_B_REQUIRED_MIGRATIONS,
  PHASE_B_REQUIRED_TABLES,
  type PhaseBHistoryReadinessSnapshot
} from './phaseBHistoryReadiness';

const passingSnapshot = (): PhaseBHistoryReadinessSnapshot => ({
  transactionReadOnly: true,
  migrations: [...PHASE_B_REQUIRED_MIGRATIONS],
  tables: [...PHASE_B_REQUIRED_TABLES],
  immutableTables: [...PHASE_B_REQUIRED_IMMUTABLE_TABLES],
  settings: {
    decision_evaluation_sampling_enabled: 'true',
    evidence_document_dual_write_enabled: 'true',
    evidence_assertion_dual_write_enabled: 'false',
    creator_focus_classifier_mode: 'SHADOW',
    creator_focus_classifier_canary_basis_points: '0',
    gap_specific_scheduler_mode: 'OFF',
    release5_creator_focus_advisory_mode: 'OFF'
  },
  protectedAuditPolicyApproved: true,
  creatorFocusPolicyPresent: true,
  invalidCreatorFocusEffectiveStatusCount: 0,
  assertionActivationHasPassingValidation: false
});

test('Phase B history readiness passes only non-authoritative observational controls', () => {
  const report = evaluatePhaseBHistoryReadiness(passingSnapshot());
  assert.equal(report.ready, true);
  assert.equal(report.authorityPreserved, true);
  assert.equal(report.servingAuthority, false);
  assert.equal(report.automaticPromotion, false);
  assert.ok(report.checks.every(check => check.status === 'PASS'));
});

test('Phase B history readiness fails closed on schema, mutation, canary, or serving gaps', () => {
  const snapshot = passingSnapshot();
  snapshot.migrations = snapshot.migrations.filter(version => version !== 63);
  snapshot.tables = snapshot.tables.filter(table => table !== 'evidence_coverage_snapshots');
  snapshot.immutableTables = snapshot.immutableTables.filter(table => table !== 'evaluation_ground_truth_labels');
  snapshot.settings.creator_focus_classifier_mode = 'CANARY';
  snapshot.settings.creator_focus_classifier_canary_basis_points = '100';
  snapshot.settings.gap_specific_scheduler_mode = 'SHADOW';
  snapshot.settings.release5_creator_focus_advisory_mode = 'CANARY';
  snapshot.invalidCreatorFocusEffectiveStatusCount = 1;
  const report = evaluatePhaseBHistoryReadiness(snapshot);
  assert.equal(report.ready, false);
  for (const code of ['REQUIRED_MIGRATIONS', 'REQUIRED_TABLES', 'IMMUTABLE_HISTORY', 'CREATOR_FOCUS_SHADOW_ONLY', 'CREATOR_FOCUS_CANARY_DISABLED', 'INVESTIGATION_AUTHORITY_DISABLED', 'ADVISORY_AUTHORITY_DISABLED', 'EFFECTIVE_STATUS_NON_AUTHORITATIVE']) {
    assert.equal(report.checks.find(check => check.code === code)?.status, 'FAIL', code);
  }
});

test('assertion collection requires a PASS-linked immutable activation event', () => {
  const snapshot = passingSnapshot();
  snapshot.settings.evidence_assertion_dual_write_enabled = 'true';
  assert.equal(evaluatePhaseBHistoryReadiness(snapshot).checks.find(check => check.code === 'ASSERTION_ACTIVATION_GOVERNED')?.status, 'FAIL');
  snapshot.assertionActivationHasPassingValidation = true;
  assert.equal(evaluatePhaseBHistoryReadiness(snapshot).checks.find(check => check.code === 'ASSERTION_ACTIVATION_GOVERNED')?.status, 'PASS');
});

test('readiness inspection is read-only and cannot grant authority', () => {
  const source = readFileSync(new URL('./phaseBHistoryReadiness.ts', import.meta.url), 'utf8');
  assert.match(source, /BEGIN TRANSACTION READ ONLY/);
  assert.doesNotMatch(source, /db\.query\([`'"]\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i);
  assert.match(source, /servingAuthority:\s*false/);
  assert.match(source, /automaticPromotion:\s*false/);
  const controls = readFileSync(new URL('./phaseBShadow.ts', import.meta.url), 'utf8');
  for (const control of ['EVALUATION_SAMPLING', 'EVIDENCE_DOCUMENTS', 'EVIDENCE_ASSERTIONS', 'CREATOR_FOCUS_SHADOW']) assert.match(controls, new RegExp(control));
});
