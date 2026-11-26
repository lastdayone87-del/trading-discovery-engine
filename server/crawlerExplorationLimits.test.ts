import assert from 'node:assert/strict';
import test from 'node:test';
import { crawlExternalLinks } from './inspector';
import { isCrawlerCanarySelected, mergeNavigationQueue, resolveCrawlerExplorationLimits } from './crawlerExplorationLimits';

const resolver = async (): Promise<string[]> => ['93.184.216.1'];

test('exploration limits preserve defaults and accept a canary expansion', () => {
  assert.deepEqual(resolveCrawlerExplorationLimits({}), { maxDepth: 2, queueCap: 12, pageCap: 12 });
  assert.deepEqual(
    resolveCrawlerExplorationLimits({ CRAWLER_MAX_DEPTH: '3', CRAWLER_QUEUE_CAP: '24', CRAWLER_PAGE_CAP: '30' }),
    { maxDepth: 3, queueCap: 24, pageCap: 30 },
  );
  assert.deepEqual(
    resolveCrawlerExplorationLimits({ CRAWLER_MAX_DEPTH: '99', CRAWLER_QUEUE_CAP: '1', CRAWLER_PAGE_CAP: 'x' }),
    { maxDepth: 8, queueCap: 12, pageCap: 12 },
  );
});

test('queue merging keeps the shallowest path and the highest score', () => {
  const merged = mergeNavigationQueue(
    [{ url: 'https://creator.example/hub', score: 10, depth: 1 }],
    [{ url: 'https://creator.example/hub', score: 90, depth: 3 }],
    12,
  );
  assert.equal(merged.queue.length, 1);
  assert.equal(merged.queue[0]?.score, 90);
  assert.equal(merged.queue[0]?.depth, 1);
  assert.equal(merged.overflow, 0);
});

test('queue merging applies the cap to the merged queue', () => {
  const existing = Array.from({ length: 12 }, (_, index) => ({
    url: `https://creator.example/${index}`,
    score: 10 + index,
    depth: 1,
  }));
  const merged = mergeNavigationQueue(existing, [
    { url: 'https://creator.example/new', score: 100, depth: 2 },
  ], 12);
  assert.equal(merged.queue.length, 12);
  assert.equal(merged.queue[0]?.url, 'https://creator.example/new');
  assert.equal(merged.overflow, 1);
});

test('frontier canary is deterministic and bounded', () => {
  assert.equal(isCrawlerCanarySelected('creator.example', 0), false);
  assert.equal(isCrawlerCanarySelected('creator.example', 10_000), true);
  const first = isCrawlerCanarySelected('creator.example', 500);
  assert.equal(isCrawlerCanarySelected('creator.example', 500), first);
  let selected = 0;
  for (let index = 0; index < 2_000; index++) if (isCrawlerCanarySelected(`site-${index}`, 500)) selected++;
  assert.ok(selected > 70 && selected < 130, `5% canary selected ${selected}/2000`);
});

test('canary depth 3 reaches an invite that default depth 2 misses', async () => {
  const previous = {
    depth: process.env.CRAWLER_MAX_DEPTH,
    queue: process.env.CRAWLER_QUEUE_CAP,
    pages: process.env.CRAWLER_PAGE_CAP,
  };
  const pages: Record<string, string> = {
    'https://creator.example/': '<a href="/a">Community</a>',
    'https://creator.example/a': '<a href="/b">Community</a>',
    'https://creator.example/b': '<a href="/c">Discord</a>',
    'https://creator.example/c': '<a href="https://discord.gg/DEPTHTHREE">Discord</a>',
  };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    return new Response(pages[url] || 'not found', {
      status: pages[url] ? 200 : 404,
      headers: { 'content-type': 'text/html' },
    });
  }) as typeof fetch;
  const run = () => crawlExternalLinks(
    ['https://creator.example/'],
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
    resolver,
  );
  try {
    delete process.env.CRAWLER_MAX_DEPTH;
    delete process.env.CRAWLER_QUEUE_CAP;
    delete process.env.CRAWLER_PAGE_CAP;
    const baseline = await run();
    assert.equal(baseline.candidates.length, 0, 'default depth 2 must not reach the depth-3 invite');
    process.env.CRAWLER_MAX_DEPTH = '3';
    process.env.CRAWLER_QUEUE_CAP = '13';
    process.env.CRAWLER_PAGE_CAP = '13';
    const result = await run();
    assert.equal(result.candidates[0]?.nativeInviteCode, 'DEPTHTHREE');
  } finally {
    if (previous.depth === undefined) delete process.env.CRAWLER_MAX_DEPTH;
    else process.env.CRAWLER_MAX_DEPTH = previous.depth;
    if (previous.queue === undefined) delete process.env.CRAWLER_QUEUE_CAP;
    else process.env.CRAWLER_QUEUE_CAP = previous.queue;
    if (previous.pages === undefined) delete process.env.CRAWLER_PAGE_CAP;
    else process.env.CRAWLER_PAGE_CAP = previous.pages;
  }
});
