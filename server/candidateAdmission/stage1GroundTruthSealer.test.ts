import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stage1GroundTruthEligibility, summarizeStage1GroundTruthCandidates } from './stage1GroundTruthSealer';

const row = (overrides: Record<string, unknown> = {}) => ({
  channel_id: 'channel-1',
  label_id: 'label-1',
  label: 'NON_TRADING' as const,
  provenance: 'HUMAN_REVIEW',
  labeled_at: '2026-08-01T00:00:00.000Z',
  diagnostic_id: 'diagnostic-1',
  diagnostic_created_at: '2026-07-31T00:00:00.000Z',
  decision: { status: 'UNCERTAIN', confidenceScore: 50 },
  normalized_input: {},
  assignment_id: 'assignment-1',
  inclusion_basis_points: 1000,
  stratum: {},
  focus_snapshot_id: 'focus-1',
  coverage_snapshot_id: 'coverage-1',
  ...overrides
});

test('eligible Stage 1 labels require diagnostic, sampled assignment, focus, and coverage lineage', () => {
  assert.equal(stage1GroundTruthEligibility(row()).eligible, true);
  assert.equal(stage1GroundTruthEligibility(row({ diagnostic_id: null })).reason, 'DIAGNOSTIC_MISSING');
  assert.equal(stage1GroundTruthEligibility(row({ assignment_id: null })).reason, 'RETRIEVAL_ASSIGNMENT_MISSING');
  assert.equal(stage1GroundTruthEligibility(row({ inclusion_basis_points: 0 })).reason, 'RETRIEVAL_ASSIGNMENT_MISSING');
  assert.equal(stage1GroundTruthEligibility(row({ focus_snapshot_id: null })).reason, 'CREATOR_FOCUS_SNAPSHOT_MISSING');
  assert.equal(stage1GroundTruthEligibility(row({ coverage_snapshot_id: null })).reason, 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING');
});

test('seal readiness requires the governed minimum in both ground-truth classes', () => {
  const trading = Array.from({ length: 30 }, (_, i) => row({ channel_id: `t-${i}`, label_id: `tl-${i}`, label: 'TRADING_CONFIRMED' as const }));
  const nonTrading = Array.from({ length: 30 }, (_, i) => row({ channel_id: `n-${i}`, label_id: `nl-${i}` }));
  const ready = summarizeStage1GroundTruthCandidates([...trading, ...nonTrading], 30);
  assert.equal(ready.ready, true);
  assert.equal(ready.tradingConfirmed, 30);
  assert.equal(ready.nonTrading, 30);

  const insufficient = summarizeStage1GroundTruthCandidates([...trading, ...nonTrading.slice(0, 29)], 30);
  assert.equal(insufficient.ready, false);
  assert.ok(insufficient.reasonCodes.includes('NON_TRADING_EFFECTIVE_SAMPLE_SIZE_INSUFFICIENT'));
});

test('missing lineage is excluded rather than relabeled or fabricated', () => {
  const summary = summarizeStage1GroundTruthCandidates([
    row({ diagnostic_id: null }),
    row({ channel_id: 'channel-2', assignment_id: null }),
    row({ channel_id: 'channel-3', focus_snapshot_id: null }),
    row({ channel_id: 'channel-4', coverage_snapshot_id: null })
  ], 1);
  assert.equal(summary.eligible, 0);
  assert.deepEqual(summary.exclusions, {
    DIAGNOSTIC_MISSING: 1,
    RETRIEVAL_ASSIGNMENT_MISSING: 1,
    CREATOR_FOCUS_SNAPSHOT_MISSING: 1,
    EVIDENCE_COVERAGE_SNAPSHOT_MISSING: 1
  });
});

test('sealer only accepts independent human/adjudication labels and performs insert-only sealing writes', () => {
  const source = readFileSync(new URL('./stage1GroundTruthSealer.ts', import.meta.url), 'utf8');
  assert.match(source, /provenance IN \('HUMAN_REVIEW','ADJUDICATION'\)/);
  assert.doesNotMatch(source, /DELAYED_PRODUCTION/);
  assert.match(source, /SEAL_STAGE1_EVALUATION_DATASET/);
  assert.match(source, /INSERT INTO decision_evaluation_datasets/);
  assert.match(source, /INSERT INTO decision_evaluation_examples/);
  assert.doesNotMatch(source, /\b(?:UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
});
