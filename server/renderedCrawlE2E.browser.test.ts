/**
 * Full-crawler real-browser E2E baseline (E2E-1..E2E-9).
 *
 * These tests call the production inspection entry point with the real
 * `crawlRenderedCommunitySurface` implementation. They do not inject a fake
 * rendered result. The only test seam is the browser egress proxy: fixture
 * hostnames resolve to a public test address through the same
 * `assessPublicDestination` guard used in production, and a test-only loopback
 * proxy forwards their HTTP requests to a local fixture origin. The production
 * proxy, route guard, page/click/scroll/time budgets and outcome mapping are
 * otherwise unchanged.
 *
 * Baseline rule: a fixture with relevant, eligible, uninspected work must not
 * resolve as a clean `INSPECTED_NO_MATCH`. E2E-9 is that acceptance gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { runChannelInspectionForTest, crawlExternalLinksForTest } from './testCrawlHelpers';
import { crawlRenderedCommunitySurface, type BrowserFallbackBudget, type BrowserFallbackResult } from './browserCommunityFallback';
import type { BrowserEgressProxy } from './browserEgressProxy';
import type { InspectionResult } from './inspector';

const MAIN = 'creator.test';
const HUB = 'hub.test';
const BROWSER_SKIP = process.platform === 'android';
const E2E_TIMEOUT = 180_000;

interface FixtureRoute {
  body: string | Buffer;
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
}

interface ProxyRequest {
  host: string;
  path: string;
}

function hostOf(value: string): string {
  return value.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

function page(body: string, head = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

class FixtureWorld {
  readonly routes = new Map<string, FixtureRoute>();
  readonly hosts = new Set<string>();
  readonly proxyRequests: ProxyRequest[] = [];
  readonly staticRequests: ProxyRequest[] = [];
  private server: http.Server | undefined;
  private port = 0;
  private readonly proxies = new Set<http.Server>();

  add(host: string, path: string, route: FixtureRoute): void {
    this.hosts.add(hostOf(host));
    this.routes.set(`${hostOf(host)}${path}`, route);
  }

  private routeFor(host: string, path: string): FixtureRoute | undefined {
    return this.routes.get(`${hostOf(host)}${path}`);
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((request, response) => {
      const host = hostOf(String(request.headers.host || ''));
      const url = new URL(request.url || '/', `http://${host || 'fixture.invalid'}`);
      const route = this.routeFor(host, url.pathname);
      if (!route) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('fixture route not found');
        return;
      }
      const headers: Record<string, string | number> = {
        'content-type': route.contentType || 'text/html; charset=utf-8',
        ...(route.headers || {}),
      };
      response.writeHead(route.status || 200, headers);
      response.end(route.body);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not expose a port');
    this.port = address.port;
  }

  async close(): Promise<void> {
    await Promise.all([...this.proxies].map(server => new Promise<void>(resolve => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })));
    this.proxies.clear();
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      await new Promise<void>(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    }
  }

  /** Static-tier fixture transport. It never touches the network; the
   * rendered tier below always does. Response.url intentionally stays empty so
   * the profiler keeps the synthetic requested URL as the final identity. */
  staticFetch: typeof fetch = async (input) => {
    const raw = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const parsed = new URL(raw);
    const host = hostOf(parsed.hostname);
    const route = this.routeFor(host, parsed.pathname);
    this.staticRequests.push({ host, path: parsed.pathname });
    if (!route) {
      return new Response('fixture route not found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return new Response(route.body, {
      status: route.status || 200,
      headers: {
        'content-type': route.contentType || 'text/html; charset=utf-8',
        ...(route.headers || {}),
      },
    });
  };

  /** Test-only egress proxy. It accepts absolute-form HTTP proxy requests for
   * fixture hosts only and forwards them to the local fixture origin. HTTPS
   * CONNECT is denied: these fixtures exercise the HTTP crawler path. */
  async startProxy(): Promise<BrowserEgressProxy> {
    const proxy = http.createServer((request, response) => {
      let target: URL;
      try {
        target = new URL(request.url || '/');
      } catch {
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('malformed proxy request');
        return;
      }
      const host = hostOf(target.hostname);
      if (!this.hosts.has(host)) {
        response.writeHead(403, { 'content-type': 'text/plain' });
        response.end('fixture host not allowed');
        return;
      }
      this.proxyRequests.push({ host, path: target.pathname });
      const headers: http.OutgoingHttpHeaders = { ...request.headers, host: target.host };
      for (const name of ['proxy-connection', 'connection', 'keep-alive', 'transfer-encoding']) {
        delete headers[name];
      }
      const upstream = http.request({
        host: '127.0.0.1',
        port: this.port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
      }, upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
        response.end('fixture upstream failed');
      });
      request.pipe(upstream);
    });
    proxy.on('connect', (_request, socket) => {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', () => resolve());
    });
    this.proxies.add(proxy);
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('fixture proxy did not expose a port');
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>(resolve => {
        this.proxies.delete(proxy);
        proxy.closeAllConnections?.();
        proxy.close(() => resolve());
      }),
    };
  }

  /**
   * Runs the production inspection path (`runChannelInspection`) with the real
   * rendered crawler. The rendered call is wrapped only to retain its result
   * for assertions; it is not replaced.
   */
  async inspect(
    seed: string,
    budget: Partial<BrowserFallbackBudget> = {},
    channelData: Record<string, unknown> = {},
  ): Promise<{ result: InspectionResult; rendered: BrowserFallbackResult[] }> {
    const rendered: BrowserFallbackResult[] = [];
    const renderedFallback = async (
      seedUrl: string,
      callerBudget: Partial<BrowserFallbackBudget> = {},
    ): Promise<BrowserFallbackResult> => {
      const result = await crawlRenderedCommunitySurface(seedUrl, {
        ...callerBudget,
        ...budget,
        resolveHost: async () => ['93.184.216.1'],
        egressProxyFactory: () => this.startProxy(),
      });
      rendered.push(result);
      return result;
    };
    const result = await runChannelInspectionForTest({
      channelId: 'UC_RENDERED_E2E_FIXTURE',
      channelBio: 'Trading education creator with an official website.',
      channelLinks: [seed],
      videoDescriptions: ['', '', '', '', ''],
      externalFetchImpl: this.staticFetch,
      creatorLikelyTrading: true,
      renderedFallback,
      ...channelData,
    });
    for (const [index, entry] of rendered.entries()) {
      const telemetry = entry.telemetry;
      console.log(`E2E_DIAG ${JSON.stringify({
        seed,
        index,
        inspectedPages: entry.inspectedPages,
        complete: entry.complete,
        retryable: entry.retryable,
        timedOut: entry.timedOut,
        failureClass: entry.failureClass,
        coverageReason: telemetry?.coverageReason,
        requestsStarted: telemetry?.requestsStarted,
        requestsFinished: telemetry?.requestsFinished,
        requestsFailed: telemetry?.requestsFailed,
        unresolvedFailedRequests: telemetry?.unresolvedFailedRequests,
        requiredTotal: entry.requiredTotal,
        requiredUnvisited: entry.requiredUnvisited,
        requiredTransientFailures: entry.requiredTransientFailures,
        requiredPermanentFailures: entry.requiredPermanentFailures,
        interactionGap: entry.interactionGap,
        controlsEnumeratedTotal: telemetry?.controlsEnumeratedTotal,
        controlsHintRejected: telemetry?.controlsHintRejected,
        controlsStructuralDisclosure: telemetry?.controlsStructuralDisclosure,
        controlsIconLabelRecovered: telemetry?.controlsIconLabelRecovered,
        popupTargets: telemetry?.popupTargets,
        popupCaptured: telemetry?.popupCaptured,
        popupDestinationsDropped: telemetry?.popupDestinationsDropped,
        revealedSameOriginAdmitted: telemetry?.revealedSameOriginAdmitted,
        revealedSameOriginDropped: telemetry?.revealedSameOriginDropped,
        opaqueInteractiveControls: telemetry?.opaqueInteractiveControls,
        frameCount: telemetry?.frameCount,
        shadowRootCount: telemetry?.shadowRootCount,
        closedShadowRootCount: telemetry?.closedShadowRootCount,
        dropReasons: entry.dropReasons,
        visitedUrls: entry.visitedUrls,
      })}`);
    }
    return { result, rendered };
  }
}

