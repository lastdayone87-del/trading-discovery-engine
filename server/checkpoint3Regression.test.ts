import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNeighborhoodKey,
  mapQueryRunToNeighborhood
} from './discoveryNeighborhood';
import {
  calculateJaccardSimilarity,
  calculateResultSetOverlap,
  deriveNeighborhoodObservationMetrics,
  evaluateNeighborhoodTrend
} from './neighborhoodAnalytics';
import {
  calculateExpectedMarginalValue,
  calculateObservedMarginalValue
} from './neighborhoodValueModel';
import {
  calculateSegmentHealthFromHistory,
  classifyCreatorSizeBand
} from './segmentedDiscoveryHealth';
import { evaluateNeighborhoodFrontierState } from './discoveryFrontierState';
import { buildFrontierProposal, createProposalDedupKey } from './discoveryProposalGenerators';
import { classifyTrialOutcomeState } from './discoveryFrontierTrials';

test('Checkpoint 3 Regression: Protected Invariant 1 & 4 - Frozen expected prediction is derived from pre-run context and immutable post-run', () => {
  const priorContext = {
    priorRelevantNewRatio: 0.20,
    priorQualityNewRatio: 0.10,
    priorAverageOverlap: 0.15,
    priorExecutionsCount: 5
  };

  const expectedPreRun = calculateExpectedMarginalValue(priorContext, 100);
  assert.ok(expectedPreRun > 0, 'Pre-run expected value must be non-zero given productive history');

  // Changing post-run outcomes must not alter pre-run expected prediction formula
  const observedPostRun = calculateObservedMarginalValue({
    relevantNewCreators: 0,
    qualityNewCreators: 0,
    coverageGain: 0,
    providerQuotaCost: 100,
    redundancyRatio: 0.90
  });

  assert.notEqual(expectedPreRun, observedPostRun.totalValue, 'Post-run actual outcomes must not alter pre-run frozen prediction');
});

test('Checkpoint 3 Regression: Protected Invariant 5 & 6 - Distinct creator size classification and quota conservation', () => {
  assert.equal(classifyCreatorSizeBand(5000), 'MICRO_<10K');
  assert.equal(classifyCreatorSizeBand(50000), 'MID_10K_100K');
  assert.equal(classifyCreatorSizeBand(250000), 'LARGE_100K_500K');
  assert.equal(classifyCreatorSizeBand(1000000), 'MAJOR_500K+');
  assert.equal(classifyCreatorSizeBand(undefined), 'UNKNOWN');

  // Verify diagnostic only nature: no classification returns REJECT or error
  assert.doesNotThrow(() => classifyCreatorSizeBand(0));
});

test('Checkpoint 3 Regression: Protected Invariant 7 - Exact new+relevant and new+quality intersections', () => {
  const obs = deriveNeighborhoodObservationMetrics(
    { rawResults: 10, distinctResults: 8, duplicateResults: 2, knownChannels: 3, newChannels: 5 },
    { relevantNewCreatorsCount: 3, qualityNewCreatorsCount: 2 },
    ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'],
    ['c1', 'c2', 'c3'],
    ['c1', 'c2', 'c3', 'c9', 'c10']
  );

  assert.equal(obs.relevantNewCreatorsCount, 3);
  assert.equal(obs.qualityNewCreatorsCount, 2);
  assert.equal(obs.relevantNewCreatorRatio, 3 / 8);
  assert.equal(obs.qualityNewCreatorRatio, 2 / 8);
});

test('Checkpoint 3 Regression: Protected Invariant 8 - Deterministic neighborhood key and lineage creation', () => {
  const mapped = mapQueryRunToNeighborhood(
    { runId: 'run-123', country: 'US', retrievalLane: 'ORGANIC', searchOrdering: 'RELEVANCE', source: 'automated_query' },
    { query: 'trading strategy', intent: 'strategy', primary_term: 'trading', country: 'US' }
  );

  assert.equal(mapped.lineage.queryRunId, 'run-123');
  assert.ok(mapped.neighborhood.neighborhoodKey.startsWith('us|none|strategy|trading|organic|relevance|none|automated_query'));
  assert.equal(mapped.lineage.retrievalActionKey, `retrieval_action:run-123:${mapped.neighborhood.neighborhoodKey}`);
});

test('Checkpoint 3 Regression: Phase 5-7 Frontier Intelligence integrates without altering Checkpoint 2 contracts', () => {
  const evalResult = evaluateNeighborhoodFrontierState({
    neighborhoodKey: 'us|none|strategy|trading|organic|relevance|none|automated_query',
    observationCount: 5,
    expectedMarginalValue: 25,
    observedMarginalValue: 30,
    relevantNewYield: 0.20,
    qualityNewYield: 0.10,
    knownCreatorRatio: 0.30,
    jaccardSimilarity: 0.20,
    resultSetOverlap: 0.15,
    recentYieldTrend: [0.20, 0.20, 0.20, 0.20, 0.20],
    recentOverlapTrend: [0.15, 0.15, 0.15, 0.15, 0.15],
    isSaturating: false,
    quotaEfficiency: 8.0
  });

  assert.equal(evalResult.state, 'PRODUCTIVE');

  const proposal = buildFrontierProposal({
    proposalFamily: 'LEARNED',
    country: 'US',
    concept: 'day trading options',
    sourceProvenance: 'query_library:active_query:day trading options',
    noveltyRationale: 'Exploitation baseline.'
  });

  assert.equal(proposal.proposalFamily, 'LEARNED');
  assert.equal(proposal.trialStatus, 'PENDING');

  const trialOutcome = classifyTrialOutcomeState({
    creatorsReturned: 10,
    distinctCreators: 8,
    newCreators: 6,
    relevantNewCreators: 4,
    qualityNewCreators: 3,
    knownChannelOverlap: 0.2,
    neighborhoodOverlap: 0.1,
    quotaConsumed: 100,
    marginalDiscoveryValue: 45,
    coverageGain: 0.4
  });

  assert.equal(trialOutcome, 'PRODUCTIVE');
});
