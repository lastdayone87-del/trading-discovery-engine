import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CRAWL_RESPONSE_CHARS, readBoundedResponseText } from './crawlResponseBounds';
import { crawlExternalLinks } from './inspector';

const htmlResponse = (html: string): Response =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });

test('small bodies pass through byte-identical (no behavior change below cap)', async () => {
  const html = '<html><body>hello https://discord.gg/abc123</body></html>';
  const text = await readBoundedResponseText(htmlResponse(html));
  assert.equal(text, html);
});

test('oversized bodies truncate at the cap instead of buffering fully', async () => {
  const padding = 'x'.repeat(MAX_CRAWL_RESPONSE_CHARS + 100_000);
  const html = `<html><body>prefix ${padding}</body></html>`;
  assert.ok(html.length > MAX_CRAWL_RESPONSE_CHARS);
  const text = await readBoundedResponseText(htmlResponse(html));
  assert.equal(text.length, MAX_CRAWL_RESPONSE_CHARS);
  assert.ok(text.startsWith('<html><body>prefix '));
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

test('custom cap is honored', async () => {
  const text = await readBoundedResponseText(htmlResponse('abcdef'), 3);
  assert.equal(text, 'abc');
});