function websiteOutcomes(result: InspectionResult) {
  return (result.acquisitionOutcomes || []).filter(item => item.surface === 'CREATOR_WEBSITES');
}

function renderedOutcome(result: InspectionResult) {
  return websiteOutcomes(result).find(item => item.telemetry?.mode === 'RENDERED');
}

function coverageOf(result: InspectionResult): {
  status: string | undefined;
  failureClass: string | undefined;
  coverageReason: string | undefined;
  inspectedPages: number | undefined;
  complete: boolean | undefined;
  timedOut: boolean | undefined;
} {
  const outcome = renderedOutcome(result);
  return {
    status: result.acquisitionStatus,
    failureClass: outcome?.failureClass,
    coverageReason: outcome?.telemetry?.coverageReason,
    inspectedPages: outcome?.telemetry?.pagesInspected,
    complete: outcome?.telemetry ? outcome.telemetry.pagesInspected > 0 && !outcome.retryable : undefined,
    timedOut: outcome?.telemetry?.ceiling?.kind === 'total-timeout',
  };
}

function logResult(scenario: string, result: InspectionResult): void {
  const cover = coverageOf(result);
  console.log(`E2E_RESULT ${JSON.stringify({
    scenario,
    foundInvite: result.foundInvite,
    status: cover.status,
    failureClass: cover.failureClass,
    coverageReason: cover.coverageReason,
    inspectedPages: cover.inspectedPages,
    timedOut: cover.timedOut,
    outcomes: websiteOutcomes(result).map(item => ({
      outcome: item.outcome,
      retryable: item.retryable,
      failureClass: item.failureClass,
      pages: item.telemetry?.pagesInspected,
      coverageReason: item.telemetry?.coverageReason,
      ceiling: item.telemetry?.ceiling?.kind,
      dropReasons: item.telemetry?.dropReasons,
    })),
  })}`);
}

