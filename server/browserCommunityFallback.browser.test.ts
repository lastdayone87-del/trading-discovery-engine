import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Browser, BrowserContext } from 'playwright';
import { browserLaunchOptions } from './browserCapability';
import { createRenderedRouteGuard, installRenderedRouteCloseCleanup, type RenderedRouteGuard } from './browserCommunityFallback';

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
