import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_BROWSER_FALLBACK_BUDGET, browserFallbackTelemetrySummary, isTelegramPostPermalink, RenderedFallbackGate, renderedFallbackGate, shouldEnqueueRenderedCommunityLink, shouldEscalateToRenderedFallback } from './browserCommunityFallback';
import { classifyRenderedCrawlerFailure, isRenderedNavigationTimeout, renderedCrawlerHostBackoffMs, renderedCrawlerRetryPolicy } from './renderedCrawlerPolicy';

test('browser fallback remains bounded while allowing useful retries', () => {
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxPages <= 6);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxScrollsPerPage <= 5);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxClicksPerPage <= 4);
  assert.equal(DEFAULT_BROWSER_FALLBACK_BUDGET.maxRequestRetries, 3);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxSessionRotations <= 4);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.totalTimeoutMs <= 60_000);
});

test('Telegram message permalinks are not recursively crawled as community surfaces', () => {
  assert.equal(isTelegramPostPermalink('https://t.me/vipintraders/4013'), true);
  assert.equal(isTelegramPostPermalink('https://t.me/s/vipintraders/4014?single'), true);
  assert.equal(isTelegramPostPermalink('https://telegram.me/vipintraders/4015'), true);
  assert.equal(shouldEnqueueRenderedCommunityLink('https://t.me/vipintraders/4013'), false);
  assert.equal(shouldEnqueueRenderedCommunityLink('https://t.me/s/vipintraders/4014'), false);
});

test('Telegram community roots and non-Telegram community links remain eligible', () => {
  assert.equal(isTelegramPostPermalink('https://t.me/vipintraders'), false);
  assert.equal(shouldEnqueueRenderedCommunityLink('https://t.me/vipintraders'), true);
  assert.equal(shouldEnqueueRenderedCommunityLink('https://example.com/vip-community'), true);
});

test('rendered retry policy rotates sessions for blocked responses', () => {
  assert.equal(classifyRenderedCrawlerFailure(new Error('Request blocked - received 403 status code.')), 'BLOCKED');
  const policy = renderedCrawlerRetryPolicy(new Error('Request blocked - received 403 status code.'), 0);
  assert.equal(policy.retryable, true);
  assert.equal(policy.retireSession, true);
  assert.ok(policy.delayMs >= 500);
});

test('rendered retry policy backs off harder for 429 rate limits', () => {
  const first = renderedCrawlerRetryPolicy(new Error('received 429 Too Many Requests'), 0);
  const second = renderedCrawlerRetryPolicy(new Error('received 429 Too Many Requests'), 1);
  assert.equal(first.failureClass, 'RATE_LIMITED');
  assert.equal(first.retireSession, true);
  assert.ok(second.delayMs > first.delayMs);
  assert.ok(second.delayMs <= 8_000);
});

test('navigation timeout is a transient request failure, not a browser-runtime failure', () => {
  const error = new Error('Page.goto: Timeout 15000ms exceeded.');
  assert.equal(isRenderedNavigationTimeout(error), true);
  assert.equal(classifyRenderedCrawlerFailure(error), 'TRANSIENT');
  assert.equal(renderedCrawlerHostBackoffMs('TRANSIENT', 0), 500);
  assert.equal(renderedCrawlerHostBackoffMs('TRANSIENT', 8), 4_000);
});

test('rendered retry policy keeps transient network retries without forced session churn', () => {
  const policy = renderedCrawlerRetryPolicy(new Error('Navigation timed out after 15000 ms'), 1);
  assert.equal(policy.failureClass, 'TRANSIENT');
  assert.equal(policy.retryable, true);
  assert.equal(policy.retireSession, false);
});

test('rendered browser launches are process-wide bounded', async () => {
  assert.ok(renderedFallbackGate.snapshot().concurrency <= 2);
  assert.ok(renderedFallbackGate.snapshot().maxPending <= 32);

  const gate = new RenderedFallbackGate(1, 2);
  let active = 0;
  let maxActive = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });

  const first = gate.run(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await firstBlocked;
    active--;
  });
  const second = gate.run(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    active--;
  });

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(gate.snapshot(), { active: 1, pending: 1, concurrency: 1, maxPending: 2 });
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
  assert.deepEqual(gate.snapshot(), { active: 0, pending: 0, concurrency: 1, maxPending: 2 });
});