function assertNotClean(scenario: string, result: InspectionResult): void {
  logResult(scenario, result);
  const status = result.acquisitionStatus;
  assert.ok(
    status !== 'INSPECTED_NO_MATCH',
    `${scenario}: clean INSPECTED_NO_MATCH with uninspected eligible work (rendered=${JSON.stringify(coverageOf(result))})`,
  );
  assert.ok(status === 'FOUND' || status === 'PARTIALLY_INSPECTED' || status === 'ACQUISITION_FAILED',
    `${scenario}: expected a non-clean acquisition status, got ${status}`);
  const rendered = renderedOutcome(result);
  if (rendered) {
    assert.notEqual(rendered.outcome, 'INSPECTED_NO_MATCH',
      `${scenario}: rendered tier certified a clean no-link while eligible work was unexamined (${JSON.stringify({
        pages: rendered.telemetry?.pagesInspected,
        coverageReason: rendered.telemetry?.coverageReason,
        dropReasons: rendered.telemetry?.dropReasons,
      })})`);
  }
}

function assertFound(scenario: string, result: InspectionResult, invite: string): void {
  logResult(scenario, result);
  assert.equal(result.foundInvite, invite, `${scenario}: expected invite ${invite}`);
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

function e2e1HamburgerToCommunity(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: page(`
      <nav>
        <button id="menu" aria-label="Menu" aria-expanded="false">Menu</button>
        <div id="panel" hidden></div>
      </nav>
      <p>Trading education and market analysis.</p>
      <script>
        document.getElementById('menu').addEventListener('click', () => {
          document.getElementById('panel').hidden = false;
          // Split path so no static scanner can extract it from script text.
          document.getElementById('panel').innerHTML = '<a href="/comm' + 'unity">Community</a>';
          document.getElementById('menu').setAttribute('aria-expanded', 'true');
        });
      </script>`),
  });
  world.add(MAIN, '/community', {
    body: page(`
      <h1>Community</h1>
      <a href="/join">Join the community</a>`),
  });
  world.add(MAIN, '/join', {
    body: page(`
      <h1>Join</h1>
      <a href="https://discord.gg/E2E1">Discord</a>`),
  });
  return world;
}

function e2e2GenericResources(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: page(`
      <h1>Trading creator</h1>
      <button id="more" aria-label="More">More</button>
      <div id="panel"></div>
      <script>
        document.getElementById('more').addEventListener('click', () => {
          // Split path so static extraction cannot discover the destination;
          // only rendered execution can reveal it.
          document.getElementById('panel').innerHTML =
            '<a href="/resour' + 'ces">Resources</a>';
        });
      </script>`),
  });
  world.add(MAIN, '/resources', {
    body: page('<h1>Resources</h1><a href="https://discord.gg/E2E2">Discord</a>'),
  });
  return world;
}

function e2e3DedupeBranches(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: page(`
      <a href="/links">Links</a>
      <a href="/links#top">Links top</a>
      <a href="/links/">Links slash</a>
      <a href="/community">Community</a>
      <a href="/community-partners">Community partners</a>`),
  });
  world.add(MAIN, '/links', { body: page('<h1>Links hub</h1><p>No invite here.</p>') });
  for (const path of ['/community', '/community-partners']) {
    world.add(MAIN, path, {
      body: page(`
        <h1>${path}</h1>
        <button id="join" aria-label="Join">Join</button>
        <div id="out"></div>
        <script>
          document.getElementById('join').addEventListener('click', () => {
            const code = '${path === '/community' ? 'E2E3A' : 'E2E3B'}';
            document.getElementById('out').innerHTML =
              '<a href="https://discord.gg/' + code + '">Discord</a>';
          });
        </script>`),
    });
  }
  return world;
}

function e2e4PageBudget(): FixtureWorld {
  const world = new FixtureWorld();
  const links = Array.from({ length: 8 }, (_, index) => `<a href="/community/${index + 1}">Community ${index + 1}</a>`).join('');
  world.add(MAIN, '/', { body: page(`<h1>Community hub</h1>${links}`) });
  for (let index = 1; index <= 8; index++) {
    world.add(MAIN, `/community/${index}`, { body: page(`<h1>Community ${index}</h1><p>No invite.</p>`) });
  }
  return world;
}

function e2e4ClickBudget(): FixtureWorld {
  const world = new FixtureWorld();
  const buttons = Array.from({ length: 6 }, (_, index) =>
    `<button data-control="${index + 1}" aria-label="Community link ${index + 1}">Community link ${index + 1}</button>`).join('');
  world.add(MAIN, '/', {
    body: page(`
      <h1>Community controls</h1>${buttons}<div id="out"></div>
      <script>
        document.querySelectorAll('button[data-control]').forEach(button => {
          button.addEventListener('click', () => {
            document.getElementById('out').textContent += ' examined ' + button.dataset.control;
          });
        });
      </script>`),
  });
  return world;
}

