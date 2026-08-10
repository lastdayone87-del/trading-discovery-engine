import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyCreatorFocusDistribution } from '../evidenceEngine/hypothesisTaxonomy';
import type { OfflineAdmissionExample } from './offlineV2';
import { evaluateStage1Admission, STAGE1_ADMISSION_POLICY_VERSION } from './offlineStage1';

const focus = (trading: number, alternative: number) => ({
  ...emptyCreatorFocusDistribution(),
  ACTIVE_TRADING_CREATOR: trading,
  UNRELATED_CREATOR: alternative
});

const example = (overrides: Partial<OfflineAdmissionExample> = {}): OfflineAdmissionExample => ({
  exampleKey: 'example-1',
  channelId: 'channel-1',
  split: 'TEST',
  groundTruth: 'NON_TRADING',
  inclusionProbability: 1,
  productionStatus: 'UNCERTAIN',
  productionScore: 50,
  segment: { language: 'en', country: 'US' },
  creatorFocusSnapshotId: 'focus-1',
  creatorFocusInputChecksum: 'focus-checksum',
  creatorFocusDistribution: focus(.1, .85),
  creatorFocusProposedStatus: 'UNCERTAIN',
  creatorFocusProbability: .1,
  creatorFocusLowerConfidenceBound: 0,
  creatorFocusReasonCodes: [],
  creatorFocusStageReport: {
    stages: [
      { stage: 'LANGUAGE_CAPABILITY', disposition: 'PASS' },
      { stage: 'TEMPORAL_RELEVANCE', disposition: 'PASS' }
    ]
  },
  creatorFocusPolicyVersion: 'creator-focus-v4',
  coverage: {
    snapshotId: 'coverage-1',
    disposition: 'SUFFICIENT',
    observedDocumentCount: 3,
    expectedDocumentCount: 3,
    independentFamilyCount: 3,
    languageCoverage: {},
    temporalCoverage: {},
    providerAvailability: [],
    acquisitionFailures: [],
    reasonCodes: [],
    inputChecksum: 'coverage-checksum',
    policyVersion: 'coverage-v1'
  },
  ...overrides
});

test('Stage 1 can withhold dominant alternative creator focus without legacy NON_TRADING status', () => {
  const result = evaluateStage1Admission(example());
  assert.equal(result.decision, 'WITHHOLD');
  assert.equal(result.policyVersion, STAGE1_ADMISSION_POLICY_VERSION);
  assert.equal(result.servingAuthority, false);
  assert.ok(result.reasonCodes.includes('DOMINANT_ALTERNATIVE_CREATOR_FOCUS'));
});

test('Stage 1 keeps strong genuine trading creators admitted', () => {
  const result = evaluateStage1Admission(example({
    groundTruth: 'TRADING_CONFIRMED',
    creatorFocusDistribution: focus(.85, .05),
    creatorFocusProposedStatus: 'TRADING_CONFIRMED',
    creatorFocusProbability: .85,
    creatorFocusLowerConfidenceBound: .75
  }));
  assert.equal(result.decision, 'ADMIT_CONFIRMED');
});

test('Stage 1 admits review only when trading hypothesis is stronger than alternatives', () => {
  const plausible = evaluateStage1Admission(example({
    groundTruth: 'TRADING_CONFIRMED',
    creatorFocusDistribution: focus(.5, .2),
    creatorFocusProposedStatus: 'UNCERTAIN',
    creatorFocusProbability: .5,
    creatorFocusLowerConfidenceBound: .35
  }));
  assert.equal(plausible.decision, 'ADMIT_REVIEW');

  const ambiguous = evaluateStage1Admission(example({
    creatorFocusDistribution: focus(.4, .45),
    creatorFocusProposedStatus: 'UNCERTAIN',
    creatorFocusProbability: .4,
    creatorFocusLowerConfidenceBound: .2
  }));
  assert.equal(ambiguous.decision, 'DEFER_INVESTIGATION');
  assert.ok(ambiguous.reasonCodes.includes('TRADING_HYPOTHESIS_NOT_YET_PLAUSIBLE'));
});

test('Stage 1 remains fail-closed when evidence capability gates are incomplete', () => {
  assert.equal(evaluateStage1Admission(example({
    coverage: { ...example().coverage, disposition: 'INSUFFICIENT' }
  })).decision, 'DEFER_INVESTIGATION');

  assert.equal(evaluateStage1Admission(example({
    coverage: { ...example().coverage, independentFamilyCount: 1 }
  })).decision, 'DEFER_INVESTIGATION');

  assert.equal(evaluateStage1Admission(example({
    creatorFocusStageReport: {
      stages: [
        { stage: 'LANGUAGE_CAPABILITY', disposition: 'ABSTAIN' },
        { stage: 'TEMPORAL_RELEVANCE', disposition: 'PASS' }
      ]
    }
  })).decision, 'DEFER_INVESTIGATION');

  assert.equal(evaluateStage1Admission(example({
    creatorFocusStageReport: {
      stages: [
        { stage: 'LANGUAGE_CAPABILITY', disposition: 'PASS' },
        { stage: 'TEMPORAL_RELEVANCE', disposition: 'ABSTAIN' }
      ]
    }
  })).decision, 'DEFER_INVESTIGATION');
});
