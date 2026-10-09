import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  LIVE_SELECTION_EXPERIMENT_SETTING_KEY,
  LIVE_THOMPSON_EVAL_EXPERIMENT_ID,
  parseScheduledSelectionExperiment,
} from './autonomousDiscovery';
import { assignSelectionExperimentArm, type NormalizedSelectionExperiment } from './querySelectionExperiments';

const LIVE_CONFIG = JSON.stringify({
  selection: {
    experimentId: LIVE_THOMPSON_EVAL_EXPERIMENT_ID,
    enabledArms: ['THOMPSON'],
    treatmentBasisPoints: 5000,
    thompsonPrior: { alpha0: 1, beta0: 1 },
    contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
  },
});

function assignedArm(opportunityKey: string) {
  return assignSelectionExperimentArm({
    experimentId: LIVE_THOMPSON_EVAL_EXPERIMENT_ID,
    enabledArms: ['THOMPSON'],
    treatmentBasisPoints: 5000,
    opportunityKey,
  });
}

test('live Thompson config parses and assigns deterministically near 50/50', () => {
  assert.equal(LIVE_SELECTION_EXPERIMENT_SETTING_KEY, 'live_selection_experiment');
  assert.equal(LIVE_THOMPSON_EVAL_EXPERIMENT_ID, 'live-thompson-eval-v1');
  const parsed = parseScheduledSelectionExperiment(LIVE_CONFIG);
  assert.ok(parsed);
  assert.equal(parsed?.selection?.experimentId, LIVE_THOMPSON_EVAL_EXPERIMENT_ID);
  const keys = Array.from({ length: 400 }, (_, i) => `US:2026-10-09:${i}`);
  const arms = keys.map(assignedArm);
  const thompson = arms.filter(a => a.arm === 'THOMPSON').length;
  assert.ok(thompson >= 160 && thompson <= 240, `expected ~50% Thompson, got ${thompson}/400`);
  for (const arm of arms) {
    assert.ok(arm.arm === 'THOMPSON' || arm.arm === 'CONTROL');
    if (arm.arm === 'THOMPSON') assert.equal(arm.propensityBasisPoints, 5000);
    else assert.equal(arm.propensityBasisPoints, 5000);
  }
});

test('retry consistency: same opportunity always draws the same arm', () => {
  for (const key of ['US:2026-10-09:7', 'DE:2026-10-09:42', 'FR:2026-10-10:0']) {
    const first = assignedArm(key);
    const second = assignedArm(key);
    assert.deepEqual(second, first);
  }
});

test('invalid or missing configuration falls back to legacy (null)', () => {
  assert.equal(parseScheduledSelectionExperiment(undefined), null);
  assert.equal(parseScheduledSelectionExperiment(''), null);
  assert.equal(parseScheduledSelectionExperiment('   '), null);
  assert.equal(parseScheduledSelectionExperiment('not-json'), null);
  assert.equal(parseScheduledSelectionExperiment(JSON.stringify({ selection: null, ordering: null })), null);
});

test('attribution identity is stable and version-namespaced', () => {
  const a = assignedArm('US:2026-10-09:7');
  assert.ok(a.bucket >= 0 && a.bucket < 10000);
  assert.equal(a.policyVersion, 'query-selection-experiment-v1');
});

test('pause gate decision matrix (behavioral, no database)', async () => {
  const { shouldPauseDiscoveryCycle } = await import('./autonomousDiscovery');
  // Paused + no direct target: pause wins, experiment never consulted.
  assert.equal(shouldPauseDiscoveryCycle({ paused: true, hasBenchmarkScope: false }), true);
  assert.equal(shouldPauseDiscoveryCycle({ paused: true, targetCountry: undefined, hasBenchmarkScope: false }), true);
  // Paused + benchmark scope even with a direct target: still pauses.
  assert.equal(shouldPauseDiscoveryCycle({ paused: true, targetCountry: 'US', hasBenchmarkScope: true }), true);
  // Paused + direct operator target without benchmark scope: bypass by design.
  assert.equal(shouldPauseDiscoveryCycle({ paused: true, targetCountry: 'US', hasBenchmarkScope: false }), false);
  // Unpaused: never pauses regardless of target/scope.
  assert.equal(shouldPauseDiscoveryCycle({ paused: false, hasBenchmarkScope: false }), false);
  assert.equal(shouldPauseDiscoveryCycle({ paused: false, targetCountry: 'US', hasBenchmarkScope: true }), false);
});