function e2e4ScrollCap(): FixtureWorld {
  const world = new FixtureWorld();
  // Growth is timer-driven, independent of scroll-event timing. The old
  // fixture appended a block only on `scroll`, so a missed/fast event made the
  // page look stable and the crawl falsely complete. Each append beacons to
  // `/__growth`, letting the test prove growth actually happened before it
  // judges the crawler.
  world.add(MAIN, '/__growth', { body: 'ok', contentType: 'text/plain' });
  world.add(MAIN, '/', {
    body: page(`
      <h1>Growing page</h1><div id="spacer" style="height:1200px"></div>
      <script>
        let added = 0;
        const timer = setInterval(() => {
          if (added >= 7) { clearInterval(timer); return; }
          added++;
          const block = document.createElement('div');
          block.style.height = '1200px';
          block.textContent = 'more content ' + added;
          document.body.appendChild(block);
          fetch('/__growth?n=' + added).catch(() => {});
        }, 100);
      </script>`),
  });
  return world;
}

function e2e4Timeout(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: page(`
      <h1>Slow page</h1><div id="spacer" style="height:2000px"></div>
      <script>
        setInterval(() => {
          const block = document.createElement('div');
          block.style.height = '600px';
          document.body.appendChild(block);
        }, 100);
      </script>`),
  });
  return world;
}

function e2e5Frame(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', { body: page('<h1>Framed community</h1><iframe src="/frame"></iframe>') });
  world.add(MAIN, '/frame', { body: page('<a href="https://discord.gg/E2E5FRAME">Discord</a>') });
  return world;
}

function e2e5OpenShadow(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: page(`
      <h1>Shadow community</h1><div id="host"></div>
      <script>
        const root = document.getElementById('host').attachShadow({ mode: 'open' });
        const href = 'https://discord.gg/' + 'E2E5SHADOW';
        root.innerHTML = '<a href="' + href + '">Discord</a>';
      </script>`),
  });
  return world;
}

function e2e5ClosedShadow(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: page(`
      <h1>Closed shadow community</h1><div id="host"></div>
      <script>
        const root = document.getElementById('host').attachShadow({ mode: 'closed' });
        const href = 'https://discord.gg/' + 'E2E5CLOSED';
        root.innerHTML = '<a href="' + href + '">Discord</a>';
      </script>`),
  });
  return world;
}

function e2e5Popup(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: page(`
      <h1>Popup community</h1>
      <a href="http://${HUB}/popup" target="_blank">Community room</a>`),
  });
  world.add(HUB, '/popup', {
    body: page(`
      <h1>Popup room</h1>
      <button id="join" aria-label="Join">Join</button>
      <div id="out"></div>
      <script>
        document.getElementById('join').addEventListener('click', () => {
          const code = 'E2E5POPUP';
          document.getElementById('out').innerHTML =
            '<a href="https://discord.gg/' + code + '">Discord</a>';
        });
      </script>`),
  });
  return world;
}

function e2e5SameOriginPopup(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: page(`
      <h1>Popup community</h1>
      <button id="open" aria-label="Community room">Community room</button>
      <script>
        document.getElementById('open').addEventListener('click', () => {
          window.open('/popup-room', '_blank');
        });
      </script>`),
  });
  world.add(MAIN, '/popup-room', {
    body: page(`
      <h1>Popup room</h1>
      <button id="join" aria-label="Join">Join</button>
      <div id="out"></div>
      <script>
        document.getElementById('join').addEventListener('click', () => {
          const code = 'E2E5SAMEPOPUP';
          document.getElementById('out').innerHTML =
            '<a href="https://discord.gg/' + code + '">Discord</a>';
        });
      </script>`),
  });
  return world;
}

function e2e6CrossOrigin(): FixtureWorld {
  const world = new FixtureWorld();
  // Deliberately non-hint anchor text: the destination path carries the
  // community evidence, and the anchor must not enter the click set. This
  // isolates the cross-origin enqueue branch from the popup-click branch.
  const links = Array.from({ length: 4 }, (_, index) =>
    `<a href="http://${HUB}/community-${index + 1}" target="_blank">Partner site ${index + 1}</a>`).join('');
  world.add(MAIN, '/', { body: page(`<h1>Trading creator</h1>${links}`) });
  for (let index = 1; index <= 4; index++) {
    world.add(HUB, `/community-${index}`, {
      body: page(`
        <h1>Hub ${index}</h1>
        <button id="join" aria-label="Join">Join</button>
        <div id="out"></div>
        <script>
          document.getElementById('join').addEventListener('click', () => {
            const code = 'HUB${index}';
            document.getElementById('out').innerHTML =
              '<a href="https://discord.gg/' + code + '">Discord</a>';
          });
        </script>`),
    });
  }
  return world;
}

