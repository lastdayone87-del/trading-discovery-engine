/**
 * SSRF regressions for every creator-influenced acquisition path.
 *
 * The vulnerability fixed here was not a single missing URL check: admission
 * accepted private IP literals, destination selection only reused admission,
 * and the shared fetch followed redirects automatically. These tests cover
 * the synchronous admission boundary, DNS-resolved-private hostnames, manual
 * redirect validation, redirect loops, and the legitimate-public path that
 * must keep working.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCrawlAdmission } from './communitySurfacePolicy';
import { shouldFollowDestination } from './destinationPolicy';
import { crawlExternalLinks, crawlMessagingPreview, normalizeExternalUrl, runChannelInspection } from './inspector';
import { assessPublicDestination, isPublicInternetUrl, isPublicIpAddress } from './publicDestination';
import { createGuardedLookup } from './pinnedExternalFetch';
import { crawlRenderedCommunitySurface } from './browserCommunityFallback';
import { fetchProfilerUrl, runSiteProfiler } from './siteProfiler';

const PUBLIC_IP = '93.184.216.1';

const htmlResponse = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });

const redirectResponse = (location: string, status = 302): Response =>
  htmlResponse('', status, { location });

const publicResolver = async (): Promise<string[]> => [PUBLIC_IP];

test('private and reserved IPv4/IPv6 literals are rejected at admission and normalization', () => {
  const blocked = [
    'http://127.0.0.1/community',
    'http://10.0.0.5/community',
    'http://172.16.4.2/community',
    'http://192.168.1.10/community',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/community',
    'http://0.0.0.0/community',
    'http://127.1/community',
    'http://2130706433/community',
    'http://0x7f000001/community',
    'http://[::1]/community',
    'http://[fc00::1]/community',
    'http://[fe80::1]/community',
    'http://[::ffff:127.0.0.1]/community',
    'http://[2001:db8::1]/community',
    'http://[2002:7f00:1::]/community',
  ];
  for (const raw of blocked) {
    assert.deepEqual(assessCrawlAdmission(raw), { eligible: false, reasonCode: 'NON_PUBLIC_ADDRESS' }, raw);
    assert.equal(normalizeExternalUrl(raw), null, raw);
    assert.equal(shouldFollowDestination({ url: raw, currentUrl: 'https://creator.example/', anchorText: 'Join our Discord' }).eligible, false, raw);
  }
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicIpAddress('::ffff:8.8.8.8'), true);
  assert.equal(isPublicIpAddress('::ffff:10.0.0.5'), false);
});

test('connection-time DNS lookup rejects private and mixed answers (rebinding defense)', async () => {
  const resolveAtConnect = (addresses: Array<{ address: string; family: number }>): Promise<Array<{ address: string; family: number }>> =>
    new Promise((resolve, reject) => {
      const lookup = createGuardedLookup(async () => addresses);
      lookup('rebind.example', { all: true }, (error, result) => {
        if (error) reject(error);
        else resolve(result as Array<{ address: string; family: number }>);
      });
    });
  await assert.rejects(resolveAtConnect([{ address: '10.0.0.5', family: 4 }]), /Blocked non-public DNS answer/);
  await assert.rejects(
    resolveAtConnect([{ address: PUBLIC_IP, family: 4 }, { address: '127.0.0.1', family: 4 }]),
    /Blocked non-public DNS answer/,
  );
  assert.deepEqual(await resolveAtConnect([{ address: PUBLIC_IP, family: 4 }]), [{ address: PUBLIC_IP, family: 4 }]);
});

test('connection-time DNS lookup has a bounded deadline', async () => {
  const lookup = createGuardedLookup(async () => new Promise(() => {}), 20);
  const error = await new Promise<NodeJS.ErrnoException | null>(resolve => {
    lookup('slow.example', {}, value => resolve(value as NodeJS.ErrnoException | null));
  });
  assert.equal(error?.code, 'ETIMEDOUT');
});

test('public hostnames resolving to private or mixed answers fail closed before fetch', async () => {
  const privateResolve = async (host: string): Promise<string[]> => host === 'internal.example' ? ['10.0.0.5'] : [PUBLIC_IP];
  const mixedResolve = async (): Promise<string[]> => [PUBLIC_IP, '127.0.0.1'];
  const failedResolve = async (): Promise<string[]> => { throw new Error('NXDOMAIN'); };

  assert.deepEqual(
    await assessPublicDestination('https://internal.example/community', privateResolve),
    { allowed: false, reason: 'NON_PUBLIC_RESOLVED_ADDRESS', hostname: 'internal.example', addresses: ['10.0.0.5'] },
  );
  assert.equal(await isPublicInternetUrl('https://mixed.example/community', mixedResolve), false);
  assert.equal(await isPublicInternetUrl('https://dead.example/community', failedResolve), false);
  assert.equal(await isPublicInternetUrl('https://public.example/community', publicResolver), true);

  const stalledResolve = async (): Promise<string[]> => new Promise(() => {});
  const stalled = await assessPublicDestination('https://slow.example/community', stalledResolve, 20);
  assert.equal(stalled.allowed, false);
  assert.equal(stalled.reason, 'DNS_TIMEOUT');
  assert.equal(await isPublicInternetUrl('https://slow.example/community', stalledResolve, 20), false);

  const fetched: string[] = [];
  const result = await crawlExternalLinks(
    ['https://internal.example/community'],
    [],
    undefined,
    (async (input) => {
      fetched.push(String(input));
      return htmlResponse('https://discord.gg/should-not-be-reached');
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
    privateResolve,
  );
  assert.deepEqual(fetched, [], 'private DNS answer must be rejected before the request');
  assert.equal(result.observations[0]?.failureClass, 'SSRF_BLOCKED');
  assert.equal(result.observations[0]?.retryable, false);
});

test('child links to private destinations are dropped before enqueue and fetch', async () => {
  const fetched: string[] = [];
  const result = await crawlExternalLinks(
    ['https://public.example/'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://public.example/') {
        return htmlResponse('<a href="http://10.0.0.5/community">Join our Discord</a>');
      }
      return htmlResponse('https://discord.gg/private-child');
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
  assert.deepEqual(fetched, ['https://public.example/'], 'private child is never enqueued or fetched');
  assert.equal(result.outcome, 'INSPECTED_NO_MATCH');
});

test('redirects to private literals are rejected before the private URL is contacted', async () => {
  const fetched: string[] = [];
  const result = await crawlExternalLinks(
    ['https://public.example/community'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://public.example/community') return redirectResponse('http://127.0.0.1:9000/admin');
      return htmlResponse('https://discord.gg/private-hop');
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
  assert.deepEqual(fetched, ['https://public.example/community'], 'private redirect target is never fetched');
  assert.equal(result.observations[0]?.failureClass, 'SSRF_BLOCKED');
  assert.match(result.observations[0]?.detail || '', /Blocked redirect/);
});

test('redirects to hostnames resolving private are rejected before contact', async () => {
  const fetched: string[] = [];
  const resolve = async (host: string): Promise<string[]> =>
    host === 'private-redirect.example' ? ['10.9.9.9'] : [PUBLIC_IP];
  const result = await crawlExternalLinks(
    ['https://public.example/community'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://public.example/community') return redirectResponse('https://private-redirect.example/secret');
      return htmlResponse('https://discord.gg/private-hop');
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
    resolve,
  );
  assert.deepEqual(fetched, ['https://public.example/community']);
  assert.equal(result.observations[0]?.failureClass, 'SSRF_BLOCKED');
});

test('redirect DNS failures stay retryable instead of becoming SSRF blocks', async () => {
  const fetched: string[] = [];
  const resolve = async (host: string): Promise<string[]> => {
    if (host === 'broken-redirect.example') throw new Error('NXDOMAIN');
    return [PUBLIC_IP];
  };
  const result = await crawlExternalLinks(
    ['https://public.example/community'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://public.example/community') return redirectResponse('https://broken-redirect.example/next');
      return htmlResponse('https://discord.gg/never');
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
    resolve,
  );
  assert.deepEqual(fetched, ['https://public.example/community'], 'unresolvable redirect target is never contacted');
  assert.equal(result.observations[0]?.failureClass, 'NETWORK_FAILURE');
  assert.equal(result.observations[0]?.retryable, true);
});

test('crawler keeps the prior 20-hop redirect budget with a distinct limit class', async () => {
  const routes: Record<string, { status: number; body?: string; headers?: Record<string, string> }> = {};
  for (let i = 0; i < 25; i += 1) {
    routes[`https://public.example/hop${i}`] = { status: 302, headers: { location: `/hop${i + 1}` } };
  }
  const fetched: string[] = [];
  const result = await crawlExternalLinks(
    ['https://public.example/hop0'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      const route = routes[url];
      return route ? redirectResponse(route.headers!.location) : htmlResponse('never');
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
  assert.equal(fetched.length, 20, 'crawler redirect chain is bounded at the previous 20-hop budget');
  assert.equal(result.observations[0]?.failureClass, 'REDIRECT_LIMIT');
  assert.equal(result.observations[0]?.retryable, true);
});

test('crawler rejects stalled or unsupported final bodies without draining them', async () => {
  const neverEnding = () => new ReadableStream<Uint8Array>({ start() {} });
  const startedAt = Date.now();
  const rateLimited = await crawlExternalLinks(
    ['https://public.example/rate-limited'],
    [],
    undefined,
    (async () => new Response(neverEnding(), {
      status: 429,
      headers: { 'retry-after': '60', 'content-type': 'text/html' },
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
  const rateObservation = rateLimited.observations[0];
  assert.equal(rateObservation?.failureClass, 'RATE_LIMIT');
  assert.equal(rateObservation?.retryable, true);
  assert.ok(rateObservation?.retryAt, 'Retry-After survives a stalled error body');

  const binary = await crawlExternalLinks(
    ['https://public.example/binary'],
    [],
    undefined,
    (async () => new Response(neverEnding(), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
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
  assert.equal(binary.observations[0]?.failureClass, 'UNSUPPORTED_CONTENT_TYPE');
  assert.ok(Date.now() - startedAt < 2000, 'no stalled body consumed the fetch budget');
});

test('redirect loops terminate without contacting a private destination', async () => {
  const fetched: string[] = [];
  const result = await crawlExternalLinks(
    ['https://public.example/loop-a'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://public.example/loop-a') return redirectResponse('/loop-b');
      if (url === 'https://public.example/loop-b') return redirectResponse('/loop-a');
      return htmlResponse('https://discord.gg/never');
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
  assert.ok(fetched.length <= 2, `redirect loop is bounded, got ${fetched.length} requests`);
  assert.ok(!fetched.some(url => url.includes('127.0.0.1')));
  assert.equal(result.outcome, 'ACQUISITION_FAILED');
  assert.equal(result.observations[0]?.failureClass, 'REDIRECT_LOOP');
  assert.equal(result.observations[0]?.retryable, false);
});

test('legitimate public destinations still crawl and retain invites', async () => {
  const fetched: string[] = [];
  const result = await crawlExternalLinks(
    ['https://public.example/community'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://public.example/community') {
        return redirectResponse('/join');
      }
      return htmlResponse('<html><body>Join https://discord.gg/public-room</body></html>');
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
  assert.deepEqual(fetched, ['https://public.example/community', 'https://public.example/join']);
  assert.equal(result.outcome, 'FOUND');
  assert.equal(result.foundInvite, 'public-room');
});

test('messaging-preview fetches apply the initial destination guard', async () => {
  const fetched: string[] = [];
  const result = await crawlMessagingPreview(
    'http://169.254.169.254/latest/meta-data/',
    [],
    undefined,
    (async (input) => {
      fetched.push(String(input));
      return htmlResponse('https://discord.gg/metadata');
    }) as typeof fetch,
    'CREATOR_WEBSITES',
    undefined,
    publicResolver,
  );
  assert.deepEqual(fetched, []);
  assert.equal(result.outcome, 'ACQUISITION_FAILED');
  assert.equal(result.observations[0]?.failureClass, 'SSRF_BLOCKED');
});

test('static SSRF block is terminal and never escalates to rendered fallback', async () => {
  let renderedCalls = 0;
  const fetched: string[] = [];
  const result = await runChannelInspection({
    channelId: 'ssrf-terminal-render',
    channelName: 'SSRF Terminal',
    channelBio: 'Trading notes',
    channelLinks: ['https://internal.example/community'],
    videoDescriptions: ['one', 'two', 'three', 'four', 'five'],
    creatorLikelyTrading: true,
    destinationResolver: async () => ['10.0.0.5'],
    externalFetchImpl: (async (input) => {
      fetched.push(String(input));
      return htmlResponse('https://discord.gg/should-not-be-reached');
    }) as typeof fetch,
    renderedFallback: (async (seedUrl: string) => {
      renderedCalls += 1;
      return {
        foundInvite: null,
        foundLocation: seedUrl,
        inspectedPages: 1,
        scrolls: 0,
        clicks: 0,
        complete: true,
        retryable: false,
        detail: 'must not run after an SSRF block',
      };
    }) as never,
  });
  assert.equal(renderedCalls, 0, 'rendered escalation must not retry a blocked destination');
  assert.deepEqual(fetched, [], 'private-resolving seed is rejected before the static fetch');
  const blocked = (result.acquisitionOutcomes || []).filter(item => item.failureClass === 'SSRF_BLOCKED');
  assert.ok(blocked.length >= 1, 'the block remains visible in acquisition outcomes');
  assert.ok(blocked.every(item => item.retryable === false), 'SSRF blocks are non-retryable');
});

test('rendered fallback refuses a private seed before launching a browser', async () => {
  const result = await crawlRenderedCommunitySurface('http://169.254.169.254/latest/meta-data/', {
    resolveHost: publicResolver,
  });
  assert.equal(result.failureClass, 'SSRF_BLOCKED');
  assert.equal(result.retryable, false);
  assert.equal(result.inspectedPages, 0);
  assert.match(result.detail, /not a public destination/);
});

test('profiler transport failures preserve the security/transport cause', async () => {
  let captured: { name?: string; code?: string; causeCode?: string } | undefined;
  const fetchImpl = (async () => {
    const error = new Error('blocked at connect') as NodeJS.ErrnoException & { cause?: { code?: string } };
    error.name = 'TypeError';
    error.code = 'ESSRFBLOCKED';
    error.cause = { code: 'ESSRFBLOCKED' };
    throw error;
  }) as typeof fetch;
  const fetched = await fetchProfilerUrl(
    'https://public.example/community',
    fetchImpl,
    1000,
    1000,
    publicResolver,
    {},
    { onTransportError: failure => { captured = failure; } },
  );
  assert.equal(fetched, null);
  assert.equal(captured?.code, 'ESSRFBLOCKED');
  assert.equal(captured?.causeCode, 'ESSRFBLOCKED');
});

test('site-profiler seed DNS timeout is bounded and explicitly blocked', async () => {
  let fetches = 0;
  const startedAt = Date.now();
  const result = await runSiteProfiler(
    { siteIdentity: 'slow.example', identityTier: 'A', seedUrl: 'https://slow.example/' },
    {
      fetchImpl: (async () => {
        fetches += 1;
        return htmlResponse('never');
      }) as typeof fetch,
      resolveHost: async () => new Promise(() => {}),
      dnsTimeoutMs: 20,
    },
    async () => true,
  );
  const elapsed = Date.now() - startedAt;
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'DNS_TIMEOUT');
  assert.equal(fetches, 0, 'timed-out seed is never fetched');
  assert.ok(elapsed < 1000, `seed DNS deadline bounded the profiler, took ${elapsed}ms`);
});

test('site-profiler seed resolving private fetches nothing', async () => {
  let fetches = 0;
  const result = await runSiteProfiler(
    { siteIdentity: 'internal.example', identityTier: 'A', seedUrl: 'https://internal.example/' },
    {
      fetchImpl: (async () => {
        fetches += 1;
        return htmlResponse('<html><body>should not be reached</body></html>');
      }) as typeof fetch,
      resolveHost: async () => ['10.0.0.5'],
    },
    async () => true,
  );
  assert.equal(fetches, 0);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.profile, null);
  assert.equal(result.reason, 'NON_PUBLIC_RESOLVED_ADDRESS');
});
