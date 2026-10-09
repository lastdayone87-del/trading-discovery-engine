import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  LIVE_SELECTION_EXPERIMENT_SETTING_KEY,
  LIVE_THOMPSON_EVAL_EXPERIMENT_ID,
  parseScheduledSelectionExperiment,
} from './autonomousDiscovery';
import { assignSelectionExperimentArm } from './querySelectionExperiments';

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
