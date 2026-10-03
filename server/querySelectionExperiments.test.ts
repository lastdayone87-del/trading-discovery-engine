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
  assert.deepEqual(normalizeSelectionExperimentRequest(undefined), { selection: null, ordering: null, trial: null, benchmark: null });
  assert.deepEqual(normalizeSelectionExperimentRequest(null), { selection: null, ordering: null, trial: null, benchmark: null });
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

test('ordering dimension requires identity and validates the window contract', () => {
  assert.throws(
    () => validateSelectionExperimentRequest({ ordering: { treatmentBasisPoints: 1000 } }),
    /INVALID_ORDERING_EXPERIMENT/
  );
  assert.throws(
    () => validateSelectionExperimentRequest({
      ordering: { treatmentBasisPoints: 1000, experimentId: 'ord-1', window: { publishedAfter: '2026-01-01' } },
    }),
    /INVALID_ORDERING_EXPERIMENT/
  );
  assert.throws(
    () => validateSelectionExperimentRequest({
      ordering: {
        treatmentBasisPoints: 1000,
        experimentId: 'ord-1',
        window: { publishedAfter: '2026-02-01T00:00:00Z', publishedBefore: '2026-01-01T00:00:00Z' },
      },
    }),
    /INVALID_ORDERING_EXPERIMENT/
  );
  const inherited = validateSelectionExperimentRequest({
    selection: { experimentId: 'exp-1', enabledArms: ['THOMPSON'], treatmentBasisPoints: 0 },
    ordering: { treatmentBasisPoints: 1000, window: { publishedAfter: '2026-01-01T00:00:00Z' } },
  })!;
  assert.equal(inherited.ordering?.experimentId, 'exp-1');
  const standalone = validateSelectionExperimentRequest({
    ordering: { treatmentBasisPoints: 1000, experimentId: 'ord-9', window: { publishedAfter: '2026-01-01T00:00:00Z' } },
  })!;
  assert.equal(standalone.selection, null);
  assert.equal(standalone.ordering?.experimentId, 'ord-9');
});

test('ordering CONTROL never carries a treatment window', async () => {
  const { evaluateOrderingDimension, resolveScheduledSearchWindow } = await import('./querySelectionExperiments');
  const control = evaluateOrderingDimension({
    treatmentBasisPoints: 0,
    window: { publishedAfter: '2026-01-01T00:00:00Z' },
    experimentId: 'exp-1',
    opportunityKey: 'opp-oc',
  });
  assert.equal(control.arm, 'CONTROL');
  assert.equal(control.windowApplied, false);
  assert.equal(control.window, null);
  assert.equal(control.experimentId, null);
  assert.equal(resolveScheduledSearchWindow(control), undefined);
  assert.equal(resolveScheduledSearchWindow(undefined), undefined);
  assert.equal(resolveScheduledSearchWindow(null), undefined);
});

test('ordering TREATMENT applies the validated window with matching propensity', async () => {
  const { evaluateOrderingDimension, resolveScheduledSearchWindow } = await import('./querySelectionExperiments');
  const window = { publishedAfter: '2026-01-01T00:00:00Z', publishedBefore: '2026-02-01T00:00:00Z' };
  const treated = evaluateOrderingDimension({
    treatmentBasisPoints: 10000,
    window,
    experimentId: 'exp-1',
    opportunityKey: 'opp-ot',
  });
  assert.equal(treated.arm, 'TREATMENT');
  assert.equal(treated.windowApplied, true);
  assert.deepEqual(treated.window, window);
  assert.equal(treated.experimentId, 'exp-1');
  assert.deepEqual(resolveScheduledSearchWindow(treated), { ...window, experimentId: 'exp-1' });
  const noWindow = evaluateOrderingDimension({
    treatmentBasisPoints: 10000,
    window: null,
    experimentId: 'exp-1',
    opportunityKey: 'opp-ot',
  });
  assert.equal(noWindow.arm, 'TREATMENT');
  assert.equal(noWindow.windowApplied, false);
  assert.equal(resolveScheduledSearchWindow(noWindow), undefined);
});