function e2e8Xhtml(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>XHTML</h1><div id="out"></div><script>
      const a = document.createElement('a');
      const code = 'E2E8XHTML';
      a.setAttribute('href', 'https://discord.gg/' + code);
      a.textContent = 'Discord';
      document.getElementById('out').appendChild(a);
    </script></body></html>`,
    contentType: 'application/xhtml+xml',
  });
  return world;
}

function e2e8Utf16(): FixtureWorld {
  const world = new FixtureWorld();
  const html = page(`
    <h1>UTF-16</h1><div id="out"></div>
    <script>
      const a = document.createElement('a');
      const code = 'E2E8UTF16';
      a.setAttribute('href', 'https://discord.gg/' + code);
      a.textContent = 'Discord';
      document.getElementById('out').appendChild(a);
    </script>`);
  world.add(MAIN, '/', {
    body: Buffer.from(html, 'utf16le'),
    contentType: 'text/html; charset=utf-16le',
  });
  return world;
}

function e2e8Feed(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Trading</title><item><link>https://discord.gg/E2E8FEED</link></item></channel></rss>`,
    contentType: 'application/rss+xml',
  });
  return world;
}

function e2e8ForbiddenWrapper(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    status: 403,
    body: page('<h1>Access restricted</h1><a href="https://discord.gg/E2E8FORBIDDEN">Discord</a>'),
  });
  return world;
}

function e2e8PlainText(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: 'Trading community: https://discord.gg/E2E8PLAIN',
    contentType: 'text/plain; charset=utf-8',
  });
  return world;
}

function e2e9GenericLink(): FixtureWorld {
  return e2e2GenericResources();
}

function e2e9Popup(): FixtureWorld {
  return e2e5Popup();
}

function e2e9ClosedShadow(): FixtureWorld {
  return e2e5ClosedShadow();
}

function e2e9IconButton(): FixtureWorld {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: page(`
      <h1>Trading creator</h1>
      <button id="icon" aria-label=""><svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg></button>
      <div id="out"></div>
      <script>
        document.getElementById('icon').addEventListener('click', () => {
          const code = 'UNLABELEDBUTTON';
          document.getElementById('out').innerHTML =
            '<a href="https://discord.gg/' + code + '">Discord</a>';
        });
      </script>`),
  });
  return world;
}

/* ------------------------------------------------------------------ */
/* E2E-1..E2E-9                                                       */
/* ------------------------------------------------------------------ */

test('E2E-1 hamburger -> community page -> Join -> Discord across multiple pages', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e1HamburgerToCommunity();
  await world.start();
  try {
    const { result, rendered } = await world.inspect(`http://${MAIN}/`);
    assertFound('E2E-1', result, 'E2E1');
    assert.ok((rendered[0]?.inspectedPages || 0) >= 3, 'E2E-1: expected home, community and join pages');
    const visited = (rendered[0]?.visitedUrls || []).join(' ');
    assert.match(visited, /\/community/, 'E2E-1: the community page was not visited');
    assert.match(visited, /\/join/, 'E2E-1: the join page was not visited');
  } finally {
    await world.close();
  }
});

test('E2E-2 JS-inserted generic /resources path with an invite on it', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e2GenericResources();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`);
    logResult('E2E-2', result);
    assertFound('E2E-2', result, 'E2E2');
  } finally {
    await world.close();
  }
});

test('E2E-3 distinct branches preserved, duplicate /links variants inspected once', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e3DedupeBranches();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`);
    logResult('E2E-3', result);
    const linksRequests = world.proxyRequests.filter(item => item.host === MAIN && item.path === '/links').length;
    const communityRequests = world.proxyRequests.filter(item => item.host === MAIN && item.path === '/community').length;
    const partnersRequests = world.proxyRequests.filter(item => item.host === MAIN && item.path === '/community-partners').length;
    assert.equal(linksRequests, 1, `E2E-3: /links inspected ${linksRequests} times; normalized duplicates must be inspected once`);
    assert.ok(communityRequests >= 1, 'E2E-3: /community branch was not inspected');
    assert.ok(partnersRequests >= 1, 'E2E-3: /community-partners branch was not inspected');
    assert.ok(result.foundInvite === 'E2E3A' || result.foundInvite === 'E2E3B', 'E2E-3: a distinct branch invite was lost');
  } finally {
    await world.close();
  }
});

test('E2E-4a page budget with eligible work queued is partial, never clean', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e4PageBudget();
  await world.start();
  try {
    const { result, rendered } = await world.inspect(`http://${MAIN}/`);
    logResult('E2E-4a', result);
    assert.ok((rendered[0]?.inspectedPages || 0) <= 6, 'E2E-4a: rendered crawl exceeded the page budget');
    assert.ok((rendered[0]?.requiredTotal || 0) > 6,
      'E2E-4a: the required set must contain more destinations than the page budget');
    assert.ok((rendered[0]?.requiredUnvisited?.length || 0) > 0,
      'E2E-4a: eligible destinations must remain unvisited at the budget stop');
    assertNotClean('E2E-4a', result);
    assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED', 'E2E-4a: queued eligible pages must force a partial result');
  } finally {
    await world.close();
  }
});

