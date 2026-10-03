import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryRecord } from '../src/types';
import {
  normalizeSelectionExperimentRequest,
  validateSelectionExperimentRequest,
  evaluateSelectionExperimentEligibility,
  assignSelectionExperimentArm,
  buildThompsonObservationArms,
  buildContextualFeatureArms,
  selectPoolWinner,
  buildSelectionExperimentObservation,
  resolvePersistedSelectionArm,
  QUERY_SELECTION_EXPERIMENT_VERSION,
} from './querySelectionExperiments';

function poolFixture(): QueryRecord[] {
  const rows = [
    { id: 3, quality_channels_found: 2, times_executed: 10, performance_score: 60, total_channels_found: 20, unique_channels_found: 12 },
    { id: 1, quality_channels_found: 0, times_executed: 0, performance_score: 0, total_channels_found: 0, unique_channels_found: 0 },
    { id: 2, quality_channels_found: 5, times_executed: 5, performance_score: 90, total_channels_found: 8, unique_channels_found: 8 },
  ];
  return rows as QueryRecord[];
}

test('absent experiment normalizes to all-null (legacy path)', () => {
  assert.deepEqual(normalizeSelectionExperimentRequest(undefined), { selection: null, ordering: null, trial: null });
  assert.deepEqual(normalizeSelectionExperimentRequest(null), { selection: null, ordering: null, trial: null });
  assert.equal(validateSelectionExperimentRequest(undefined), null);
  assert.equal(validateSelectionExperimentRequest(null), null);
});

test('invalid experiment requests are rejected, never defaulted on', () => {
  assert.throws(() => validateSelectionExperimentRequest({}), /INVALID_EXPERIMENT_REQUEST/);
  assert.throws(() => validateSelectionExperimentRequest([]), /INVALID_EXPERIMENT_REQUEST/);
  assert.throws(
    () => validateSelectionExperimentRequest({ selection: { experimentId: '', enabledArms: ['THOMPSON'], treatmentBasisPoints: 100 } }),
    /INVALID_SELECTION_EXPERIMENT/
  );
  assert.throws(
    () => validateSelectionExperimentRequest({ selection: { experimentId: 'x', enabledArms: ['BOGUS'], treatmentBasisPoints: 100 } }),
    /INVALID_SELECTION_EXPERIMENT/
  );
  assert.throws(
    () => validateSelectionExperimentRequest({ selection: { experimentId: 'x', enabledArms: ['THOMPSON'], treatmentBasisPoints: 10001 } }),
    /INVALID_SELECTION_EXPERIMENT/
  );
  assert.throws(
    () => validateSelectionExperimentRequest({ trial: { proposalId: '', maxQuota: 50 } }),
    /INVALID_TRIAL_REQUEST/
  );
  assert.throws(
    () => validateSelectionExperimentRequest({ ordering: { treatmentBasisPoints: -1 } }),
    /INVALID_ORDERING_EXPERIMENT/
  );
});

test('valid experiment normalizes with documented defaults', () => {
  const normalized = validateSelectionExperimentRequest({
    selection: { experimentId: 'exp-1', enabledArms: ['THOMPSON', 'CONTEXTUAL'], treatmentBasisPoints: 2500 },
    trial: { proposalId: 'prop-1' },
  })!;
  assert.equal(normalized.selection?.experimentId, 'exp-1');
  assert.deepEqual(normalized.selection?.enabledArms, ['THOMPSON', 'CONTEXTUAL']);
  assert.deepEqual(normalized.selection?.thompsonPrior, { alpha0: 1, beta0: 1 });
  assert.deepEqual(normalized.selection?.contextualWeights, { value: 0.5, exploration: 0.35, cost: 0.1 });
  assert.deepEqual(normalized.trial, { proposalId: 'prop-1', maxQuota: 100, pageDepth: 1 });
  assert.equal(normalized.ordering, null);
});

test('eligibility reports exact reason codes', () => {
  assert.deepEqual(evaluateSelectionExperimentEligibility(null), { eligible: false, reason: 'SELECTION_EXPERIMENT_NOT_REQUESTED' });
  const normalized = validateSelectionExperimentRequest({
    selection: { experimentId: 'exp-1', enabledArms: ['THOMPSON'], treatmentBasisPoints: 0 },
  })!;
  assert.deepEqual(evaluateSelectionExperimentEligibility(normalized.selection), { eligible: true, reason: 'SELECTION_EXPERIMENT_ELIGIBLE' });
});

test('assignment is disabled by default and deterministic', () => {
  const base = { experimentId: 'exp-1', enabledArms: ['THOMPSON'] as Array<'THOMPSON' | 'CONTEXTUAL'>, opportunityKey: 'opp-1' };
  const off = assignSelectionExperimentArm({ ...base, treatmentBasisPoints: 0 });
  assert.equal(off.arm, 'CONTROL');
  assert.equal(off.propensityBasisPoints, 10000);
  assert.equal(off.policyVersion, QUERY_SELECTION_EXPERIMENT_VERSION);
  const again = assignSelectionExperimentArm({ ...base, treatmentBasisPoints: 0 });
  assert.deepEqual(again, off);
  assert.throws(() => assignSelectionExperimentArm({ ...base, treatmentBasisPoints: 100, opportunityKey: '  ' }), /OPPORTUNITY_KEY_REQUIRED/);
});

