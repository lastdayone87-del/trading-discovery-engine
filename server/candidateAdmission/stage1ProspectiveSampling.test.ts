import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assignEvaluationCohort } from '../decisionEvaluation';
import {
  buildStage1ProspectiveRetrievalAssignment,
  stage1ProspectiveNominationEligible,
  STAGE1_PROSPECTIVE_SAMPLING_POLICY
} from './stage1ProspectiveSampling';
import { requiresStage1AssignmentBeforeClassification } from './store';
import type { NominationInput } from './types';

const nomination: NominationInput = {
  channelId: 'UC-stage1-prospective',
  sourceType: 'automated_search',
  queryId: 17,
  queryRunId: 'run-17',
  jobId: 'job-17',
  query: 'day trading education',
  country: 'United States',
  declaredLanguage: 'en',
  retrievalLane: 'VIDEO',
  searchOrdering: 'RELEVANCE',
  pageNumber: 1,
  resultRank: 4,
  matchedDocument: { type: 'VIDEO', providerNativeId: 'video-17' },
  rawObservation: { channelName: 'Prospective Creator' }
};

test('Stage 1 prospective capture is a full retrieval-bound census', () => {
  assert.equal(STAGE1_PROSPECTIVE_SAMPLING_POLICY.policyKey, 'stage1-prospective-census');
  assert.equal(STAGE1_PROSPECTIVE_SAMPLING_POLICY.protectedAuditBasisPoints, 10000);
  assert.equal(STAGE1_PROSPECTIVE_SAMPLING_POLICY.targetedAuditBasisPoints, 0);
  const stratum = {
    country: 'United States', language: 'en', script: 'UNKNOWN',
    evidenceBand: 'PRE_CLASSIFICATION', providerState: 'NOT_OBSERVED', discoveryOrigin: 'automated_search'
  };
  const assignment = assignEvaluationCohort('subject', stratum, STAGE1_PROSPECTIVE_SAMPLING_POLICY);
  assert.equal(assignment.cohort, 'PROTECTED_AUDIT');
  assert.equal(assignment.inclusionBasisPoints, 10000);
});

test('prospective assignment preserves nomination time and retrieval context', () => {
  const observedAt = '2026-08-11T01:00:00.000Z';
  const payload = buildStage1ProspectiveRetrievalAssignment(nomination, observedAt);
  assert.equal(payload.input.channelId, nomination.channelId);
  assert.equal(payload.input.observedAt, observedAt);
  assert.equal(payload.input.discoveryOrigin, nomination.sourceType);
  assert.equal(payload.input.context && (payload.input.context as any).queryRunId, nomination.queryRunId);
  assert.equal(payload.input.context && (payload.input.context as any).resultRank, nomination.resultRank);
});

test('prospective assignment excludes channels ingestion will short-circuit before classification', () => {
  assert.equal(stage1ProspectiveNominationEligible(null), true);
  assert.equal(stage1ProspectiveNominationEligible({ trading_status: 'UNCERTAIN', scan_status: 'PENDING' }), true);
  assert.equal(stage1ProspectiveNominationEligible({ trading_status: 'TRADING_CONFIRMED', scan_status: 'COMPLETED' }), false);
  assert.equal(stage1ProspectiveNominationEligible({ trading_status: 'NON_TRADING', scan_status: 'SKIPPED_NON_TRADING' }), false);
  assert.equal(stage1ProspectiveNominationEligible({ trading_status: 'HUMAN_REJECTED' }), false);
  assert.equal(stage1ProspectiveNominationEligible({ country_status: 'REJECTED' }), false);
  assert.equal(stage1ProspectiveNominationEligible({ scan_status: 'COMPLETED' }), false);
});

test('normal production discovery sources require the Stage 1 assignment before classification', () => {
  assert.equal(requiresStage1AssignmentBeforeClassification('manual_search'), true);
  assert.equal(requiresStage1AssignmentBeforeClassification('automated_query'), true);
  assert.equal(requiresStage1AssignmentBeforeClassification('automated_search'), true);
  assert.equal(requiresStage1AssignmentBeforeClassification('external_provider'), false);
  assert.equal(requiresStage1AssignmentBeforeClassification('recheck'), false);
});

test('recordNomination guards Stage 1 capture with current channel state and fails closed for production search ordering', () => {
  const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
  assert.match(source, /SELECT country_status,trading_status,scan_status FROM channels/);
  assert.match(source, /stage1ProspectiveNominationEligible\(existingChannel\.rows\[0\]\)/);
  assert.match(source, /observeRetrievalAssignmentReliably\(buildStage1ProspectiveRetrievalAssignment/);
  assert.match(source, /if\(requiresStage1AssignmentBeforeClassification\(input\.sourceType\)\)await assignmentCapture\(\)/);
  assert.match(source, /else await assignmentCapture\(\)\.catch/);
});
