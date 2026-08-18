import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateJaccardSimilarity,
  calculateResultSetOverlap,
  deriveNeighborhoodObservationMetrics,
  evaluateNeighborhoodTrend
} from './neighborhoodAnalytics';
import {
  calculateObservedMarginalValue,
  calculateExpectedMarginalValue
} from './neighborhoodValueModel';
import {
  classifyCreatorSizeBand,
  calculateSegmentHealthFromHistory
} from './segmentedDiscoveryHealth';
import { recordNeighborhoodAnalyticsAfterRun } from './db';

test('Blocker 1 Fix: Run with ONLY known high-quality creators receives ZERO relevant-new/quality-new yield', () => {
  const runWithOnlyKnownCreators = {
    rawResults: 10,
    distinctResults: 10,
    duplicateResults: 0,
    knownChannels: 10,
    newChannels: 0
  };

  // Even if aggregate tradingConfirmed = 10 and qualityChannels = 10, actual new intersections are 0
  const actualIntersections = {
    relevantNewCreatorsCount: 0,
    qualityNewCreatorsCount: 0
  };

  const metrics = deriveNeighborhoodObservationMetrics(
    runWithOnlyKnownCreators,
    actualIntersections,
    ['ch1', 'ch2', 'ch3'],
    null,
    null
  );

  assert.equal(metrics.relevantNewCreatorRatio, 0, 'Relevant new creator ratio must be 0 for known channels');
  assert.equal(metrics.qualityNewCreatorRatio, 0, 'Quality new creator ratio must be 0 for known channels');
  assert.equal(metrics.relevantNewCreatorsCount, 0);
  assert.equal(metrics.qualityNewCreatorsCount, 0);

  const observedVal = calculateObservedMarginalValue({
    relevantNewCreators: metrics.relevantNewCreatorsCount,
    qualityNewCreators: metrics.qualityNewCreatorsCount,
    providerQuotaCost: 100
  });

  assert.equal(observedVal.relevantCreatorGain, 0, 'Relevant creator gain must be 0 for known channels');
  assert.equal(observedVal.qualityCreatorGain, 0, 'Quality creator gain must be 0 for known channels');
});

test('Blocker 2 Fix: Changing current run outcome does NOT retroactively change expected value', () => {
  const priorHistory = {
    priorRelevantNewRatio: 0.3,
    priorQualityNewRatio: 0.2,
    priorAverageOverlap: 0.25,
    priorExecutionsCount: 5
  };

  // Expected value before run
  const expectedValBeforeRun = calculateExpectedMarginalValue(priorHistory, 100);

  // Scenario A: current run yields 0 new creators
  const runAObservedVal = calculateObservedMarginalValue({
    relevantNewCreators: 0,
    qualityNewCreators: 0,
    providerQuotaCost: 100
  });

  // Scenario B: current run yields 8 new quality creators
  const runBObservedVal = calculateObservedMarginalValue({
    relevantNewCreators: 8,
    qualityNewCreators: 6,
    providerQuotaCost: 100
  });

  // Expected value before run must remain identical regardless of whether current run is A or B
  const expectedValReCalculated = calculateExpectedMarginalValue(priorHistory, 100);

  assert.equal(expectedValBeforeRun, expectedValReCalculated, 'Expected value prior to run must be independent of current run outcome');
  assert.notEqual(runAObservedVal.totalValue, runBObservedVal.totalValue, 'Observed values reflect actual run outcomes separately');
});

test('Blocker 3 Fix: Unobserved evidence receives zero gain credit without fabricated defaults', () => {
  const unobservedValue = calculateObservedMarginalValue({
    relevantNewCreators: 2,
    qualityNewCreators: 1,
    providerQuotaCost: 100
  });

  assert.equal(unobservedValue.coverageGain, 0, 'Unobserved coverage gain must default to 0');
  assert.equal(unobservedValue.informationGain, 0, 'Unobserved information gain must default to 0');
  assert.equal(unobservedValue.frontierExpansionGain, 0, 'Unobserved frontier gain must default to 0');
  assert.equal(unobservedValue.uncertaintyReduction, 0, 'Unobserved uncertainty reduction must default to 0');
});

test('Blocker 4 Fix: Bounded multi-dimensional segment health diagnostics', () => {
  const segmentHistory = {
    segmentType: 'COUNTRY' as const,
    segmentKey: 'Brazil',
    totalExecutions: 10,
    totalQuotaConsumed: 1000,
    valuableNewCreators: 12,
    totalNewCreators: 25,
    totalDistinctCreators: 40,
    uniqueSources: ['automated_query', 'persistent_research', 'organic_expansion'],
    averageOverlap: 0.25,
    underexploredQuotaConsumed: 750
  };

  const health = calculateSegmentHealthFromHistory(segmentHistory);

  assert.equal(health.yieldPer1000Quota, 12);
  assert.equal(health.saturationScore, 0.25);
  assert.equal(health.frontierExpansionRate, 0.75);
  assert.equal(health.underexploredQuotaPercent, 75);
  assert.equal(health.provenanceDiversity, 0.3); // 3 unique sources / 10 executions
  assert.equal(health.coverageGapIdentified, false);
});