test('assignment propensity accounting is truthful', () => {
  const full = assignSelectionExperimentArm({
    experimentId: 'exp-1',
    enabledArms: ['THOMPSON', 'CONTEXTUAL'],
    treatmentBasisPoints: 3000,
    opportunityKey: 'opp-prop',
  });
  if (full.arm === 'CONTROL') {
    assert.equal(full.propensityBasisPoints, 7000);
  } else {
    assert.equal(full.propensityBasisPoints, 1500);
    assert.ok(['THOMPSON', 'CONTEXTUAL'].includes(full.arm));
  }
  assert.ok(full.bucket >= 0 && full.bucket < 10000);
});

test('Thompson observation mapping is documented and deterministic', () => {
  const arms = buildThompsonObservationArms(poolFixture());
  assert.deepEqual(arms, [
    { successes: 2, failures: 8 },
    { successes: 0, failures: 0 },
    { successes: 5, failures: 0 },
  ]);
  const winner = selectPoolWinner({
    pool: poolFixture(),
    arm: 'THOMPSON',
    opportunityKey: 'opp-t',
    thompsonPrior: { alpha0: 1, beta0: 1 },
    contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
  });
  const winnerAgain = selectPoolWinner({
    pool: poolFixture(),
    arm: 'THOMPSON',
    opportunityKey: 'opp-t',
    thompsonPrior: { alpha0: 1, beta0: 1 },
    contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
  });
  assert.deepEqual(winner, winnerAgain);
  assert.equal(winner.thompsonScores?.length, 3);
  assert.ok(winner.index >= 0 && winner.index < 3);
});

test('contextual selection is deterministic over documented features', () => {
  const features = buildContextualFeatureArms(poolFixture());
  assert.deepEqual(features[1], { expectedValue: 0, uncertainty: 1, coverageGap: 1, cost: 1 });
  const first = selectPoolWinner({
    pool: poolFixture(),
    arm: 'CONTEXTUAL',
    opportunityKey: 'opp-c',
    thompsonPrior: { alpha0: 1, beta0: 1 },
    contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
  });
  const second = selectPoolWinner({
    pool: poolFixture(),
    arm: 'CONTEXTUAL',
    opportunityKey: 'opp-c',
    thompsonPrior: { alpha0: 1, beta0: 1 },
    contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
  });
  assert.deepEqual(first, second);
  assert.equal(first.contextualScores?.length, 3);
  assert.throws(() => selectPoolWinner({
    pool: [],
    arm: 'THOMPSON',
    opportunityKey: 'opp-c',
    thompsonPrior: { alpha0: 1, beta0: 1 },
    contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
  }), /NO_ARMS/);
});

test('observation envelope carries allocation probability and provenance', () => {
  const assignment = assignSelectionExperimentArm({
    experimentId: 'exp-1',
    enabledArms: ['THOMPSON'],
    treatmentBasisPoints: 2500,
    opportunityKey: 'opp-env',
  });
  const envelope = buildSelectionExperimentObservation({
    experimentId: 'exp-1',
    assignment,
    eligibility: 'SELECTION_EXPERIMENT_ELIGIBLE',
    reason: 'test',
    opportunityKey: 'opp-env',
    poolQueryIds: [1, 2, 3],
    winner: { index: 0, queryId: 1 },
    thompsonPrior: { alpha0: 1, beta0: 1 },
    contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
    servedArm: assignment.arm,
  });
  assert.equal(envelope.experimentVersion, QUERY_SELECTION_EXPERIMENT_VERSION);
  assert.equal(envelope.allocationProbability, assignment.propensityBasisPoints / 10000);
  assert.equal(envelope.determinism.poolSize, 3);
  assert.equal(envelope.provenance.producer, 'query-selection-experiment');
  assert.doesNotThrow(() => JSON.stringify(envelope));
});

test('persisted arm resolution never invents treatment', () => {
  assert.equal(resolvePersistedSelectionArm({ selectionExperiment: { servedArm: 'THOMPSON' } }), 'THOMPSON');
  assert.equal(resolvePersistedSelectionArm({ selectionExperiment: { servedArm: 'CONTEXTUAL' } }), 'CONTEXTUAL');
  assert.equal(resolvePersistedSelectionArm({ selectionExperiment: { servedArm: 'CONTROL' } }), 'CONTROL');
  assert.equal(resolvePersistedSelectionArm({}), 'CONTROL');
  assert.equal(resolvePersistedSelectionArm(null), 'CONTROL');
  assert.equal(resolvePersistedSelectionArm({ selectionExperiment: { servedArm: 'BOGUS' } }), 'CONTROL');
  assert.equal(resolvePersistedSelectionArm({ selectionExperiment: { servedArm: 'FRONTIER_CANARY' } }), 'CONTROL');
});
