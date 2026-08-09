import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { CreatorDiscoveryObjective } from './contracts';
import { CREATOR_READINESS_POLICY_VERSION, type ShadowAllocationCandidate } from './readiness';
import { CREATOR_SEARCH_CANARY_POLICY_VERSION, creatorCanaryBucket, decideCreatorCanaryArm, type CreatorCanaryControl } from './canary';

const at = '2026-08-09T00:00:00.000Z';
const objective: CreatorDiscoveryObjective = { objectiveKey: 'german-futures', version: 1, title: 'German futures', statement: 'Find German futures creators.', coordinates: { country: 'Germany' }, criteria: {}, coverageDefinition: {}, evaluationHorizonDays: 30, createdAt: at, policyVersion: 'objective-v1' };
const candidate: ShadowAllocationCandidate = { programId: 'program-1', programKey: 'german-futures', objective, hypothesisId: 'hypothesis-1', hypothesisKey: 'gap-1', hypothesisConfidence: .9, frontierUncertainty: .8, evidenceKeys: ['frontier-1'] };
const control = (patch: Partial<CreatorCanaryControl> = {}): CreatorCanaryControl => ({ enabled: true, killSwitch: false, servingAuthorityEnabled: true, topLevelAuthorityEnabled: false, rolloutBasisPoints: 1000, globalDailyAllocationCap: 10, globalDailyQuotaCap: 1000, maximumReadinessAgeHours: 24, minimumAttributionCompleteness: 1, readinessPolicyVersion: CREATOR_READINESS_POLICY_VERSION, policyVersion: CREATOR_SEARCH_CANARY_POLICY_VERSION, configurationVersion: 1, ...patch });
const control = (patch: Partial<CreatorCanaryControl> = {}): CreatorCanaryControl => ({ enabled: true, killSwitch: false, servingAuthorityEnabled: true, rolloutBasisPoints: 1000, globalDailyAllocationCap: 10, globalDailyQuotaCap: 1000, maximumReadinessAgeHours: 24, minimumAttributionCompleteness: 1, readinessPolicyVersion: CREATOR_READINESS_POLICY_VERSION, policyVersion: CREATOR_SEARCH_CANARY_POLICY_VERSION, configurationVersion: 1, ...patch });
const opportunityFor = (predicate: (bucket: number) => boolean): string => {
  for (let index = 0; index < 100000; index++) { const key = `opportunity-${index}`; if (predicate(creatorCanaryBucket(key))) return key; }
  throw new Error('TEST_OPPORTUNITY_NOT_FOUND');
};

test('kill switch and zero rollout always preserve legacy Query Intelligence', () => {
  for (const config of [control({ killSwitch: true }), control({ rolloutBasisPoints: 0 })]) {
    const reasons = config.killSwitch ? ['KILL_SWITCH_ACTIVE'] : ['ROLLOUT_ZERO'];
    const assignment = decideCreatorCanaryArm({ opportunityKey: 'safe', country: 'Germany', assignedAt: at, estimatedQuotaUnits: 100, control: config, safetyReasons: reasons, candidate, readinessRunId: 'readiness-1', eligibilityChecksum: 'a'.repeat(64) });
    assert.equal(assignment.arm, 'CONTROL'); assert.equal(assignment.assignmentStatus, 'LEGACY_FALLBACK'); assert.equal(assignment.servingAuthority, false); assert.equal(assignment.behaviorPropensityBasisPoints, 10000);
  }
});

test('bounded treatment assignment is deterministic and logs both propensities', () => {
  const config = control({ rolloutBasisPoints: 500 });
  const opportunityKey = opportunityFor(bucket => bucket < 500);
  const input = { opportunityKey, country: 'Germany', assignedAt: at, estimatedQuotaUnits: 100, control: config, safetyReasons: [], candidate, readinessRunId: 'readiness-1', eligibilityChecksum: 'b'.repeat(64) };
  const first = decideCreatorCanaryArm(input), replay = decideCreatorCanaryArm(input);
  assert.deepEqual(first, replay); assert.equal(first.arm, 'TREATMENT'); assert.equal(first.assignmentStatus, 'CANARY_ALLOCATED');
  assert.equal(first.behaviorPropensityBasisPoints, 500); assert.equal(first.treatmentPropensityBasisPoints, 500); assert.equal(first.actionType, 'SEARCH_YOUTUBE'); assert.equal(first.servingAuthority, true);
});

