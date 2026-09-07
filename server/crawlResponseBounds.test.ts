import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CRAWL_RESPONSE_CHARS, readBoundedResponseText } from './crawlResponseBounds';
import { crawlExternalLinks, crawlMessagingPreview } from './inspector';
import { fetchLiveYouTubeChannelData } from './youtubePublicAbout';

const htmlResponse = (html: string): Response =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });

test('small bodies pass through byte-identical with truncated=false', async () => {
  const html = '<html><body>hello https://discord.gg/abc123</body></html>';
  const bounded = await readBoundedResponseText(htmlResponse(html));
  assert.equal(bounded.text, html);
  assert.equal(bounded.truncated, false);
});

test('oversized bodies truncate at the cap with truncated=true', async () => {
  const padding = 'x'.repeat(MAX_CRAWL_RESPONSE_CHARS + 100_000);
  const html = `<html><body>prefix ${padding}</body></html>`;
  assert.ok(html.length > MAX_CRAWL_RESPONSE_CHARS);
  const bounded = await readBoundedResponseText(htmlResponse(html));
  assert.equal(bounded.text.length, MAX_CRAWL_RESPONSE_CHARS);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.startsWith('<html><body>prefix '));
});

test('crawler still retains an early invite from an oversized page (recall preserved)', async () => {
  const invite = 'https://discord.gg/earlybird';
  const padding = 'y'.repeat(MAX_CRAWL_RESPONSE_CHARS + 50_000);
  const bigHtml = `<html><body><p>join ${invite}</p>${padding}</body></html>`;
  const fetchImpl = (async () => htmlResponse(bigHtml)) as unknown as typeof fetch;
  const result = await crawlExternalLinks(['https://creator.example/'], [], undefined, fetchImpl, 'CREATOR_WEBSITES');
  assert.equal(result.foundInvite, 'earlybird');
  assert.equal(result.outcome, 'FOUND');
});

test('evidence past the boundary never becomes a false definitive negative', async () => {
  // Invite lives beyond the cap: the prefix holds no evidence, so the crawl
  // must report incomplete coverage — never FOUND, never a clean no-match.
  const padding = 'z '.repeat(MAX_CRAWL_RESPONSE_CHARS / 2 + 50_000);
  const bigHtml = `<html><body>${padding}<p>join https://discord.gg/lateinvite</p></body></html>`;
  assert.ok(bigHtml.length > MAX_CRAWL_RESPONSE_CHARS);
  const fetchImpl = (async () => htmlResponse(bigHtml)) as unknown as typeof fetch;
  const result = await crawlExternalLinks(['https://creator.example/'], [], undefined, fetchImpl, 'CREATOR_WEBSITES');
  assert.equal(result.foundInvite, null);
  assert.equal(result.outcome, 'PARTIALLY_INSPECTED');
  assert.ok(result.observations.some(item => item.outcome === 'PARTIALLY_INSPECTED'));
});

test('truncated page with no invite stays partial and retry-eligible', async () => {
  const padding = 'w '.repeat(MAX_CRAWL_RESPONSE_CHARS / 2 + 50_000);
  const bigHtml = `<html><body>${padding}</body></html>`;
  const fetchImpl = (async () => htmlResponse(bigHtml)) as unknown as typeof fetch;
  const result = await crawlExternalLinks(['https://creator.example/'], [], undefined, fetchImpl, 'CREATOR_WEBSITES');
  assert.equal(result.outcome, 'PARTIALLY_INSPECTED');
  assert.ok(!result.observations.some(item => item.outcome === 'FOUND'));
});

test('truncated messaging preview stays retry-owned partial, never clean', async () => {
  const padding = 'v '.repeat(MAX_CRAWL_RESPONSE_CHARS / 2 + 50_000);
  const bigHtml = `<html><body>${padding}</body></html>`;
  const fetchImpl = (async () => htmlResponse(bigHtml)) as unknown as typeof fetch;
  const preview = await crawlMessagingPreview('https://t.me/creatorpreview', [], undefined, fetchImpl, 'CREATOR_WEBSITES');
  assert.equal(preview.truncated, true);
  assert.equal(preview.outcome, 'PARTIALLY_INSPECTED');
  assert.equal(preview.observations.length, 1);
  assert.equal(preview.observations[0].outcome, 'PARTIALLY_INSPECTED');
  assert.equal(preview.observations[0].required, true);
  assert.equal(preview.observations[0].retryable, true);
});

test('truncated About page with no usable evidence is a failed fetch, not definitive empty', async () => {
  const padding = 'lorem '.repeat(MAX_CRAWL_RESPONSE_CHARS / 6 + 20_000);
  const bigHtml = `<html><head><title>Channel</title></head><body>${padding}</body></html>`;
  assert.ok(bigHtml.length > MAX_CRAWL_RESPONSE_CHARS);
  const fetchImpl = (async () => htmlResponse(bigHtml)) as unknown as typeof fetch;
  const live = await fetchLiveYouTubeChannelData('https://www.youtube.com/channel/UC1234567890123456789012', false, fetchImpl);
  assert.equal(live, null);
});

test('truncated About page with early bio still returns its evidence', async () => {
  const padding = 'lorem '.repeat(MAX_CRAWL_RESPONSE_CHARS / 6 + 20_000);
  const bigHtml = `<html><head><meta name="description" content="Trading educator bio"></head><body>${padding}</body></html>`;
  const fetchImpl = (async () => htmlResponse(bigHtml)) as unknown as typeof fetch;
  const live = await fetchLiveYouTubeChannelData('https://www.youtube.com/channel/UC1234567890123456789012', false, fetchImpl);
  assert.ok(live);
  assert.equal(live.bio, 'Trading educator bio');
  assert.equal(live.truncated, true);
});

test('custom cap is honored', async () => {
  const bounded = await readBoundedResponseText(htmlResponse('abcdef'), 3);
  assert.equal(bounded.text, 'abc');
  assert.equal(bounded.truncated, true);
});

test('body of exactly cap size at EOF is complete, not truncated', async () => {
  const bounded = await readBoundedResponseText(htmlResponse('abc'), 3);
  assert.equal(bounded.text, 'abc');
  assert.equal(bounded.truncated, false);
});

test('body one char over cap is truncated', async () => {
  const bounded = await readBoundedResponseText(htmlResponse('abcd'), 3);
  assert.equal(bounded.text, 'abc');
  assert.equal(bounded.truncated, true);
});
