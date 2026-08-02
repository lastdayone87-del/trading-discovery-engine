import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateCounterfactualPolicy, protectedExplorationBucket, type PolicySample } from './persistentResearchPhase6';

const samples = (reward: number, behaviorPropensityBasisPoints = 5000, country = 'US', language = 'en'): PolicySample[] => Array.from({ length: 40 }, (_, i) => ({
  actionId: `${country}-${i}`, supported: true, targetSelected: true, targetPropensityBasisPoints: 5000,
  behaviorPropensityBasisPoints, reward, providerCost: 1, reviewCost: 0, overlapPenalty: 0, country, language
}));

test('protected exploration assignment is deterministic with truthful known propensity', () => {
  const a = protectedExplorationBucket('action', 'policy', 2000);
  assert.deepEqual(a, protectedExplorationBucket('action', 'policy', 2000));
  assert.equal(a.propensityBasisPoints, 2000);
  assert.throws(() => protectedExplorationBucket('a', 'p', 6000), /INVALID_PROTECTED_EXPLORATION_RATE/);
});

test('counterfactual gate uses logged behavior propensity, ESS, confidence and segment guards', () => {
  const candidate = samples(4).map((row, index) => ({ ...row, behaviorPropensityBasisPoints: index < 20 ? 1000 : 5000 }));
  const result = evaluateCounterfactualPolicy(candidate, samples(1), 10);
  assert.equal(result.decision, 'PASS');
  assert.ok(result.candidate.effectiveSampleSize < 40, 'unequal logging propensities must reduce effective sample size');
  assert.ok(result.confidenceInterval.lower > 0);
  assert.equal(result.segmentGuardrails['US\u001fen'].pass, true);
  assert.ok(result.reasonCodes.includes('LOGGED_BEHAVIOR_IPS'));
});

test('unsupported target actions abstain instead of becoming zero-reward observations', () => {
  const unsupported = samples(4).map((row, index) => index === 0 ? { ...row, supported: false, behaviorPropensityBasisPoints: 0 } : row);
  const result = evaluateCounterfactualPolicy(unsupported, samples(1), 10);
  assert.equal(result.decision, 'ABSTAIN');
  assert.deepEqual(result.reasonCodes, ['COUNTERFACTUAL_SUPPORT_REQUIRED']);
  assert.equal(result.candidate.unsupportedTargetActions, 1);
});

test('configured sample floor is honored and validated', () => {
  assert.equal(evaluateCounterfactualPolicy(samples(4), samples(1), 41).decision, 'ABSTAIN');
  assert.throws(() => evaluateCounterfactualPolicy(samples(4), samples(1), 0), /INVALID_MINIMUM_ASSIGNMENTS/);
});

test('phase six completion migration records behavior support and evaluation windows', () => {
  const sql = fs.readFileSync(new URL('./db/migrations/052_persistent_research_phase6_valid_evaluation.sql', import.meta.url), 'utf8');
  for (const token of ['evaluation_window_start', 'assignment_id', 'supported', 'behavior_propensity_basis_points', 'target_propensity_basis_points', 'minimum_assignments']) assert.match(sql, new RegExp(token));
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|TRUNCATE/i);
});

test('controller joins immutable logged assignments, enforces a time split, and passes the sample floor', () => {
  const controller = fs.readFileSync(new URL('./persistentResearchController.ts', import.meta.url), 'utf8');
  assert.match(controller, /JOIN discovery_action_outcomes o ON o\.assignment_id=a\.id/);
  assert.match(controller, /a\.propensity_basis_points behavior_propensity_basis_points/);
  assert.match(controller, /a\.assigned_at>=\$1 AND a\.assigned_at<=\$2/);
  assert.match(controller, /policy_type='CONTEXTUAL_BANDIT' AND created_at<=\$2/);
  assert.match(controller, /evaluateCounterfactualPolicy\(toSamples\(candidateRows\),toSamples\(baselineRows\),input\.minimumAssignments\)/);
  assert.match(controller, /evaluationWindowStart:input\.evaluationWindowStart/);
});
