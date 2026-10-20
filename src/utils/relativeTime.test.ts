import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFoundAgo } from './relativeTime';

const now = Date.parse('2026-10-20T18:00:00.000Z');

test('missing or invalid confirmation timestamps stay unavailable', () => {
  assert.equal(formatFoundAgo(null, now), null);
  assert.equal(formatFoundAgo(undefined, now), null);
  assert.equal(formatFoundAgo('not-a-date', now), null);
});

test('confirmation age is rendered from the supplied timestamp, not channel first_seen', () => {
  assert.equal(formatFoundAgo('2026-10-20T17:59:30.000Z', now), 'Found just now');
  assert.equal(formatFoundAgo('2026-10-20T17:45:00.000Z', now), 'Found 15m ago');
  assert.equal(formatFoundAgo('2026-10-20T12:00:00.000Z', now), 'Found 6h ago');
  assert.equal(formatFoundAgo('2026-10-15T18:00:00.000Z', now), 'Found 5d ago');
  assert.equal(formatFoundAgo('2026-08-01T18:00:00.000Z', now), 'Found 2mo ago');
  assert.equal(formatFoundAgo('2024-10-20T18:00:00.000Z', now), 'Found 2y ago');
});

test('future timestamps clamp instead of producing a negative age', () => {
  assert.equal(formatFoundAgo('2026-10-20T18:05:00.000Z', now), 'Found just now');
});
