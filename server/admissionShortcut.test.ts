import test from 'node:test';
import assert from 'node:assert/strict';
import { admissionShortcutEligible } from './ingestionPipeline';

const base = {
  admissionConfirmedTrading: true,
  admissionDecisionId: 'decision-1',
  admissionDecisionSource: 'SEMANTIC' as const,
  admissionTradingConfidence: 1,
};

test('semantic admission never uses the confirmation shortcut', () => {
  for (const confidence of [1, 5, 10, 96]) {
    assert.equal(admissionShortcutEligible({ ...base, admissionTradingConfidence: confidence }, 'ACTIVE'), false, String(confidence));
  }
  assert.equal(admissionShortcutEligible({ ...base, admissionConfirmedTrading: false }, 'ACTIVE'), false);
});

test('only high-confidence deterministic or human admissions may shortcut', () => {
  assert.equal(admissionShortcutEligible({ ...base, admissionDecisionSource: 'DETERMINISTIC', admissionTradingConfidence: 93 }, 'ACTIVE'), true);
  assert.equal(admissionShortcutEligible({ ...base, admissionDecisionSource: 'DETERMINISTIC', admissionTradingConfidence: 40 }, 'ACTIVE'), false);
  assert.equal(admissionShortcutEligible({ ...base, admissionDecisionSource: 'HUMAN', admissionTradingConfidence: 100 }, 'ACTIVE'), true);
  assert.equal(admissionShortcutEligible({ ...base, admissionDecisionSource: undefined, admissionTradingConfidence: 96 }, 'ACTIVE'), false);
  assert.equal(admissionShortcutEligible({ ...base, admissionDecisionSource: 'DETERMINISTIC', admissionTradingConfidence: 93 }, 'OFF'), false);
});
