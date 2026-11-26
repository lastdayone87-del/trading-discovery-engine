import assert from 'node:assert/strict';
import test from 'node:test';
import { crawlExternalLinks } from './inspector';

const publicResolver = async (): Promise<string[]> => ['93.184.216.1'];

function crawl(url: string, fetchImpl: typeof fetch) {
  return crawlExternalLinks(
    [url],
    [],
    undefined,
    fetchImpl,
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

test('a readable 403 body retains invite evidence', async () => {
  const result = await crawl('https://public.example/forbidden', (async () => new Response(
    '<html><body><a href="https://discord.gg/FORBIDDENBODY">Discord</a></body></html>',
    { status: 403, headers: { 'content-type': 'text/html' } },
  )) as typeof fetch);
  assert.equal(result.candidates[0]?.nativeInviteCode, 'FORBIDDENBODY');
});

test('a redirect target is scanned even when the final fetch is blocked', async () => {
  const result = await crawl('https://public.example/go', (async (input) => {
    const url = String(input);
    if (url === 'https://public.example/go') {
      return new Response('', { status: 302, headers: { location: 'https://discord.gg/REDIRECTED' } });
    }
    return new Response('blocked', { status: 403, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch);
  assert.equal(result.candidates[0]?.nativeInviteCode, 'REDIRECTED');
});
