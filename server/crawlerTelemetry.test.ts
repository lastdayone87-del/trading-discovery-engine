import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderedCrawlerTelemetry, safeCrawlerTelemetry, staticCrawlerTelemetry, workerInstanceId } from './crawlerTelemetry';

test('static telemetry records redirect/page/budget measurements without changing outcome semantics', () => {
  const telemetry = staticCrawlerTelemetry({ redirectsFollowed: 2, pagesInspected: 3, budgetExhausted: true });
  const { workerInstanceId: instance, ...stable } = telemetry;
  assert.deepEqual(stable, {
    mode: 'STATIC',
    redirectsFollowed: 2,
    pagesInspected: 3,
    budgetExhausted: true,
    clicksStarted: 0,
    clicksSucceeded: 0,
    clicksFailed: 0,
    requestsStarted: 0,
    requestsFinished: 0,
    requestsFailed: 0,
    navigationTimeouts: 0,
    blockedRequests: 0,
    rateLimitedRequests: 0,
    hostBackoffsApplied: 0,
  });
  assert.match(instance || '', /^.+:\d+:[0-9a-f]{8}$/);
});

test('rendered telemetry preserves bounded click/request counters without mislabeling budget', () => {
  const telemetry = renderedCrawlerTelemetry({
    inspectedPages: 6,
    clicks: 2,
    complete: false,
    telemetry: {
      requestsStarted: 6,
      requestsFinished: 5,
      requestsFailed: 1,
      clicksStarted: 4,
      clicksFailed: 2,
      navigationTimeouts: 1,
      blockedRequests: 1,
      hostBackoffsApplied: 3,
    },
  });
  assert.equal(telemetry.mode, 'RENDERED');
  assert.equal(telemetry.pagesInspected, 6);
  assert.equal(telemetry.clicksSucceeded, 2);
  assert.equal(telemetry.clicksFailed, 2);
  // Incomplete without budget expiry must not claim budget exhaustion:
  // blocked/transient failures are incomplete for non-budget reasons.
  assert.equal(telemetry.budgetExhausted, false);
  assert.equal(telemetry.navigationTimeouts, 1);
  assert.equal(telemetry.blockedRequests, 1);
  assert.equal(telemetry.hostBackoffsApplied, 3);
});

test('rendered telemetry marks budget exhaustion only on real budget expiry', () => {
  const timedOut = renderedCrawlerTelemetry({ inspectedPages: 3, clicks: 0, complete: false, timedOut: true, telemetry: { requestsStarted: 3 } });
  assert.equal(timedOut.budgetExhausted, true);
  const clean = renderedCrawlerTelemetry({ inspectedPages: 3, clicks: 0, complete: true, telemetry: { requestsStarted: 3 } });
  assert.equal(clean.budgetExhausted, false);
  const zeroPage = renderedCrawlerTelemetry({ inspectedPages: 0, clicks: 0, complete: false, telemetry: { requestsStarted: 0 } });
  assert.equal(zeroPage.budgetExhausted, false);
});

test('safe telemetry rejects malformed mode and clamps malformed counters', () => {
  assert.equal(safeCrawlerTelemetry({ mode: 'UNKNOWN' }), undefined);
  const telemetry = safeCrawlerTelemetry({ mode: 'STATIC', pagesInspected: -4, redirectsFollowed: 2.8, clicksFailed: 'bad', budgetExhausted: true });
  assert.equal(telemetry?.pagesInspected, 0);
  assert.equal(telemetry?.redirectsFollowed, 2);
  assert.equal(telemetry?.clicksFailed, 0);
  assert.equal(telemetry?.budgetExhausted, true);
});

test('worker instance id is stable per process and identifies host and pid', () => {
  assert.equal(workerInstanceId(), workerInstanceId());
  assert.match(workerInstanceId(), /^.+:\d+:[0-9a-f]{8}$/);
  assert.equal(workerInstanceId().split(':')[1], String(process.pid));
});

test('rendered constructor stamps this-process instance attribution', () => {
  const telemetry = renderedCrawlerTelemetry({ inspectedPages: 1, clicks: 0, complete: true });
  assert.equal(telemetry.workerInstanceId, workerInstanceId());
});