test('rendered host backoff remains bounded by failure class and retry count', () => {
  assert.equal(renderedCrawlerHostBackoffMs('RATE_LIMITED', 0), 1_000);
  assert.equal(renderedCrawlerHostBackoffMs('RATE_LIMITED', 10), 8_000);
  assert.equal(renderedCrawlerHostBackoffMs('BLOCKED', 10), 4_000);
  assert.equal(renderedCrawlerHostBackoffMs('OTHER', 10), 250);
});

test('rendered browser gate rejects unbounded pending launches', async () => {
  const gate = new RenderedFallbackGate(1, 1);
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const first = gate.run(async () => blocker);
  const second = gate.run(async () => undefined);
  await assert.rejects(gate.run(async () => undefined), /RENDERED_FALLBACK_SATURATED/);
  release();
  await Promise.all([first, second]);
});

test('does not launch browser after static Discord success', () => {
  assert.equal(shouldEscalateToRenderedFallback({ staticOutcome: 'FOUND', creatorLikelyTrading: true, surface: 'CREATOR_WEBSITES' }), false);
});

test('does not spend browser budget on non-trading creators', () => {
  assert.equal(shouldEscalateToRenderedFallback({ staticOutcome: 'PARTIALLY_INSPECTED', creatorLikelyTrading: false, surface: 'CREATOR_WEBSITES' }), false);
});

test('escalates incomplete trading-creator websites', () => {
  assert.equal(shouldEscalateToRenderedFallback({ staticOutcome: 'PARTIALLY_INSPECTED', creatorLikelyTrading: true, surface: 'CREATOR_WEBSITES' }), true);
  assert.equal(shouldEscalateToRenderedFallback({ staticOutcome: 'ACQUISITION_FAILED', creatorLikelyTrading: true, surface: 'CREATOR_WEBSITES' }), true);
});

test('can escalate a fully static no-match because Discord may be JS-hidden', () => {
  assert.equal(shouldEscalateToRenderedFallback({ staticOutcome: 'INSPECTED_NO_MATCH', creatorLikelyTrading: true, surface: 'CREATOR_WEBSITES' }), true);
});

test('crawler telemetry summary is sanitized and bounded for durable inspection detail', () => {
  assert.equal(browserFallbackTelemetrySummary({requestsStarted:2,requestsFinished:1,requestsFailed:1,navigationTimeouts:1,blockedRequests:0,rateLimitedRequests:0,transientRequests:1,hostBackoffsApplied:1,clicksStarted:3,clicksSucceeded:2,clicksFailed:1,clickFailureClasses:{BLOCKED:0,RATE_LIMITED:0,TRANSIENT:1,OTHER:0}}), 'telemetry{started:2,finished:1,failed:1,navigationTimeouts:1,blocked:0,rateLimited:0,transient:1,hostBackoffs:1,clicksStarted:3,clicksSucceeded:2,clicksFailed:1,clickFailureClasses:{"BLOCKED":0,"RATE_LIMITED":0,"TRANSIENT":1,"OTHER":0}}');
});

test('crawler exposes bounded failure telemetry and keeps partial results retryable', () => {
  const source = fs.readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  assert.match(source, /telemetry\.requestsFailed/);
  assert.match(source, /telemetry\.navigationTimeouts/);
  assert.match(source, /hostBackoffUntil/);
  assert.match(source, /isBrowserRuntimeFailure/);
  assert.match(source, /clicksFailed/);
  assert.match(source, /clickFailureClasses/);
  assert.match(source, /complete:!incomplete/);
});

test('browser acquisition failure remains retryable rather than proving NOT_FOUND', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8'));
  assert.match(source, /complete:\s*false/);
  assert.match(source, /retryable:\s*true/);
  assert.match(source, /retryOnBlocked:\s*true/);
  assert.match(source, /maxSessionRotations:\s*limits\.maxSessionRotations/);
});
