import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const queueManager = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const activeProvider2Symbols = [
  'youtubeInnerTubeProvider',
  'youtubeInnerTubeEnrichment',
  'innerTubeLane',
  'YOUTUBE_INNERTUBE_',
  'YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED',
  'youtube_inner_tube_',
  'youtube_js_hybrid_enrichment_enabled',
  'fetchYouTubeChannelEnrichmentQuotaFree'
];

test('Provider2 is physically absent from active YouTube runtime and tooling', () => {
  for (const symbol of activeProvider2Symbols) {
    assert.equal(queueManager.includes(symbol), false, `queueManager still contains ${symbol}`);
    assert.equal(youtube.includes(symbol), false, `youtube runtime still contains ${symbol}`);
  }
  assert.equal(existsSync(new URL('./youtubeInnerTubeProvider.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('./youtubeInnerTubeEnrichment.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('../scripts/youtubeProviderBakeoff.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('../.github/workflows/youtube-provider-bakeoff.yml', import.meta.url)), false);
  assert.equal(pkg.dependencies?.['youtubei.js'], undefined);
  assert.equal(pkg.scripts?.['youtube:provider-bakeoff'], undefined);
});

test('durable autonomous discovery is official API only', () => {
  assert.match(queueManager, /providerQuotaUnits\s*=\s*100/);
  assert.match(queueManager, /searchYouTubeChannelPage/);
  assert.match(queueManager, /finishQuotaReservation\('AUTONOMOUS_QUERY_PAGE'/);
  assert.match(queueManager, /decision\.shouldContinue&&searchPage\?\.nextPageToken/);
  assert.match(queueManager, /const quotaConsumed=pageNumber\*100/);
  assert.match(queueManager, /via YOUTUBE_DATA_API/);
});

test('channel enrichment remains official and stage-costed', () => {
  assert.match(queueManager, /const enrichmentQuotaUnits=enrichmentStage>=2\?202:101/);
  assert.match(queueManager, /fetchYouTubeChannelEnrichment\(channelId, candidate,enrichmentStage\)/);
  assert.match(youtube, /channel-uploads/);
  assert.match(youtube, /enrichment-playlists/);
});