test('explicit ordering experimentId wins over the selection identity', async () => {
  const { normalizeSelectionExperimentRequest, evaluateOrderingDimension, resolveScheduledSearchWindow } = await import('./querySelectionExperiments');
  const normalized = normalizeSelectionExperimentRequest({
    selection: { experimentId: 'selection-exp', enabledArms: ['THOMPSON'], treatmentBasisPoints: 0 },
    ordering: {
      experimentId: 'ordering-exp',
      treatmentBasisPoints: 10000,
      window: { publishedAfter: '2026-01-01T00:00:00Z' },
    },
  });
  assert.equal(normalized.selection?.experimentId, 'selection-exp');
  assert.equal(normalized.ordering?.experimentId, 'ordering-exp');
  const evaluated = evaluateOrderingDimension({
    treatmentBasisPoints: normalized.ordering!.treatmentBasisPoints,
    window: normalized.ordering!.window,
    experimentId: normalized.ordering!.experimentId,
    opportunityKey: 'opp-ids',
  });
  assert.equal(evaluated.arm, 'TREATMENT');
  assert.equal(evaluated.experimentId, 'ordering-exp');
  const payload = resolveScheduledSearchWindow({
    arm: evaluated.arm,
    propensityBasisPoints: evaluated.propensityBasisPoints,
    policyVersion: evaluated.policyVersion,
    windowApplied: evaluated.windowApplied,
    window: evaluated.window,
    experimentId: evaluated.experimentId,
  });
  assert.deepEqual(payload, { publishedAfter: '2026-01-01T00:00:00Z', experimentId: 'ordering-exp' });
});

test('ordering without any identity falls back to selection, then fails closed', () => {
  // Window present but no identity anywhere: rejected, never unattributed.
  assert.throws(
    () =>
      validateSelectionExperimentRequest({
        ordering: { treatmentBasisPoints: 1000, window: { publishedAfter: '2026-01-01T00:00:00Z' } },
      }),
    /INVALID_ORDERING_EXPERIMENT/
  );
  // Bare ordering knobs without identity are not an experiment either.
  assert.throws(
    () => validateSelectionExperimentRequest({ ordering: { treatmentBasisPoints: 5000 } }),
    /INVALID_ORDERING_EXPERIMENT/
  );
});

