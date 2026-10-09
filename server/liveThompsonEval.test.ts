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

test('scheduler pause gate still precedes experiment substitution', () => {
  const source = fs.readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  const pauseAt = source.indexOf('isQueryIntelligencePaused()');
  const substitutionAt = source.indexOf('selectExperimentalQueryForCountry(');
  assert.ok(pauseAt !== -1 && substitutionAt !== -1 && pauseAt < substitutionAt, 'pause gate must precede experiment use');
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