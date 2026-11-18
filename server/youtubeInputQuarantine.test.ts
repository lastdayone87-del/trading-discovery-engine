import test from 'node:test';
import assert from 'node:assert/strict';
import { isYouTubeInputQuarantineFailure, isYouTubeSearchQueryQuarantineFailure, YOUTUBE_INPUT_QUARANTINED_CODE } from './youtubeInputQuarantine';

test('quarantined input errors are recognized by their stable code', () => {
  assert.equal(YOUTUBE_INPUT_QUARANTINED_CODE, 'YOUTUBE_INPUT_QUARANTINED');
  assert.equal(isYouTubeInputQuarantineFailure({ code: YOUTUBE_INPUT_QUARANTINED_CODE }), true);
  assert.equal(isYouTubeInputQuarantineFailure(Object.assign(new Error('x'), { code: YOUTUBE_INPUT_QUARANTINED_CODE })), true);
  assert.equal(isYouTubeInputQuarantineFailure({ code: 'ETIMEDOUT' }), false);
  assert.equal(isYouTubeInputQuarantineFailure(null), false);
});

test('only search-query quarantines are terminal search failures', () => {
  assert.equal(isYouTubeSearchQueryQuarantineFailure({ code: YOUTUBE_INPUT_QUARANTINED_CODE, inputKind: 'searchQuery' }), true);
  assert.equal(isYouTubeSearchQueryQuarantineFailure({ code: YOUTUBE_INPUT_QUARANTINED_CODE, inputKind: 'channelId' }), false);
  assert.equal(isYouTubeSearchQueryQuarantineFailure({ code: YOUTUBE_INPUT_QUARANTINED_CODE }), false);
  assert.equal(isYouTubeSearchQueryQuarantineFailure({ code: 'ETIMEDOUT', inputKind: 'searchQuery' }), false);
});