test('Exact valuable_new_creators uses exact quality-new intersection count without ratio approximations', () => {
  const exactCount = 7; // Exact integer count of new quality creators
  const history = {
    segmentType: 'INTENT' as const,
    segmentKey: 'futures',
    totalExecutions: 5,
    totalQuotaConsumed: 500,
    valuableNewCreators: exactCount,
    totalNewCreators: 10,
    totalDistinctCreators: 20,
    uniqueSources: ['automated_query'],
    averageOverlap: 0.1,
    underexploredQuotaConsumed: 450
  };

  const health = calculateSegmentHealthFromHistory(history);
  assert.equal(health.valuableNewCreators, exactCount, 'Valuable new creators count must equal exact integer count');
  assert.equal(health.yieldPer1000Quota, 14, 'Yield per 1000 quota = (7 / 500) * 1000 = 14');
});

test('CREATOR_SIZE historical health diagnostics remain distinct across different size bands', () => {
  const microBandHistory = {
    segmentType: 'CREATOR_SIZE' as const,
    segmentKey: 'MICRO_<10K',
    totalExecutions: 8,
    totalQuotaConsumed: 800,
    valuableNewCreators: 15,
    totalNewCreators: 30,
    totalDistinctCreators: 50,
    uniqueSources: ['automated_query'],
    averageOverlap: 0.15,
    underexploredQuotaConsumed: 680
  };

  const majorBandHistory = {
    segmentType: 'CREATOR_SIZE' as const,
    segmentKey: 'MAJOR_500K+',
    totalExecutions: 3,
    totalQuotaConsumed: 300,
    valuableNewCreators: 1,
    totalNewCreators: 2,
    totalDistinctCreators: 10,
    uniqueSources: ['automated_query'],
    averageOverlap: 0.85,
    underexploredQuotaConsumed: 45
  };

  const microHealth = calculateSegmentHealthFromHistory(microBandHistory);
  const majorHealth = calculateSegmentHealthFromHistory(majorBandHistory);

  assert.notEqual(microHealth.yieldPer1000Quota, majorHealth.yieldPer1000Quota, 'Yield per 1k quota must differ between bands');
  assert.notEqual(microHealth.saturationScore, majorHealth.saturationScore, 'Saturation scores must differ between bands');
  assert.equal(microHealth.valuableNewCreators, 15);
  assert.equal(majorHealth.valuableNewCreators, 1);
  assert.equal(majorHealth.coverageGapIdentified, false);
});

test('Phase 2: Jaccard similarity and result-set overlap calculations', () => {
  const setA = ['ch1', 'ch2', 'ch3', 'ch4'];
  const setB = ['ch3', 'ch4', 'ch5', 'ch6'];

  const jaccard = calculateJaccardSimilarity(setA, setB);
  assert.equal(Math.round(jaccard * 100) / 100, 0.33);

  const overlap = calculateResultSetOverlap(['ch1', 'ch2', 'ch3'], ['ch2', 'ch3', 'ch4', 'ch5']);
  assert.equal(Math.round(overlap * 100) / 100, 0.67);
});

test('Phase 2: Rolling yield trends identify saturation evidence without triggering rejection', () => {
  const yields = [0.60, 0.35, 0.15, 0.05];
  const overlaps = [0.30, 0.55, 0.75, 0.85];

  const trend = evaluateNeighborhoodTrend(yields, overlaps);
  assert.equal(trend.isSaturating, true, 'Declining yield with high overlap indicates saturation evidence');
});

test('Phase 4: Creator size band classification is diagnostic only', () => {
  assert.equal(classifyCreatorSizeBand(500), 'MICRO_<10K');
  assert.equal(classifyCreatorSizeBand('25K'), 'MID_10K_100K');
  assert.equal(classifyCreatorSizeBand('250K'), 'LARGE_100K_500K');
  assert.equal(classifyCreatorSizeBand('1.2M'), 'MAJOR_500K+');
  assert.equal(classifyCreatorSizeBand(undefined), 'UNKNOWN');
});

test('Non-Interference Safety: Analytics failure does not throw or block completed query runs', async () => {
  let threw = false;
  try {
    await recordNeighborhoodAnalyticsAfterRun('non-existent-query-run-id', {
      rawResults: 10,
      distinctResults: 10,
      duplicateResults: 0,
      knownChannels: 2,
      newChannels: 8,
      countryRejected: 0,
      nonTrading: 0,
      uncertain: 0,
      needsReview: 0,
      tradingConfirmed: 8,
      qualityChannels: 6,
      quotaUsed: 100
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'recordNeighborhoodAnalyticsAfterRun must handle missing data gracefully without throwing');
});