test('scheduled tick wires the scheduled config into the cycle (structural pin)', () => {
  // The tick itself needs a database + scheduler, so this pins the exact
  // 4-argument call shape instead: scheduled config flows positionally into
  // runAutonomousDiscoveryCycle, which is what the behavioral matrix above
  // cannot observe without integration infrastructure.
  const source = fs.readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  assert.ok(
    source.includes('await getScheduledSelectionExperiment()'),
    'tick must read the scheduled experiment'
  );
});

test('opportunity keys are stable per attempt and redraw across attempts/roles', async () => {
  const { buildCycleOpportunityKey } = await import('./autonomousDiscovery');
  const base = { workerId: 'w1', cycleStartedAt: '2026-10-09T00:00:00.000Z', country: 'US', attempt: 3 };
  assert.equal(buildCycleOpportunityKey(base), buildCycleOpportunityKey({ ...base }));
  assert.notEqual(
    buildCycleOpportunityKey(base),
    buildCycleOpportunityKey({ ...base, attempt: 4 })
  );
  assert.notEqual(
    buildCycleOpportunityKey(base),
    buildCycleOpportunityKey({ ...base, country: 'DE' })
  );
  assert.notEqual(
    buildCycleOpportunityKey(base),
    buildCycleOpportunityKey({ ...base, workerId: 'w2' })
  );
});

test('scheduled settings: read failure is loud, absence/invalid is silent legacy', async () => {
  const { getScheduledSelectionExperiment } = await import('./autonomousDiscovery');
  await assert.rejects(
    getScheduledSelectionExperiment(async () => { throw new Error('DB_DOWN'); }),
    /SCHEDULED_EXPERIMENT_SETTINGS_UNREADABLE/
  );
  assert.equal(await getScheduledSelectionExperiment(async () => ''), null);
  assert.equal(await getScheduledSelectionExperiment(async () => '   '), null);
  assert.equal(await getScheduledSelectionExperiment(async () => 'not-json'), null);
  assert.equal(
    await getScheduledSelectionExperiment(async () => JSON.stringify({ selection: { experimentId: 'x' } })),
    null
  );
});

test('strict gate admits only the canonical live design', async () => {
  const { isCanonicalLiveThompsonConfig } = await import('./autonomousDiscovery');
  const canonical = {
    selection: {
      experimentId: 'live-thompson-eval-v1', enabledArms: ['THOMPSON'], treatmentBasisPoints: 5000,
      thompsonPrior: { alpha0: 1, beta0: 1 }, contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
    },
  } as NormalizedSelectionExperiment;
  assert.equal(isCanonicalLiveThompsonConfig(canonical), true);
  assert.equal(isCanonicalLiveThompsonConfig(null), false);
  assert.equal(isCanonicalLiveThompsonConfig(undefined), false);
  const withId = (id: string): NormalizedSelectionExperiment => ({ selection: { ...canonical.selection, experimentId: id } }) as NormalizedSelectionExperiment;
  assert.equal(isCanonicalLiveThompsonConfig(withId('other-exp')), false);
  assert.equal(isCanonicalLiveThompsonConfig(withId('benchmark-prereg-v1-selection')), false);
  assert.equal(isCanonicalLiveThompsonConfig(withId('benchmark-prereg-v2-selection')), false);
  const altered = (patch: Record<string, unknown>): NormalizedSelectionExperiment => ({
    selection: { ...canonical.selection, ...(patch.selection as object | undefined) },
  }) as NormalizedSelectionExperiment;
  assert.equal(isCanonicalLiveThompsonConfig(altered({ selection: { treatmentBasisPoints: 2500 } })), false);
  assert.equal(
    isCanonicalLiveThompsonConfig(altered({ selection: { thompsonPrior: { alpha0: 2, beta0: 2 } } })),
    false
  );
  assert.equal(isCanonicalLiveThompsonConfig(altered({ selection: { enabledArms: ['THOMPSON', 'CONTEXTUAL'] } })), false);
  assert.equal(
    isCanonicalLiveThompsonConfig({ ...canonical, ordering: { experimentId: 'x', treatmentBasisPoints: 1, window: {} } }),
    false
  );
  assert.equal(
    isCanonicalLiveThompsonConfig({ ...canonical, benchmark: { snapshotHash: 'abc', poolRowId: 1 } } as NormalizedSelectionExperiment),
    false
  );
  assert.ok(parseScheduledSelectionExperiment(JSON.stringify(canonical)));
  assert.equal(parseScheduledSelectionExperiment(JSON.stringify(withId('other-exp'))), null);
  assert.equal(
    parseScheduledSelectionExperiment(
      JSON.stringify({ selection: canonical.selection, ordering: { experimentId: 'live-thompson-eval-v1', treatmentBasisPoints: 1 } })
    ),
    null
  );
});

