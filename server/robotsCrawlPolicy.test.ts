import assert from 'node:assert/strict';
import test from 'node:test';
import { crawlExternalLinks } from './inspector';
import { runChannelInspectionForTest } from './testCrawlHelpers';
import { RobotsCrawlPolicy, isRobotsCrawlEnforcementEnabled } from './robotsCrawlPolicy';

const resolver = async (): Promise<string[]> => ['93.184.216.1'];

function fetchRobots(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  })) as typeof fetch;
}

test('query-specific Disallow rules are matched with the query string', async () => {
  const policy = new RobotsCrawlPolicy(
    fetchRobots('User-agent: *\nDisallow: /search?q=discord\n'),
    resolver,
  );
  assert.equal((await policy.decide('https://creator.example/search?q=discord')).allowed, false);
  assert.equal((await policy.decide('https://creator.example/search?q=other')).allowed, true);
});

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

test('Crawl-delay closes its user-agent group before a following bot group', async () => {
  const policy = new RobotsCrawlPolicy(
    fetchRobots('User-agent: *\nCrawl-delay: 5\n\nUser-agent: bot\nDisallow: /private\n'),
    resolver,
  );
  assert.equal((await policy.decide('https://creator.example/private')).allowed, true);
  assert.equal((await policy.decide('https://creator.example/public')).allowed, true);
});

test('duplicate wildcard groups are merged instead of the first winning', async () => {
  const policy = new RobotsCrawlPolicy(
    fetchRobots('User-agent: *\nCrawl-delay: 1\n\nUser-agent: *\nDisallow: /private\n'),
    resolver,
  );
  assert.equal((await policy.decide('https://creator.example/private')).allowed, false);
  assert.equal((await policy.decide('https://creator.example/public')).allowed, true);
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

test('a robots-disallowed seed is not escalated to the rendered tier', async () => {
  const previous = process.env.CRAWLER_ROBOTS_ENFORCEMENT;
  process.env.CRAWLER_ROBOTS_ENFORCEMENT = 'true';
  let renderedCalls = 0;
  let pageFetched = false;
  try {
    const result = await runChannelInspectionForTest({
      channelId: 'UC_ROBOTS_BARRIER',
      channelName: 'Robots Barrier',
      channelBio: 'Trading education creator with an official website and community links.',
      channelLinks: ['https://creator.example/private'],
      videoDescriptions: ['one', 'two', 'three', 'four', 'five'],
      videoDescriptionsAuthoritative: true,
      creatorLikelyTrading: true,
      externalFetchImpl: (async (input) => {
        const url = String(input);
        if (url.endsWith('/robots.txt')) {
          return new Response('User-agent: *\nDisallow: /private\n', { status: 200, headers: { 'content-type': 'text/plain' } });
        }
        pageFetched = true;
        return new Response('<a href="https://discord.gg/MUSTNOTRENDER">Discord</a>', { status: 200, headers: { 'content-type': 'text/html' } });
      }) as typeof fetch,
      renderedFallback: async () => {
        renderedCalls += 1;
        return { foundInvite: null, inspectedPages: 1, scrolls: 0, clicks: 0, complete: true, retryable: false, detail: 'stub', candidates: [], telemetry: { mode: 'RENDERED' } } as any;
      },
    });
    assert.equal(pageFetched, false, 'the disallowed seed must not be fetched');
    assert.ok(result.acquisitionOutcomes?.some(outcome => outcome.requestedUrl === 'https://creator.example/private' && outcome.failureClass === 'ROBOTS_DISALLOWED'), 'the policy exclusion must be persisted as an observation');
    assert.equal(renderedCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.CRAWLER_ROBOTS_ENFORCEMENT;
    else process.env.CRAWLER_ROBOTS_ENFORCEMENT = previous;
  }
});

test('a redirect into a disallowed path is stopped before contact', async () => {
  const previous = process.env.CRAWLER_ROBOTS_ENFORCEMENT;
  process.env.CRAWLER_ROBOTS_ENFORCEMENT = 'true';
  const requested: string[] = [];
  try {
    const result = await crawl('https://creator.example/allowed', (async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /private\n', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      if (url === 'https://creator.example/allowed') {
        return new Response('', { status: 302, headers: { location: '/private/discord' } });
      }
      return new Response('<a href="https://discord.gg/MUSTNOTFETCH">Discord</a>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch);
    assert.deepEqual(result.candidates, []);
    assert.equal(requested.includes('https://creator.example/private/discord'), false);
    assert.equal(result.observations[0]?.failureClass, 'ROBOTS_DISALLOWED');
  } finally {
    if (previous === undefined) delete process.env.CRAWLER_ROBOTS_ENFORCEMENT;
    else process.env.CRAWLER_ROBOTS_ENFORCEMENT = previous;
  }
});

test('a disallowed child does not suppress a separate root block escalation', async () => {
  const { isExternalBlockEscalation } = await import('./inspector');
  const blocked = (requestedUrl: string, failureClass: string) => ({
    requestedUrl,
    rootUrl: 'https://linktr.ee/creator',
    outcome: 'ACQUISITION_FAILED',
    retryable: true,
    httpStatus: 403,
    failureClass,
    detail: '',
    observedAt: '',
    surface: 'CREATOR_WEBSITES',
    required: false,
  } as any);
  assert.equal(isExternalBlockEscalation({
    outcome: 'PARTIALLY_INSPECTED',
    observations: [
      blocked('https://linktr.ee/private', 'ROBOTS_DISALLOWED'),
      blocked('https://linktr.ee/creator', 'HTTP_ERROR'),
    ],
  }, 'https://linktr.ee/creator'), true, 'the root 403 still justifies escalation');
  assert.equal(isExternalBlockEscalation({
    outcome: 'PARTIALLY_INSPECTED',
    observations: [blocked('https://linktr.ee/creator', 'ROBOTS_DISALLOWED')],
  }, 'https://linktr.ee/creator'), false, 'a disallowed root is terminal');
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
