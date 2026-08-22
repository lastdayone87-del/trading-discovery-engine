import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { CreatorDiscoveryObjective } from './contracts';
import { prioritizeCreatorSearchPrograms, type CreatorAuthorityCandidate } from './authority';

const at = '2026-08-09T00:00:00.000Z';
const objective: CreatorDiscoveryObjective = { objectiveKey: 'de-futures', version: 2, title: 'German futures', statement: 'Find German futures creators.', coordinates: { country: 'Germany' }, criteria: {}, coverageDefinition: {}, evaluationHorizonDays: 30, createdAt: at, policyVersion: 'objective-v2' };
const candidate = (patch: Partial<CreatorAuthorityCandidate> = {}): CreatorAuthorityCandidate => ({ programId: 'program-1', programKey: 'de-futures', objective, hypothesisId: 'hypothesis-1', hypothesisConfidence: .8, country: 'Germany', lifecycle: 'ACTIVE', frontierSnapshotId: 'frontier-1', frontierState: 'UNEXPLORED', frontierUncertainty: .9, estimatedUnexploredCoverage: 5, marginalVerifiedYield: .2, providerBudgetRemaining: 500, dailyAllocationRemaining: 5, evidenceKeys: ['frontier-1'], ...patch });

test('authority prioritizes coverage gaps deterministically without producing a query', () => {
  const low = candidate({ programId: 'program-2', programKey: 'low', hypothesisId: 'hypothesis-2', frontierUncertainty: .2, estimatedUnexploredCoverage: 1 });
  const first = prioritizeCreatorSearchPrograms([low, candidate()]), replay = prioritizeCreatorSearchPrograms([candidate(), low]);
  assert.deepEqual(first, replay); assert.equal(first[0].candidate.programId, 'program-1'); assert.equal(first[0].lifecycleDecision, 'ACTIVE'); assert.equal(first[0].eligible, true); assert.equal('query' in first[0], false);
});

test('sleeping programs reactivate only when frontier evidence materially changes', () => {
  const reactivated = prioritizeCreatorSearchPrograms([candidate({ lifecycle: 'SLEEPING', frontierState: 'PARTIALLY_OBSERVED', frontierUncertainty: .7 })])[0];
  const sleeping = prioritizeCreatorSearchPrograms([candidate({ lifecycle: 'SLEEPING', frontierState: 'OBSERVED', frontierUncertainty: .1 })])[0];
  assert.equal(reactivated.lifecycleDecision, 'REACTIVATE'); assert.equal(reactivated.eligible, true);
  assert.equal(sleeping.lifecycleDecision, 'SLEEP'); assert.equal(sleeping.eligible, false);
});

test('budget exhaustion and completed lifecycle stop allocation', () => {
  for (const stopped of [candidate({ providerBudgetRemaining: 0 }), candidate({ lifecycle: 'COMPLETE' })]) {
    const decision = prioritizeCreatorSearchPrograms([stopped])[0]; assert.equal(decision.lifecycleDecision, 'STOP'); assert.equal(decision.eligible, false);
  }
});

test('Phase 5 migration transfers only bounded top-level SEARCH_YOUTUBE allocation', () => {
  const sql = readFileSync(new URL('../db/migrations/075_creator_search_allocation_authority.sql', import.meta.url), 'utf8');
  assert.match(sql, /top_level_authority_enabled BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /creator_search_top_level_authority_bounded/);
  for (const table of ['creator_search_program_authority_decisions', 'creator_search_authority_assignment_links']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /lifecycle_decision TEXT NOT NULL CHECK\(lifecycle_decision IN\('ACTIVE','SLEEP','STOP','REACTIVATE'\)\)/);
  assert.match(sql, /serving_authority=false/); assert.match(sql, /reject_immutable_event_mutation/);
  assert.doesNotMatch(sql, /query_text|query_specification|INSERT INTO jobs|PLAYLIST|WEBSITE|GRAPH|EXTERNAL_PROVIDER/i);
});

test('scheduler delegates top-level allocation before unchanged Query Intelligence execution', () => {
  const scheduler = readFileSync(new URL('../autonomousDiscovery.ts', import.meta.url), 'utf8');
  assert.ok(scheduler.indexOf('allocateCreatorSearchAuthority') < scheduler.indexOf('selectNextQueryForCountry(country)'));
  assert.match(scheduler, /const legacyCountry = countries/); assert.match(scheduler, /country = authority\.country/); assert.match(scheduler, /legacy Query Intelligence fallback continues/);
  assert.match(scheduler, /geographicAllocationIntent: providerTarget\?\.geographicAllocationIntent \|\| 'PIN_LEGACY_COUNTRY'/);
  const authority = readFileSync(new URL('./authority.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(authority, /searchYouTube|enqueueJob|scheduleAutonomousQueryRuns|allocateRetrievalLane|allocateSearchOrdering|INSERT INTO jobs|INSERT INTO quota_reservations/);
});
