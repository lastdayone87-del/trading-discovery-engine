import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRONTIER_POLICY_VERSION,
  MAX_FRONTIER_PAGES_PER_SITE,
  MAX_FRONTIER_DEPTH,
  scoreFrontierCandidate,
  hintScoreFor,
  marginalEvidenceYield,
  decideFrontierStep,
  classifyBlockedAcquisition,
  isFrontierEnabled,
} from './frontierManager';

test('base scorer is deterministic with documented discounts', () => {
  const signals = { url: 'https://example.com/join', hintScore: 50, depth: 1, attempts: 0, sitemapListed: false, structuredNominated: false };
  const a = scoreFrontierCandidate(signals);
  const b = scoreFrontierCandidate(signals);
  assert.deepEqual(a, b);
  assert.equal(a.scorerVersion, FRONTIER_POLICY_VERSION);
  assert.ok(a.expectedValue > 0 && a.expectedValue <= 50);
  const deeper = scoreFrontierCandidate({ ...signals, depth: 2 });
  assert.ok(deeper.expectedValue < a.expectedValue, 'depth discounts value');
  const retried = scoreFrontierCandidate({ ...signals, attempts: 2 });
  assert.ok(retried.expectedValue < a.expectedValue, 'prior failures discount value');
  const nominated = scoreFrontierCandidate({ ...signals, hintScore: 0, sitemapListed: true });
  assert.ok(nominated.expectedValue > 0, 'sitemap nomination carries a small prior even at zero hint');
  const zeroed = scoreFrontierCandidate({ ...signals, hintScore: 0 });
  assert.equal(zeroed.expectedValue, 0);
});

test('hint scoring shares the crawl loop source of truth', () => {
  assert.ok(hintScoreFor('https://example.com/join-community') > 0);
  assert.equal(hintScoreFor('https://example.com/quiet-garden-path'), 0);
  assert.equal(hintScoreFor('not a url'), 0);
  assert.equal(MAX_FRONTIER_PAGES_PER_SITE, 12, 'never above the legacy child cap without approved evidence');
  assert.equal(MAX_FRONTIER_DEPTH, 2, 'never deeper than the legacy crawl without approved evidence');
});

test('marginal yield averages the trailing window deterministically', () => {
  assert.equal(marginalEvidenceYield([], 5), 0);
  assert.equal(marginalEvidenceYield([0, 0, 0], 5), 0);
  assert.equal(marginalEvidenceYield([2, 4], 5), 3);
  assert.equal(marginalEvidenceYield([10, 0, 0, 0, 0, 2], 3), 2 / 3);
});

function stateful(overrides: Record<string, unknown> = {}) {
  return {
    queued: [
      scoreFrontierCandidate({ url: 'https://example.com/a', hintScore: 50, depth: 1, attempts: 0, sitemapListed: false, structuredNominated: false }),
      scoreFrontierCandidate({ url: 'https://example.com/b', hintScore: 10, depth: 1, attempts: 0, sitemapListed: false, structuredNominated: false }),
    ],
    acquiredPages: 2,
    evidenceUnits: 1,
    yieldHistory: [1, 0],
    blockedTerminals: 0,
    spentBudget: 1,
    budgetCap: 12,
    ...overrides,
  };
}

const OPEN_POLICY = { marginalFloor: 0.01, remainingValueFloor: 0.01, marginalWindow: 5 };

test('arbiter acquires best value while coverage, budget, and yield hold', () => {
  const decision = decideFrontierStep(stateful(), OPEN_POLICY);
  assert.equal(decision.action, 'ACQUIRE');
  if (decision.action === 'ACQUIRE') assert.equal(decision.url, 'https://example.com/a');
});

test('arbiter stops on exhaustion, caps, budget, floors — each with its reason', () => {
  assert.deepEqual(decideFrontierStep(stateful({ queued: [] }), OPEN_POLICY).action, 'STOP');
  assert.match(
    (decideFrontierStep(stateful({ acquiredPages: 12 }), OPEN_POLICY) as { reason: string }).reason,
    /page-cap-reached/,
  );
  assert.match(
    (decideFrontierStep(stateful({ spentBudget: 12, budgetCap: 12 }), OPEN_POLICY) as { reason: string }).reason,
    /budget-exhausted/,
  );
  assert.match(
    (decideFrontierStep(stateful({ yieldHistory: [0, 0, 0, 0, 0] }), { marginalFloor: 0.5, remainingValueFloor: 0, marginalWindow: 5 }) as { reason: string }).reason,
    /marginal-yield-below-floor/,
  );
  assert.match(
    (decideFrontierStep(stateful({ queued: [scoreFrontierCandidate({ url: 'https://example.com/z', hintScore: 0, depth: 1, attempts: 0, sitemapListed: false, structuredNominated: false })] }), OPEN_POLICY) as { reason: string }).reason,
    /frontier-exhausted/,
  );
});

test('arbiter never stops a known-evidence site on floors alone', () => {
  // High remaining value + positive marginal yield must always acquire,
  // regardless of how strict the floors are set below actuals.
  const decision = decideFrontierStep(
    stateful({ yieldHistory: [3, 2], evidenceUnits: 5 }),
    { marginalFloor: 0.5, remainingValueFloor: 1, marginalWindow: 5 },
  );
  assert.equal(decision.action, 'ACQUIRE');
});

test('blocked classification separates terminal states without extra fetches', () => {
  assert.equal(classifyBlockedAcquisition({}), 'INCOMPLETE');
  assert.equal(classifyBlockedAcquisition({ processedPages: 0 }), 'INCOMPLETE');
  assert.equal(classifyBlockedAcquisition({ processedPages: 3 }), 'OK');
  assert.equal(classifyBlockedAcquisition({ robotsState: 'DISALLOWED' }), 'ROBOTS_DISALLOWED');
  assert.equal(classifyBlockedAcquisition({ httpStatus: 429 }), 'RATE_LIMITED');
  assert.equal(classifyBlockedAcquisition({ failureClass: 'RATE_LIMIT' }), 'RATE_LIMITED');
  assert.equal(classifyBlockedAcquisition({ hasWafMarkers: true }), 'WAF_MANAGED');
  assert.equal(classifyBlockedAcquisition({ hasLoginForm: true }), 'LOGIN_WALL');
  assert.equal(classifyBlockedAcquisition({ hasPaywallMarkers: true }), 'PAYWALL');
  assert.equal(classifyBlockedAcquisition({ timedOut: true }), 'UNREACHABLE');
  assert.equal(classifyBlockedAcquisition({ transportFailed: true }), 'UNREACHABLE');
  assert.equal(classifyBlockedAcquisition({ httpStatus: 503 }), 'UNREACHABLE');
  // HTTP semantics outrank body markers.
  assert.equal(classifyBlockedAcquisition({ httpStatus: 429, hasLoginForm: true }), 'RATE_LIMITED');
});

test('frontier stays disabled by default', async () => {
  assert.equal(await isFrontierEnabled(async () => 'false'), false);
  assert.equal(await isFrontierEnabled(async () => 'true'), true);
});
