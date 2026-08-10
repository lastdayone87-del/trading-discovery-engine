import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStage1ToSealedResult } from './stage1SealedDatasetReplay';

const base = (overrides: any = {}) => ({
  decision: 'ADMIT_REVIEW',
  reasonCodes: ['PLAUSIBLE_TRADING_CREATOR_HYPOTHESIS'],
  creatorFocus: { tradingMass: .5, alternativeMass: .2 },
  ...overrides
});

test('dominant alternative creator focus withholds a labeled non-trading example', () => {
  const result = applyStage1ToSealedResult(base({ creatorFocus: { tradingMass: .05, alternativeMass: .9 } }));
  assert.equal(result.decision, 'WITHHOLD');
});

test('genuine trading hypothesis remains review-eligible', () => {
  const result = applyStage1ToSealedResult(base({ creatorFocus: { tradingMass: .6, alternativeMass: .2 } }));
  assert.equal(result.decision, 'ADMIT_REVIEW');
});

test('ambiguous review candidate defers rather than being admitted', () => {
  const result = applyStage1ToSealedResult(base({ creatorFocus: { tradingMass: .4, alternativeMass: .5 } }));
  assert.equal(result.decision, 'DEFER_INVESTIGATION');
});

test('capability failure cannot be promoted to WITHHOLD', () => {
  const result = applyStage1ToSealedResult(base({ reasonCodes: ['EVIDENCE_COVERAGE_INCOMPLETE'], creatorFocus: { tradingMass: .05, alternativeMass: .95 }, decision: 'DEFER_INVESTIGATION' }));
  assert.equal(result.decision, 'DEFER_INVESTIGATION');
});
