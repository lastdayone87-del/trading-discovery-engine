import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stage1ProspectiveAdjudicationReadiness } from './stage1ProspectiveAdjudication';

const ready = (overrides: Record<string, unknown> = {}) => ({
  channel_id: 'channel-1',
  channel_name: 'Trading Creator',
  youtube_url: 'https://youtube.com/channel/channel-1',
  country: 'United States',
  trading_status: 'TRADING_CONFIRMED',
  scan_status: 'COMPLETED',
  assignment_id: 'assignment-1',
  assigned_at: '2026-08-11T01:00:00Z',
  inclusion_basis_points: 10000,
  diagnostic_id: 'diagnostic-1',
  diagnostic_at: '2026-08-11T01:01:00Z',
  focus_snapshot_id: 'focus-1',
  coverage_snapshot_id: 'coverage-1',
  existing_label_id: null,
  existing_label: null,
  existing_provenance: null,
  ...overrides
});

test('adjudication readiness requires complete prospective lineage but not PENDING operational review state', () => {
  assert.equal(stage1ProspectiveAdjudicationReadiness(ready()), 'READY_FOR_INDEPENDENT_ADJUDICATION');
  assert.equal(stage1ProspectiveAdjudicationReadiness(ready({ assignment_id: null })), 'PROSPECTIVE_ASSIGNMENT_MISSING');
  assert.equal(stage1ProspectiveAdjudicationReadiness(ready({ diagnostic_id: null })), 'DIAGNOSTIC_MISSING_AFTER_ASSIGNMENT');
  assert.equal(stage1ProspectiveAdjudicationReadiness(ready({ focus_snapshot_id: null })), 'CREATOR_FOCUS_SNAPSHOT_MISSING');
  assert.equal(stage1ProspectiveAdjudicationReadiness(ready({ coverage_snapshot_id: null })), 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING');
  assert.equal(stage1ProspectiveAdjudicationReadiness(ready({ existing_label_id: 'label-1' })), 'INDEPENDENT_LABEL_ALREADY_EXISTS');
});

test('independent adjudication writes only evaluation ground truth and never calls operational review mutation', () => {
  const source = readFileSync(new URL('./stage1ProspectiveAdjudication.ts', import.meta.url), 'utf8');
  assert.match(source, /provenance: 'ADJUDICATION'/);
  assert.match(source, /recordEvaluationGroundTruth/);
  assert.match(source, /operationalStateMutation: false/);
  assert.match(source, /COMMIT_STAGE1_PROSPECTIVE_ADJUDICATION/);
  assert.doesNotMatch(source, /decideReview\(/);
  assert.doesNotMatch(source, /UPDATE channels/i);
  assert.doesNotMatch(source, /UPDATE channel_reviews/i);
});

test('candidate lookup requires a diagnostic created after the Stage 1 prospective assignment', () => {
  const source = readFileSync(new URL('./stage1ProspectiveAdjudication.ts', import.meta.url), 'utf8');
  assert.match(source, /x\.created_at>=a\.assigned_at/);
  assert.match(source, /creator_focus_classification_snapshots/);
  assert.match(source, /evidence_coverage_snapshots/);
  assert.match(source, /x\.provenance IN \('HUMAN_REVIEW','ADJUDICATION'\)/);
});
