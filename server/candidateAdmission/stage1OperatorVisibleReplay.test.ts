import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyStage1Decision } from './stage1OperatorVisibleReplay';

test('dominant alternative creator focus becomes WITHHOLD', () => {
  const result = applyStage1Decision({
    channelId: 'non-trading', decision: 'DEFER_INVESTIGATION',
    reasonCodes: ['NO_TERMINAL_DECISION', 'TRADING_HYPOTHESIS_NOT_YET_PLAUSIBLE'],
    tradingMass: 0.1, alternativeMass: 0.85
  });
  assert.equal(result.decision, 'WITHHOLD');
});

test('capability failures remain deferred even with alternative mass', () => {
  const result = applyStage1Decision({
    channelId: 'insufficient', decision: 'DEFER_INVESTIGATION',
    reasonCodes: ['EVIDENCE_COVERAGE_INCOMPLETE'], tradingMass: 0.05, alternativeMass: 0.9
  });
  assert.equal(result.decision, 'DEFER_INVESTIGATION');
});

test('plausible trading review remains admitted for review', () => {
  const result = applyStage1Decision({
    channelId: 'trading', decision: 'ADMIT_REVIEW', reasonCodes: ['PLAUSIBLE_TRADING_CREATOR_HYPOTHESIS'],
    tradingMass: 0.55, alternativeMass: 0.2
  });
  assert.equal(result.decision, 'ADMIT_REVIEW');
});

test('ambiguous review is deferred when alternative focus is stronger', () => {
  const result = applyStage1Decision({
    channelId: 'mixed', decision: 'ADMIT_REVIEW', reasonCodes: ['PLAUSIBLE_TRADING_CREATOR_HYPOTHESIS'],
    tradingMass: 0.4, alternativeMass: 0.45
  });
  assert.equal(result.decision, 'DEFER_INVESTIGATION');
});

test('replay remains explicitly read-only and non-serving', () => {
  const source = readFileSync(new URL('./stage1OperatorVisibleReplay.ts', import.meta.url), 'utf8');
  assert.match(source, /evaluateOperatorVisibleAssertionReplay/);
  assert.match(source, /readOnly: true/);
  assert.match(source, /servingAuthority: false/);
  assert.match(source, /automaticPromotion: false/);
  assert.doesNotMatch(source, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(source, /\bUPDATE\s+\w+/i);
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
});
