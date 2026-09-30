import assert from 'node:assert/strict';
import test from 'node:test';
import { CONDITIONAL_PREREQUISITE_NOTES, isMechanismEnabled } from './conditionalMechanisms';

test('conditional mechanisms default to disabled', () => {
  assert.equal(isMechanismEnabled({ tosReviewed: false, evalHarnessReady: false, explicitlyEnabled: false, extraSatisfied: false }), false);
  assert.equal(isMechanismEnabled({ tosReviewed: true, evalHarnessReady: true, explicitlyEnabled: true, extraSatisfied: false }), false);
  assert.equal(isMechanismEnabled({ tosReviewed: true, evalHarnessReady: true, explicitlyEnabled: true, extraSatisfied: true }), true);
});

test('every conditional mechanism documents prerequisites', () => {
  for (const note of Object.values(CONDITIONAL_PREREQUISITE_NOTES)) {
    assert.ok(note.length > 10);
  }
});