test('randomized control records complementary behavior propensity', () => {
  const config = control({ rolloutBasisPoints: 500 });
  const opportunityKey = opportunityFor(bucket => bucket >= 500);
  const assignment = decideCreatorCanaryArm({ opportunityKey, country: 'Germany', assignedAt: at, estimatedQuotaUnits: 100, control: config, safetyReasons: [], candidate, readinessRunId: 'readiness-1', eligibilityChecksum: 'c'.repeat(64) });
  assert.equal(assignment.arm, 'CONTROL'); assert.equal(assignment.behaviorPropensityBasisPoints, 9500); assert.equal(assignment.treatmentPropensityBasisPoints, 500); assert.deepEqual(assignment.reasonCodes, ['RANDOMIZED_LEGACY_CONTROL']);
});

test('any safety failure becomes non-randomized legacy fallback', () => {
  const assignment = decideCreatorCanaryArm({ opportunityKey: 'unsafe', country: 'Germany', assignedAt: at, estimatedQuotaUnits: 100, control: control(), safetyReasons: ['READINESS_STALE', 'GUARDRAILS_NOT_PASS'], candidate, readinessRunId: 'readiness-1', eligibilityChecksum: 'd'.repeat(64) });
  assert.equal(assignment.assignmentStatus, 'LEGACY_FALLBACK'); assert.equal(assignment.treatmentPropensityBasisPoints, 0); assert.equal(assignment.behaviorPropensityBasisPoints, 10000); assert.deepEqual(assignment.reasonCodes, ['GUARDRAILS_NOT_PASS', 'READINESS_STALE']);
});

test('Phase 4 migration is default-off, bounded, immutable, and SEARCH_YOUTUBE-only', () => {
  const sql = readFileSync(new URL('../db/migrations/074_creator_search_allocation_canary.sql', import.meta.url), 'utf8');
  for (const table of ['creator_search_canary_control', 'creator_search_canary_country_limits', 'creator_search_canary_program_limits', 'creator_search_canary_assignments', 'creator_search_canary_query_run_bindings', 'creator_search_canary_control_events']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /enabled BOOLEAN NOT NULL DEFAULT false/); assert.match(sql, /kill_switch BOOLEAN NOT NULL DEFAULT true/); assert.match(sql, /rollout_basis_points INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /action_type TEXT NOT NULL CHECK\(action_type='SEARCH_YOUTUBE'\)/); assert.match(sql, /query_intelligence_authority=true/); assert.match(sql, /reject_immutable_event_mutation/);
  assert.doesNotMatch(sql, /PLAYLIST|WEBSITE|GRAPH|EXTERNAL_PROVIDER|INSERT INTO jobs|INSERT INTO quota_reservations/i);
});

test('scheduler preserves Query Intelligence selection and existing quota accounting', () => {
  const scheduler = readFileSync(new URL('../autonomousDiscovery.ts', import.meta.url), 'utf8');
  const db = readFileSync(new URL('../db.ts', import.meta.url), 'utf8');
  assert.ok(scheduler.indexOf('allocateCreatorSearchAuthority') < scheduler.indexOf('selectNextQueryForCountry(country)'));
  assert.ok(scheduler.indexOf('allocateCreatorSearchCanary') < scheduler.indexOf('selectNextQueryForCountry(country)'));
  assert.match(scheduler, /await selectNextQueryForCountry\(country\)/); assert.match(scheduler, /CANARY_ALLOCATION_UNAVAILABLE/);
  assert.match(db, /quota_reserved,metadata[^]*VALUES\(\$1,\$2,'automated_query',\$3,\$4,\$5,\$6,100,\$7\)/);
  assert.doesNotMatch(readFileSync(new URL('./canary.ts', import.meta.url), 'utf8'), /INSERT INTO jobs|INSERT INTO quota_reservations|searchYouTube|allocateRetrievalLane|allocateSearchOrdering/);
});

test('rollback control is auditable and supports kill switch or zero rollout', () => {
  const source = readFileSync(new URL('./canary.ts', import.meta.url), 'utf8');
  assert.match(source, /updateCreatorCanaryControl/); assert.match(source, /rollout_basis_points=\$1,kill_switch=\$2/); assert.match(source, /creator_search_canary_control_events/);
  assert.match(source, /!enabled \|\| killSwitch \|\| rollout === 0 \? false/);
});
