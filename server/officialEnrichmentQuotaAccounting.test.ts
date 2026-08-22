import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');

test('official enrichment accounts expensive and cheap requests independently', () => {
  const start = youtube.indexOf('export async function fetchYouTubeChannelEnrichment(');
  const end = youtube.indexOf('/** One-unit basic metadata hydration used when country or subscriber evidence is missing. */', start);
  assert.ok(start >= 0 && end > start, 'official enrichment function boundary must remain discoverable');
  const official = youtube.slice(start, end);
  const uploads = official.indexOf("youtubeFetch(recentUrl,'channel-uploads',100");
  const uploadsAccounting = official.indexOf('incrementQuota(100,', uploads);
  const details = official.indexOf("youtubeFetch(channelUrl,'channel-details',1", uploads);
  const detailsAccounting = official.indexOf('incrementQuota(1,', details);
  assert.ok(uploads >= 0 && uploadsAccounting > uploads);
  assert.ok(details > uploadsAccounting && detailsAccounting > details);
  assert.doesNotMatch(official, /incrementQuota\(101\)/);
  assert.match(official, /'enrichment-playlists',100[\s\S]*incrementQuota\(100,/);
  assert.match(official, /'enrichment-video-details',1[\s\S]*incrementQuota\(1,/);
});
