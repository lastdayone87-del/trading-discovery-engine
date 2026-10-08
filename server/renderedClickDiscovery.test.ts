import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attemptRenderedControlClick,
  buildClickFailureSample,
  createRenderedControlClickDeps,
  isSkippableNavigableAnchorClick,
  partitionRenderedClickTargets,
  type BrowserFallbackTelemetry,
} from './browserCommunityFallback';
import {
  classifyRenderedClickFailure,
  emptyRenderedClickFailureDetail,
} from './renderedCrawlerPolicy';
import { extractDiscordCandidates } from './discordCandidates';
import { safeCrawlerTelemetry } from './crawlerTelemetry';
import {
  sanitizeClickFailureDetail,
  sanitizeClickFailedTargetKinds,
} from './crawlerTelemetry';

const freshTelemetry = (): BrowserFallbackTelemetry => ({
  requestsStarted: 0,
  requestsFinished: 0,
  requestsFailed: 0,
  navigationTimeouts: 0,
  blockedRequests: 0,
  rateLimitedRequests: 0,
  transientRequests: 0,
  unresolvedFailedRequests: 0,
  hostBackoffsApplied: 0,
  clicksStarted: 0,
  clicksSucceeded: 0,
  clicksFailed: 0,
  clickFailureClasses: { BLOCKED: 0, RATE_LIMITED: 0, TRANSIENT: 0, OTHER: 0 },
  lastLifecycleStage: 'PAGE_PROCESSED',
});

// Fixture 1: a same-host /community anchor is handled by normal link
// enqueue and must never need a click.
test('same-host community anchor is enqueue-handled, never clicked', () => {
  assert.equal(
    isSkippableNavigableAnchorClick({ href: 'https://creator.example/community' }, 'https://creator.example/'),
    true,
  );
  const plan = partitionRenderedClickTargets(
    [{ index: 0, text: 'community https://creator.example/community', href: 'https://creator.example/community', tag: 'anchor' }],
    'https://creator.example/',
    4,
  );
  assert.equal(plan.toClick.length, 0);
  assert.equal(plan.skippedNavigableAnchors, 1);
});

