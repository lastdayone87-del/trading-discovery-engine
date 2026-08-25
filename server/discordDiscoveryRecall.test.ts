import test from 'node:test';
import assert from 'node:assert/strict';
import { runChannelInspection } from './inspector';
import type { BrowserFallbackResult } from './browserCommunityFallback';

const emptyRendered = async (seedUrl: string): Promise<BrowserFallbackResult> => ({
  foundInvite: null,
  foundLocation: seedUrl,
  inspectedPages: 1,
  scrolls: 0,
  clicks: 0,
  complete: true,
  retryable: false,
  detail: 'test rendered surface inspected without invite',
});

const staticHtml = async (_url: string | URL | Request): Promise<Response> => new Response('<html><body>no invite</body></html>', {
  status: 200,
  headers: { 'content-type': 'text/html' },
});

test('confirmed trading creator refreshes live About even when preloaded bio and links look complete', async () => {
  let aboutCalls = 0;
  const result = await runChannelInspection({
    channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
    channelBio: 'This is a sufficiently long preloaded trading creator biography.',
    channelLinks: ['https://example.com'],
    videoDescriptions: Array.from({ length: 5 }, (_, i) => `preloaded description ${i + 1}`),
    youtubeUrl: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
    creatorLikelyTrading: true,
    liveChannelDataLoader: async () => {
      aboutCalls++;
      return {
        bio: 'Current About metadata: join https://discord.gg/about-room',
        channelLinks: ['https://example.com'],
      };
    },
    recentVideoDescriptionsLoader: async () => [],
    externalFetchImpl: staticHtml as typeof fetch,
    renderedFallback: emptyRendered,
  });

  assert.equal(aboutCalls, 1);
  assert.equal(result.foundInvite, 'about-room');
  assert.equal(result.steps.find(step => step.step === 'BIO')?.status, 'FOUND');
});

test('authoritative newest video descriptions are refreshed and prioritized over stale preloaded descriptions', async () => {
  let recentCalls = 0;
  const stale = Array.from({ length: 10 }, (_, i) => `stale preloaded description ${i + 1}`);
  const result = await runChannelInspection({
    channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb',
    channelBio: 'Trading creator',
    channelLinks: [],
    videoDescriptions: stale,
    creatorLikelyTrading: true,
    recentVideoDescriptionsLoader: async () => {
      recentCalls++;
      return ['Newest video: Stay Connected — Join our Discord https://discord.gg/recent-room https://linktr.ee/example'];
    },
    externalFetchImpl: staticHtml as typeof fetch,
    renderedFallback: emptyRendered,
  });

  assert.equal(recentCalls, 1);
  assert.equal(result.foundInvite, 'recent-room');
  const videoStep = result.steps.find(step => step.step === 'VIDEO_DESCRIPTIONS');
  assert.equal(videoStep?.status, 'FOUND');
  assert.match(videoStep?.details || '', /Scanning 5 recent video descriptions/);
});

test('confirmed trading social profiles escalate from static inspection to rendered fallback', async () => {
  let renderedCalls = 0;
  const result = await runChannelInspection({
    channelId: 'UCcccccccccccccccccccccc',
    channelBio: 'Trading creator',
    channelLinks: ['https://instagram.com/exampletrader'],
    socialLinks: ['https://instagram.com/exampletrader'],
    creatorLikelyTrading: true,
    recentVideoDescriptionsLoader: async () => [],
    externalFetchImpl: staticHtml as typeof fetch,
    renderedFallback: async seedUrl => {
      renderedCalls++;
      return {
        foundInvite: 'social-room',
        foundLocation: seedUrl,
        inspectedPages: 1,
        scrolls: 1,
        clicks: 1,
        complete: true,
        retryable: false,
        detail: 'Discord invite discovered from rendered social profile',
      };
    },
  });

  assert.equal(renderedCalls, 1);
  assert.equal(result.foundInvite, 'social-room');
  assert.equal(result.steps.find(step => step.step === 'SOCIAL_BIO')?.status, 'FOUND');
});


test('encoded and protocol-relative community links are retained by shared extraction', async () => {
  const { extractEmbeddedUrls, extractDynamicTargetValues } = await import('./crawlerExtraction');
  assert.deepEqual(extractEmbeddedUrls('data-url="//linktr.ee/trader&amp;club"'), ['https://linktr.ee/trader&club']);
  assert.deepEqual(extractDynamicTargetValues('<div data-href="https://linktr.ee/community"></div>'), ['https://linktr.ee/community']);
});

test('YouTube video extraction tolerates multiple current page-shape variants and stays bounded', async () => {
  const { extractYouTubeVideoIds } = await import('./crawlerExtraction');
  const html = 'watch?v=aaaaaaaaaaa canonical /watch?list=x&v=bbbbbbbbbbb videoId":"ccccccccccc" youtu.be/ddddddddddd video_id: "eeeeeeeeeee"';
  assert.deepEqual(extractYouTubeVideoIds(html, 5), ['bbbbbbbbbbb', 'ccccccccccc', 'eeeeeeeeeee', 'ddddddddddd']);
  assert.equal(extractYouTubeVideoIds(html, 2).length, 2);
});

test('dynamic cross-domain community hub is followed within the existing bounded crawl', async () => {
  const result = await runChannelInspection({
    channelName: 'Dynamic Trading Creator',
    channelId: 'UC_dynamic_recall_test',
    channelBio: 'Trading creator',
    creatorLikelyTrading: false,
    channelLinks: ['https://creator.example/'],
    videoDescriptions: ['', '', '', '', ''],
    externalFetchImpl: async input => {
      const url = String(input);
      const html = url.includes('linktr.ee')
        ? '<html><body><a href="https://discord.gg/dynamic-room">Join community</a></body></html>'
        : '<html><body><div data-url="https://linktr.ee/trading-community">Community</div></body></html>';
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    },
  });
  assert.equal(result.foundInvite, 'dynamic-room');
  assert.equal(result.acquisitionStatus, 'FOUND');
});
