import test from 'node:test';
import assert from 'node:assert/strict';
import { isPageAssetInfrastructureUrl } from './communitySurfacePolicy';
import { parseYouTubeChannelAboutFromHtml } from './youtubePublicAbout';
import type { SiteInspectionStore } from './siteInspectionCache';

test('page-asset infrastructure hosts are filtered', () => {
  assert.equal(isPageAssetInfrastructureUrl('https://i.ytimg.com/vi/abc/hqdefault.jpg'), true);
  assert.equal(isPageAssetInfrastructureUrl('https://rr1---sn-p5qs7n6y.googlevideo.com/initplayback?x=1'), true);
  assert.equal(isPageAssetInfrastructureUrl('https://schema.org/Person'), true);
  assert.equal(isPageAssetInfrastructureUrl('http://www.w3.org/2000/svg'), true);
  assert.equal(isPageAssetInfrastructureUrl('https://fonts.googleapis.com/css2?family=Roboto'), true);
  assert.equal(isPageAssetInfrastructureUrl('https://youtubei-att.googleapis.com/'), true);
  assert.equal(isPageAssetInfrastructureUrl('https://#'), true);
  assert.equal(isPageAssetInfrastructureUrl('not a url'), true);
});

test('valid creator, affiliate, social, and messaging hosts are preserved', () => {
  assert.equal(isPageAssetInfrastructureUrl('https://www.kiss.com/'), false);
  assert.equal(isPageAssetInfrastructureUrl('https://kiki.com/shop'), false);
  assert.equal(isPageAssetInfrastructureUrl('https://t.me/tradingroom'), false);
  assert.equal(isPageAssetInfrastructureUrl('https://discord.gg/abc123'), false);
  assert.equal(isPageAssetInfrastructureUrl('https://www.youtube.com/@SomeChannel'), false);
});

test('dotless single-label hosts are rejected by admission, not asset-filtered', () => {
  // isDotlessHostnameUrl semantics unchanged. Dotless hosts are NOT
  // asset-filtered here; they are rejected earlier by the crawl admission
  // boundary (`assessCrawlAdmission` → DOTLESS_HOST) before scoring/crawling.
  assert.equal(isPageAssetInfrastructureUrl('https://g/'), false);
});

test('media/CDN hosts are filtered while profile and invite hosts stay eligible', () => {
  for (const raw of [
    'https://scontent-lhr8-1.xx.fbcdn.net/v/t1.6435-9/abc.jpg',
    'https://scontent.cdninstagram.com/v/t51/abc.jpg',
    'https://pbs.twimg.com/media/abc.jpg',
    'https://yt3.ggpht.com/abc',
    'https://lh3.googleusercontent.com/abc',
    'https://res.cloudinary.com/demo/image/upload/sample.jpg',
    'https://creator.imgix.net/hero.jpg',
    'https://images.weserv.nl/?url=example.com/image.png',
    'https://i0.wp.com/example.com/image.png',
    'https://static.wixstatic.com/media/abc.png',
    'https://cdn.jsdelivr.net/npm/pkg/dist/app.js',
    'https://unpkg.com/pkg/dist/app.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pkg/app.js',
    'https://i.pinimg.com/abc.jpg',
    'https://media.licdn.com/dms/image/abc.jpg',
    'https://i.scdn.co/image/abc',
    'https://p16-sign.tiktokcdn.com/abc~tplv.jpg',
    'https://substackcdn.com/image/fetch/abc.png',
    'https://cdn.discordapp.com/attachments/1/2/file.png',
    'https://media.discordapp.net/attachments/1/2/file.png',
  ]) assert.equal(isPageAssetInfrastructureUrl(raw), true, raw);
  for (const raw of [
    'https://www.instagram.com/creator/',
    'https://x.com/creator',
    'https://discord.com/invite/abc123',
    'https://discordapp.com/invite/abc123',
    'https://discord.gg/abc123',
    'https://t.me/tradingroom',
    'https://linktr.ee/creator',
    'https://example.com/community',
  ]) assert.equal(isPageAssetInfrastructureUrl(raw), false, raw);
});

test('public-about extraction filters asset URLs so they cannot become crawl seeds', () => {
  const html = `<html><head></head><body><script>ytInitialData = {"a":{"urlEndpoint":{"url":"https://i.ytimg.com/vi/abc/hqdefault.jpg"}},"b":{"urlEndpoint":{"url":"https://www.kiss.com/"}},"c":{"channelExternalLinkViewModel":{"link":{"content":"https://kiki.com/shop"}}}};</script><a href="https://schema.org/Person">x</a><a href="https://t.me/tradingroom">join</a></body></html>`;
  const parsed = parseYouTubeChannelAboutFromHtml(html, {});
  const links = parsed.channelLinks || [];
  assert.ok(links.includes('https://www.kiss.com/'), 'creator link retained');
  assert.ok(links.includes('https://kiki.com/shop'), 'affiliate link retained');
  assert.ok(links.includes('https://t.me/tradingroom'), 'messaging link retained');
  assert.ok(!links.some(url => isPageAssetInfrastructureUrl(url)), 'no asset URL survives');
});

test('asset URLs in channelLinks and socialLinks never become crawl seeds', async () => {
  const { runChannelInspectionForTest: runChannelInspection } = await import('./testCrawlHelpers');
  const fetched: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    fetched.push(String(url));
    return new Response('<html><body>plain creator site</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  const store: SiteInspectionStore = {
    read: async () => [],
    write: async () => undefined,
    recordLinks: async () => undefined
  };
  const result = await runChannelInspection({
    channelId: 'UCAssetFilter00000001',
    channelName: 'Asset Filter Channel',
    channelBio: 'A sufficiently long creator biography for inspection testing purposes.',
    channelLinks: [
      'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      'https://rr1---sn-p5qs7n6y.googlevideo.com/initplayback?x=1',
      'https://schema.org/Person',
      'https://example-creator-site.test/'
    ],
    socialLinks: [
      'https://fonts.googleapis.com/css2?family=Roboto',
      'https://t.me/tradingroom'
    ],
    videoDescriptions: ['d1', 'd2', 'd3', 'd4', 'd5'],
    externalFetchImpl: fetchImpl,
    urlFailureHistoryLoader: async () => [],
    siteInspectionStore: store
  });
  assert.ok(fetched.some(url => url.includes('example-creator-site.test')), 'legit creator site crawled');
  assert.ok(fetched.some(url => url.includes('t.me')), 'messaging link crawled');
  for (const target of fetched) {
    assert.equal(isPageAssetInfrastructureUrl(target), false, `asset URL must never be fetched: ${target}`);
  }
  const seeds = (result.acquisitionOutcomes || []).map(outcome => outcome.requestedUrl);
  assert.ok(!seeds.some(url => isPageAssetInfrastructureUrl(url)), 'no asset seed recorded');
});

test('scheme-less creator links survive the filter', () => {
  assert.equal(isPageAssetInfrastructureUrl('example.com/community'), false);
  assert.equal(isPageAssetInfrastructureUrl('kiss.com'), false);
  assert.equal(isPageAssetInfrastructureUrl('t.me/tradingroom'), false);
});

test('google API infrastructure and trailing-dot hosts are filtered', () => {
  assert.equal(isPageAssetInfrastructureUrl('https://youtube.googleapis.com/youtube/v3/channels'), true);
  assert.equal(isPageAssetInfrastructureUrl('https://i.ytimg.com./vi/abc/hqdefault.jpg'), true);
  assert.equal(isPageAssetInfrastructureUrl('https://example-creator-site.test./'), false);
});
