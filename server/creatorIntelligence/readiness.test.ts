import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { CreatorDiscoveryObjective } from './contracts';
import { allocateShadowCreatorProgram, evaluateCreatorReadiness, projectCreatorGuardrails, type GuardrailOutcomeInput, type ShadowAllocationCandidate, type ShadowSchedulingOpportunity } from './readiness';

const at = '2026-08-09T00:00:00.000Z';
const objective: CreatorDiscoveryObjective = { objectiveKey: 'german-futures', version: 1, title: 'German futures creators', statement: 'Find active German futures educators.', coordinates: { country: 'Germany', language: 'de', market: 'futures' }, criteria: { roles: ['EDUCATOR'], activityRequirement: 'ACTIVE' }, coverageDefinition: { dimensions: ['country', 'market'] }, evaluationHorizonDays: 90, createdAt: at, policyVersion: 'objective-v1' };
const opportunity: ShadowSchedulingOpportunity = { opportunityKey: 'query-run:1:selected:v1', queryRunId: 'run-1', country: 'Germany', occurredAt: at };
const candidate = (patch: Partial<ShadowAllocationCandidate> = {}): ShadowAllocationCandidate => ({ programId: 'program-1', programKey: 'german-futures', objective, hypothesisId: 'hypothesis-1', hypothesisKey: 'coverage-gap-1', hypothesisConfidence: .8, frontierUncertainty: .9, evidenceKeys: ['frontier-1', 'hypothesis-1'], ...patch });

test('allocation stops at program, objective, and hypothesis and is independent of input order', () => {
  const lower = candidate({ programId: 'program-2', programKey: 'other', hypothesisConfidence: .2 });
  const first = allocateShadowCreatorProgram(opportunity, [lower, candidate()]);
  const second = allocateShadowCreatorProgram(opportunity, [candidate(), lower]);
  assert.deepEqual(first, second); assert.equal(first.disposition, 'ALLOCATED'); assert.equal(first.programId, 'program-1');
  assert.equal(first.objectiveKey, objective.objectiveKey); assert.equal(first.hypothesisId, 'hypothesis-1');
  assert.equal(first.servingAuthority, false); assert.equal('query' in first, false);
});

test('every opportunity receives an explicit ABSTAIN when no program is eligible', () => {
  const decision = allocateShadowCreatorProgram(opportunity, [candidate({ objective: { ...objective, coordinates: { country: 'France' } } })]);
  assert.equal(decision.disposition, 'ABSTAIN'); assert.deepEqual(decision.reasonCodes, ['NO_ELIGIBLE_PROGRAM']); assert.equal(decision.targetPropensityBasisPoints, 0);
});

const outcome = (index: number, patch: Partial<GuardrailOutcomeInput> = {}): GuardrailOutcomeInput => ({ outcomeKey: `outcome-${index}`, allocationKey: `allocation-${index}`, countryStatus: 'CONFIRMED', tradingStatus: 'TRADING_CONFIRMED', outcomeType: 'NEW_VERIFIED_CREATOR', maturity: 'TERMINAL', verifiedCreatorCredit: true, activeCreatorCredit: true, activityStatus: 'ACTIVE', providerUnits: 50, effectiveAt: at, behaviorPropensityBasisPoints: 10000, targetPropensityBasisPoints: 10000, country: 'Germany', ...patch });

test('guardrails expose all required metrics and conservatively abstain on insufficient evidence', () => {
  const snapshots = projectCreatorGuardrails({ allocationRunKey: 'run', outcomes: [outcome(1)], attributionCompleteness: 1, observationWindow: { from: '2026-07-09T00:00:00.000Z', to: at } });
  assert.equal(snapshots.length, 8); assert.ok(snapshots.every(snapshot => snapshot.result === 'ABSTAIN'));
  assert.ok(snapshots.every(snapshot => snapshot.reasonCodes.includes('INSUFFICIENT_EFFECTIVE_SAMPLE_SIZE'))); assert.ok(snapshots.every(snapshot => !snapshot.servingAuthority));
});

