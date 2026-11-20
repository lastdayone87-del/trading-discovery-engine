import test from 'node:test';
import assert from 'node:assert/strict';
import { admissionShortcutEligible } from './ingestionPipeline';

const base = {
  admissionConfirmedTrading: true,
  admissionDecisionId: 'decision-1',
  admissionDecisionSource: 'SEMANTIC' as const,
};

test('semantic admission never uses the confirmation shortcut', () => {
  assert.equal(admissionShortcutEligible(base, 'ACTIVE'), false);
  assert.equal(admissionShortcutEligible({ ...base, admissionConfirmedTrading: false }, 'ACTIVE'), false);
  assert.equal(admissionShortcutEligible({ ...base, admissionDecisionId: undefined }, 'ACTIVE'), false);
});

test('deterministic and human admissions are already final relevance decisions', () => {
  assert.equal(admissionShortcutEligible({ ...base, admissionDecisionSource: 'DETERMINISTIC' }, 'ACTIVE'), true);
  assert.equal(admissionShortcutEligible({ ...base, admissionDecisionSource: 'HUMAN' }, 'ACTIVE'), true);
  assert.equal(admissionShortcutEligible({ ...base, admissionDecisionSource: undefined }, 'ACTIVE'), false);
  assert.equal(admissionShortcutEligible({ ...base, admissionDecisionSource: 'DETERMINISTIC' }, 'OFF'), false);
});
