import test from 'node:test';
import assert from 'node:assert/strict';
import {
  communityAcquisitionWorkKey,
  normalizeCommunityWorkUrl,
  percentDelta,
  projectCommunityAcquisitionWork,
  reconcileCommunityWorkProjection,
  resolveCommunityWorkState,
  type CommunityWorkObservation,
} from './communityAcquisitionWorkLedger';

function observation(overrides: Partial<CommunityWorkObservation> = {}): CommunityWorkObservation {
  return {
    channelId: 'UC-ledger',
    requestedUrl: 'https://example.com/links',
    outcome: 'ACQUISITION_FAILED',
    retryable: true,
    failureClass: 'NETWORK_FAILURE',
    observedAt: '2026-11-01T00:00:00.000Z',
    provenance: {
      surface: 'CREATOR_WEBSITES',
      required: true,
      crawlerTelemetry: {
        mode: 'STATIC',
        pagesInspected: 2,
        requestsStarted: 0,
        requestsFinished: 0,
        clicksSucceeded: 0,
      },
    },
    ...overrides,
  };
}

test('work keys are stable and scoped to channel, surface, and normalized URL', () => {
  const first = communityAcquisitionWorkKey('UC-a', 'https://example.com/x', 'CREATOR_WEBSITES');
  assert.equal(first, communityAcquisitionWorkKey('UC-a', 'https://example.com/x', 'CREATOR_WEBSITES'));
  assert.notEqual(first, communityAcquisitionWorkKey('UC-b', 'https://example.com/x', 'CREATOR_WEBSITES'));
  assert.notEqual(first, communityAcquisitionWorkKey('UC-a', 'https://example.com/y', 'CREATOR_WEBSITES'));
  assert.notEqual(first, communityAcquisitionWorkKey('UC-a', 'https://example.com/x', 'SOCIAL_PROFILES'));
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('URL normalization ignores host case, fragments, default ports, and trailing slashes', () => {
  assert.equal(
    normalizeCommunityWorkUrl(' HTTPS://Example.COM:443/Path/To/?a=1#fragment '),
    'https://example.com/Path/To?a=1',
  );
  assert.equal(
    normalizeCommunityWorkUrl('http://example.com:80'),
    'http://example.com/',
  );
  assert.equal(normalizeCommunityWorkUrl('not a url'), null);
  assert.equal(normalizeCommunityWorkUrl('mailto:user@example.com'), null);
});

test('a started request never clears never_executed', () => {
  const { rows } = projectCommunityAcquisitionWork([
    observation({
      outcome: 'INSPECTED_NO_MATCH',
      provenance: {
        surface: 'CREATOR_WEBSITES',
        required: true,
        crawlerTelemetry: { mode: 'STATIC', pagesInspected: 0, requestsStarted: 12, requestsFinished: 0 },
      },
    }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].neverExecuted, true);
  assert.equal(rows[0].attempts, 0);
  assert.equal(rows[0].state, 'PENDING');
  assert.equal(rows[0].terminalReason, null, 'unevidenced absence must never resolve');
});

test('processed static evidence clears never_executed but not never_browser_executed', () => {
  const { rows } = projectCommunityAcquisitionWork([
    observation({
      outcome: 'INSPECTED_NO_MATCH',
      provenance: {
        surface: 'CREATOR_WEBSITES',
        required: true,
        crawlerTelemetry: { mode: 'STATIC', pagesInspected: 12, requestsStarted: 0, requestsFinished: 0 },
      },
    }),
  ]);
  assert.equal(rows[0].neverExecuted, false);
  assert.equal(rows[0].neverBrowserExecuted, true);
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].state, 'RESOLVED');
  assert.equal(rows[0].terminalReason, 'INSPECTED_NO_MATCH');
});

test('rendered processed evidence counts as browser execution', () => {
  const { rows } = projectCommunityAcquisitionWork([
    observation({
      outcome: 'INSPECTED_NO_MATCH',
      provenance: {
        surface: 'SOCIAL_PROFILES',
        required: true,
        crawlerTelemetry: {
          mode: 'RENDERED',
          pagesInspected: 3,
          requestsStarted: 4,
          requestsFinished: 4,
          clicksSucceeded: 1,
        },
      },
    }),
  ]);
  assert.equal(rows[0].neverExecuted, false);
  assert.equal(rows[0].neverBrowserExecuted, false);
  assert.equal(rows[0].state, 'RESOLVED');
});

test('the latest observation wins regardless of input order', () => {
  const older = observation({
    observedAt: '2026-11-01T00:00:00.000Z',
    outcome: 'ACQUISITION_FAILED',
    failureClass: 'NETWORK_FAILURE',
  });
  const newer = observation({
    observedAt: '2026-11-02T00:00:00.000Z',
    outcome: 'FOUND',
    failureClass: null,
    provenance: {
      surface: 'CREATOR_WEBSITES',
      required: true,
      crawlerTelemetry: { mode: 'STATIC', pagesInspected: 1, requestsStarted: 0, requestsFinished: 0 },
    },
  });
  const { rows } = projectCommunityAcquisitionWork([newer, older]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'RESOLVED');
  assert.equal(rows[0].lastOutcome, 'FOUND');
  assert.equal(rows[0].firstObservedAt, older.observedAt);
  assert.equal(rows[0].lastAttemptAt, newer.observedAt);
});

test('infra failures park work without consuming its attempt budget', () => {
  const { rows } = projectCommunityAcquisitionWork([
    observation({ failureClass: 'BROWSER_RUNTIME_UNAVAILABLE' }),
    observation({
      failureClass: 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE',
      observedAt: '2026-11-02T00:00:00.000Z',
    }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'PARKED_INFRA');
  assert.equal(rows[0].terminalReason, 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE');
});

test('work is exhausted only after the attempt cap and never once resolved', () => {
  const failed = resolveCommunityWorkState(observation(), 5, 5);
  assert.equal(failed.state, 'EXHAUSTED');
  assert.equal(failed.terminalReason, 'MAX_ATTEMPTS');

  const resolved = resolveCommunityWorkState(
    observation({ outcome: 'FOUND', failureClass: null }),
    5,
    5,
  );
  assert.equal(resolved.state, 'RESOLVED');
});

test('upstream YouTube surfaces are not community work rows', () => {
  const { rows, stats } = projectCommunityAcquisitionWork([
    observation({
      provenance: { surface: 'YOUTUBE_ABOUT', crawlerTelemetry: { pagesInspected: 1 } },
    }),
    observation({
      provenance: { surface: 'RECENT_VIDEO_DESCRIPTIONS', crawlerTelemetry: { pagesInspected: 1 } },
    }),
    observation({ channelId: 'UC-kept' }),
  ]);
  assert.equal(stats.observedRows, 3);
  assert.equal(stats.skippedRows, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channelId, 'UC-kept');
});

test('projection stats separate retryable rows from never-executed rows', () => {
  const { stats } = projectCommunityAcquisitionWork([
    observation({ channelId: 'UC-1', requestedUrl: 'https://a.example/', observedAt: '2026-11-01T00:00:00.000Z' }),
    observation({ channelId: 'UC-1', requestedUrl: 'https://b.example/', observedAt: '2026-11-01T00:00:00.000Z', retryable: false }),
    observation({
      channelId: 'UC-2',
      requestedUrl: 'https://c.example/',
      outcome: 'INSPECTED_NO_MATCH',
      provenance: {
        surface: 'CREATOR_WEBSITES',
        crawlerTelemetry: { mode: 'STATIC', pagesInspected: 2 },
      },
    }),
  ]);
  assert.equal(stats.workRows, 3);
  assert.equal(stats.retryableRows, 2);
  assert.equal(stats.neverExecutedRows, 0);
  assert.equal(stats.neverBrowserExecutedRows, 3);
  assert.equal(stats.retryableNeverBrowserExecutedRows, 2);
});

test('reconciliation reports deltas against the telemetry bound', () => {
  const within = reconcileCommunityWorkProjection(
    { retryableRows: 102, neverBrowserExecutedRows: 96, retryableNeverBrowserExecutedRows: 48 },
    { retryableRows: 100, neverBrowserExecutedRows: 50 },
  );
  assert.equal(within.retryableDelta, 2);
  assert.equal(within.retryableWithinFivePercent, true);
  assert.equal(within.neverExecutedWithinFivePercent, true);

  const outside = reconcileCommunityWorkProjection(
    { retryableRows: 120, neverBrowserExecutedRows: 96, retryableNeverBrowserExecutedRows: 60 },
    { retryableRows: 100, neverBrowserExecutedRows: 50 },
  );
  assert.equal(outside.retryableWithinFivePercent, false);
  assert.equal(outside.neverExecutedWithinFivePercent, false);
  assert.ok(outside.retryableDeltaPct > 5);
});

test('percent delta handles empty baselines safely', () => {
  assert.equal(percentDelta(0, 0), 0);
  assert.equal(percentDelta(1, 0), 100);
  assert.equal(percentDelta(95, 100), 5);
});
