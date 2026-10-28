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
  collectRenderedPageContext,
  enumerateRenderedControlNodes,
  installRenderedRouteCloseCleanup,
  isSkippableNavigableAnchorClick,
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
      const revealed = document.getElementById('revealed');
      if (revealed) revealed.appendChild(link);
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
      firstWindow.toClick.map(target => target.text.trim()),
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
      retryWindow.toClick.map(target => target.text.trim()),
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
      wrapped.toClick.map(target => target.text.trim()),
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

test('real DOM: enumeration separates hint-rejected, structural, icon-label, and popup controls', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  const html = `<!doctype html><html><head>
    <base href="https://creator.example/base/">
    <title>mixed control fixture</title>
  </head><body>
    <a href="/community">Community</a>
    <button type="button" aria-label="Open menu" aria-haspopup="dialog">Menu</button>
    <button type="button" title="Join our Discord">
      <svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="8"></circle></svg>
    </button>
    <a href="https://discord.gg/example" target="_blank">Community chat</a>
    <iframe src="about:blank" title="embedded"></iframe>
    <div id="shadow-host"></div>
    <script>
      document.getElementById('shadow-host').attachShadow({ mode: 'open' }).innerHTML = '<span>shadow content</span>';
    </script>
  </body></html>`;
  await withControlPage(html, async (page) => {
    const enumeration = await enumeratePageControls(page);
    assert.equal(enumeration.total, 4, 'the pre-filter denominator includes every selector-matched control');
    assert.equal(enumeration.controls.length, 4, 'hint-matched, icon-label, and structural disclosure controls are all evidence-bearing');
    assert.equal(enumeration.hintRejected, 2, 'hint rejection is measured against the original filter, not the recovered set');
    assert.equal(enumeration.structuralNavigation, 1, 'the menu/aria-haspopup control is structural navigation');
    assert.equal(enumeration.structuralHintRejected, 1, 'the structural control would be hidden by the original hint filter');
    assert.equal(enumeration.structuralDisclosure, 1, 'the menu control is included as an in-place disclosure');
    assert.equal(enumeration.structuralUnrecovered, 0, 'no structural control is left outside the click set');
    assert.equal(enumeration.iconLabelRecovered, 1, 'title-only icon labels are recovered in P1.2');
    assert.equal(enumeration.popupTargets, 1, 'only the dialog control requires popup capture; the href-bearing _blank anchor is navigable');

    const context = await page.evaluate(collectRenderedPageContext);
    assert.equal(context.frameCount, 1, 'iframe presence is recorded for P1.4');
    assert.equal(context.shadowRootCount, 1, 'open shadow roots are recorded for P1.4');
    assert.equal(context.baseHrefPresent, true, 'a document <base href> is recorded for P1.5');
  });
});

test('real DOM: a generic hamburger disclosure is clicked and reveals a community link', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  const html = `<!doctype html><html><body>
    <button id="menu" type="button" aria-expanded="false">Menu</button>
    <div id="panel"></div>
    <script>
      document.getElementById('menu').addEventListener('click', () => {
        document.getElementById('menu').setAttribute('aria-expanded', 'true');
        document.getElementById('panel').innerHTML = '<a href="https://discord.gg/generic-menu">Join</a>';
      });
    </script>
  </body></html>`;
  await withControlPage(html, async (page, url) => {
    const before = await enumeratePageControls(page);
    assert.equal(before.controls.length, 1, 'the generic menu is the only clickable control');
    assert.equal(before.structuralDisclosure, 1, 'the collapsed hamburger is a structural disclosure');
    assert.equal(before.structuralUnrecovered, 0, 'the hamburger is included, not left to the enqueue path');
    const plan = partitionRenderedClickTargets(before.controls, url, 4, 0);
    assert.equal(plan.toClick.length, 1);
    assert.equal(plan.toClick[0]?.text.trim(), 'Menu');
    await page.locator(`[data-oc-control="${plan.toClick[0]!.marker}"]`).click();
    const after = await enumeratePageControls(page);
    const revealed = after.controls.find(target => target.href === 'https://discord.gg/generic-menu');
    assert.ok(revealed, 'the revealed invite link is enumerated after the disclosure click');
    const candidates = extractDiscordCandidates(await page.content(), 'CREATOR_WEBSITES', page.url());
    assert.equal(candidates[0]?.nativeInviteCode, 'generic-menu');
  });
});

