import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateNeighborhoodFrontierState,
  type NeighborhoodFrontierEvidence
} from './discoveryFrontierState';

test('Phase 5: Deterministic frontier state evaluation - UNEXPLORED for zero observations', () => {
  const evidence: NeighborhoodFrontierEvidence = {
    neighborhoodKey: 'US|en|trading|crypto|ORGANIC|RELEVANCE|none|automated',
    observationCount: 0,
    expectedMarginalValue: 0,
    observedMarginalValue: 0,
    relevantNewYield: 0,
    qualityNewYield: 0,
    knownCreatorRatio: 0,
    jaccardSimilarity: null,
    resultSetOverlap: null,
    recentYieldTrend: [],
    recentOverlapTrend: [],
    isSaturating: false,
    quotaEfficiency: 0
  };

  const evalResult = evaluateNeighborhoodFrontierState(evidence);
  assert.equal(evalResult.state, 'UNEXPLORED');
  assert.match(evalResult.reason, /No historical retrieval observations/i);
});

test('Phase 5: Sparse evidence (count < 3) produces PROBING state and does NOT falsely saturate', () => {
  const sparseEvidence: NeighborhoodFrontierEvidence = {
    neighborhoodKey: 'JP|ja|trading|forex|ORGANIC|RELEVANCE|none|automated',
    observationCount: 2,
    expectedMarginalValue: 10,
    observedMarginalValue: 5,
    relevantNewYield: 0.01,
    qualityNewYield: 0.0,
    knownCreatorRatio: 0.8,
    jaccardSimilarity: 0.85,
    resultSetOverlap: 0.90, // High overlap but only 2 observations!
    recentYieldTrend: [0.01, 0.01],
    recentOverlapTrend: [0.85, 0.90],
    isSaturating: true,
    quotaEfficiency: 0.1
  };

  const evalResult = evaluateNeighborhoodFrontierState(sparseEvidence);
  assert.equal(evalResult.state, 'PROBING');
  assert.match(evalResult.reason, /Sparse evidence/i);
  assert.notEqual(evalResult.state, 'SATURATED', 'Sparse evidence must NOT falsely classify as SATURATED');
});

test('Phase 5: Historically productive territory that begins saturating transitions to MAINTENANCE', () => {
  const maintenanceEvidence: NeighborhoodFrontierEvidence = {
    neighborhoodKey: 'GB|en|investing|stocks|ORGANIC|RELEVANCE|none|automated',
    observationCount: 10,
    expectedMarginalValue: 20,
    observedMarginalValue: 2,
    relevantNewYield: 0.02,
    qualityNewYield: 0.01,
    knownCreatorRatio: 0.85,
    jaccardSimilarity: 0.80,
    resultSetOverlap: 0.82,
    recentYieldTrend: [0.30, 0.25, 0.15, 0.05, 0.02], // Declining yield
    recentOverlapTrend: [0.20, 0.40, 0.60, 0.75, 0.82],
    isSaturating: true,
    quotaEfficiency: 5.0 // Historical productivity
  };

  const evalResult = evaluateNeighborhoodFrontierState(maintenanceEvidence);
  assert.equal(evalResult.state, 'MAINTENANCE');
  assert.match(evalResult.reason, /transitioned to maintenance monitoring/i);
});

test('Phase 5: High relevant/quality creator yield evaluates to PRODUCTIVE state', () => {
  const productiveEvidence: NeighborhoodFrontierEvidence = {
    neighborhoodKey: 'BR|pt|trading|daytrade|ORGANIC|RELEVANCE|none|automated',
    observationCount: 5,
    expectedMarginalValue: 35,
    observedMarginalValue: 40,
    relevantNewYield: 0.25,
    qualityNewYield: 0.15,
    knownCreatorRatio: 0.20,
    jaccardSimilarity: 0.15,
    resultSetOverlap: 0.10,
    recentYieldTrend: [0.20, 0.22, 0.25, 0.24, 0.25],
    recentOverlapTrend: [0.10, 0.12, 0.10, 0.11, 0.10],
    isSaturating: false,
    quotaEfficiency: 12.5
  };

  const evalResult = evaluateNeighborhoodFrontierState(productiveEvidence);
  assert.equal(evalResult.state, 'PRODUCTIVE');
  assert.match(evalResult.reason, /Sustained high relevant\/quality creator yield/i);
});

test('Phase 5: High cost zero yield with extreme redundancy evaluates to HARMFUL state', () => {
  const harmfulEvidence: NeighborhoodFrontierEvidence = {
    neighborhoodKey: 'IN|hi|trading|options|ORGANIC|RELEVANCE|none|automated',
    observationCount: 5,
    expectedMarginalValue: 0,
    observedMarginalValue: 0,
    relevantNewYield: 0.0,
    qualityNewYield: 0.0,
    knownCreatorRatio: 0.05,
    jaccardSimilarity: 0.90,
    resultSetOverlap: 0.95,
    recentYieldTrend: [0, 0, 0, 0, 0],
    recentOverlapTrend: [0.9, 0.9, 0.95, 0.95, 0.95],
    isSaturating: true,
    quotaEfficiency: 0
  };

  const evalResult = evaluateNeighborhoodFrontierState(harmfulEvidence);
  assert.equal(evalResult.state, 'HARMFUL');
  assert.match(evalResult.reason, /High quota expenditure with zero relevant\/quality yields/i);
});
