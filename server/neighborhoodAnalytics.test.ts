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
  calculateSegmentHealth
} from './segmentedDiscoveryHealth';
import { recordNeighborhoodAnalyticsAfterRun } from './db';

test('Phase 2: Jaccard similarity and result-set overlap calculations', () => {
  const setA = ['ch1', 'ch2', 'ch3', 'ch4'];
  const setB = ['ch3', 'ch4', 'ch5', 'ch6'];

  const jaccard = calculateJaccardSimilarity(setA, setB);
  // Intersection = {ch3, ch4} (2), Union = {ch1, ch2, ch3, ch4, ch5, ch6} (6) => 2/6 = 0.3333...
  assert.equal(Math.round(jaccard * 100) / 100, 0.33);

  const overlap = calculateResultSetOverlap(['ch1', 'ch2', 'ch3'], ['ch2', 'ch3', 'ch4', 'ch5']);
  // Overlap = {ch2, ch3} / 3 = 2/3 = 0.666...
  assert.equal(Math.round(overlap * 100) / 100, 0.67);
});

test('Phase 2: Rolling yield trends identify saturation evidence without triggering rejection', () => {
  const yields = [0.60, 0.35, 0.15, 0.05];
  const overlaps = [0.30, 0.55, 0.75, 0.85];

  const trend = evaluateNeighborhoodTrend(yields, overlaps);
  assert.equal(trend.isSaturating, true, 'Declining yield with high overlap indicates saturation evidence');
});

test('Phase 3: Shadow marginal value rewards relevant quality creators and penalizes redundancy', () => {
  const highQualityInput = {
    relevantNewCreators: 4,
    qualityNewCreators: 3,
    knownCreators: 1,
    coverageGain: 0.8,
    informationGain: 0.7,
    frontierExpansionGain: 0.6,
    uncertaintyReduction: 0.5,
    providerQuotaCost: 100,
    reviewUnitsCost: 0,
    redundancyRatio: 0.1
  };

  const highVal = calculateObservedMarginalValue(highQualityInput);

  const redundantLowQualityInput = {
    relevantNewCreators: 0,
    qualityNewCreators: 0,
    knownCreators: 10,
    coverageGain: 0.0,
    informationGain: 0.0,
    frontierExpansionGain: 0.0,
    uncertaintyReduction: 0.0,
    providerQuotaCost: 100,
    reviewUnitsCost: 2,
    redundancyRatio: 0.9
  };

  const lowVal = calculateObservedMarginalValue(redundantLowQualityInput);

  assert.ok(highVal.totalValue > 100, 'High quality discovery must yield strong positive marginal value');
  assert.equal(lowVal.totalValue, 0, 'Redundant low-quality discovery must receive zero marginal value');
});

test('Phase 3: Expected marginal value prioritizes underexplored high-yield territories', () => {
  const underexplored = calculateExpectedMarginalValue({ relevantNewRatio: 0.7, qualityNewRatio: 0.5, averageOverlap: 0.1 });
  const saturated = calculateExpectedMarginalValue({ relevantNewRatio: 0.05, qualityNewRatio: 0.01, averageOverlap: 0.85 });

  assert.ok(underexplored > saturated, 'Underexplored territory must have higher expected marginal value');
});

test('Phase 4: Creator size band classification is diagnostic only', () => {
  assert.equal(classifyCreatorSizeBand(500), 'MICRO_<10K');
  assert.equal(classifyCreatorSizeBand('25K'), 'MID_10K_100K');
  assert.equal(classifyCreatorSizeBand('250K'), 'LARGE_100K_500K');
  assert.equal(classifyCreatorSizeBand('1.2M'), 'MAJOR_500K+');
  assert.equal(classifyCreatorSizeBand(undefined), 'UNKNOWN');
});

test('Phase 4: Segmented discovery health correctly flags coverage gaps and yields', () => {
  const healthy = calculateSegmentHealth('COUNTRY', 'Germany', {
    valuableNewCreators: 8,
    totalQuotaConsumed: 500,
    underexploredQuotaConsumed: 300,
    averageOverlap: 0.2,
    uniqueSources: ['automated_query', 'persistent_research'],
    totalExecutions: 5
  });

  assert.equal(healthy.yieldPer1000Quota, 16);
  assert.equal(healthy.coverageGapIdentified, false);

  const gap = calculateSegmentHealth('COUNTRY', 'Nigeria', {
    valuableNewCreators: 0,
    totalQuotaConsumed: 200,
    underexploredQuotaConsumed: 10,
    averageOverlap: 0.8,
    uniqueSources: ['automated_query'],
    totalExecutions: 2
  });

  assert.equal(gap.coverageGapIdentified, true, 'Zero valuable creators or low underexplored quota must flag a coverage gap');
});

test('Non-Interference Safety: Analytics failure does not throw or block completed query runs', async () => {
  // Pass an invalid/non-existent queryRunId
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
