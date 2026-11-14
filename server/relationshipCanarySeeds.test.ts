import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSelectedCountries,
  relationshipSeedSweepProgress,
} from './relationshipCanarySeeds';

test('relationship seed selection rejects malformed or non-string settings', () => {
  assert.deepEqual(parseSelectedCountries('["Ireland","New Zealand"]'), ['Ireland', 'New Zealand']);
  assert.throws(() => parseSelectedCountries('{'), /DISCOVERY_SCOPE_SELECTION_MALFORMED/);
  assert.throws(() => parseSelectedCountries('{"country":"Ireland"}'), /DISCOVERY_SCOPE_SELECTION_MALFORMED/);
  assert.throws(() => parseSelectedCountries('["Ireland",42]'), /DISCOVERY_SCOPE_SELECTION_MALFORMED/);
  assert.throws(() => parseSelectedCountries('["Ireland",{"country":"France"}]'), /DISCOVERY_SCOPE_SELECTION_MALFORMED/);
  assert.deepEqual(parseSelectedCountries('["Ireland","ireland"]'), ['Ireland']);
  assert.deepEqual(parseSelectedCountries('["Not A Country"]'), []);
});

test('empty successful selections advance the sweep rotation', () => {
  assert.deepEqual(relationshipSeedSweepProgress({
    selectedCount: 2,
    completed: 2,
    failures: 0,
  }), { recordDay: true, cursorAdvance: 2 });
});

test('partial failures advance past completed countries and keep the day retryable', () => {
  assert.deepEqual(relationshipSeedSweepProgress({
    selectedCount: 2,
    completed: 1,
    failures: 1,
  }), { recordDay: false, cursorAdvance: 1 });
});

test('a fully failed window does not move the cursor or close the day', () => {
  assert.deepEqual(relationshipSeedSweepProgress({
    selectedCount: 2,
    completed: 0,
    failures: 2,
  }), { recordDay: false, cursorAdvance: 0 });
});
