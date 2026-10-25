import test from 'node:test';
import assert from 'node:assert/strict';
import { buildYouTubeDiscoveryTerminalError, extractDiscoveredChannels } from './youtube';

test('video lane extracts unique channels and retains matching video evidence', () => {
  const results = extractDiscoveredChannels([
    { id: { videoId: 'v1' }, snippet: { channelId: 'creator-1', channelTitle: 'Trader', title: 'DAX setup', description: 'first' } },
    { id: { videoId: 'v2' }, snippet: { channelId: 'creator-1', channelTitle: 'Trader', title: 'DAX analysis', description: 'second' } },
    { id: { videoId: 'v3' }, snippet: { channelId: 'creator-2', channelTitle: 'Other', title: 'Market structure' } }
  ], 'VIDEO', 'dax analyse');

  assert.equal(results.length, 2);
  assert.deepEqual(results[0].videoTitles, ['DAX setup', 'DAX analysis']);
  assert.deepEqual(results[0].videoDescriptions, ['first', 'second']);
  assert.equal(results[0].description, '');
  assert.deepEqual(results[0].matchedDocument, {type:'VIDEO',providerNativeId:'v1',title:'DAX setup',description:'first',publishedAt:undefined,locator:'youtube:video:v1'});
});

test('video lane keeps per-title IDs with descriptions', () => {
  const results = extractDiscoveredChannels([
    { id: { videoId: 'v1' }, snippet: { channelId: 'creator-1', channelTitle: 'Trader', title: 'DAX setup', description: 'first' } },
    { id: { videoId: 'v2' }, snippet: { channelId: 'creator-1', channelTitle: 'Trader', title: 'DAX analysis', description: 'second' } }
  ], 'VIDEO', 'dax analyse');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].videos, [
    { id: 'v1', title: 'DAX setup', description: 'first' },
    { id: 'v2', title: 'DAX analysis', description: 'second' },
  ]);
});

test('discovery terminal error preserves provider quota metadata', () => {
  const all = buildYouTubeDiscoveryTerminalError(2, 2) as Error & {
    quotaExceeded?: boolean;
    providerReasons?: string[];
  };
  assert.match(all.message, /quota exhaustion/);
  assert.equal(all.quotaExceeded, true);
  assert.deepEqual(all.providerReasons, ['quotaExceeded']);

  const some = buildYouTubeDiscoveryTerminalError(1, 2) as Error & { quotaExceeded?: boolean };
  assert.equal(some.quotaExceeded, true);

  const none = buildYouTubeDiscoveryTerminalError(0, 2) as Error & {
    quotaExceeded?: boolean;
    providerReasons?: string[];
  };
  assert.equal(none.quotaExceeded, undefined);
  assert.equal(none.providerReasons, undefined);
});

test('channel lane preserves direct channel discovery behavior', () => {
  const results = extractDiscoveredChannels([
    { id: { channelId: 'creator-1' }, snippet: { title: 'Direct Trader', description: 'education' } }
  ], 'CHANNEL', 'trading education');
  assert.equal(results[0].channelId, 'creator-1');
  // The search query is not a video title and must never carry VIDEO_TITLE
  // provenance downstream; retrieval context lives on matchedDocument.
  assert.deepEqual(results[0].videoTitles, []);
  assert.equal(results[0].description, 'education');
  assert.deepEqual(results[0].matchedDocument, {type:'CHANNEL',providerNativeId:'creator-1',title:'Direct Trader',description:'education',locator:'youtube:channel:creator-1'});
});