// Fixture 2: a button revealing a hidden discord.gg link only after a
// successful click — driven through the production wiring factory so the
// test proves the call-site callbacks (getHref, click+timeout, 400ms settle,
// retain, inspect, clicks++) behave exactly as the crawl loop wires them.
test('click-through button reveals hidden Discord invite via post-click inspection', async () => {
  const telemetry = freshTelemetry();
  const state = { revealed: false };
  const discovered: string[] = [];
  const calls: string[] = [];
  let clickCount = 0;
  const control = { index: 1, text: 'Join our Discord', href: null, tag: 'button' as const };
  const fakeLocator = {
    getAttribute: async (name: string) => {
      calls.push(`getAttribute:${name}`);
      return null;
    },
    click: async (options: { timeout: number }) => {
      calls.push(`click:${options.timeout}`);
      state.revealed = true;
    },
  };
  const fakePage = {
    url: () => 'https://creator.example/',
    waitForTimeout: async (ms: number) => {
      calls.push(`wait:${ms}`);
    },
  };
  const retained: string[] = [];
  let inspections = 0;
  const result = await attemptRenderedControlClick(
    createRenderedControlClickDeps({
      locator: fakeLocator,
      page: fakePage,
      control,
      retain: (text: string, pageUrl: string) => {
        retained.push(`${text} @${pageUrl}`);
      },
      inspect: async () => {
        inspections++;
        const dom = state.revealed
          ? '<a href="https://discord.gg/hiddentrading">join</a>'
          : '<button>Join our Discord</button>';
        for (const candidate of extractDiscordCandidates(dom, 'CREATOR_WEBSITES', 'https://creator.example/')) {
          if (candidate.nativeInviteCode) discovered.push(candidate.nativeInviteCode);
        }
      },
      telemetry,
      onClicked: () => {
        clickCount++;
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(discovered, ['hiddentrading']);
  // Production wiring proof: href read, 2s click timeout, 400ms settle,
  // single post-click inspection, exactly one clicks++ on success.
  assert.deepEqual(calls, ['getAttribute:href', 'click:2000', 'wait:400']);
  assert.equal(inspections, 1);
  assert.equal(clickCount, 1);
  assert.equal(retained.length, 1);
  assert.equal(telemetry.clicksStarted, 1);
  assert.equal(telemetry.clicksSucceeded, 1);
  assert.equal(telemetry.clicksFailed, 0);
});

// Fixture 3: a control detached after the scroll/re-location phase — the
// click fails deterministically, is classified, and never throws or touches
// page/request accounting.
test('detached control fails deterministically without corrupting page outcome', async () => {
  const telemetry = freshTelemetry();
  telemetry.requestsStarted = 2;
  const calls: string[] = [];
  let clickCount = 0;
  let inspected = false;
  const control = { index: 7, text: 'Join now', href: 'https://creator.example/join', tag: 'anchor' as const };
  const result = await attemptRenderedControlClick(
    createRenderedControlClickDeps({
      locator: {
        getAttribute: async () => {
          calls.push('getAttribute:href');
          return 'https://creator.example/join';
        },
        click: async (options: { timeout: number }) => {
          calls.push(`click:${options.timeout}`);
          throw new Error('locator.click: Element is not attached to the DOM');
        },
      },
      page: {
        url: () => 'https://creator.example/',
        waitForTimeout: async () => {
          calls.push('wait');
        },
      },
      control,
      retain: () => {},
      inspect: async () => {
        inspected = true;
      },
      telemetry,
      onClicked: () => {
        clickCount++;
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.clickFailureKind, 'detached_stale');
  // Wiring proof on failure: href read and click attempted with production
  // timeout, but no settle wait, no inspection, and no clicks++.
  assert.deepEqual(calls, ['getAttribute:href', 'click:2000']);
  assert.equal(clickCount, 0);
  assert.equal(telemetry.clicksStarted, 1);
  assert.equal(telemetry.clicksSucceeded, 0);
  assert.equal(telemetry.clicksFailed, 1);
  assert.equal(telemetry.clickFailureDetail?.detached_stale, 1);
  assert.equal(telemetry.clickFailedTargetKinds?.anchor, 1);
  assert.equal(telemetry.clickFailedWithHref, 1);
  assert.equal(inspected, false);
  // Page/request accounting untouched by click handling.
  assert.equal(telemetry.requestsStarted, 2);
  assert.ok(telemetry.firstClickFailureSample);
  assert.ok((telemetry.firstClickFailureSample as string).length <= 200);
});

// Classification uses Playwright's actual error message formats.
test('click failure classification covers real Playwright error shapes', () => {
  assert.equal(classifyRenderedClickFailure(new Error('locator.click: Timeout 2000ms exceeded.')), 'timeout');
  assert.equal(
    classifyRenderedClickFailure(new Error('locator.click: Element is not attached to the DOM')),
    'detached_stale',
  );
  assert.equal(
    classifyRenderedClickFailure(new Error('locator.click: Element intercepts pointer events')),
    'overlay_intercepted',
  );
  assert.equal(
    classifyRenderedClickFailure(new Error('locator.click: Element is not visible')),
    'overlay_intercepted',
  );
  assert.equal(classifyRenderedClickFailure(new Error('Target closed')), 'target_closed');
  assert.equal(classifyRenderedClickFailure(new Error('browser has been closed')), 'target_closed');
  assert.equal(
    classifyRenderedClickFailure(new Error('Execution context was destroyed, most likely because of a navigation')),
    'nav_interrupted',
  );
  assert.equal(
    classifyRenderedClickFailure(new Error('Navigation failed because page crashed')),
    'nav_interrupted',
  );
  assert.equal(
    classifyRenderedClickFailure(new Error('locator.click: Element is not enabled')),
    'overlay_intercepted',
  );
  assert.equal(classifyRenderedClickFailure(new Error('net::ERR_INTERNET_DISCONNECTED')), 'network');
  assert.equal(classifyRenderedClickFailure(new Error('read ECONNRESET')), 'network');
  assert.equal(classifyRenderedClickFailure(new Error('connect ECONNREFUSED 127.0.0.1:80')), 'network');
  assert.equal(classifyRenderedClickFailure(new Error('something entirely unexpected')), 'other');
  assert.equal(emptyRenderedClickFailureDetail().timeout, 0);
});

// Bounded sample: URLs/query stripped, capped at 200 chars.
test('first-failure sample is sanitized and bounded', () => {
  const sample = buildClickFailureSample(
    'timeout',
    'https://creator.example/join?token=abc123',
    new Error('locator.click: Timeout 2000ms exceeded waiting for https://creator.example/join?token=abc123'),
  );
  assert.ok(sample.startsWith('timeout|href|'));
  assert.ok(!sample.includes('http'));
  assert.ok(!sample.includes('abc123'));
  assert.ok(sample.length <= 200);
});

// Ledger persistence keeps the new bounded fields and drops the rest.
test('sanitizer persists bounded click detail and drops unknown/negative keys', () => {  const persisted = safeCrawlerTelemetry({
    mode: 'RENDERED',
    redirectsFollowed: 0,
    pagesInspected: 1,
    budgetExhausted: false,
    clicksStarted: 2,
    clicksSucceeded: 0,
    clicksFailed: 2,
    requestsStarted: 1,
    requestsFinished: 1,
    requestsFailed: 0,
    navigationTimeouts: 0,
    blockedRequests: 0,
    rateLimitedRequests: 0,
    hostBackoffsApplied: 0,
    clickFailureDetail: { timeout: 1, detached_stale: 1, bogus: 5, network: -1 },
    clickFailedTargetKinds: { anchor: 1, button: 1, role: 0, span: 2 },
    clickFailedWithHref: 1,
    firstClickFailureSample: 'timeout|href|locator.click: Timeout 2000ms exceeded.',
  });
  assert.deepEqual(persisted?.clickFailureDetail, { timeout: 1, detached_stale: 1 });
  assert.deepEqual(persisted?.clickFailedTargetKinds, { anchor: 1, button: 1 });
  assert.equal(persisted?.clickFailedWithHref, 1);
  assert.equal(persisted?.firstClickFailureSample, 'timeout|href|locator.click: Timeout 2000ms exceeded.');
});

// Bounded counters: normal values survive, invalid rejected, excess clamped.
test('sanitizer clamps click counters to actual attempts and truncates samples', () => {
  const base = {
    mode: 'RENDERED',
    redirectsFollowed: 0,
    pagesInspected: 1,
    budgetExhausted: false,
    clicksStarted: 3,
    clicksSucceeded: 1,
    clicksFailed: 2,
    requestsStarted: 1,
    requestsFinished: 1,
    requestsFailed: 0,
    navigationTimeouts: 0,
    blockedRequests: 0,
    rateLimitedRequests: 0,
    hostBackoffsApplied: 0,
  };
  // Normal values survive unchanged.
  const normal = safeCrawlerTelemetry({
    ...base,
    clickFailureDetail: { timeout: 1, detached_stale: 1 },
    clickFailedTargetKinds: { anchor: 1, button: 1 },
    clickFailedWithHref: 2,
  });
  assert.deepEqual(normal?.clickFailureDetail, { timeout: 1, detached_stale: 1 });
  assert.deepEqual(normal?.clickFailedTargetKinds, { anchor: 1, button: 1 });
  assert.equal(normal?.clickFailedWithHref, 2);
  // Zero/negative/invalid values are rejected.
  const invalid = safeCrawlerTelemetry({
    ...base,
    clicksStarted: 0,
    clickFailureDetail: { timeout: 0, network: -5, bogus: 3 },
    clickFailedTargetKinds: { anchor: 0 },
    clickFailedWithHref: -2,
  });
  assert.equal(invalid?.clickFailureDetail, undefined);
  assert.equal(invalid?.clickFailedTargetKinds, undefined);
  assert.equal(invalid?.clickFailedWithHref, undefined);
  // Excessively large values are clamped to actual attempts, never unbounded.
  const clamped = safeCrawlerTelemetry({
    ...base,
    clickFailureDetail: { timeout: 1_000_000_000, network: 1_000_000_000 },
    clickFailedTargetKinds: { anchor: 999_999_999 },
    clickFailedWithHref: 999_999_999,
  });
  assert.deepEqual(clamped?.clickFailureDetail, { timeout: 3 });
  assert.deepEqual(clamped?.clickFailedTargetKinds, { anchor: 3 });
  assert.equal(clamped?.clickFailedWithHref, 3);
  // Oversize samples are truncated to 200 chars with URLs stripped.
  const longSample = safeCrawlerTelemetry({
    ...base,
    firstClickFailureSample: `timeout|href|${'x'.repeat(500)} https://example.com/join?token=secret-value`,
  });
  assert.ok((longSample?.firstClickFailureSample as string).length <= 200);
  assert.ok(!(longSample?.firstClickFailureSample as string).includes('http'));
});

// Sanitizer budget semantics: omitted maxTotal is unlimited for direct
// callers; finite budgets clamp; invalid budgets permit nothing.
test('exported sanitizers default to unlimited and clamp finite budgets', () => {
  // 1. No maxTotal preserves valid normal counters.
  assert.deepEqual(sanitizeClickFailureDetail({ timeout: 2, network: 1 }), { timeout: 2, network: 1 });
  assert.deepEqual(sanitizeClickFailedTargetKinds({ anchor: 3, role: 1 }), { anchor: 3, role: 1 });
  // 2. Finite maxTotal still clamps per-key and total counts.
  assert.deepEqual(sanitizeClickFailureDetail({ timeout: 5, network: 5 }, 3), { timeout: 3 });
  assert.deepEqual(sanitizeClickFailedTargetKinds({ anchor: 4, button: 4 }, 5), { anchor: 4, button: 1 });
  // 3. Zero/negative/invalid budgets do not permit positive counters.
  assert.equal(sanitizeClickFailureDetail({ timeout: 2 }, 0), undefined);
  assert.equal(sanitizeClickFailureDetail({ timeout: 2 }, -4), undefined);
  assert.equal(sanitizeClickFailureDetail({ timeout: 2 }, Number.NaN), undefined);
  assert.equal(sanitizeClickFailedTargetKinds({ anchor: 2 }, 0), undefined);
});
