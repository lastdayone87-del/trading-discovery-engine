import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Browser, BrowserContext, Page } from 'playwright';
import { browserLaunchOptions } from './browserCapability';
import {
  COMMUNITY_HINTS,
  RENDERED_CONTROL_EVALUATION_WINDOW,
  RENDERED_CONTROL_SELECTOR,
  createRenderedRouteGuard,
  enumerateRenderedControlNodes,
  installRenderedRouteCloseCleanup,
  partitionRenderedClickTargets,
  type RenderedRouteGuard,
} from './browserCommunityFallback';
import { extractDiscordCandidates } from './discordCandidates';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

test('Crawlee browser close with an in-flight route unwinds before closing the context', { skip: process.platform === 'android', timeout: 30_000 }, async () => {
  const { chromium } = await import('playwright');
  const { PlaywrightBrowser } = await import('@crawlee/browser-pool');
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const release = deferred();
  let server: http.Server | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let guard: RenderedRouteGuard | undefined;
  try {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>route-race</title>');
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not expose a port');

    browser = await chromium.launch(browserLaunchOptions());
    context = await browser.newContext();
    const entered = deferred();
    const order: string[] = [];
    let unrouteBehavior: string | undefined;
    context.once('close', () => { order.push('context-close'); });
    guard = createRenderedRouteGuard(
      {
        unrouteAll: async options => {
          unrouteBehavior = options?.behavior;
          order.push('unroute');
          await context!.unrouteAll(options);
        },
      },
      {
        isAllowed: async () => { entered.resolve(); await release.promise; return true; },
        onBlocked: () => {},
      },
    );
    await context.route('**/*', guard.handler);
    installRenderedRouteCloseCleanup(context, () => guard!.dispose());

    const page = await context.newPage();
    const navigation = page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await entered.promise;
    // This is the browser-level retirement path Crawlee uses. Its
    // PlaywrightBrowser.close() delegates to browserContext.close(), so the
    // installed context-close wrapper must run before the context goes away.
    const crawleeBrowser = new PlaywrightBrowser({ browserContext: context, version: 'test' });
    const closePromise = crawleeBrowser.close();
    release.resolve();
    await closePromise;
    await navigation;
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(unrouteBehavior, 'ignoreErrors');
    assert.deepEqual(order, ['unroute', 'context-close']);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    release.resolve();
    await guard?.dispose().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (server?.listening) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
  }
});

const controlFixtureHtml = (count: number, revealAt: number | null): string => {
  const controls = Array.from({ length: count }, (_, index) =>
    `<button type="button" data-control="${index + 1}">Community link ${index + 1}</button>`,
  ).join('');
  const reveal = revealAt === null ? '' : `
    if (button.dataset.control === '${revealAt}') {
      const link = document.createElement('a');
      link.href = 'https://discord.gg/revealed-room';
      link.textContent = 'Discord community';
      document.getElementById('revealed')!.appendChild(link);
    }`;
  return `<!doctype html><html><head><title>control fixture</title></head><body>
    ${controls}
    <div id="revealed"></div>
    <script>
      document.querySelectorAll('button[data-control]').forEach(button => {
        button.addEventListener('click', () => {${reveal}
        });
      });
    </script>
  </body></html>`;
};

async function withControlPage(
  html: string,
  run: (page: Page, url: string) => Promise<void>,
): Promise<void> {
  const { chromium } = await import('playwright');
  let server: http.Server | undefined;
  let browser: Browser | undefined;
  try {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not expose a port');
    const url = `http://127.0.0.1:${address.port}/`;
    browser = await chromium.launch(browserLaunchOptions());
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await run(page, url);
  } finally {
    await browser?.close().catch(() => undefined);
    if (server?.listening) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
  }
}

const enumeratePageControls = async (page: Page) =>
  page.locator(RENDERED_CONTROL_SELECTOR).evaluateAll(enumerateRenderedControlNodes, COMMUNITY_HINTS.source);

test('real DOM: control 65 is reachable after rotating the full 70-control pool', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  await withControlPage(controlFixtureHtml(70, 65), async (page, url) => {
    const firstAttempt = await enumeratePageControls(page);
    assert.equal(firstAttempt.total, 70, 'the complete matched set is enumerated, not a 64-item prefix');
    assert.equal(firstAttempt.controls.length, 70);

    const firstWindow = partitionRenderedClickTargets(firstAttempt.controls, url, 4, 0);
    assert.deepEqual(
      firstWindow.toClick.map(target => target.text),
      ['Community link 1', 'Community link 2', 'Community link 3', 'Community link 4'],
    );
    for (const target of firstWindow.toClick) {
      await page.locator(`[data-oc-control="${target.marker}"]`).click();
    }
    assert.equal(
      await page.locator('a[href="https://discord.gg/revealed-room"]').count(),
      0,
      'the first click window cannot reveal control 65',
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    const retryAttempt = await enumeratePageControls(page);
    const retryWindow = partitionRenderedClickTargets(
      retryAttempt.controls,
      page.url(),
      4,
      RENDERED_CONTROL_EVALUATION_WINDOW,
    );
    assert.equal(retryWindow.evaluationWindow.length, RENDERED_CONTROL_EVALUATION_WINDOW);
    assert.deepEqual(
      retryWindow.toClick.map(target => target.text),
      ['Community link 65', 'Community link 66', 'Community link 67', 'Community link 68'],
      'the durable retry offset reaches controls beyond the first 64',
    );

    await page.locator(`[data-oc-control="${retryWindow.toClick[0].marker}"]`).click();
    assert.equal(await page.locator('a[href="https://discord.gg/revealed-room"]').count(), 1);
    const candidates = extractDiscordCandidates(await page.content(), 'CREATOR_WEBSITES', page.url());
    assert.equal(candidates[0]?.nativeInviteCode, 'revealed-room');
  });
});

test('real DOM: a 64-control page wraps without inventing overflow', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  await withControlPage(controlFixtureHtml(64, null), async (page, url) => {
    const enumeration = await enumeratePageControls(page);
    assert.equal(enumeration.total, 64);
    assert.equal(enumeration.controls.length, 64);

    const wrapped = partitionRenderedClickTargets(enumeration.controls, url, 4, RENDERED_CONTROL_EVALUATION_WINDOW);
    assert.equal(wrapped.evaluationWindow.length, 64, 'a full 64-control page still fits one window');
    assert.deepEqual(
      wrapped.toClick.map(target => target.text),
      ['Community link 1', 'Community link 2', 'Community link 3', 'Community link 4'],
      'offset 64 wraps to the first control instead of creating a 65th target',
    );
    assert.equal(new Set(wrapped.evaluationWindow.map(target => target.marker)).size, 64);

    for (const target of wrapped.toClick) {
      await page.locator(`[data-oc-control="${target.marker}"]`).click();
    }
    assert.equal(await page.locator('a[href^="https://discord.gg/"]').count(), 0);
  });
});