test('frozen benchmark ordering derives the 90-day window from scheduled_at', async () => {
  const {
    evaluateOrderingDimension,
    deriveBenchmarkOrderingWindow,
    resolveScheduledSearchWindow,
    resolveFrozenBenchmarkScheduleOrdering,
    benchmarkOpportunityIdForScope,
    BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID,
    BENCHMARK_PREREG_ORDERING_WINDOW_DAYS,
  } = await import('./querySelectionExperiments');
  const { buildWindowedSearchParams } = await import('./retrievalExperiment');
  assert.equal(BENCHMARK_PREREG_ORDERING_WINDOW_DAYS, 90);
  const scheduledAt = new Date('2026-03-10T12:00:00.000Z');
  const derived = deriveBenchmarkOrderingWindow(scheduledAt);
  assert.equal(derived.publishedBefore, '2026-03-10T12:00:00.000Z');
  assert.equal(derived.publishedAfter, '2025-12-10T12:00:00.000Z');
  assert.equal(buildWindowedSearchParams({}, derived, BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID).windowApplied, true);
  // A divergent caller-supplied window never reaches the frozen envelope.
  const treated = evaluateOrderingDimension({
    treatmentBasisPoints: 10000,
    window: { publishedAfter: '2020-01-01T00:00:00Z', publishedBefore: '2020-02-01T00:00:00Z' },
    experimentId: BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID,
    opportunityKey: 'opp-frozen-divergent',
    scheduledAt,
  });
  assert.equal(treated.arm, 'TREATMENT');
  assert.equal(treated.windowApplied, true);
  assert.deepEqual(treated.window, derived);
  assert.equal(treated.experimentId, BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID);
  assert.deepEqual(resolveScheduledSearchWindow(treated), { ...derived, experimentId: BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID });
  // A missing caller window still derives (no unwindowed treatment).
  const missing = evaluateOrderingDimension({
    treatmentBasisPoints: 10000,
    window: null,
    experimentId: BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID,
    opportunityKey: 'opp-frozen-missing',
    scheduledAt,
  });
  assert.equal(missing.arm, 'TREATMENT');
  assert.equal(missing.windowApplied, true);
  assert.deepEqual(missing.window, derived);
  // Frozen CONTROL carries no window, as before.
  const control = evaluateOrderingDimension({
    treatmentBasisPoints: 0,
    window: { publishedAfter: '2020-01-01T00:00:00Z' },
    experimentId: BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID,
    opportunityKey: 'opp-frozen-control',
    scheduledAt,
  });
  assert.equal(control.arm, 'CONTROL');
  assert.equal(control.windowApplied, false);
  // Stable benchmark opportunity identity is scoped to designated frozen
  // pool rows under the frozen configuration, never the served query alone.
  const frozenExperiment = normalizeSelectionExperimentRequest({
    selection: { experimentId: 'benchmark-prereg-v1-selection', enabledArms: ['THOMPSON', 'CONTEXTUAL'], treatmentBasisPoints: 5000 },
    ordering: { experimentId: 'benchmark-prereg-v1-ordering', treatmentBasisPoints: 5000 },
    benchmark: { snapshotHash: 'abc123', poolRowId: 42 },
  });
  assert.equal(
    benchmarkOpportunityIdForScope(frozenExperiment.benchmark, 42, frozenExperiment),
    'benchmark-prereg-v1:pool:abc123:42'
  );
  // A fallback winner or generated query never acquires the frozen identity.
  assert.equal(benchmarkOpportunityIdForScope(frozenExperiment.benchmark, 7, frozenExperiment), undefined);
  assert.equal(benchmarkOpportunityIdForScope(null, 42, frozenExperiment), undefined);
  assert.equal(benchmarkOpportunityIdForScope(undefined, 42, frozenExperiment), undefined);
});