test('real DOM: non-button menuitem and aria-haspopup controls are enumerated and clickable', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  const html = `<!doctype html><html><body>
    <div role="menuitem" id="menuitem" tabindex="0">Community</div>
    <div aria-haspopup="menu" id="haspopup" tabindex="0">More</div>
    <div id="panel-menuitem"></div>
    <div id="panel-haspopup"></div>
    <script>
      document.getElementById('menuitem').addEventListener('click', () => {
        document.getElementById('panel-menuitem').innerHTML = '<a href="https://discord.gg/menuitem-room">Join</a>';
      });
      document.getElementById('haspopup').addEventListener('click', () => {
        document.getElementById('panel-haspopup').innerHTML = '<a href="https://discord.gg/haspopup-room">Join</a>';
      });
    </script>
  </body></html>`;
  await withControlPage(html, async (page, url) => {
    const enumeration = await enumeratePageControls(page);
    assert.equal(enumeration.total, 2, 'both non-button controls match the shared selector');
    assert.equal(enumeration.controls.length, 2, 'both are evidence-bearing disclosures');
    assert.equal(enumeration.structuralNavigation, 2);
    assert.equal(enumeration.structuralDisclosure, 2);
    const plan = partitionRenderedClickTargets(enumeration.controls, url, 4, 0);
    assert.equal(plan.toClick.length, 2);
    for (const target of plan.toClick) {
      await page.locator(`[data-oc-control="${target.marker}"]`).click();
    }
    assert.equal(await page.locator('a[href="https://discord.gg/menuitem-room"]').count(), 1);
    assert.equal(await page.locator('a[href="https://discord.gg/haspopup-room"]').count(), 1);
  });
});

test('real DOM: recovered structural anchors never replace the page and are counted unrecovered', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  const html = `<!doctype html><html><body>
    <button type="button" id="menu" aria-expanded="false">Menu</button>
    <a href="/community">Community</a>
    <a href="/help" title="Community support">Help</a>
    <a href="/resources">Resources</a>
  </body></html>`;
  await withControlPage(html, async (page, url) => {
    const enumeration = await enumeratePageControls(page);
    assert.equal(
      enumeration.structuralUnrecovered,
      1,
      'only the hint-recovered structural anchor is a coverage candidate; the ordinary /resources link is not',
    );
    assert.deepEqual(
      enumeration.structuralUnrecoveredHrefs.map(href => new URL(href).pathname),
      ['/help'],
    );
    assert.equal(
      enumeration.controls.some(target => target.href?.endsWith('/help')),
      false,
      'a label-recovered structural anchor is not clicked',
    );
    assert.equal(
      enumeration.controls.some(target => target.href?.endsWith('/resources')),
      false,
      'an ordinary structural navigable anchor is not clicked',
    );
    assert.equal(
      enumeration.controls.some(target => target.href?.endsWith('/community')),
      true,
      'a base-matched navigable anchor keeps its existing enqueue-owned click-set behavior',
    );
    // Base matches lead, even when a disclosure appears earlier in the DOM.
    assert.equal(enumeration.controls[0]?.href?.endsWith('/community'), true);
    const plan = partitionRenderedClickTargets(enumeration.controls, url, 4, 0);
    assert.deepEqual(plan.toClick.map(target => target.text.trim()), ['Menu'], 'only the in-place disclosure is clicked');
    assert.equal(plan.skippedNavigableAnchors, 1, 'the base-matched anchor is enqueue-owned, not clicked');
  });
});

test('real DOM: ordinary resources/support/learn-more links are not structural coverage gaps', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  const html = `<!doctype html><html><body>
    <a href="/resources">Resources</a>
    <a href="/support">Support</a>
    <a href="/learn-more">Learn more</a>
    <a href="/contact">Read more</a>
  </body></html>`;
  await withControlPage(html, async (page) => {
    const enumeration = await enumeratePageControls(page);
    assert.equal(
      enumeration.structuralUnrecovered,
      0,
      'ordinary page links are navigation candidates, not structural disclosure gaps',
    );
    assert.deepEqual(enumeration.structuralUnrecoveredHrefs, []);
    assert.equal(
      enumeration.controls.some(target => target.href?.endsWith('/contact')),
      true,
      'the hint-matched /contact link keeps its existing click-set behavior',
    );
    assert.equal(
      enumeration.controls.some(target => target.href?.endsWith('/resources')),
      false,
      'a non-hint ordinary link is not clicked',
    );
  });
});