test('E2E-4b click budget with evidence controls skipped is partial, never clean', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e4ClickBudget();
  await world.start();
  try {
    const { result, rendered } = await world.inspect(`http://${MAIN}/`);
    logResult('E2E-4b', result);
    assertNotClean('E2E-4b', result);
    assert.equal(rendered[0]?.interactionGap, true, 'E2E-4b: skipped evidence controls must set interactionGap');
  } finally {
    await world.close();
  }
});

test('E2E-4c scroll cap still growing is partial, never clean', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e4ScrollCap();
  await world.start();
  try {
    const { result, rendered } = await world.inspect(`http://${MAIN}/`);
    const growthRequests = world.proxyRequests.filter(item => item.host === MAIN && item.path.startsWith('/__growth')).length;
    logResult('E2E-4c', result);
    assert.ok(growthRequests > 0,
      'E2E-4c: fixture growth never occurred, so the scroll result is not meaningful');
    assertNotClean('E2E-4c', result);
    assert.equal(rendered[0]?.telemetry?.scrollCapReachedStillGrowing, true,
      'E2E-4c: the last permitted scroll still found a growing document');
  } finally {
    await world.close();
  }
});

test('E2E-4d total time budget exhaustion is partial, never clean', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e4Timeout();
  await world.start();
  try {
    const { result, rendered } = await world.inspect(`http://${MAIN}/`, {
      totalTimeoutMs: 1_500,
      navigationTimeoutMs: 5_000,
    });
    logResult('E2E-4d', result);
    assertNotClean('E2E-4d', result);
    assert.equal(rendered[0]?.timedOut, true, 'E2E-4d: the reduced total budget must expire');
  } finally {
    await world.close();
  }
});

test('E2E-5a same-origin iframe invite is found or marked context-unreachable', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e5Frame();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`);
    logResult('E2E-5a', result);
    const cover = coverageOf(result);
    const discovered = result.foundInvite === 'E2E5FRAME';
    console.log(`E2E_CONTEXT ${JSON.stringify({ scenario: 'E2E-5a', discovered, status: cover.status, coverageReason: cover.coverageReason })}`);
    assert.ok(discovered || (cover.status === 'PARTIALLY_INSPECTED' && cover.coverageReason === 'CONTEXT_UNREACHABLE'),
      `E2E-5a: an uninspected iframe must be found or explicitly context-unreachable; got ${JSON.stringify(cover)}`);
  } finally {
    await world.close();
  }
});

test('E2E-5b open shadow-root invite is found or marked context-unreachable', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e5OpenShadow();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`);
    logResult('E2E-5b', result);
    const cover = coverageOf(result);
    const discovered = result.foundInvite === 'E2E5SHADOW';
    console.log(`E2E_CONTEXT ${JSON.stringify({ scenario: 'E2E-5b', discovered, status: cover.status, coverageReason: cover.coverageReason })}`);
    assert.ok(discovered || (cover.status === 'PARTIALLY_INSPECTED' && cover.coverageReason === 'CONTEXT_UNREACHABLE'),
      `E2E-5b: an uninspected open shadow root must be found or explicitly context-unreachable; got ${JSON.stringify(cover)}`);
  } finally {
    await world.close();
  }
});

test('E2E-5c closed shadow root is never certified as a clean no-link', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e5ClosedShadow();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`);
    assertNotClean('E2E-5c', result);
  } finally {
    await world.close();
  }
});

test('E2E-5d target=_blank popup with a real non-hint href is never certified clean', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e5Popup();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`);
    assertNotClean('E2E-5d', result);
  } finally {
    await world.close();
  }
});

test('E2E-5e allowed same-origin popup is captured and inspected within budget', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e5SameOriginPopup();
  await world.start();
  try {
    const { result, rendered } = await world.inspect(`http://${MAIN}/`);
    logResult('E2E-5e', result);
    assert.ok((rendered[0]?.telemetry?.popupCaptured || 0) > 0,
      'E2E-5e: the same-origin popup was not captured');
    assert.equal(result.foundInvite, 'E2E5SAMEPOPUP',
      'E2E-5e: the captured same-origin popup was not inspected for an invite');
  } finally {
    await world.close();
  }
});

