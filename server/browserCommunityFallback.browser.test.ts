import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { browserLaunchOptions } from './browserCapability';
import { createRenderedRouteGuard, installRenderedRouteCloseCleanup, type RenderedRouteGuard } from './browserCommunityFallback';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

test('Playwright context close with an in-flight route does not produce an unhandled rejection', { timeout: 30_000 }, async () => {
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
    let unrouteBehavior: string | undefined;
    guard = createRenderedRouteGuard(
      {
        unrouteAll: async options => {
          unrouteBehavior = options?.behavior;
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
    const closePromise = context.close();
    release.resolve();
    await closePromise;
    await navigation;
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(unrouteBehavior, 'ignoreErrors');
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