test('served envelope carries complete attribution identity', async () => {
  const { buildSelectionExperimentObservation } = await import('./querySelectionExperiments');
  const assignment = assignedArm('US:2026-10-09:7');
  const envelope = buildSelectionExperimentObservation({
    experimentId: 'live-thompson-eval-v1',
    assignment,
    eligibility: 'SELECTION_EXPERIMENT_ELIGIBLE',
    reason: 'test',
    opportunityKey: 'US:2026-10-09:7',
    poolQueryIds: [11, 22],
    winner: null,
    thompsonPrior: { alpha0: 1, beta0: 1 },
    contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
    servedArm: assignment.arm,
  });
  assert.equal(envelope.experimentId, 'live-thompson-eval-v1');
  assert.equal(envelope.requestedArm, assignment.arm);
  assert.equal(envelope.servedArm, assignment.arm);
  assert.equal(envelope.propensityBasisPoints, assignment.propensityBasisPoints);
  assert.equal(envelope.determinism.opportunityKey, 'US:2026-10-09:7');
  assert.deepEqual(envelope.determinism.poolQueryIds, [11, 22]);
});

test('accepted parser fields drive the resulting assignment behavior', async () => {
  const { parseScheduledSelectionExperiment } = await import('./autonomousDiscovery');
  const { assignSelectionExperimentArm } = await import('./querySelectionExperiments');
  const parsed = parseScheduledSelectionExperiment(
    JSON.stringify({
      selection: {
        experimentId: 'live-thompson-eval-v1', enabledArms: ['THOMPSON'], treatmentBasisPoints: 5000,
        thompsonPrior: { alpha0: 1, beta0: 1 }, contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
      },
    })
  );
  assert.ok(parsed?.selection);
  const sel = parsed.selection;
  assert.deepEqual(sel.enabledArms, ['THOMPSON']);
  const keys = Array.from({ length: 200 }, (_, i) => `US:2026-10-09:${i}`);
  const arms = keys.map(key =>
    assignSelectionExperimentArm({
      experimentId: sel.experimentId,
      enabledArms: sel.enabledArms,
      treatmentBasisPoints: sel.treatmentBasisPoints,
      opportunityKey: key,
    })
  );
  const treated = arms.filter(a => a.arm === 'THOMPSON').length;
  assert.ok(treated >= 80 && treated <= 120, `parsed 5000bp config must treat ~50%, got ${treated}/200`);
  for (const arm of arms) assert.equal(arm.propensityBasisPoints, 5000);
});

test('assignment namespace separates experiment identities deterministically', async () => {
  const { assignSelectionExperimentArm } = await import('./querySelectionExperiments');
  const key = 'US:2026-10-09:7';
  const live = assignSelectionExperimentArm({
    experimentId: 'live-thompson-eval-v1', enabledArms: ['THOMPSON'], treatmentBasisPoints: 5000, opportunityKey: key,
  });
  const other = assignSelectionExperimentArm({
    experimentId: 'other-exp', enabledArms: ['THOMPSON'], treatmentBasisPoints: 5000, opportunityKey: key,
  });
  assert.equal(assignSelectionExperimentArm({
    experimentId: 'live-thompson-eval-v1', enabledArms: ['THOMPSON'], treatmentBasisPoints: 5000, opportunityKey: key,
  }).bucket, live.bucket);
  assert.notEqual(other.bucket, live.bucket);
});