test('E2E-6a strong cross-origin hub with P1.6 OFF is never certified clean', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e6CrossOrigin();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`, { crossOriginEnqueue: false });
    assertNotClean('E2E-6a', result);
  } finally {
    await world.close();
  }
});

test('E2E-6b strong cross-origin hub with P1.6 ON is inspected within the cap', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e6CrossOrigin();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`, { crossOriginEnqueue: true });
    logResult('E2E-6b', result);
    const hubRequests = world.proxyRequests.filter(item => item.host === HUB && item.path.startsWith('/community-')).length;
    assert.ok(hubRequests > 0, 'E2E-6b: no cross-origin hub page was inspected');
    assert.ok(hubRequests <= 3, `E2E-6b: cross-origin cap exceeded (${hubRequests} hub requests)`);
    assert.match(result.foundInvite || '', /^HUB[1-3]$/, 'E2E-6b: a cross-origin hub invite was not found');
  } finally {
    await world.close();
  }
});

test('E2E-7a static base href resolves the community path', { timeout: E2E_TIMEOUT }, async () => {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: page('<base href="http://creator.test/deep/"><a href="community">Community</a>'),
  });
  world.add(MAIN, '/deep/community', { body: page('<a href="https://discord.gg/E2E7BASE">Discord</a>') });
  await world.start();
  try {
    const result = await crawlExternalLinksForTest([`http://${MAIN}/`], [], undefined, world.staticFetch);
    console.log(`E2E_RESULT ${JSON.stringify({ scenario: 'E2E-7a', foundInvite: result.foundInvite, outcome: result.outcome })}`);
    assert.equal(result.foundInvite, 'E2E7BASE', 'E2E-7a: base-href path was not resolved');
  } finally {
    await world.close();
  }
});

test('E2E-7b static queue cap with eligible links remaining is partial', { timeout: E2E_TIMEOUT }, async () => {
  const world = new FixtureWorld();
  const links = Array.from({ length: 20 }, (_, index) => `<a href="/community/${index + 1}">Community ${index + 1}</a>`).join('');
  world.add(MAIN, '/', { body: page(links) });
  for (let index = 1; index <= 20; index++) {
    world.add(MAIN, `/community/${index}`, { body: page('<p>No invite.</p>') });
  }
  await world.start();
  try {
    const result = await crawlExternalLinksForTest([`http://${MAIN}/`], [], undefined, world.staticFetch);
    console.log(`E2E_RESULT ${JSON.stringify({ scenario: 'E2E-7b', outcome: result.outcome, failureClass: result.observations[0]?.failureClass, ceiling: result.observations[0]?.telemetry?.ceiling?.kind })}`);
    assert.equal(result.outcome, 'PARTIALLY_INSPECTED', 'E2E-7b: queue cap with remaining eligible links must be partial');
    assert.equal(result.observations[0]?.failureClass, 'STATIC_BUDGET_GAP');
  } finally {
    await world.close();
  }
});

test('E2E-7c static depth-3 child remains partial', { timeout: E2E_TIMEOUT }, async () => {
  const world = new FixtureWorld();
  world.add(MAIN, '/', { body: page('<a href="/community/a">Community A</a>') });
  world.add(MAIN, '/community/a', { body: page('<a href="/community/b">Community B</a>') });
  world.add(MAIN, '/community/b', { body: page('<a href="/community/c">Community C</a>') });
  world.add(MAIN, '/community/c', { body: page('<a href="https://discord.gg/E2E7DEPTH">Discord</a>') });
  await world.start();
  try {
    const result = await crawlExternalLinksForTest([`http://${MAIN}/`], [], undefined, world.staticFetch);
    console.log(`E2E_RESULT ${JSON.stringify({ scenario: 'E2E-7c', outcome: result.outcome, failureClass: result.observations[0]?.failureClass, ceiling: result.observations[0]?.telemetry?.ceiling?.kind })}`);
    assert.equal(result.foundInvite, null, 'E2E-7c: the depth-3 child must not be reached at depth 2');
    assert.equal(result.outcome, 'PARTIALLY_INSPECTED', 'E2E-7c: depth cap with an eligible child must be partial');
  } finally {
    await world.close();
  }
});

test('E2E-7d static redirect limit is a non-retryable terminal failure', { timeout: E2E_TIMEOUT }, async () => {
  const world = new FixtureWorld();
  for (let index = 0; index < 21; index++) {
    world.add(MAIN, `/redirect/${index}`, {
      status: 302,
      headers: { location: `http://${MAIN}/redirect/${index + 1}` },
      body: '',
    });
  }
  world.add(MAIN, '/redirect/21', { body: page('<a href="https://discord.gg/UNREACHABLE">Discord</a>') });
  await world.start();
  try {
    const result = await crawlExternalLinksForTest([`http://${MAIN}/redirect/0`], [], undefined, world.staticFetch);
    const observation = result.observations[0];
    console.log(`E2E_RESULT ${JSON.stringify({ scenario: 'E2E-7d', outcome: result.outcome, failureClass: observation?.failureClass, retryable: observation?.retryable })}`);
    assert.equal(observation?.failureClass, 'REDIRECT_LIMIT', 'E2E-7d: redirect limit was not classified');
    assert.equal(observation?.retryable, false, 'E2E-7d: redirect limit must not be retryable');
  } finally {
    await world.close();
  }
});

