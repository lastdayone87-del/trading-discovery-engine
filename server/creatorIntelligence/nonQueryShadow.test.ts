import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { CreatorDiscoveryObjective } from './contracts';
import { proposeShadowNonQueryActions, type NonQueryProposalEvidence } from './nonQueryShadow';

const at = '2026-08-09T00:00:00.000Z';
const objective: CreatorDiscoveryObjective = { objectiveKey: 'de-futures', version: 2, title: 'German futures', statement: 'Find German futures creators.', coordinates: { country: 'Germany' }, criteria: {}, coverageDefinition: {}, evaluationHorizonDays: 30, createdAt: at, policyVersion: 'objective-v2' };
const evidence = (patch: Partial<NonQueryProposalEvidence> = {}): NonQueryProposalEvidence => ({ programId: 'program-1', objective, hypothesisId: 'hypothesis-1', hypothesisConfidence: .8, sourceFamilyIds: ['family-2', 'family-1'], targetAccountId: 'channel-1', unresolvedIdentity: true, frontierTargetKey: 'de:futures', frontierUncertainty: .7, estimatedUnexploredCoverage: 4, sourceEventKeys: ['event-2', 'event-1'], creatorOutcomeIds: ['outcome-1'], coverageSnapshotIds: ['coverage-1'], proposedAt: at, ...patch });

test('unresolved creator evidence deterministically proposes all five Phase 6 acquisition types', () => {
  const first = proposeShadowNonQueryActions(evidence()), replay = proposeShadowNonQueryActions(evidence());
  assert.deepEqual(first, replay);
  assert.deepEqual(first.map(proposal => proposal.actionType), ['INSPECT_COLLABORATOR', 'INSPECT_FEATURED_CHANNELS', 'INSPECT_PLAYLIST', 'INSPECT_WEBSITE_AUTHOR', 'RESOLVE_EXTERNAL_ENTITY']);
  for (const proposal of first) { assert.equal(proposal.servingAuthority, false); assert.equal(proposal.executionPropensityBasisPoints, 0); assert.ok(proposal.supportingEvidence.length); assert.ok(proposal.expectedCost.providerUnits >= 0); }
});

test('resolved identities do not receive redundant external identity proposals', () => {
  const proposals = proposeShadowNonQueryActions(evidence({ unresolvedIdentity: false }));
  assert.equal(proposals.length, 4); assert.ok(proposals.every(proposal => proposal.actionType !== 'RESOLVE_EXTERNAL_ENTITY'));
});

test('proposal checksums are sensitive to objective, hypothesis, target, and cutoff', () => {
  const original = proposeShadowNonQueryActions(evidence())[0];
  assert.notEqual(original.actionId, proposeShadowNonQueryActions(evidence({ hypothesisId: 'hypothesis-2' }))[0].actionId);
  assert.notEqual(original.actionId, proposeShadowNonQueryActions(evidence({ targetAccountId: 'channel-2' }))[0].actionId);
  assert.notEqual(original.actionId, proposeShadowNonQueryActions(evidence({ objective: { ...objective, version: 3 } }))[0].actionId);
  assert.notEqual(original.actionId, proposeShadowNonQueryActions(evidence({ proposedAt: '2026-08-10T00:00:00.000Z' }))[0].actionId);
});

test('Phase 6 migration is disabled, immutable, non-serving, and proposal-only', () => {
  const sql = readFileSync(new URL('../db/migrations/076_creator_non_query_action_shadow.sql', import.meta.url), 'utf8');
  for (const table of ['creator_non_query_shadow_control', 'creator_non_query_shadow_runs', 'creator_non_query_shadow_proposals', 'creator_non_query_shadow_lineage']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /enabled BOOLEAN NOT NULL DEFAULT false/); assert.match(sql, /mode TEXT NOT NULL DEFAULT 'SHADOW'/); assert.match(sql, /execution_propensity_basis_points=0/); assert.match(sql, /serving_authority=false/g); assert.match(sql, /reject_immutable_event_mutation/);
  assert.doesNotMatch(sql, /INSERT INTO jobs|INSERT INTO discovery_actions|INSERT INTO frontier_actions|INSERT INTO quota_reservations|mode='CANARY'/i);
});

test('Phase 6 has no production scheduler, queue, or provider wiring', () => {
  const module = readFileSync(new URL('./nonQueryShadow.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /enqueue|addJob|scheduleAutonomousQueryRuns|searchYouTube|fetch\s*\(|processPlaylistInspectionJob|proposeDiscoveryAction/);
  for (const file of ['../../server.ts', '../autonomousDiscovery.ts', '../queueManager.ts', '../persistentResearchController.ts']) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /projectShadowNonQueryActions|creator_non_query_shadow_proposals/);
});
