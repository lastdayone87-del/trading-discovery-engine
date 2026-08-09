import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREATOR_ACTIVITY_STATUSES,
  CREATOR_INTELLIGENCE_CONTRACT_VERSION,
  CREATOR_OUTCOME_MATURITIES,
  CREATOR_OUTCOME_TYPES,
  createCreatorReplayEnvelope,
  creatorIntelligenceChecksum,
  validateCreatorAction,
  validateCreatorDiscoveryObjective,
  validateCreatorOutcome,
  validateCreatorProgram,
  type CreatorAction,
  type CreatorDiscoveryObjective,
  type CreatorOutcome,
  type CreatorProgram
} from './contracts';

const now = '2026-08-08T00:00:00.000Z';
const objective: CreatorDiscoveryObjective = {
  objectiveKey: 'germany-futures-educators', version: 1, title: 'German futures educators',
  statement: 'Discover active futures trading educators serving Germany.',
  coordinates: { country: 'Germany', language: 'de', market: 'futures' },
  criteria: { roles: ['EDUCATOR'], activityRequirement: 'ACTIVE', requiresEducationalContent: true, minimumQualityScore: 55 },
  coverageDefinition: { dimensions: ['country', 'language', 'market', 'creatorCluster'] }, evaluationHorizonDays: 90,
  createdAt: now, policyVersion: 'creator-objective-v1'
};
const program: CreatorProgram = {
  programId: 'program-1', programKey: 'germany-futures-educators', objective, lifecycle: 'DRAFT',
  budget: { providerUnits: 0, reviewUnits: 0 }, servingAuthority: false,
  createdAt: now, updatedAt: now, policyVersion: 'creator-program-v1'
};
const action: CreatorAction = {
  actionId: 'action-1', programId: program.programId, objectiveKey: objective.objectiveKey,
  actionType: 'SEARCH_YOUTUBE', providerKey: 'youtube-search', target: 'DAX Analyse',
  coordinates: objective.coordinates, sourceFamilyIds: ['curated-query-catalog'],
  expectedIncrementalCreators: 1, expectedInformationGain: .5, expectedCoverageGain: .25, uncertainty: .5,
  expectedCost: { providerUnits: 100, reviewUnits: 0 }, provenance: { queryId: 7 },
  proposedAt: now, policyVersion: 'creator-action-v1', servingAuthority: false
};
const outcome: CreatorOutcome = {
  outcomeKey: 'outcome-1', actionId: action.actionId, objectiveKey: objective.objectiveKey,
  creator: { canonicalCreatorId: 'creator-1', sourceAccountId: 'channel-1', sourceAccountType: 'YOUTUBE_CHANNEL', identityConfidence: 'CONFIRMED' },
  outcomeType: 'NEW_VERIFIED_CREATOR', maturity: 'TERMINAL', incremental: true,
  activeCreatorCredit: true, verifiedCreatorCredit: true, coverageCellKeys: ['cell-1'],
  cost: { providerUnits: 100, reviewUnits: 0 },
  evidence: { sourceEventKeys: ['query-run:1:funnel'], countryStatus: 'CONFIRMED', tradingStatus: 'TRADING_CONFIRMED', qualityScore: 80,
    activity: { status: 'ACTIVE', observedAt: now, evidenceSourceIds: ['youtube:channel-1'], policyVersion: 'activity-v1' } },
  observedAt: now, effectiveAt: now, policyVersion: 'creator-outcome-v1', contractVersion: CREATOR_INTELLIGENCE_CONTRACT_VERSION
};

test('Phase 0 taxonomies are closed and distinguish activity, maturity, and creator outcomes', () => {
  assert.deepEqual(CREATOR_ACTIVITY_STATUSES, ['ACTIVE', 'RECENTLY_ACTIVE', 'DORMANT', 'INACTIVE', 'UNKNOWN', 'CONFLICTED']);
  assert.deepEqual(CREATOR_OUTCOME_MATURITIES, ['PROVISIONAL', 'ENRICHED', 'REVIEWED', 'TERMINAL']);
  assert.ok(CREATOR_OUTCOME_TYPES.includes('DUPLICATE_ACCOUNT'));
  assert.ok(CREATOR_OUTCOME_TYPES.includes('OPERATIONALLY_UNRESOLVED'));
});

test('Phase 0 objective and program contracts validate without granting serving authority', () => {
  assert.doesNotThrow(() => validateCreatorDiscoveryObjective(objective));
  assert.doesNotThrow(() => validateCreatorProgram(program));
  assert.throws(() => validateCreatorProgram({ ...program, servingAuthority: true as false }), /cannot have serving authority/);
  assert.throws(() => validateCreatorDiscoveryObjective({ ...objective, evaluationHorizonDays: 0 }), /positive number of days/);
});

test('Creator Actions reuse provider-neutral persistent-research actions and remain non-serving', () => {
  assert.doesNotThrow(() => validateCreatorAction(action));
  assert.throws(() => validateCreatorAction({ ...action, sourceFamilyIds: [] }), /source-family provenance/);
  assert.throws(() => validateCreatorAction({ ...action, servingAuthority: true as false }), /cannot have serving authority/);
});

test('creator credit requires resolved verification and explicit active evidence', () => {
  assert.doesNotThrow(() => validateCreatorOutcome(outcome));
  assert.throws(() => validateCreatorOutcome({ ...outcome, creator: { ...outcome.creator, canonicalCreatorId: undefined } }), /canonical creator ID/);
  assert.throws(() => validateCreatorOutcome({ ...outcome, outcomeType: 'NEEDS_REVIEW' }), /verified creator outcome/);
  assert.throws(() => validateCreatorOutcome({ ...outcome, evidence: { ...outcome.evidence, activity: { ...outcome.evidence.activity!, status: 'INACTIVE' } } }), /ACTIVE evidence/);
});

test('replay envelopes are stable, versioned, and insensitive to object key order', () => {
  assert.equal(creatorIntelligenceChecksum({ b: 2, a: 1 }), creatorIntelligenceChecksum({ a: 1, b: 2 }));
  const first = createCreatorReplayEnvelope({ subjectType: 'ACTION', subjectKey: action.actionId, asOf: now, policyVersion: action.policyVersion, payload: action });
  const second = createCreatorReplayEnvelope({ policyVersion: action.policyVersion, asOf: now, subjectKey: action.actionId, subjectType: 'ACTION', payload: action });
  assert.deepEqual(first, second);
  assert.equal(first.contractVersion, CREATOR_INTELLIGENCE_CONTRACT_VERSION);
  assert.equal(first.checksum.length, 64);
});
