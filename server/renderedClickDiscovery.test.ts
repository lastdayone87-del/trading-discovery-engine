import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attemptRenderedControlClick,
  buildClickFailureSample,
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
// successful click — the crawler must click it and post-click inspection
// must discover the invite. Fake page: no network, no browser.
test('click-through button reveals hidden Discord invite via post-click inspection', async () => {
  const telemetry = freshTelemetry();
  const state = { revealed: false };
  const discovered: string[] = [];
  const control = { index: 1, text: 'Join our Discord', href: null, tag: 'button' as const };
  const result = await attemptRenderedControlClick({
    control,
    pageUrl: 'https://creator.example/',
    getHref: async () => null,
    performClick: async () => {
      state.revealed = true;
    },
    settle: async () => {},
    retain: () => {},
    inspect: async () => {
      const dom = state.revealed
        ? '<a href="https://discord.gg/hiddentrading">join</a>'
        : '<button>Join our Discord</button>';
      for (const candidate of extractDiscordCandidates(dom, 'CREATOR_WEBSITES', 'https://creator.example/')) {
        if (candidate.nativeInviteCode) discovered.push(candidate.nativeInviteCode);
      }
    },
    telemetry,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(discovered, ['hiddentrading']);
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
  let inspected = false;
  const control = { index: 7, text: 'Join now', href: 'https://creator.example/join', tag: 'anchor' as const };
  const result = await attemptRenderedControlClick({
    control,
    pageUrl: 'https://creator.example/',
    getHref: async () => 'https://creator.example/join',
    performClick: async () => {
      throw new Error('locator.click: Element is not attached to the DOM');
    },
    settle: async () => {
      throw new Error('settle must not run after a failed click');
    },
    retain: () => {},
    inspect: async () => {
      inspected = true;
    },
    telemetry,
  });
  assert.equal(result.ok, false);
  assert.equal(result.clickFailureKind, 'detached_stale');
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
  assert.equal(classifyRenderedClickFailure(new Error('net::ERR_INTERNET_DISCONNECTED')), 'network');
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
test('sanitizer persists bounded click detail and drops unknown/negative keys', () => {
  const persisted = safeCrawlerTelemetry({
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