test('benchmark opportunity identity requires the full frozen configuration', async () => {
  const { benchmarkOpportunityIdForScope, isFrozenBenchmarkConfiguration, normalizeSelectionExperimentRequest } = await import('./querySelectionExperiments');
  const frozenRequest = {
    selection: { experimentId: 'benchmark-prereg-v1-selection', enabledArms: ['THOMPSON', 'CONTEXTUAL'], treatmentBasisPoints: 5000 },
    ordering: { experimentId: 'benchmark-prereg-v1-ordering', treatmentBasisPoints: 5000 },
    benchmark: { snapshotHash: 'abc123', poolRowId: 42 },
  };
  const frozen = normalizeSelectionExperimentRequest(frozenRequest);
  // 1. Valid frozen configuration + matching designated pool row → attached.
  assert.equal(isFrozenBenchmarkConfiguration(frozen), true);
  assert.equal(benchmarkOpportunityIdForScope(frozen.benchmark, 42, frozen), 'benchmark-prereg-v1:pool:abc123:42');
  const variant = (patch: Record<string, unknown>) => normalizeSelectionExperimentRequest({
    selection: { ...(frozenRequest.selection as object), ...(patch.selection as object | undefined) },
    ordering: { ...(frozenRequest.ordering as object), ...(patch.ordering as object | undefined) },
    benchmark: frozenRequest.benchmark,
  });
  // 2. Same valid scope + unrelated experimentId → absent (never mislabeled).
  const unrelated = variant({ selection: { experimentId: 'other-exp' } });
  assert.equal(isFrozenBenchmarkConfiguration(unrelated), false);
  assert.equal(benchmarkOpportunityIdForScope(unrelated.benchmark, 42, unrelated), undefined);
  // 3. Same valid scope + altered treatmentBasisPoints → absent.
  const alteredBasis = variant({ selection: { treatmentBasisPoints: 2500 } });
  assert.equal(isFrozenBenchmarkConfiguration(alteredBasis), false);
  assert.equal(benchmarkOpportunityIdForScope(alteredBasis.benchmark, 42, alteredBasis), undefined);
  const alteredOrderingBasis = variant({ ordering: { treatmentBasisPoints: 1000 } });
  assert.equal(isFrozenBenchmarkConfiguration({ ...alteredOrderingBasis, selection: null }), false);
  // 4. Same valid scope + altered enabled arms → absent.
  const alteredArms = variant({ selection: { enabledArms: ['THOMPSON'] } });
  assert.equal(isFrozenBenchmarkConfiguration(alteredArms), false);
  assert.equal(benchmarkOpportunityIdForScope(alteredArms.benchmark, 42, alteredArms), undefined);
  const reorderedArms = variant({ selection: { enabledArms: ['CONTEXTUAL', 'THOMPSON'] } });
  assert.equal(isFrozenBenchmarkConfiguration(reorderedArms), false);
  assert.equal(benchmarkOpportunityIdForScope(reorderedArms.benchmark, 42, reorderedArms), undefined);
  // 5. Same valid scope + altered frozen priors/weights → absent.
  const alteredPrior = variant({ selection: { thompsonPrior: { alpha0: 2, beta0: 1 } } });
  assert.equal(isFrozenBenchmarkConfiguration(alteredPrior), false);
  assert.equal(benchmarkOpportunityIdForScope(alteredPrior.benchmark, 42, alteredPrior), undefined);
  const alteredWeights = variant({ selection: { contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.2 } } });
  assert.equal(isFrozenBenchmarkConfiguration(alteredWeights), false);
  assert.equal(benchmarkOpportunityIdForScope(alteredWeights.benchmark, 42, alteredWeights), undefined);
  // 6. Generated/fallback query still cannot acquire the frozen ID.
  assert.equal(benchmarkOpportunityIdForScope(frozen.benchmark, 999, frozen), undefined);
  // Ordering-only frozen configuration also qualifies on its own.
  const orderingOnly = normalizeSelectionExperimentRequest({
    ordering: { experimentId: 'benchmark-prereg-v1-ordering', treatmentBasisPoints: 5000 },
    benchmark: { snapshotHash: 'abc123', poolRowId: 42 },
  });
  assert.equal(isFrozenBenchmarkConfiguration(orderingOnly), true);
  assert.equal(benchmarkOpportunityIdForScope(orderingOnly.benchmark, 42, orderingOnly), 'benchmark-prereg-v1:pool:abc123:42');
  // 7. CONTROL and treatment share the same frozen opportunity identity: the
  // gate depends on configuration only, never the assigned arm.
  assert.equal(benchmarkOpportunityIdForScope(frozen.benchmark, 42, frozen), benchmarkOpportunityIdForScope(frozen.benchmark, 42, frozen));
  assert.equal(isFrozenBenchmarkConfiguration(null), false);
  assert.equal(isFrozenBenchmarkConfiguration(undefined), false);
});

test('observation envelope carries the stable benchmark opportunity only for frozen experiments', async () => {
  const { buildSelectionExperimentObservation, assignSelectionExperimentArm } = await import('./querySelectionExperiments');
  const base = {
    experimentId: 'exp-plain',
    assignment: assignSelectionExperimentArm({ experimentId: 'exp-plain', enabledArms: [], treatmentBasisPoints: 0, opportunityKey: 'opp-plain' }),
    eligibility: 'SELECTION_EXPERIMENT_NOT_REQUESTED' as const,
    reason: 'plain',
    opportunityKey: 'opp-plain',
    poolQueryIds: [],
    winner: null,
    thompsonPrior: { alpha0: 1, beta0: 1 },
    contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
    servedArm: 'CONTROL' as const,
  };
  const legacy = buildSelectionExperimentObservation(base);
  assert.equal('benchmarkOpportunityId' in legacy, false);
  const benchmark = buildSelectionExperimentObservation({ ...base, benchmarkOpportunityId: 'benchmark-prereg-v1:q42' });
  assert.equal(benchmark.benchmarkOpportunityId, 'benchmark-prereg-v1:q42');
});

