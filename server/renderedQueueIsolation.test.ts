import test from 'node:test';
import assert from 'node:assert/strict';
import { Configuration, RequestQueue, type Request } from 'crawlee';
import { openIsolatedRenderedRequestQueue } from './browserCommunityFallback';

// No-browser regression coverage for per-crawl RequestQueue isolation.
// Production proved repeat crawls of already-handled seed URLs resolve with
// zero requests/pages through the shared default persisted queue; these tests
// pin the isolation semantics with real Crawlee queues on throwaway
// pure-memory storage (persistStorage:false — never the repo ./storage,
// never a browser).

function isolatedTestConfig() {
  return { config: new Configuration({ persistStorage: false }) };
}

async function markHandled(queue: RequestQueue, url: string): Promise<void> {
  const added = await queue.addRequest({ url });
  assert.ok(added.requestId);
  await queue.markRequestHandled({ id: added.requestId!, uniqueKey: added.uniqueKey!, url } as Request);
}

async function fetchSoon(queue: RequestQueue): Promise<unknown> {
  // Freshly added requests can take a moment to become fetchable (storage
  // consistency delay); poll briefly instead of asserting timing behavior.
  for (let i = 0; i < 100; i++) {
    const next = await queue.fetchNextRequest();
    if (next) return next;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

test('shared queue reproduces the production skip: handled URL is not redispatched', async () => {
  const { config } = isolatedTestConfig();
  // Production shares one default queue per process (StorageManager cache).
  // Crawl 1 dispatches and handles the seed; crawl 2 finds nothing to fetch:
  // the handled request is filtered at fetch time, so the run resolves with
  // zero requests and zero errors — the exact production signature.
  const shared = await RequestQueue.open('shared-repro', { config });
  await markHandled(shared, 'https://repeat.example/community');
  assert.equal(await shared.fetchNextRequest(), null);
  // Control: the same URL on a queue where it was never handled IS fetchable.
  const control = await RequestQueue.open('shared-repro-control', { config });
  await control.addRequest({ url: 'https://repeat.example/community' });
  assert.ok(await fetchSoon(control));
  await shared.drop().catch(() => undefined);
  await control.drop().catch(() => undefined);
});

test('separate isolated queues dispatch the same URL in every invocation', async (t) => {
  const { config } = isolatedTestConfig();
  // Crawl invocation 1 handles the seed...
  const first = await RequestQueue.open('rendered-community-call-1', { config });
  await markHandled(first, 'https://retry.example/invite');
  await first.drop().catch(() => undefined);
  // ...retry invocation 2 (fresh isolated queue) dispatches it again.
  const second = await RequestQueue.open('rendered-community-call-2', { config });
  const readded = await second.addRequest({ url: 'https://retry.example/invite' });
  assert.equal(readded.wasAlreadyHandled, false);
  assert.ok(await fetchSoon(second));
  await second.drop().catch(() => undefined);
});

test('duplicate requests stay deduplicated within one crawl invocation', async (t) => {
  const { config } = isolatedTestConfig();
  const queue = await RequestQueue.open('rendered-community-single', { config });
  await queue.addRequest({ url: 'https://dup.example/page' });
  const duplicate = await queue.addRequest({ url: 'https://dup.example/page' });
  assert.equal(duplicate.wasAlreadyPresent, true);
  await queue.drop().catch(() => undefined);
});

test('queue opener mints a unique name per invocation', async () => {
  const seen: string[] = [];
  const fakeOpen = async (name: string) => {
    seen.push(name);
    return { drop: async () => undefined };
  };
  const first = await openIsolatedRenderedRequestQueue(fakeOpen);
  const second = await openIsolatedRenderedRequestQueue(fakeOpen);
  assert.match(first.name, /^rendered-community-[0-9a-z-]+$/);
  assert.notEqual(first.name, second.name);
  assert.equal(seen.length, 2);
});

test('crawler uses a per-invocation named queue and always drops it', async () => {
  // Wiring contract: construction receives an explicitly opened queue and a
  // finally guarantees drop() on every path, so named queues cannot
  // accumulate in storage.
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8'));
  assert.match(source, /openIsolatedRenderedRequestQueue\(\(name\) => RequestQueue\.open\(name\)\)/);
  assert.match(source, /requestQueue: isolated\.queue,/);
  assert.match(source, /await isolated\.queue\.drop\(\)\.catch\(\(\) => undefined\)/);
});
