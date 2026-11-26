import assert from 'node:assert/strict';
import test from 'node:test';
import { crawlExternalLinks } from './inspector';

const PUBLIC_IP = '93.184.216.1';
const publicResolver = async (): Promise<string[]> => [PUBLIC_IP];

function crawl(url: string, body: string, contentType: string) {
  return crawlExternalLinks(
    [url],
    [],
    undefined,
    (async () => new Response(body, {
      status: 200,
      headers: { 'content-type': contentType },
    })) as typeof fetch,
    'CREATOR_WEBSITES',
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    publicResolver,
  );
}

test('XHTML bodies are readable and retain native invites', async () => {
  const result = await crawl(
    'https://public.example/creator',
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><a href="https://discord.gg/XHTMLTYPE">Discord</a></body></html>',
    'application/xhtml+xml; charset=utf-8',
  );
  assert.equal(result.candidates[0]?.nativeInviteCode, 'XHTMLTYPE');
});

test('XML/RSS bodies are readable and retain native invites', async () => {
  const result = await crawl(
    'https://public.example/feed',
    '<?xml version="1.0"?><rss><channel><item><description><![CDATA[<a href="https://discord.gg/FEEDTYPE">Discord</a>]]></description></item></channel></rss>',
    'application/rss+xml; charset=utf-8',
  );
  assert.equal(result.candidates[0]?.nativeInviteCode, 'FEEDTYPE');
});

test('binary media stays unsupported', async () => {
  const result = await crawl(
    'https://public.example/image',
    'not html',
    'application/octet-stream',
  );
  assert.equal(result.observations[0]?.failureClass, 'UNSUPPORTED_CONTENT_TYPE');
});

test('an image/font/script response does not consume the static page budget', async () => {
  const previous = {
    pages: process.env.CRAWLER_PAGE_CAP,
    queue: process.env.CRAWLER_QUEUE_CAP,
  };
  // Six assets plus seven documents. If assets consume the 12-page budget,
  // the final `/invite` document is never fetched; with asset screening it is
  // reached because only documents count toward `explored`.
  process.env.CRAWLER_PAGE_CAP = '12';
  process.env.CRAWLER_QUEUE_CAP = '13';
  try {
    const rootLinks = [
      ...Array.from({ length: 6 }, (_, index) => `<a href="/asset/${index}">Community</a>`),
      ...Array.from({ length: 6 }, (_, index) => `<a href="/doc/${index}">Community</a>`),
      '<a href="/invite">Community</a>',
    ].join('');
    const result = await crawlExternalLinks(
      ['https://public.example/'],
      [],
      undefined,
      (async (input) => {
        const url = String(input);
        if (url === 'https://public.example/') {
          return new Response(rootLinks, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        if (url.startsWith('https://public.example/asset/')) {
          return new Response('binary', { status: 200, headers: { 'content-type': 'image/png' } });
        }
        if (url.startsWith('https://public.example/doc/')) {
          return new Response('<html><body>No invite</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        if (url === 'https://public.example/invite') {
          return new Response('<a href="https://discord.gg/ASSETBUDGET">Discord</a>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      }) as typeof fetch,
      'CREATOR_WEBSITES',
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      publicResolver,
    );
    assert.equal(result.candidates[0]?.nativeInviteCode, 'ASSETBUDGET');
    assert.ok((result.observations.find(observation => observation.failureClass === 'UNSUPPORTED_CONTENT_TYPE')?.telemetry?.dropReasons?.['asset-content-type'] || 0) > 0);
  } finally {
    if (previous.pages === undefined) delete process.env.CRAWLER_PAGE_CAP;
    else process.env.CRAWLER_PAGE_CAP = previous.pages;
    if (previous.queue === undefined) delete process.env.CRAWLER_QUEUE_CAP;
    else process.env.CRAWLER_QUEUE_CAP = previous.queue;
  }
});