test('rendered constructor preserves lifecycle stage, zero-page reason, and cause', () => {
  const telemetry = renderedCrawlerTelemetry({
    inspectedPages: 0,
    clicks: 0,
    complete: false,
    telemetry: {
      requestsStarted: 0,
      lastLifecycleStage: 'CRAWLER_RUNNING',
      zeroPageReason: 'CRAWLER_RETURNED_WITHOUT_REQUESTS',
      launchCauseSnippet: 'boom',
    },
  });
  assert.equal(telemetry.lastLifecycleStage, 'CRAWLER_RUNNING');
  assert.equal(telemetry.zeroPageReason, 'CRAWLER_RETURNED_WITHOUT_REQUESTS');
  assert.equal(telemetry.launchCauseSnippet, 'boom');
});

test('safe telemetry round-trips new diagnostic fields to the ledger', () => {
  const telemetry = safeCrawlerTelemetry({
    mode: 'RENDERED',
    pagesInspected: 0,
    requestsStarted: 0,
    lastLifecycleStage: 'HANDLER_ENTERED',
    zeroPageReason: 'HANDLER_ENTERED_NO_PAGES',
    launchCauseSnippet: '  spaced\ncause ',
    workerInstanceId: 'replica-a:123',
  });
  assert.equal(telemetry?.lastLifecycleStage, 'HANDLER_ENTERED');
  assert.equal(telemetry?.zeroPageReason, 'HANDLER_ENTERED_NO_PAGES');
  assert.equal(telemetry?.launchCauseSnippet, 'spaced cause');
  assert.equal(telemetry?.workerInstanceId, 'replica-a:123');
});

test('safe telemetry drops unknown stage/reason and truncates cause text', () => {
  const telemetry = safeCrawlerTelemetry({
    mode: 'RENDERED',
    pagesInspected: 0,
    lastLifecycleStage: 'FUTURE_STAGE',
    zeroPageReason: 'MYSTERY',
    launchCauseSnippet: 'b'.repeat(900),
    workerInstanceId: '',
  });
  assert.equal(telemetry?.lastLifecycleStage, undefined);
  assert.equal(telemetry?.zeroPageReason, undefined);
  assert.equal(telemetry?.launchCauseSnippet?.length, 500);
  assert.equal(telemetry?.workerInstanceId, undefined);
});

test('safe telemetry keeps old observations valid without new fields', () => {
  const telemetry = safeCrawlerTelemetry({ mode: 'RENDERED', pagesInspected: 2, requestsStarted: 2 });
  assert.equal(telemetry?.pagesInspected, 2);
  assert.equal(telemetry?.lastLifecycleStage, undefined);
  assert.equal(telemetry?.zeroPageReason, undefined);
  assert.equal(telemetry?.launchCauseSnippet, undefined);
  assert.equal(telemetry?.workerInstanceId, undefined);
});

test('safe telemetry drops rendered-only diagnostics from static rows', () => {
  // Lifecycle stage, zero-page reason, and browser-cause text are rendered
  // diagnostics: they must never pollute STATIC telemetry, even when present.
  // The instance id is process provenance and is retained for both modes.
  const telemetry = safeCrawlerTelemetry({
    mode: 'STATIC',
    pagesInspected: 1,
    lastLifecycleStage: 'HANDLER_ENTERED',
    zeroPageReason: 'HANDLER_ENTERED_NO_PAGES',
    launchCauseSnippet: 'boom',
    workerInstanceId: 'replica-a:123:abcdef01',
  });
  assert.equal(telemetry?.pagesInspected, 1);
  assert.equal(telemetry?.lastLifecycleStage, undefined);
  assert.equal(telemetry?.zeroPageReason, undefined);
  assert.equal(telemetry?.launchCauseSnippet, undefined);
  assert.equal(telemetry?.workerInstanceId, 'replica-a:123:abcdef01');
});

test('ledger persists sanitized telemetry wholesale into observation provenance', () => {
  // appendExternalAcquisitionObservations gates on safeCrawlerTelemetry (proven
  // above to preserve the new fields) and serializes the result as
  // provenance.crawlerTelemetry, so stage/reason/cause/instance survive
  // crawler → result → observation → ledger without further mapping.
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  assert.match(dbCore, /const telemetry=safeCrawlerTelemetry\(observation\.telemetry\)/);
  assert.match(dbCore, /\.\.\.\(telemetry\?\{crawlerTelemetry:telemetry\}:\{\}\)/);
});
