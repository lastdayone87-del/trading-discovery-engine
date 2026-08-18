import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTrialOutcomeState,
  type FrontierTrialMetrics
} from './discoveryFrontierTrials';

test('Phase 7: Trial outcome state classification - NOISY when zero distinct creators', () => {
  const metrics: FrontierTrialMetrics = {
    creatorsReturned: 0,
    distinctCreators: 0,
    newCreators: 0,
    relevantNewCreators: 0,
    qualityNewCreators: 0,
    knownChannelOverlap: 0,
    neighborhoodOverlap: 0,
    quotaConsumed: 100,
    marginalDiscoveryValue: 0,
    coverageGain: 0
  };

  const outcome = classifyTrialOutcomeState(metrics);
  assert.equal(outcome, 'NOISY');
});

test('Phase 7: Trial outcome state classification - PRODUCTIVE when relevant AND quality creators found', () => {
  const metrics: FrontierTrialMetrics = {
    creatorsReturned: 10,
    distinctCreators: 8,
    newCreators: 5,
    relevantNewCreators: 3,
    qualityNewCreators: 2,
    knownChannelOverlap: 0.2,
    neighborhoodOverlap: 0.15,
    quotaConsumed: 100,
    marginalDiscoveryValue: 35,
    coverageGain: 0.35
  };

  const outcome = classifyTrialOutcomeState(metrics);
  assert.equal(outcome, 'PRODUCTIVE');
});

test('Phase 7: Trial outcome state classification - PROMISING when relevant creators found without quality', () => {
  const metrics: FrontierTrialMetrics = {
    creatorsReturned: 10,
    distinctCreators: 8,
    newCreators: 4,
    relevantNewCreators: 2,
    qualityNewCreators: 0,
    knownChannelOverlap: 0.3,
    neighborhoodOverlap: 0.25,
    quotaConsumed: 100,
    marginalDiscoveryValue: 15,
    coverageGain: 0.25
  };

  const outcome = classifyTrialOutcomeState(metrics);
  assert.equal(outcome, 'PROMISING');
});

test('Phase 7: Trial outcome state classification - SATURATED when high overlap', () => {
  const metrics: FrontierTrialMetrics = {
    creatorsReturned: 10,
    distinctCreators: 8,
    newCreators: 1,
    relevantNewCreators: 0,
    qualityNewCreators: 0,
    knownChannelOverlap: 0.85,
    neighborhoodOverlap: 0.80,
    quotaConsumed: 100,
    marginalDiscoveryValue: 0,
    coverageGain: 0.05
  };

  const outcome = classifyTrialOutcomeState(metrics);
  assert.equal(outcome, 'SATURATED');
});

test('Phase 7: Trial outcome state classification - HARMFUL when high cost zero relevant with low known overlap', () => {
  const metrics: FrontierTrialMetrics = {
    creatorsReturned: 10,
    distinctCreators: 10,
    newCreators: 10,
    relevantNewCreators: 0,
    qualityNewCreators: 0,
    knownChannelOverlap: 0.05,
    neighborhoodOverlap: 0.05,
    quotaConsumed: 100,
    marginalDiscoveryValue: 0,
    coverageGain: 0.0
  };

  const outcome = classifyTrialOutcomeState(metrics);
  assert.equal(outcome, 'HARMFUL');
});