test('real DOM: base matches outrank icon-label recoveries and disclosures', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  const html = `<!doctype html><html><body>
    <button type="button" title="Join our Discord">
      <svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="8"></circle></svg>
    </button>
    <div aria-haspopup="menu" tabindex="0">More</div>
    <a href="/community">Community</a>
  </body></html>`;
  await withControlPage(html, async (page) => {
    const enumeration = await enumeratePageControls(page);
    assert.equal(enumeration.controls.length, 3);
    assert.deepEqual(
      enumeration.controls.map(target => target.index),
      [2, 0, 1],
      'base match first, then the icon-label recovery, then the disclosure',
    );
  });
});

test('real DOM: an already-open details summary is not clicked closed', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  const html = `<!doctype html><html><body>
    <details open>
      <summary>Community</summary>
      <a href="/open-details">Details</a>
    </details>
    <details>
      <summary>Resources</summary>
      <a href="/closed-details">Details</a>
    </details>
  </body></html>`;
  await withControlPage(html, async (page) => {
    const enumeration = await enumeratePageControls(page);
    assert.equal(
      enumeration.controls.some(target => target.text.trim() === 'Community'),
      false,
      'the open summary is not in the click set',
    );
    assert.equal(
      enumeration.controls.some(target => target.text.trim() === 'Resources'),
      true,
      'the collapsed summary remains an in-place disclosure',
    );
    assert.equal(enumeration.structuralDisclosure, 1);
  });
});

test('real DOM: navigation compares against the document URL, not the effective base', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  const html = `<!doctype html><html><head><base href="/base/"></head><body>
    <a href="./">Resources</a>
    <a href="/#section">Resources</a>
  </body></html>`;
  await withControlPage(html, async (page, url) => {
    const enumeration = await enumeratePageControls(page);
    assert.equal(enumeration.structuralUnrecovered, 1, 'an anchor resolving to the base URI still navigates away from the document URL');
    assert.equal(enumeration.controls.length, 1);
    assert.equal(enumeration.controls[0]?.href, `${url}#section`, 'the fragment-only anchor remains an in-place disclosure');
  });
});

test('real DOM: an all-hint-matched control set has no hidden structural or popup counts', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  await withControlPage(controlFixtureHtml(8, null), async (page) => {
    const enumeration = await enumeratePageControls(page);
    assert.equal(enumeration.total, 8);
    assert.equal(enumeration.controls.length, 8);
    assert.equal(enumeration.hintRejected, 0);
    assert.equal(enumeration.structuralNavigation, 0);
    assert.equal(enumeration.structuralHintRejected, 0);
    assert.equal(enumeration.structuralDisclosure, 0);
    assert.equal(enumeration.structuralUnrecovered, 0);
    assert.equal(enumeration.iconLabelRecovered, 0);
    assert.equal(enumeration.popupTargets, 0);
  });
});

test('real DOM: SVG anchors expose a string href and stay navigable', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  const html = `<!doctype html><html><body>
    <svg width="220" height="40" xmlns="http://www.w3.org/2000/svg">
      <a href="/svg-community" aria-label="Discord community"><text x="0" y="20">Discord community</text></a>
    </svg>
  </body></html>`;
  await withControlPage(html, async (page, url) => {
    const enumeration = await enumeratePageControls(page);
    const svg = enumeration.controls.find(target => target.href?.endsWith('/svg-community'));
    assert.ok(svg, 'the SVG anchor is enumerated');
    assert.equal(typeof svg.href, 'string', 'SVGAnimatedString must not leak into the target');
    assert.equal(svg.href, `${url}svg-community`);
    assert.equal(isSkippableNavigableAnchorClick(svg, url), true, 'the SVG anchor is navigable, not click-only');
  });
});

test('real DOM: duplicate existing control markers are made unique', { skip: process.platform === 'android', timeout: 60_000 }, async () => {
  const html = `<!doctype html><html><body>
    <button type="button" data-oc-control="duplicate">Community link 1</button>
    <button type="button" data-oc-control="duplicate">Community link 2</button>
    <script>
      window.clicks = [];
      document.querySelectorAll('button[data-oc-control]').forEach((button, index) => {
        button.addEventListener('click', () => { window.clicks.push(index); });
      });
    </script>
  </body></html>`;
  await withControlPage(html, async (page) => {
    const enumeration = await enumeratePageControls(page);
    assert.equal(enumeration.controls.length, 2);
    const markers = enumeration.controls.map(target => target.marker);
    assert.equal(new Set(markers).size, 2, 'duplicate markers must not collapse two controls into one');
    for (const marker of markers) {
      assert.equal(await page.locator(`[data-oc-control="${marker}"]`).count(), 1, marker);
      await page.locator(`[data-oc-control="${marker}"]`).click();
    }
    assert.deepEqual(await page.evaluate(() => (window as unknown as { clicks: number[] }).clicks), [0, 1]);
  });
});
