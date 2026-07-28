import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateRetrievalLane } from './retrievalLanes';

test('video-first allocation converges without scheduling both lanes per run', () => {
  let videoRuns = 0;
  for (let totalRuns = 0; totalRuns < 100; totalRuns++) {
    if (allocateRetrievalLane(videoRuns, totalRuns, 70) === 'VIDEO') videoRuns++;
  }
  assert.equal(videoRuns, 70);
});

test('lane allocation honors channel-only and video-only configurations', () => {
  assert.equal(allocateRetrievalLane(0, 0, 0), 'CHANNEL');
  assert.equal(allocateRetrievalLane(0, 0, 100), 'VIDEO');
});
