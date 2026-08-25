import test from 'node:test';
import assert from 'node:assert/strict';
import { renderedCrawlerTelemetry, safeCrawlerTelemetry, staticCrawlerTelemetry } from './crawlerTelemetry';

test('static telemetry records redirect/page/budget measurements without changing outcome semantics', () => {
  const telemetry = staticCrawlerTelemetry({ redirectsFollowed: 2, pagesInspected: 3, budgetExhausted: true });
  assert.deepEqual(telemetry, {
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
});

test('rendered telemetry preserves bounded click/request counters and marks incomplete coverage', () => {
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
  assert.equal(telemetry.budgetExhausted, true);
  assert.equal(telemetry.navigationTimeouts, 1);
  assert.equal(telemetry.blockedRequests, 1);
  assert.equal(telemetry.hostBackoffsApplied, 3);
});

test('safe telemetry rejects malformed mode and clamps malformed counters', () => {
  assert.equal(safeCrawlerTelemetry({ mode: 'UNKNOWN' }), undefined);
  const telemetry = safeCrawlerTelemetry({ mode: 'STATIC', pagesInspected: -4, redirectsFollowed: 2.8, clicksFailed: 'bad', budgetExhausted: true });
  assert.equal(telemetry?.pagesInspected, 0);
  assert.equal(telemetry?.redirectsFollowed, 2);
  assert.equal(telemetry?.clicksFailed, 0);
  assert.equal(telemetry?.budgetExhausted, true);
});
