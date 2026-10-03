import test from 'node:test';
import assert from 'node:assert/strict';
import { isPageAssetInfrastructureUrl } from './communitySurfacePolicy';
import { parseYouTubeChannelAboutFromHtml } from './youtubePublicAbout';

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
