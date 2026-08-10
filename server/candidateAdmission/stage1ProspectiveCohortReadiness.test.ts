import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { prospectiveEligibility, summarizeProspectiveReadiness, type ProspectiveCandidate } from './stage1ProspectiveCohortReadiness';

const base: ProspectiveCandidate = {
  label_id: 'label-1',
  channel_id: 'channel-1',
  label: 'TRADING_CONFIRMED',
  provenance: 'HUMAN_REVIEW',
  labeled_at: '2026-08-11T00:00:00Z',
  review_decision_id: 'decision-1',
  review_decision: 'APPROVE',
  ground_truth_outbox_status: 'COMPLETED',
  diagnostic_id: 'diagnostic-1',
  assignment_id: 'assignment-1',
  inclusion_basis_points: 1000,
  focus_snapshot_id: 'focus-1',
  coverage_snapshot_id: 'coverage-1'
};

test('human review requires matching immutable review decision and completed outbox', () => {
  assert.equal(prospectiveEligibility(base).eligible, true);
  assert.equal(prospectiveEligibility({ ...base, review_decision: 'REJECT' }).reason, 'HUMAN_REVIEW_DECISION_MISMATCH');
  assert.equal(prospectiveEligibility({ ...base, ground_truth_outbox_status: 'PENDING' }).reason, 'GROUND_TRUTH_OUTBOX_NOT_COMPLETED');
});

test('adjudication does not require a human review decision but still requires evaluation lineage', () => {
  const adjudication: ProspectiveCandidate = {
    ...base,
    provenance: 'ADJUDICATION',
    review_decision_id: null,
    review_decision: null,
    ground_truth_outbox_status: null
  };
  assert.equal(prospectiveEligibility(adjudication).eligible, true);
  assert.equal(prospectiveEligibility({ ...adjudication, diagnostic_id: null }).reason, 'DIAGNOSTIC_MISSING');
});

test('readiness reports class deficits and exact exclusion reason', () => {
  const rows: ProspectiveCandidate[] = [
    base,
    { ...base, label_id: 'label-2', channel_id: 'channel-2', label: 'NON_TRADING', review_decision_id: 'decision-2', review_decision: 'REJECT' },
    { ...base, label_id: 'label-3', channel_id: 'channel-3', diagnostic_id: null }
  ];
  const summary = summarizeProspectiveReadiness(rows, 2);
  assert.equal(summary.eligible.tradingConfirmed, 1);
  assert.equal(summary.eligible.nonTrading, 1);
  assert.equal(summary.exclusions.DIAGNOSTIC_MISSING, 1);
  assert.deepEqual(summary.remaining, { tradingConfirmed: 1, nonTrading: 1 });
  assert.equal(summary.ready, false);
  assert.equal(summary.nextAction, 'CONTINUE_PROSPECTIVE_HUMAN_REVIEW');
});

test('audit source preserves read-only and non-authoritative boundaries', () => {
  const source = readFileSync(new URL('./stage1ProspectiveCohortReadiness.ts', import.meta.url), 'utf8');
  assert.match(source, /BEGIN TRANSACTION READ ONLY/);
  assert.match(source, /servingAuthority: false/);
  assert.match(source, /automaticPromotion: false/);
});
