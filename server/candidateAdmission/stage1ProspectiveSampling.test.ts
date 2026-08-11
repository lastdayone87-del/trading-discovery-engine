import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assignEvaluationCohort } from '../decisionEvaluation';
import { buildStage1ProspectiveRetrievalAssignment, STAGE1_PROSPECTIVE_SAMPLING_POLICY } from './stage1ProspectiveSampling';
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

test('recordNomination captures Stage 1 assignment before any ledger-off return', () => {
  const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
  const capture = source.indexOf('observeRetrievalAssignmentReliably(buildStage1ProspectiveRetrievalAssignment');
  const ledgerCheck = source.indexOf("getAppSetting('nomination_ledger_enabled'");
  const earlyReturn = source.indexOf('if(!ledgerEnabled)return');
  assert.ok(capture >= 0, 'prospective retrieval capture must be wired');
  assert.ok(capture < ledgerCheck, 'capture must occur before nomination-ledger serving flag lookup');
  assert.ok(capture < earlyReturn, 'capture must occur before the ledger-off early return');
});
