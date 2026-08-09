import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { emptyCreatorFocusDistribution } from '../evidenceEngine/hypothesisTaxonomy';
import { buildOfflineAdmissionV2Report, evaluateOfflineAdmissionV2, OFFLINE_ADMISSION_V2_POLICY_VERSION, type OfflineAdmissionExample } from './offlineV2';

const focus = (trading: number, alternative: number) => ({ ...emptyCreatorFocusDistribution(), ACTIVE_TRADING_CREATOR: trading, UNRELATED_CREATOR: alternative });
const example = (overrides: Partial<OfflineAdmissionExample> = {}): OfflineAdmissionExample => ({
  exampleKey: 'example-1', channelId: 'channel-1', split: 'TEST', groundTruth: 'NON_TRADING', inclusionProbability: 1,
  productionStatus: 'UNCERTAIN', productionScore: 50, segment: { language: 'en', country: 'US' },
  creatorFocusSnapshotId: 'focus-1', creatorFocusInputChecksum: 'focus-checksum',
  creatorFocusDistribution: focus(.1, .85), creatorFocusProposedStatus: 'NON_TRADING', creatorFocusProbability: .1,
  creatorFocusLowerConfidenceBound: 0, creatorFocusReasonCodes: ['V4_PROPOSED_NON_TRADING'],
  creatorFocusStageReport: { stages: [{ stage: 'LANGUAGE_CAPABILITY', disposition: 'PASS' }, { stage: 'TEMPORAL_RELEVANCE', disposition: 'PASS' }] },
  creatorFocusPolicyVersion: 'creator-focus-v4',
  coverage: { snapshotId: 'coverage-1', disposition: 'SUFFICIENT', observedDocumentCount: 3, expectedDocumentCount: 3, independentFamilyCount: 3, languageCoverage: {}, temporalCoverage: {}, providerAvailability: [], acquisitionFailures: [], reasonCodes: [], inputChecksum: 'coverage-checksum', policyVersion: 'coverage-v1' },
  ...overrides
});

test('offline Admission V2 withholds only affirmative dominant alternative focus', () => {
  const result = evaluateOfflineAdmissionV2(example());
  assert.equal(result.decision, 'WITHHOLD');
  assert.equal(result.servingAuthority, false);
  assert.equal(result.policyVersion, OFFLINE_ADMISSION_V2_POLICY_VERSION);
  assert.ok(result.reasonCodes.includes('AFFIRMATIVE_NON_TRADING_EVIDENCE'));
});

test('missing, unsupported, dependent, and stale evidence always defers', () => {
  assert.equal(evaluateOfflineAdmissionV2(example({ coverage: { ...example().coverage, disposition: 'INSUFFICIENT' } })).decision, 'DEFER_INVESTIGATION');
  assert.equal(evaluateOfflineAdmissionV2(example({ creatorFocusStageReport: { stages: [{ stage: 'LANGUAGE_CAPABILITY', disposition: 'ABSTAIN' }, { stage: 'TEMPORAL_RELEVANCE', disposition: 'PASS' }] } })).decision, 'DEFER_INVESTIGATION');
  assert.equal(evaluateOfflineAdmissionV2(example({ coverage: { ...example().coverage, independentFamilyCount: 1 } })).decision, 'DEFER_INVESTIGATION');
  assert.equal(evaluateOfflineAdmissionV2(example({ creatorFocusStageReport: { stages: [{ stage: 'LANGUAGE_CAPABILITY', disposition: 'PASS' }, { stage: 'TEMPORAL_RELEVANCE', disposition: 'ABSTAIN' }] } })).decision, 'DEFER_INVESTIGATION');
});

test('strong creator-level trading evidence confirms and plausible evidence routes to review', () => {
  assert.equal(evaluateOfflineAdmissionV2(example({ groundTruth: 'TRADING_CONFIRMED', creatorFocusDistribution: focus(.85, .05), creatorFocusProposedStatus: 'TRADING_CONFIRMED', creatorFocusProbability: .85, creatorFocusLowerConfidenceBound: .75 })).decision, 'ADMIT_CONFIRMED');
  assert.equal(evaluateOfflineAdmissionV2(example({ groundTruth: 'TRADING_CONFIRMED', creatorFocusDistribution: focus(.5, .3), creatorFocusProposedStatus: 'UNCERTAIN', creatorFocusProbability: .5, creatorFocusLowerConfidenceBound: .35 })).decision, 'ADMIT_REVIEW');
});

test('report is deterministic and measures false-positive, recall, enrichment, and review effects', () => {
  const unrelated = example();
  const genuine = example({ exampleKey: 'example-2', channelId: 'channel-2', groundTruth: 'TRADING_CONFIRMED', productionStatus: 'UNCERTAIN', creatorFocusDistribution: focus(.85, .05), creatorFocusProposedStatus: 'TRADING_CONFIRMED', creatorFocusProbability: .85, creatorFocusLowerConfidenceBound: .75 });
  const input = { dataset: { id: 'dataset-1', key: 'fixed', version: 1, cutoffAt: '2026-01-01T00:00:00.000Z', checksum: 'dataset-checksum' }, examples: [genuine, unrelated] };
  const first = buildOfflineAdmissionV2Report(input), second = buildOfflineAdmissionV2Report({ ...input, examples: [unrelated, genuine] });
  assert.equal(first.outputChecksum, second.outputChecksum);
  assert.deepEqual(first.metrics.falsePositiveReduction, { baselineFalsePositiveBurden: 1, withheldNonTrading: 1, rate: 1, effectiveSampleSize: 1 });
  assert.deepEqual(first.metrics.genuineCreatorRecall, { genuineCreators: 1, retainedCreators: 1, rate: 1, confirmedCreators: 1, confirmedRate: 1, effectiveSampleSize: 1 });
  assert.deepEqual(first.metrics.projectedEnrichmentReduction, { baselineEligible: 2, avoided: 1, rate: .5 });
  assert.deepEqual(first.metrics.projectedReviewWorkloadReduction, { baselineEligible: 2, proposedReview: 0, avoided: 2, rate: 1 });
  assert.equal(first.servingAuthority, false);
  assert.equal(first.automaticPromotion, false);
  assert.equal(first.hypothesisAssessment.outcome, 'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(first.metrics.historicalEvidenceEligibility, { sealedExamples: 2, evaluatedExamples: 2, excludedExamples: 0, rate: 1 });
});

test('missing immutable creator evidence makes the hypothesis assessment insufficient', () => {
  const report = buildOfflineAdmissionV2Report({
    dataset: { id: 'dataset-1', key: 'fixed', version: 1, cutoffAt: '2026-01-01T00:00:00.000Z', checksum: 'dataset-checksum' },
    examples: [example()],
    excludedExamples: Array.from({ length: 10 }, (_, index) => ({ exampleKey: `missing-${index}`, channelId: `channel-${index}`, reasonCode: 'CREATOR_FOCUS_SNAPSHOT_MISSING' }))
  });
  assert.equal(report.hypothesisAssessment.outcome, 'INSUFFICIENT_EVIDENCE');
  assert.ok(report.hypothesisAssessment.reasonCodes.includes('HISTORICAL_CREATOR_EVIDENCE_COVERAGE_INSUFFICIENT'));
});

test('historical loader uses a read-only transaction and contains no write statement', () => {
  const source = readFileSync(new URL('./offlineV2Store.ts', import.meta.url), 'utf8');
  assert.match(source, /BEGIN TRANSACTION READ ONLY/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i);
});
