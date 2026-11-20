import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeDeterministicCohort } from './deterministicEvaluation';

test('deterministic cohort summary separates hard false confirmations from finance-adjacent confusion', () => {
  const summary = summarizeDeterministicCohort([
    { truth: 'TRADING_RELEVANT', outcome: 'PASS', reasonCodes: ['DETERMINISTIC_FAST_PASS'] },
    { truth: 'TRADING_RELEVANT', outcome: 'REJECT', reasonCodes: ['FALSE_REJECT'] },
    { truth: 'TRADING_RELEVANT', outcome: 'AMBIGUOUS', reasonCodes: ['DETERMINISTIC_AMBIGUOUS'] },
    { truth: 'FINANCE_ADJACENT', outcome: 'PASS', reasonCodes: ['FINANCE_ADJACENT_PASS'] },
    { truth: 'UNRELATED', outcome: 'PASS', reasonCodes: ['HARD_FALSE_CONFIRM'] },
    { truth: 'UNRELATED', outcome: 'REJECT', reasonCodes: ['STRICT_REJECT'] },
    { truth: 'UNRELATED', outcome: 'AMBIGUOUS', reasonCodes: ['DETERMINISTIC_AMBIGUOUS'] },
  ]);
  assert.equal(summary.total, 7);
  assert.equal(summary.outcomes.PASS, 3);
  assert.equal(summary.outcomes.REJECT, 2);
  assert.equal(summary.outcomes.AMBIGUOUS, 2);
  assert.equal(summary.confirm.trueRelevant, 1);
  assert.equal(summary.confirm.falseRelevant, 2);
  assert.equal(summary.confirm.hardUnrelated, 1);
  assert.equal(summary.confirm.precision, 1 / 3);
  assert.equal(summary.reject.trueUnrelated, 1);
  assert.equal(summary.reject.falseTradingRelevant, 1);
  assert.equal(summary.reject.precision, 1 / 2);
  assert.equal(summary.abstain.tradingRelevant, 1);
  assert.equal(summary.abstain.financeAdjacent, 0);
  assert.equal(summary.reasonCodes.DETERMINISTIC_AMBIGUOUS, 2);
  assert.equal(summary.coverage.decisive, 5);
  assert.equal(summary.coverage.decisiveRate, 5 / 7);
});

test('an empty cohort reports null precision rather than a fabricated zero', () => {
  const summary = summarizeDeterministicCohort([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.confirm.precision, null);
  assert.equal(summary.reject.precision, null);
  assert.equal(summary.coverage.decisiveRate, null);
});
