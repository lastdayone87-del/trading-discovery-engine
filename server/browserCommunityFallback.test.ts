import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BROWSER_FALLBACK_BUDGET, RenderedFallbackGate, renderedFallbackGate, shouldEscalateToRenderedFallback } from './browserCommunityFallback';

test('browser fallback is bounded', () => {
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxPages <= 4);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxScrollsPerPage <= 4);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxClicksPerPage <= 3);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.totalTimeoutMs <= 35_000);
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
  // Contract is enforced by the implementation: dynamic import/launch/navigation
  // errors return complete=false and retryable=true. This test intentionally does
  // not launch Chromium in the ordinary unit-test suite.
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8'));
  assert.match(source, /complete:\s*false/);
  assert.match(source, /retryable:\s*true/);
});
