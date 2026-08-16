import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BROWSER_FALLBACK_BUDGET, RenderedFallbackGate, renderedFallbackGate, shouldEscalateToRenderedFallback } from './browserCommunityFallback';
import { classifyRenderedCrawlerFailure, renderedCrawlerRetryPolicy } from './renderedCrawlerPolicy';

test('browser fallback remains bounded while allowing useful retries', () => {
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxPages <= 6);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxScrollsPerPage <= 5);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxClicksPerPage <= 4);
  assert.equal(DEFAULT_BROWSER_FALLBACK_BUDGET.maxRequestRetries, 3);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxSessionRotations <= 4);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.totalTimeoutMs <= 60_000);
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

test('browser acquisition failure remains retryable rather than proving NOT_FOUND', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8'));
  assert.match(source, /complete:\s*false/);
  assert.match(source, /retryable:\s*true/);
  assert.match(source, /retryOnBlocked:\s*true/);
  assert.match(source, /maxSessionRotations:\s*limits\.maxSessionRotations/);
});