test('missing attribution abstains rather than failing even with sufficient samples', () => {
  const snapshots = projectCreatorGuardrails({ allocationRunKey: 'run', outcomes: Array.from({ length: 40 }, (_, index) => outcome(index)), attributionCompleteness: .9, observationWindow: { from: '2026-07-09T00:00:00.000Z', to: at } });
  assert.ok(snapshots.every(snapshot => snapshot.result === 'ABSTAIN')); assert.ok(snapshots.every(snapshot => snapshot.reasonCodes.includes('INCOMPLETE_ATTRIBUTION')));
});

test('stale evidence abstains rather than being interpreted as poor performance', () => {
  const snapshots = projectCreatorGuardrails({ allocationRunKey: 'run', outcomes: Array.from({ length: 40 }, (_, index) => outcome(index, { effectiveAt: '2026-07-09T00:00:00.000Z' })), attributionCompleteness: 1, observationWindow: { from: '2026-07-01T00:00:00.000Z', to: at }, maximumEvidenceAgeHours: 48 });
  assert.ok(snapshots.every(snapshot => snapshot.result === 'ABSTAIN'));
  assert.ok(snapshots.every(snapshot => snapshot.reasonCodes.includes('STALE_EVIDENCE')));
});

test('known guardrail failure takes precedence and PASS requires every guardrail', () => {
  const policy = { minimumSampleSize: 1, minimumAttributionCompleteness: 1, thresholds: Object.fromEntries(['COUNTRY_PRECISION', 'TRADING_PRECISION', 'VERIFIED_CREATOR_YIELD', 'ACTIVE_VERIFIED_CREATOR_YIELD', 'REVIEW_BURDEN', 'INACTIVE_CREATOR_RATE', 'PROVIDER_COST', 'QUOTA_CONSUMPTION'].map(metric => [metric, { direction: metric.includes('BURDEN') || metric.includes('RATE') || metric.includes('COST') || metric.includes('CONSUMPTION') ? 'MAX' : 'MIN', value: metric.includes('COST') || metric.includes('CONSUMPTION') ? 100 : .5 }])) } as any;
  const guardrails = projectCreatorGuardrails({ allocationRunKey: 'run', outcomes: Array.from({ length: 40 }, (_, index) => outcome(index)), attributionCompleteness: 1, observationWindow: { from: '2026-07-09T00:00:00.000Z', to: at }, policy });
  const pass = evaluateCreatorReadiness({ cutoffAt: at, checks: { lineage: 'PASS' }, guardrails, sourceChecksums: ['a'] });
  assert.equal(pass.result, 'PASS'); assert.equal(pass.servingAuthority, false);
  assert.equal(evaluateCreatorReadiness({ cutoffAt: at, checks: { lineage: 'ABSTAIN' }, guardrails: guardrails.map(snapshot => ({ ...snapshot, result: 'FAIL' })), sourceChecksums: ['a'] }).result, 'FAIL');
});

test('Phase 3.5 migration is immutable, default-off, attributable, and non-authoritative', () => {
  const sql = readFileSync(new URL('../db/migrations/073_creator_readiness_attribution_shadow.sql', import.meta.url), 'utf8');
  for (const table of ['creator_readiness_shadow_control', 'creator_program_allocation_shadow_runs', 'creator_program_allocation_shadow_decisions', 'creator_assignment_shadow_lineage', 'creator_guardrail_shadow_snapshots', 'creator_readiness_shadow_runs', 'creator_readiness_shadow_events']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /enabled BOOLEAN NOT NULL DEFAULT false/); assert.match(sql, /decision_count=opportunity_count/); assert.match(sql, /serving_authority=false/g); assert.match(sql, /reject_immutable_event_mutation/);
  assert.doesNotMatch(sql, /INSERT INTO jobs|discovery_action_assignments|mode='CANARY'|DROP TABLE|DROP COLUMN|TRUNCATE/i);
});

test('runner has no production execution dependency or wiring', () => {
  const module = readFileSync(new URL('./readiness.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /autonomousDiscovery|queryIntelligence|queueManager|searchYouTube|enqueueJob|scheduleAutonomousQueryRuns/i);
  for (const file of ['../../server.ts', '../autonomousDiscovery.ts', '../queueManager.ts', '../queryIntelligence.ts']) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /runCreatorReadinessShadow|creator_program_allocation_shadow_decisions/);
});
