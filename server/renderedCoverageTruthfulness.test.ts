import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveRenderedCompletionState,
  type BrowserFallbackResult,
  type BrowserFallbackTelemetry,
} from './browserCommunityFallback';
import {
  resolveRenderedCoverageReason,
  type RenderedCoverageReason,
} from './crawlerTelemetry';
import { renderedAcquisitionOutcome } from './inspector';
import { FOUND_GAP_RETRYABLE_FAILURE_CLASSES } from './communityRetryPolicy';
import { isSufficientRenderedCoverage } from './siteInspectionCache';

const telemetry = (coverageReason?: RenderedCoverageReason): BrowserFallbackTelemetry => ({
  requestsStarted: 1,
  requestsFinished: 1,
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
  clickFailureClasses: {} as BrowserFallbackTelemetry['clickFailureClasses'],
  lastLifecycleStage: 'PAGE_PROCESSED',
  coverageReason,
});

const rendered = (overrides: Partial<BrowserFallbackResult> = {}): BrowserFallbackResult => ({
  foundInvite: null,
  candidates: [],
  inspectedPages: 1,
  scrolls: 0,
  clicks: 0,
  complete: true,
  retryable: false,
  telemetry: telemetry('COMPLETE'),
  detail: 'test',
  ...overrides,
});

test('coverage reason ignores format/security rejections and keeps navigation policy gaps', () => {
  assert.equal(resolveRenderedCoverageReason({ pagesInspected: 1 }), 'COMPLETE');
  assert.equal(
    resolveRenderedCoverageReason({
      pagesInspected: 1,
      navigationPolicyExcluded: { 'invalid-protocol': 4, 'admission-rejected': 9 },
    }),
    'COMPLETE',
    'mailto/assets/private-address rejections are not unexamined navigation',
  );
  assert.equal(
    resolveRenderedCoverageReason({
      pagesInspected: 1,
      navigationPolicyExcluded: { 'cross-origin-disallowed': 1 },
    }),
    'POLICY_EXCLUDED',
  );
  assert.equal(
    resolveRenderedCoverageReason({
      pagesInspected: 1,
      navigationPolicyExcluded: { 'destination-budget': 1 },
    }),
    'POLICY_EXCLUDED',
  );
});

test('completion never certifies a non-COMPLETE coverage reason', () => {
  const clean = resolveRenderedCompletionState({
    inspectedPages: 1,
    timedOut: false,
    telemetry: telemetry('COMPLETE'),
    coverageReason: 'COMPLETE',
  });
  assert.equal(clean.complete, true);
  assert.equal(clean.retryable, false);

  const bounded = resolveRenderedCompletionState({
    inspectedPages: 1,
    timedOut: false,
    telemetry: telemetry('BOUNDED'),
    coverageReason: 'BOUNDED',
    coverageRetryable: true,
  });
  assert.equal(bounded.complete, false, 'a scroll/budget gap is not clean coverage');
  assert.equal(bounded.retryable, true);

  const policy = resolveRenderedCompletionState({
    inspectedPages: 1,
    timedOut: false,
    telemetry: telemetry('POLICY_EXCLUDED'),
    coverageReason: 'POLICY_EXCLUDED',
    coverageRetryable: false,
  });
  assert.equal(policy.complete, false);
  assert.equal(policy.retryable, false, 'deterministic policy gaps stay visible without retry ownership');

  const context = resolveRenderedCompletionState({
    inspectedPages: 1,
    timedOut: false,
    telemetry: telemetry('CONTEXT_UNREACHABLE'),
    coverageReason: 'CONTEXT_UNREACHABLE',
    coverageRetryable: false,
  });
  assert.equal(context.complete, false);
  assert.equal(context.retryable, false);
});

test('policy and context gaps become partial outcomes, never clean absence', () => {
  const policy = renderedAcquisitionOutcome(
    rendered({ telemetry: telemetry('POLICY_EXCLUDED') }),
    true,
    [],
  );
  assert.equal(policy.outcome, 'PARTIALLY_INSPECTED');
  assert.equal(policy.failureClass, 'RENDERED_POLICY_EXCLUDED');
  assert.equal(policy.gapRetryable, false);

  const context = renderedAcquisitionOutcome(
    rendered({ telemetry: telemetry('CONTEXT_UNREACHABLE') }),
    true,
    [],
  );
  assert.equal(context.outcome, 'PARTIALLY_INSPECTED');
  assert.equal(context.failureClass, 'RENDERED_CONTEXT_UNREACHABLE');
  assert.equal(context.gapRetryable, false);

  const bounded = renderedAcquisitionOutcome(
    rendered({ complete: false, retryable: true, telemetry: telemetry('BOUNDED') }),
    true,
    [],
  );
  assert.equal(bounded.outcome, 'PARTIALLY_INSPECTED');
  assert.equal(bounded.failureClass, 'RENDERED_PARTIAL_COVERAGE');
  assert.equal(bounded.gapRetryable, true);
});

