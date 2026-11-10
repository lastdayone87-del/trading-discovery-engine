import assert from 'node:assert/strict';
import test from 'node:test';
import {
  creatorFocusSummary,
  parseReviewQueuePage,
  reviewQueuePageState,
  selectionAfterQueueLoad,
} from '../src/reviewQueue';

test('review queue pagination parses the durable total and filters malformed rows', () => {
  const page = parseReviewQueuePage<{ channelId: string; channelName: string }>({
    items: [
      { channelId: 'chan-1', channelName: 'One' },
      { channelName: 'missing id' },
      { channelId: 'chan-2', channelName: 'Two' },
    ],
    total: 120,
  });
  assert.deepEqual(page.items.map(item => item.channelId), ['chan-1', 'chan-2']);
  assert.equal(page.total, 120);
  assert.deepEqual(parseReviewQueuePage({ items: [{ channelId: 'chan-1' }] }), {
    items: [{ channelId: 'chan-1' }],
    total: 1,
  });
});

test('changing pages keeps or replaces the selection predictably', () => {
  const page = [{ channelId: 'chan-2' }, { channelId: 'chan-3' }];
  assert.equal(selectionAfterQueueLoad('chan-2', page), 'chan-2');
  assert.equal(selectionAfterQueueLoad('chan-1', page), 'chan-2');
  assert.equal(selectionAfterQueueLoad(null, []), null);
});

test('page transitions are derived from the current offset and total', () => {
  assert.deepEqual(reviewQueuePageState(0, 0), { page: 1, pageCount: 1 });
  assert.deepEqual(reviewQueuePageState(120, 50), { page: 2, pageCount: 3 });
  assert.deepEqual(reviewQueuePageState(120, 100), { page: 3, pageCount: 3 });
  assert.deepEqual(reviewQueuePageState(-1, -50), { page: 1, pageCount: 1 });
});

test('creator focus display summarizes the non-authoritative snapshot', () => {
  const summary = creatorFocusSummary({
    mode: 'SHADOW',
    proposed_status: 'TRADING_CONFIRMED',
    effective_status: 'UNCERTAIN',
    probability: 0.82,
    lower_confidence_bound: 0.64,
    document_keys: ['a', 'b'],
    assertion_keys: [],
    observed_at: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(summary, {
    mode: 'SHADOW',
    proposedStatus: 'TRADING_CONFIRMED',
    effectiveStatus: 'UNCERTAIN',
    probability: 0.82,
    lowerConfidenceBound: 0.64,
    documentCount: 2,
    assertionCount: 0,
    observedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(creatorFocusSummary(null), null);
});
