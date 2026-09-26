import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');

test('official enrichment accounts expensive and cheap requests independently', () => {
  const start = youtube.indexOf('export async function fetchYouTubeChannelEnrichment(');
  const end = youtube.indexOf('/** One-unit basic metadata hydration used when country or subscriber evidence is missing. */', start);
  assert.ok(start >= 0 && end > start, 'official enrichment function boundary must remain discoverable');
  const official = youtube.slice(start, end);
  // Recent uploads resolve through the 1-unit uploads playlist
  // (channels.list contentDetails + playlistItems.list), never a 100-unit
  // search.list: the expensive call and its 100-unit accounting must be gone.
  assert.doesNotMatch(official, /'channel-uploads',100/);
  assert.match(official, /youtubeFetch\(buildYouTubeApiUrl\('playlistItems'[^;]*'channel-uploads',1,attempt/);
  const details = official.indexOf("youtubeFetch(channelUrl,'channel-details',1");
  const detailsAccounting = official.indexOf('await accountYouTubeQuotaResponse(channel', details);
  assert.ok(details >= 0 && detailsAccounting > details);
  assert.doesNotMatch(official, /incrementQuota\(101\)/);
  assert.match(official, /'enrichment-playlists',100[\s\S]*await accountYouTubeQuotaResponse\(playlistResponse, 100\)/);
  assert.match(official, /'enrichment-video-details',1[\s\S]*await accountYouTubeQuotaResponse\(videoResponse, 1\)/);
});

test('enrichment checkpoints publish only after quota accounting succeeds', () => {
  const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const start = youtube.indexOf('export async function fetchYouTubeChannelEnrichment(');
  const end = youtube.indexOf('/** One-unit basic metadata hydration used when country or subscriber evidence is missing. */', start);
  assert.ok(start >= 0 && end > start, 'official enrichment function boundary must remain discoverable');
  const official = youtube.slice(start, end);
  // No checkpoint may be assigned from an unaccounted provider response:
  // publishing first would let a later attempt skip the call with its unit
  // permanently unaccounted.
  assert.doesNotMatch(official, /Checkpoint\s*=\s*await/);
  // Every provider response is accounted through the same-response retry
  // helper (uploads-first channel, uploads, channel, playlists, details)
  // before its checkpoint publishes.
  const accounted = official.match(/await accountYouTubeQuotaResponse\(/g) || [];
  assert.ok(accounted.length >= 5, `expected >=5 accounted responses, found ${accounted.length}`);
});
