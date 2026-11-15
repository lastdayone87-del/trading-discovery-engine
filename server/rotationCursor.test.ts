import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRotationCursor } from './rotationCursor';

test('rotation cursors are finite non-negative integers', () => {
  assert.equal(normalizeRotationCursor('0'), 0);
  assert.equal(normalizeRotationCursor('3'), 3);
  assert.equal(normalizeRotationCursor('3.9'), 3);
  assert.equal(normalizeRotationCursor('-2'), 0);
  assert.equal(normalizeRotationCursor('NaN'), 0);
  assert.equal(normalizeRotationCursor('Infinity'), 0);
  assert.equal(normalizeRotationCursor(undefined), 0);
  assert.equal(normalizeRotationCursor('not-a-number'), 0);
});