test('required coverage does not hide a navigation-policy gap', () => {
  const result = renderedAcquisitionOutcome(
    rendered({
      telemetry: telemetry('POLICY_EXCLUDED'),
      requiredTotal: 1,
      requiredUnvisited: [],
      requiredTransientFailures: [],
      requiredPermanentFailures: [],
    }),
    true,
    [],
  );
  assert.equal(result.outcome, 'PARTIALLY_INSPECTED');
  assert.equal(result.failureClass, 'RENDERED_POLICY_EXCLUDED');
});

test('a retained invite keeps its coverage gap visible', () => {
  const result = renderedAcquisitionOutcome(
    rendered({
      foundInvite: 'abc',
      foundLocation: 'https://creator.example.com/',
      candidates: [{ nativeInviteCode: 'abc', sourceUrl: 'https://creator.example.com/' }] as never,
      telemetry: telemetry('POLICY_EXCLUDED'),
    }),
    true,
    [{ nativeInviteCode: 'abc', sourceUrl: 'https://creator.example.com/' }] as never,
  );
  assert.equal(result.outcome, 'FOUND');
  assert.equal(result.failureClass, 'RENDERED_POLICY_EXCLUDED');
  assert.equal(result.gapRetryable, false);
});

test('a retained invite with a bounded budget gap uses an accepted retry class', () => {
  const candidates = [{ nativeInviteCode: 'abc', sourceUrl: 'https://creator.example.com/' }] as never;
  const result = renderedAcquisitionOutcome(
    rendered({
      foundInvite: 'abc',
      foundLocation: 'https://creator.example.com/',
      candidates,
      complete: false,
      retryable: true,
      timedOut: true,
      dropReasons: { 'page-budget': 1 },
      telemetry: telemetry('BOUNDED'),
    }),
    true,
    candidates,
  );
  assert.equal(result.outcome, 'FOUND');
  assert.equal(result.failureClass, 'RENDERED_BUDGET_EXPIRED');
  assert.equal(result.gapRetryable, true);
  assert.ok(
    FOUND_GAP_RETRYABLE_FAILURE_CLASSES.has(String(result.failureClass)),
    'the FOUND gap class must be accepted by the shared retry policy',
  );
});

test('a permanent child failure does not make a deterministic context gap retryable', () => {
  const result = renderedAcquisitionOutcome(
    rendered({
      complete: false,
      // unresolvedFailedRequests makes the fallback retryable even though the
      // context gap itself is deterministic.
      retryable: true,
      telemetry: { ...telemetry('CONTEXT_UNREACHABLE'), unresolvedFailedRequests: 1 },
    }),
    true,
    [],
  );
  assert.equal(result.outcome, 'PARTIALLY_INSPECTED');
  assert.equal(result.failureClass, 'RENDERED_CONTEXT_UNREACHABLE');
  assert.equal(result.gapRetryable, false, 'context traversal limits cannot be cleared by refetching');
});

test('a transient required-child failure keeps retry ownership despite a deterministic context gap', () => {
  const result = renderedAcquisitionOutcome(
    rendered({
      complete: false,
      telemetry: telemetry('CONTEXT_UNREACHABLE'),
    }),
    true,
    [],
    {
      unvisited: [],
      transientFailures: ['https://creator.example/child'],
      permanentFailures: [],
    },
  );
  assert.equal(result.outcome, 'PARTIALLY_INSPECTED');
  assert.equal(result.failureClass, 'RENDERED_CONTEXT_UNREACHABLE');
  assert.equal(result.gapRetryable, true, 'the failed child can succeed on refetch even though traversal cannot');
});

test('legacy complete results without coverageReason stay clean', () => {
  const result = renderedAcquisitionOutcome(
    rendered({ telemetry: telemetry(undefined) }),
    true,
    [],
  );
  assert.equal(result.outcome, 'INSPECTED_NO_MATCH');
});

test('site-cache sufficiency requires a COMPLETE coverage reason', () => {
  assert.equal(isSufficientRenderedCoverage({ complete: true, coverageReason: 'COMPLETE' }, true), true);
  assert.equal(isSufficientRenderedCoverage({ complete: true, coverageReason: 'POLICY_EXCLUDED' }, true), false);
  assert.equal(isSufficientRenderedCoverage({ complete: true }, true), true, 'legacy rows keep their behavior');
});