test('benchmark pool scope normalizes, validates, and gates opportunity identity', () => {
  // Absent scope normalizes to null without affecting dimensions.
  assert.equal(normalizeSelectionExperimentRequest({ selection: { experimentId: 's', enabledArms: ['THOMPSON'], treatmentBasisPoints: 0 } }).benchmark, null);
  // Designated frozen pool row normalizes exactly.
  const scoped = normalizeSelectionExperimentRequest({
    selection: { experimentId: 'benchmark-prereg-v1-selection', enabledArms: ['THOMPSON', 'CONTEXTUAL'], treatmentBasisPoints: 5000 },
    ordering: { experimentId: 'benchmark-prereg-v1-ordering', treatmentBasisPoints: 5000 },
    benchmark: { snapshotHash: 'abc123', poolRowId: 42 },
  });
  assert.deepEqual(scoped.benchmark, { snapshotHash: 'abc123', poolRowId: 42 });
  assert.notEqual(validateSelectionExperimentRequest({
    selection: { experimentId: 'benchmark-prereg-v1-selection', enabledArms: ['THOMPSON', 'CONTEXTUAL'], treatmentBasisPoints: 5000 },
    ordering: { experimentId: 'benchmark-prereg-v1-ordering', treatmentBasisPoints: 5000 },
    benchmark: { snapshotHash: 'abc123', poolRowId: 42 },
  }), null);
  // Present-but-invalid scope fails closed; scope alone validates nothing.
  assert.throws(
    () => validateSelectionExperimentRequest({ selection: { experimentId: 's', enabledArms: ['THOMPSON'], treatmentBasisPoints: 0 }, benchmark: { snapshotHash: '', poolRowId: 0 } }),
    /INVALID_BENCHMARK_SCOPE/
  );
  assert.throws(() => validateSelectionExperimentRequest({ benchmark: { snapshotHash: 'abc123', poolRowId: 42 } }), /INVALID_EXPERIMENT_REQUEST/);
});

test('schedule-authoritative frozen ordering derives from the stored scheduled_at', async () => {
  const { resolveFrozenBenchmarkScheduleOrdering, BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID } = await import('./querySelectionExperiments');
  const stored = new Date('2026-04-01T00:00:00.000Z');
  const envelope = {
    arm: 'TREATMENT' as const,
    propensityBasisPoints: 5000,
    policyVersion: 'retrieval-experiment-v1',
    windowApplied: true,
    window: { publishedAfter: '2020-01-01T00:00:00Z', publishedBefore: '2020-02-01T00:00:00Z' },
    experimentId: BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID,
  };
  const resolved = resolveFrozenBenchmarkScheduleOrdering(envelope, stored);
  assert.notEqual(resolved, envelope);
  assert.equal(resolved?.arm, 'TREATMENT');
  assert.equal(resolved?.windowApplied, true);
  assert.deepEqual(resolved?.window, { publishedAfter: '2026-01-01T00:00:00.000Z', publishedBefore: '2026-04-01T00:00:00.000Z' });
  assert.equal(resolved?.experimentId, BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID);
  // Non-frozen identities, CONTROL arms, and absent envelopes pass through
  // by reference (nothing to persist).
  const control = { ...envelope, arm: 'CONTROL' as const, windowApplied: false, window: null, experimentId: null };
  assert.equal(resolveFrozenBenchmarkScheduleOrdering(control, stored), control);
  const other = { ...envelope, experimentId: 'other-exp' };
  assert.equal(resolveFrozenBenchmarkScheduleOrdering(other, stored), other);
  assert.equal(resolveFrozenBenchmarkScheduleOrdering(undefined, stored), undefined);
  assert.equal(resolveFrozenBenchmarkScheduleOrdering(null, stored), null);
});
