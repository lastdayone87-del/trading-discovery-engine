import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateQuerySaturation, type QuerySaturationEvidence } from './querySaturation';

const base: QuerySaturationEvidence = {
  matureRuns: 10,
  pendingClassifications: 5,
  distinctResults: 100,
  freshRelevantCreators: 6,
  freshQualityCreators: 3,
  knownChannels: 40,
  duplicateResults: 20,
  evaluatedRawResults: 120,
  officialQuotaUnits: 1000,
  baselineFreshPerRun: 0.35,
};

test('productive mature query remains ACTIVE', () => {
  const decision = evaluateQuerySaturation(base);
  assert.equal(decision.state, 'ACTIVE');
  assert.equal(decision.metrics.freshPerRun, 0.6);
  assert.equal(decision.metrics.knownCreatorShare, 0.4);
});

test('mature low-yield high-known query becomes DORMANT', () => {
  const decision = evaluateQuerySaturation({
    ...base,
    freshRelevantCreators: 0,
    freshQualityCreators: 0,
    knownChannels: 95,
    duplicateResults: 50,
    evaluatedRawResults: 150,
  });
  assert.equal(decision.state, 'DORMANT');
  assert.ok(decision.reasons.includes('FRESH_CREATOR_YIELD_LCB_BELOW_BASELINE'));
  assert.ok(decision.reasons.includes('KNOWN_CREATOR_SHARE_HIGH'));
});

test('pending classification prevents a failure verdict', () => {
  const decision = evaluateQuerySaturation({
    ...base,
    freshRelevantCreators: 0,
    freshQualityCreators: 0,
    knownChannels: 95,
    pendingClassifications: 30,
  });
  assert.equal(decision.state, 'INSUFFICIENT_EVIDENCE');
  assert.ok(decision.reasons.includes('CLASSIFICATION_PENDING_EXCEEDS_POLICY'));
});

test('insufficient mature exposure never retires a query', () => {
  const decision = evaluateQuerySaturation({
    ...base,
    matureRuns: 3,
    freshRelevantCreators: 0,
    freshQualityCreators: 0,
    knownChannels: 95,
  });
  assert.equal(decision.state, 'INSUFFICIENT_EVIDENCE');
  assert.ok(decision.reasons.includes('INSUFFICIENT_MATURE_RUNS'));
});

test('low absolute volume at the country baseline is not penalized', () => {
  const decision = evaluateQuerySaturation({
    ...base,
    matureRuns: 8,
    freshRelevantCreators: 2,
    freshQualityCreators: 1,
    knownChannels: 60,
    baselineFreshPerRun: 0.25,
  });
  assert.equal(decision.state, 'ACTIVE');
});

test('high duplicate rate alone does not retire a productive query', () => {
  const decision = evaluateQuerySaturation({
    ...base,
    freshRelevantCreators: 6,
    knownChannels: 50,
    duplicateResults: 80,
    evaluatedRawResults: 180,
  });
  assert.equal(decision.state, 'ACTIVE');
  assert.ok(decision.reasons.length === 0 || decision.reasons.includes('DUPLICATE_RATE_HIGH'));
});

test('baseline is evaluated per run, not absolute creator volume', () => {
  const low = evaluateQuerySaturation({ ...base, freshRelevantCreators: 2, knownChannels: 95, baselineFreshPerRun: 0.5 });
  const high = evaluateQuerySaturation({ ...base, freshRelevantCreators: 2, knownChannels: 95, baselineFreshPerRun: 0.1 });
  assert.equal(low.state, 'DORMANT');
  assert.equal(high.state, 'ACTIVE');
});
