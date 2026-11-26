import assert from 'node:assert/strict';
import test from 'node:test';
import { crawlExternalLinks } from './inspector';
import { RobotsCrawlPolicy, isRobotsCrawlEnforcementEnabled } from './robotsCrawlPolicy';

const resolver = async (): Promise<string[]> => ['93.184.216.1'];

function fetchRobots(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  })) as typeof fetch;
}

test('explicit Disallow and Crawl-delay are enforced', async () => {
  const policy = new RobotsCrawlPolicy(
    fetchRobots('User-agent: *\nDisallow: /private\nCrawl-delay: 2\n'),
    resolver,
  );
  const allowed = await policy.decide('https://creator.example/public');
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'ALLOWED');
  assert.equal(allowed.crawlDelayMs, 2_000);

  const denied = await policy.decide('https://creator.example/private/page');
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'DISALLOWED');
});

test('403, 429, 5xx and unreachable robots are unavailable, not a block', async () => {
  for (const status of [403, 429, 500]) {
    const policy = new RobotsCrawlPolicy(fetchRobots('', status), resolver);
    const decision = await policy.decide('https://creator.example/community');
    assert.equal(decision.allowed, true, String(status));
    assert.equal(decision.reason, 'UNKNOWN', String(status));
  }
  const unreachable = new RobotsCrawlPolicy((async () => { throw new Error('network'); }) as typeof fetch, resolver);
  assert.equal((await unreachable.decide('https://creator.example/community')).allowed, true);
});

test('malformed robots is treated conservatively as unknown/allow', async () => {
  const policy = new RobotsCrawlPolicy(fetchRobots('User-agent: *\nDisallow /private\n'), resolver);
  const decision = await policy.decide('https://creator.example/private');
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'UNKNOWN');
});

test('robots policy is cached per origin', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('User-agent: *\nDisallow: /x\n', { status: 200, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const policy = new RobotsCrawlPolicy(fetchImpl, resolver);
  await policy.decide('https://creator.example/a');
  await policy.decide('https://creator.example/b');
  assert.equal(calls, 1);
});

test('enforcement defaults off and is enabled by the canary env', () => {
  assert.equal(isRobotsCrawlEnforcementEnabled({}), false);
  assert.equal(isRobotsCrawlEnforcementEnabled({ CRAWLER_ROBOTS_ENFORCEMENT: 'true' }), true);
  assert.equal(isRobotsCrawlEnforcementEnabled({ CRAWLER_ROBOTS_ENFORCEMENT: 'TRUE' }), true);
});

function crawl(url: string, fetchImpl: typeof fetch) {
  return crawlExternalLinks(
    [url], [], undefined, fetchImpl, 'CREATOR_WEBSITES', true,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, resolver,
  );
}

test('crawl path enforces explicit Disallow and records a policy exclusion', async () => {
  const previous = process.env.CRAWLER_ROBOTS_ENFORCEMENT;
  process.env.CRAWLER_ROBOTS_ENFORCEMENT = 'true';
  let pageFetched = false;
  try {
    const result = await crawl('https://creator.example/private', (async (input) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /private\n', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      pageFetched = true;
      return new Response('<a href="https://discord.gg/SHOULDNOT">Discord</a>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch);
    assert.equal(pageFetched, false);
    assert.equal(result.observations[0]?.failureClass, 'ROBOTS_DISALLOWED');
    assert.equal(result.candidates.length, 0);
  } finally {
    if (previous === undefined) delete process.env.CRAWLER_ROBOTS_ENFORCEMENT;
    else process.env.CRAWLER_ROBOTS_ENFORCEMENT = previous;
  }
});

test('crawl path allows a creator page when robots returns 403', async () => {
  const previous = process.env.CRAWLER_ROBOTS_ENFORCEMENT;
  process.env.CRAWLER_ROBOTS_ENFORCEMENT = 'true';
  try {
    const result = await crawl('https://creator.example/community', (async (input) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('', { status: 403 });
      return new Response('<a href="https://discord.gg/ALLOWEDAFTER403">Discord</a>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch);
    assert.equal(result.candidates[0]?.nativeInviteCode, 'ALLOWEDAFTER403');
  } finally {
    if (previous === undefined) delete process.env.CRAWLER_ROBOTS_ENFORCEMENT;
    else process.env.CRAWLER_ROBOTS_ENFORCEMENT = previous;
  }
});
