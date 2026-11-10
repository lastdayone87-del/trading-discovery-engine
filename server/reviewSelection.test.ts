import assert from 'node:assert/strict';
import test from 'node:test';
import { canSubmitReviewForSelection } from '../src/reviewSelection';

test('a review can only be submitted for the selected pending channel', () => {
  const bundle = { review: { channelId: 'chan-1', state: 'PENDING' } };
  assert.equal(canSubmitReviewForSelection(bundle, 'chan-1'), true);
  assert.equal(canSubmitReviewForSelection(bundle, 'chan-2'), false);
  assert.equal(canSubmitReviewForSelection({ review: { channelId: 'chan-1', state: 'APPROVED' } }, 'chan-1'), false);
  assert.equal(canSubmitReviewForSelection(null, 'chan-1'), false);
});