test('E2E-8a XHTML invite is found or explicitly partial', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e8Xhtml();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`);
    logResult('E2E-8a', result);
    assert.equal(result.foundInvite, 'E2E8XHTML', 'E2E-8a: XHTML invite was not found');
  } finally {
    await world.close();
  }
});

test('E2E-8b UTF-16 invite is found or explicitly partial', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e8Utf16();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`);
    logResult('E2E-8b', result);
    assert.equal(result.foundInvite, 'E2E8UTF16', 'E2E-8b: UTF-16 invite was not found');
  } finally {
    await world.close();
  }
});

test('E2E-8c RSS link is found or explicitly partial, never clean', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e8Feed();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`);
    assertNotClean('E2E-8c', result);
  } finally {
    await world.close();
  }
});

test('E2E-8d 403 wrapper is found or explicitly partial, never clean', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e8ForbiddenWrapper();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`);
    assertNotClean('E2E-8d', result);
  } finally {
    await world.close();
  }
});

test('E2E-8e plain-text invite is found', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e8PlainText();
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`);
    logResult('E2E-8e', result);
    assert.equal(result.foundInvite, 'E2E8PLAIN', 'E2E-8e: plain-text invite was not found');
  } finally {
    await world.close();
  }
});

test('unlabeled icon anchor: href extraction does not need visual recognition', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = new FixtureWorld();
  world.add(MAIN, '/', {
    body: page(`
      <h1>Trading creator</h1>
      <a id="icon-link" href="https://discord.gg/UNLABELEDANCHOR"><svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg></a>`),
  });
  await world.start();
  try {
    const { result } = await world.inspect(`http://${MAIN}/`);
    logResult('UNLABELED-ANCHOR', result);
    assert.equal(result.foundInvite, 'UNLABELEDANCHOR',
      'an icon-only anchor with a real Discord href should be found by href extraction');
  } finally {
    await world.close();
  }
});

test('unlabeled Discord icon button: record whether the crawler discovers it', { skip: BROWSER_SKIP, timeout: E2E_TIMEOUT }, async () => {
  const world = e2e9IconButton();
  await world.start();
  try {
    const { result, rendered } = await world.inspect(`http://${MAIN}/`);
    logResult('UNLABELED-BUTTON', result);
    const cover = coverageOf(result);
    const opaque = rendered[0]?.telemetry?.opaqueInteractiveControls || 0;
    const explicitPartial = cover.status === 'PARTIALLY_INSPECTED'
      && cover.coverageReason === 'CONTEXT_UNREACHABLE'
      && opaque > 0;
    console.log(`UNLABELED_ICON_RESULT ${JSON.stringify({
      discovered: result.foundInvite === 'UNLABELEDBUTTON',
      foundInvite: result.foundInvite,
      status: cover.status,
      coverageReason: cover.coverageReason,
      opaqueInteractiveControls: opaque,
      visualRecognitionNeeded: result.foundInvite !== 'UNLABELEDBUTTON',
    })}`);
    assert.ok(result.foundInvite === 'UNLABELEDBUTTON' || explicitPartial,
      'an unlabeled icon-only button must be discovered or reported as an explicit opaque-control gap');
    assert.ok(explicitPartial || result.foundInvite === 'UNLABELEDBUTTON');
  } finally {
    await world.close();
  }
});

/**
 * E2E-9 is the acceptance gate. Every fixture below has relevant, eligible
 * work that the current crawl did not inspect. None may return a clean
 * `INSPECTED_NO_MATCH`.
 */
test('E2E-9 false-clean matrix', { skip: BROWSER_SKIP, timeout: 600_000 }, async t => {
  const scenarios: Array<{ name: string; build: () => FixtureWorld; budget?: Partial<BrowserFallbackBudget> }> = [
    { name: 'js-inserted-generic-link', build: e2e9GenericLink },
    { name: 'target-blank-popup', build: e2e9Popup },
    { name: 'closed-shadow-root', build: e2e9ClosedShadow },
    { name: 'unlabeled-icon-button', build: e2e9IconButton },
    { name: 'page-budget', build: e2e4PageBudget },
    { name: 'click-budget', build: e2e4ClickBudget },
    { name: 'scroll-cap', build: e2e4ScrollCap },
    { name: 'total-timeout', build: e2e4Timeout, budget: { totalTimeoutMs: 1_200, navigationTimeoutMs: 5_000 } },
    { name: 'iframe-context', build: e2e5Frame },
    { name: 'open-shadow-context', build: e2e5OpenShadow },
    { name: 'plain-text-invite', build: e2e8PlainText },
    { name: 'cross-origin-hub-off', build: e2e6CrossOrigin, budget: { crossOriginEnqueue: false } },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, { timeout: E2E_TIMEOUT }, async () => {
      const world = scenario.build();
      await world.start();
      try {
        const { result } = await world.inspect(`http://${MAIN}/`, scenario.budget || {});
        assertNotClean(`E2E-9:${scenario.name}`, result);
      } finally {
        await world.close();
      }
    });
  }
});
