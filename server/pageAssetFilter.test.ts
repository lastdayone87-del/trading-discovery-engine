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

test('dotless single-label hosts keep the existing static-attempt doctrine', () => {
  // isDotlessHostnameUrl semantics unchanged: these are NOT asset-filtered,
  // so the recall-safe static attempt path is preserved.
  assert.equal(isPageAssetInfrastructureUrl('https://g/'), false);
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
  const { runChannelInspection } = await import('./inspector');
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
