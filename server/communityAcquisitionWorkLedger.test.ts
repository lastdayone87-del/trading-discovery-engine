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

test('URL normalization ignores host case, fragments, default ports, and trailing path slashes', () => {
  assert.equal(
    normalizeCommunityWorkUrl(' HTTPS://Example.COM:443/Path/To/?a=1#fragment '),
    'https://example.com/Path/To?a=1',
  );
  assert.equal(
    normalizeCommunityWorkUrl('http://example.com:80'),
    'http://example.com/',
  );
  assert.equal(
    normalizeCommunityWorkUrl('https://example.com/join/?next=/a/'),
    'https://example.com/join?next=/a/',
    'only the path is trimmed; query values keep their trailing slash',
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

test('malformed telemetry counters never manufacture execution evidence', () => {
  const { rows } = projectCommunityAcquisitionWork([
    observation({
      outcome: 'INSPECTED_NO_MATCH',
      provenance: {
        surface: 'CREATOR_WEBSITES',
        required: true,
        crawlerTelemetry: {
          mode: 'RENDERED',
          pagesInspected: true,
          requestsFinished: '4',
          clicksSucceeded: [],
        },
      },
    }),
  ]);
  assert.equal(rows[0].neverExecuted, true);
  assert.equal(rows[0].neverBrowserExecuted, true);
  assert.equal(rows[0].attempts, 0);
  assert.equal(rows[0].state, 'PENDING');
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
  assert.equal(rows[0].retryOwned, false);
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

test('borrowed shared evidence never counts as execution or an attempt', () => {
  const { rows, stats } = projectCommunityAcquisitionWork([
    observation({
      outcome: 'INSPECTED_NO_MATCH',
      provenance: {
        surface: 'CREATOR_WEBSITES',
        required: true,
        sharedEvidenceFrom: 'https://lender.example/',
        crawlerTelemetry: { mode: 'RENDERED', pagesInspected: 3, requestsFinished: 3 },
      },
    }),
  ]);
  assert.equal(stats.skippedRows, 0);
  assert.equal(rows.length, 1, 'shared evidence still identifies real URL work');
  assert.equal(rows[0].neverExecuted, true);
  assert.equal(rows[0].neverBrowserExecuted, true);
  assert.equal(rows[0].attempts, 0);
  assert.equal(rows[0].state, 'RESOLVED', 'same-inspection lender evidence can resolve the URL');
  assert.equal(rows[0].retryOwned, false);
});

test('later optional recovery evidence resolves an admitted static-gap key', () => {
  const gap = observation({
    observedAt: '2026-11-01T00:00:00.000Z',
    outcome: 'PARTIALLY_INSPECTED',
    failureClass: 'STATIC_BUDGET_GAP',
    provenance: {
      surface: 'CREATOR_WEBSITES',
      required: false,
      crawlerTelemetry: { mode: 'STATIC', pagesInspected: 1, requestsStarted: 0, requestsFinished: 0 },
    },
  });
  const laterFound = observation({
    observedAt: '2026-11-01T00:01:00.000Z',
    outcome: 'FOUND',
    failureClass: null,
    retryable: false,
    provenance: {
      surface: 'CREATOR_WEBSITES',
      required: false,
      crawlerTelemetry: { mode: 'RENDERED', pagesInspected: 2, requestsStarted: 2, requestsFinished: 2 },
    },
  });
  const { rows, stats } = projectCommunityAcquisitionWork([gap, laterFound]);
  assert.equal(stats.skippedRows, 0, 'optional evidence for an admitted key is not discarded');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'RESOLVED');
  assert.equal(rows[0].lastOutcome, 'FOUND');
  assert.equal(rows[0].retryOwned, false, 'the completed URL is no longer retry work');
  assert.equal(rows[0].observations, 2);
  assert.equal(rows[0].neverExecuted, false);
  assert.equal(rows[0].neverBrowserExecuted, false);
});

test('only required community observations become backlog work', () => {
  const { rows, stats } = projectCommunityAcquisitionWork([
    observation({
      requestedUrl: 'https://optional.example/',
      provenance: {
        surface: 'CREATOR_WEBSITES',
        required: false,
        crawlerTelemetry: { mode: 'STATIC', pagesInspected: 1 },
      },
    }),
    observation({ requestedUrl: 'https://required.example/' }),
  ]);
  assert.equal(stats.observedRows, 2);
  assert.equal(stats.skippedRows, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].normalizedUrl, 'https://required.example/');
});

test('an old success never hides a newer inspection failure', () => {
  const olderFound = observation({
    observedAt: '2026-11-01T00:00:00.000Z',
    outcome: 'FOUND',
    failureClass: null,
    provenance: {
      surface: 'CREATOR_WEBSITES',
      required: true,
      crawlerTelemetry: { mode: 'STATIC', pagesInspected: 1, requestsStarted: 0, requestsFinished: 0 },
    },
  });
  const newerFailure = observation({
    observedAt: '2026-11-02T00:00:00.000Z',
    outcome: 'ACQUISITION_FAILED',
    failureClass: 'NETWORK_FAILURE',
    provenance: {
      surface: 'CREATOR_WEBSITES',
      required: true,
      crawlerTelemetry: { mode: 'RENDERED', pagesInspected: 2, requestsFinished: 2 },
    },
  });
  const { rows } = projectCommunityAcquisitionWork([newerFailure, olderFound]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'PENDING');
  assert.equal(rows[0].lastOutcome, 'ACQUISITION_FAILED');
  assert.equal(rows[0].retryOwned, true, 'the newer failure owns retry despite the old success');
  assert.equal(rows[0].neverBrowserExecuted, false, 'browser evidence is aggregated across every observation');
});

test('rank-first applies within the latest inspection, not across inspections', () => {
  const newerFailure = observation({
    observedAt: '2026-11-02T00:00:00.000Z',
    outcome: 'ACQUISITION_FAILED',
    failureClass: 'NETWORK_FAILURE',
  });
  const sameInspectionSuccess = observation({
    observedAt: '2026-11-02T00:02:00.000Z',
    outcome: 'FOUND',
    failureClass: null,
  });
  const { rows } = projectCommunityAcquisitionWork([newerFailure, sameInspectionSuccess]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'RESOLVED');
  assert.equal(rows[0].lastOutcome, 'FOUND', 'rank-first tolerates inspector timestamp skew');
  assert.equal(rows[0].retryOwned, false);
});

test('equal-timestamp observations are ordered deterministically by id', () => {
  const first = observation({ id: '00000000-0000-0000-0000-000000000001' });
  const second = observation({
    id: '00000000-0000-0000-0000-000000000002',
    retryable: false,
    failureClass: 'PERMANENT_ACCESS_BLOCK',
  });
  const forward = projectCommunityAcquisitionWork([first, second]).rows[0];
  const reverse = projectCommunityAcquisitionWork([second, first]).rows[0];
  assert.equal(forward.lastOutcome, reverse.lastOutcome);
  assert.equal(forward.lastFailureClass, 'PERMANENT_ACCESS_BLOCK');
  assert.equal(
    reverse.lastFailureClass,
    'PERMANENT_ACCESS_BLOCK',
    'reversing input order must not change the id tie-break winner',
  );
});

test('the latest observation wins within the same rank regardless of input order', () => {
  const older = observation({
    observedAt: '2026-11-01T00:00:00.000Z',
    failureClass: 'NETWORK_FAILURE',
  });
  const newer = observation({
    observedAt: '2026-11-02T00:00:00.000Z',
    failureClass: 'TIMEOUT',
    retryable: false,
  });
  const { rows } = projectCommunityAcquisitionWork([newer, older]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lastFailureClass, 'TIMEOUT');
  assert.equal(rows[0].firstObservedAt, older.observedAt);
  assert.equal(rows[0].lastAttemptAt, newer.observedAt);
  assert.equal(rows[0].attempts, 2);
  assert.equal(rows[0].retryOwned, false, 'the effective non-retryable failure does not own a retry');
});

test('infra failures park work without consuming its attempt budget', () => {
  const { rows } = projectCommunityAcquisitionWork([
    observation({
      failureClass: 'BROWSER_RUNTIME_UNAVAILABLE',
      provenance: {
        surface: 'CREATOR_WEBSITES',
        required: true,
        crawlerTelemetry: { mode: 'STATIC', pagesInspected: 0, requestsStarted: 0, requestsFinished: 0 },
      },
    }),
    observation({
      failureClass: 'RATE_LIMIT',
      observedAt: '2026-11-02T00:00:00.000Z',
      provenance: {
        surface: 'CREATOR_WEBSITES',
        required: true,
        crawlerTelemetry: { mode: 'STATIC', pagesInspected: 0, requestsStarted: 0, requestsFinished: 0 },
      },
    }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempts, 0);
  assert.equal(rows[0].neverExecuted, true);
  assert.equal(rows[0].state, 'PARKED_INFRA');
  assert.equal(rows[0].terminalReason, 'RATE_LIMIT');
});

test('infra failures that actually processed work still charge the attempt', () => {
  const { rows } = projectCommunityAcquisitionWork([
    observation({
      failureClass: 'BROWSER_LAUNCH_FAILED',
      provenance: {
        surface: 'CREATOR_WEBSITES',
        required: true,
        crawlerTelemetry: { mode: 'RENDERED', pagesInspected: 1, requestsFinished: 0 },
      },
    }),
  ]);
  assert.equal(rows[0].attempts, 1, 'processed work is a real attempt even when it ended in an infra failure');
  assert.equal(rows[0].neverExecuted, false);
  assert.equal(rows[0].state, 'PARKED_INFRA');
});

test('repeated telemetry-free transport failures exhaust the budget', () => {
  const observations = Array.from({ length: 5 }, (_, index) => observation({
    observedAt: `2026-11-0${index + 1}T00:00:00.000Z`,
    failureClass: 'NETWORK_FAILURE',
    provenance: {
      surface: 'CREATOR_WEBSITES',
      required: true,
      crawlerTelemetry: { mode: 'STATIC', pagesInspected: 0, requestsStarted: 0, requestsFinished: 0 },
    },
  }));
  const { rows } = projectCommunityAcquisitionWork(observations);
  assert.equal(rows[0].attempts, 5);
  assert.equal(rows[0].neverExecuted, true);
  assert.equal(rows[0].state, 'EXHAUSTED');
  assert.equal(rows[0].terminalReason, 'MAX_ATTEMPTS');
});

test('an unevidenced no-match cannot bypass the attempt cap', () => {
  const unevidenced = observation({
    outcome: 'INSPECTED_NO_MATCH',
    provenance: {
      surface: 'CREATOR_WEBSITES',
      required: true,
      crawlerTelemetry: { mode: 'STATIC', pagesInspected: 0, requestsStarted: 3, requestsFinished: 0 },
    },
  });
  const resolved = resolveCommunityWorkState(unevidenced, 4, 5);
  assert.equal(resolved.state, 'PENDING', 'unevidenced absence never resolves');
  const capped = resolveCommunityWorkState(unevidenced, 5, 5);
  assert.equal(capped.state, 'EXHAUSTED');
  assert.equal(capped.terminalReason, 'MAX_ATTEMPTS');
});

test('retry ownership follows the effective production predicate', () => {
  const retryableFailure = observation();
  assert.equal(projectCommunityAcquisitionWork([retryableFailure]).rows[0].retryOwned, true);

  const terminalRedirect = observation({ failureClass: 'REDIRECT_LIMIT' });
  assert.equal(projectCommunityAcquisitionWork([terminalRedirect]).rows[0].retryOwned, false);

  const resolvedLater = observation({
    observedAt: '2026-11-02T00:00:00.000Z',
    outcome: 'FOUND',
    failureClass: null,
  });
  assert.equal(
    projectCommunityAcquisitionWork([retryableFailure, resolvedLater]).rows[0].retryOwned,
    false,
    'a later FOUND clears retry ownership',
  );

  const optionalFailure = observation({
    provenance: { surface: 'CREATOR_WEBSITES', required: false, crawlerTelemetry: { pagesInspected: 1 } },
  });
  assert.equal(projectCommunityAcquisitionWork([optionalFailure]).rows.length, 0);

  // Production owns retry for retryable partial inspections, FOUND rows with
  // an outstanding bounded gap, and static-budget-gap seeds even when the seed
  // is not required. Permanent classes never own retry.
  const partial = observation({
    outcome: 'PARTIALLY_INSPECTED',
    failureClass: 'RESPONSE_TRUNCATED',
  });
  assert.equal(projectCommunityAcquisitionWork([partial]).rows[0].retryOwned, true);

  const foundGap = observation({
    outcome: 'FOUND',
    failureClass: 'REQUIRED_UNVISITED_BUDGET_GAP',
  });
  assert.equal(projectCommunityAcquisitionWork([foundGap]).rows[0].retryOwned, true);

  const staticGap = observation({
    outcome: 'PARTIALLY_INSPECTED',
    failureClass: 'STATIC_BUDGET_GAP',
    provenance: {
      surface: 'CREATOR_WEBSITES',
      required: false,
      crawlerTelemetry: { mode: 'STATIC', pagesInspected: 1 },
    },
  });
  const staticGapProjection = projectCommunityAcquisitionWork([staticGap]);
  assert.equal(staticGapProjection.rows.length, 1, 'the static-gap exception is real retry work');
  assert.equal(staticGapProjection.rows[0].retryOwned, true);

  for (const failureClass of [
    'UNSUPPORTED_CONTENT_TYPE',
    'LOGIN_WALL',
    'PAYWALL_WALL',
    'PERMANENT_ACCESS_BLOCK',
  ]) {
    const permanent = observation({ failureClass });
    assert.equal(
      projectCommunityAcquisitionWork([permanent]).rows[0].retryOwned,
      false,
      `${failureClass} must never own retry`,
    );
  }
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
      provenance: { surface: 'YOUTUBE_ABOUT', required: true, crawlerTelemetry: { pagesInspected: 1 } },
    }),
    observation({
      provenance: { surface: 'RECENT_VIDEO_DESCRIPTIONS', required: true, crawlerTelemetry: { pagesInspected: 1 } },
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
      outcome: 'ACQUISITION_FAILED',
      provenance: {
        surface: 'CREATOR_WEBSITES',
        required: true,
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
  assert.equal(within.projectionRetryableNeverBrowserExecutedRows, 48);
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
