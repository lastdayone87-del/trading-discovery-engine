import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CREATOR_READINESS_POLICY_VERSION, type ShadowAllocationCandidate } from './readiness';
import { CREATOR_SEARCH_CANARY_POLICY_VERSION, creatorCanaryBucket, decideCreatorCanaryArm, type CreatorCanaryControl } from './canary';

const at = '2026-08-09T00:00:00.000Z';
const candidate: ShadowAllocationCandidate = { programId: 'program-1', programKey: 'de-futures', objective: { objectiveKey: 'de-futures', version: 2, title: 'German futures', statement: 'Find creators.', coordinates: { country: 'Germany' }, criteria: {}, coverageDefinition: {}, evaluationHorizonDays: 30, createdAt: at, policyVersion: 'objective-v2' }, hypothesisId: 'hypothesis-1', hypothesisKey: 'gap-1', hypothesisConfidence: .8, frontierUncertainty: .7, evidenceKeys: ['frontier-1'] };
const control: CreatorCanaryControl = { enabled: true, killSwitch: false, servingAuthorityEnabled: true, topLevelAuthorityEnabled: true, playlistAuthorityEnabled: true, playlistRolloutBasisPoints: 1000, rolloutBasisPoints: 1000, globalDailyAllocationCap: 10, globalDailyQuotaCap: 1000, maximumReadinessAgeHours: 24, minimumAttributionCompleteness: 1, readinessPolicyVersion: CREATOR_READINESS_POLICY_VERSION, policyVersion: CREATOR_SEARCH_CANARY_POLICY_VERSION, configurationVersion: 2 };
const treatmentOpportunity = (() => { for (let i = 0; i < 100000; i++) if (creatorCanaryBucket(`playlist-${i}`) < 1000) return `playlist-${i}`; throw new Error('NO_TEST_BUCKET'); })();

test('playlist treatment reuses deterministic assignment and propensity model', () => {
  const input = { opportunityKey: treatmentOpportunity, country: 'Germany', assignedAt: at, estimatedQuotaUnits: 1, control, safetyReasons: [], candidate, readinessRunId: 'readiness-1', eligibilityChecksum: 'a'.repeat(64), actionType: 'INSPECT_PLAYLIST' as const, nonQueryProposalId: 'proposal-1' };
  const assignment = decideCreatorCanaryArm(input);
  assert.deepEqual(assignment, decideCreatorCanaryArm(input)); assert.equal(assignment.actionType, 'INSPECT_PLAYLIST'); assert.equal(assignment.nonQueryProposalId, 'proposal-1'); assert.equal(assignment.assignmentStatus, 'CANARY_ALLOCATED'); assert.equal(assignment.behaviorPropensityBasisPoints, 1000);
});

test('playlist safety failure is a non-serving control assignment', () => {
  const assignment = decideCreatorCanaryArm({ opportunityKey: treatmentOpportunity, country: 'Germany', assignedAt: at, estimatedQuotaUnits: 1, control, safetyReasons: ['PLAYLIST_ADAPTER_DISABLED'], candidate, readinessRunId: 'readiness-1', eligibilityChecksum: 'b'.repeat(64), actionType: 'INSPECT_PLAYLIST', nonQueryProposalId: 'proposal-1' });
  assert.equal(assignment.arm, 'CONTROL'); assert.equal(assignment.servingAuthority, false); assert.equal(assignment.treatmentPropensityBasisPoints, 0);
});

test('Phase 7 migration generalizes the existing assignment ledger for playlist only', () => {
  const sql = readFileSync(new URL('../db/migrations/077_creator_playlist_canary.sql', import.meta.url), 'utf8');
  assert.match(sql, /playlist_authority_enabled BOOLEAN NOT NULL DEFAULT false/); assert.match(sql, /playlist_rollout_basis_points INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /action_type IN\('SEARCH_YOUTUBE','INSPECT_PLAYLIST'\)/); assert.match(sql, /creator_playlist_proposal_required/); assert.match(sql, /creator_playlist_canary_execution_links/); assert.match(sql, /reject_immutable_event_mutation/);
  assert.doesNotMatch(sql, /INSPECT_FEATURED|INSPECT_COLLABORATOR|INSPECT_WEBSITE|RESOLVE_EXTERNAL|GRAPH|CREATE TABLE IF NOT EXISTS .*assignments/i);
});

test('bridge invokes only the existing playlist adapter and preserves fallback', () => {
  const bridge = readFileSync(new URL('./playlistCanary.ts', import.meta.url), 'utf8');
  assert.match(bridge, /enqueuePlaylistCanary/); assert.match(bridge, /acquisition_type='INSPECT_PLAYLIST'/); assert.match(bridge, /allocateCreatorSearchCanary/);
  assert.doesNotMatch(bridge, /INSPECT_FEATURED|INSPECT_COLLABORATOR|INSPECT_WEBSITE|RESOLVE_EXTERNAL|searchYouTube|fetch\s*\(/);
  const controller = readFileSync(new URL('../persistentResearchController.ts', import.meta.url), 'utf8');
  assert.match(controller, /materializeCreatorPlaylistCanary\(cutoff\)\.catch/); assert.match(controller, /Playlist canary fallback/);
});
