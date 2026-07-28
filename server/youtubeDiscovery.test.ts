import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDiscoveredChannels } from './youtube';

test('video lane extracts unique channels and retains matching video evidence', () => {
  const results = extractDiscoveredChannels([
    { id: { videoId: 'v1' }, snippet: { channelId: 'creator-1', channelTitle: 'Trader', title: 'DAX setup', description: 'first' } },
    { id: { videoId: 'v2' }, snippet: { channelId: 'creator-1', channelTitle: 'Trader', title: 'DAX analysis', description: 'second' } },
    { id: { videoId: 'v3' }, snippet: { channelId: 'creator-2', channelTitle: 'Other', title: 'Market structure' } }
  ], 'VIDEO', 'dax analyse');

  assert.equal(results.length, 2);
  assert.deepEqual(results[0].videoTitles, ['DAX setup', 'DAX analysis']);
  assert.deepEqual(results[0].videoDescriptions, ['first', 'second']);
});

test('channel lane preserves direct channel discovery behavior', () => {
  const results = extractDiscoveredChannels([
    { id: { channelId: 'creator-1' }, snippet: { title: 'Direct Trader', description: 'education' } }
  ], 'CHANNEL', 'trading education');
  assert.equal(results[0].channelId, 'creator-1');
  assert.deepEqual(results[0].videoTitles, ['trading education']);
});
