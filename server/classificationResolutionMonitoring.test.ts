import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildResolutionAlerts, getClassificationResolutionOverview } from './classificationResolutionMonitoring';
import { getYouTubeQuotaDay } from './youtubeQuotaDay';

const base = {
  dueEnrichment: 0,
  oldestDueHours: 0,
  orphanPending: 0,
  genericFailures: 0,
  unresolvedCompleted: 0,
  eligibleWithoutPendingReview: 0,
  pendingReviews: 0,
  oldestReviewDays: 0,
  semanticRateLimitCalls15m: 0,
  youtubeKeysAtCap: 0,
};

test('a clean resolution state emits no alerts', () => {
  assert.deepEqual(buildResolutionAlerts(base), []);
});

test('orphan pending, generic failures, unresolved completed and missing reviews are alertable', () => {
  const alerts = buildResolutionAlerts({
    ...base,
    orphanPending: 398,
    genericFailures: 26,
    unresolvedCompleted: 3517,
    eligibleWithoutPendingReview: 1,
  });
  assert.deepEqual(alerts.map(alert => alert.code), [
    'ORPHAN_ENRICHMENT_PENDING',
    'GENERIC_TERMINAL_FAILURES',
    'UNRESOLVED_COMPLETED',
    'ELIGIBLE_REVIEW_WITHOUT_PENDING',
  ]);
  assert.ok(alerts.find(alert => alert.code === 'UNRESOLVED_COMPLETED')?.severity === 'CRITICAL');
});

test('aged backlog and provider pressure are severity-scaled', () => {
  const backlog = buildResolutionAlerts({ ...base, dueEnrichment: 5_795, oldestDueHours: 742 });
  assert.equal(backlog[0].code, 'ENRICHMENT_BACKLOG_AGED');
  assert.equal(backlog[0].severity, 'CRITICAL');
  const pressure = buildResolutionAlerts({ ...base, semanticRateLimitCalls15m: 150, youtubeKeysAtCap: 31 });
  assert.equal(pressure.find(alert => alert.code === 'SEMANTIC_ROUTE_PRESSURE')?.severity, 'CRITICAL');
  assert.equal(pressure.find(alert => alert.code === 'YOUTUBE_KEYS_AT_CAP')?.severity, 'CRITICAL');
});

test('an aged review queue is warned before it becomes critical', () => {
  const warn = buildResolutionAlerts({ ...base, pendingReviews: 10, oldestReviewDays: 8 });
  assert.equal(warn[0].code, 'REVIEW_QUEUE_AGED');
  assert.equal(warn[0].severity, 'WARN');
  const critical = buildResolutionAlerts({ ...base, pendingReviews: 10, oldestReviewDays: 38 });
  assert.equal(critical[0].severity, 'CRITICAL');
});


test('overview computes due work, routes, reviews and quota from query results', async () => {
  const quotaDay = getYouTubeQuotaDay();
  const results: any[][] = [
    [{ key: 'UNCERTAIN', count: 10 }, { key: 'NEEDS_REVIEW', count: 2 }],
    [{ key: 'FAILED', count: 3 }],
    [{ key: 'ENRICH', recognition: 'AMBIGUOUS_THIN', semantic_used: 'false', semantic_attempted: 'true', count: 4 }],
    [{ key: 'PENDING', count: 5, oldest_due_hours: 12 }, { key: 'PROCESSING', count: 1, oldest_due_hours: 0 }],
    [{ count: 5 }],
    [{ count: 2 }],
    [{ count: 7 }],
    [{ count: 4 }],
    [{ key: 'PENDING', count: 4, oldest_days: 8 }],
    [{ key: 'ELIGIBLE', count: 6 }],
    [{ count: 1 }],
    [{ units_used: 100, daily_limit: 1000, last_reset: quotaDay }],
    [{ reserved: 50 }],
    [{ setting_value: 'true' }],
    [{ stage1: 10, stage2: 2 }],
    [{ allocation: 'AUTONOMOUS', units: 100 }, { allocation: 'ENRICHMENT', units: 50 }],
    [{ count: 25 }],
    [{ count: 5 }],
    [{ count: 3 }],
  ];
  let index = 0;
  const overview = await getClassificationResolutionOverview({
    query: async () => ({ rows: results[index++] || [] }),
  });

  assert.equal(overview.channels.total, 12);
  assert.equal(overview.channels.uncertain, 10);
  assert.equal(overview.channels.needsReview, 2);
  assert.equal(overview.enrichment.due, 12);
  assert.equal(overview.enrichment.pending, 5);
  assert.equal(overview.enrichment.processing, 1);
  assert.equal(overview.enrichment.oldestDueHours, 12);
  assert.equal(overview.enrichment.orphanPending, 5);
  assert.equal(overview.enrichment.genericFailures, 2);
  assert.equal(overview.enrichment.recoveryCycles24h, 7);
  assert.equal(overview.enrichment.exhaustionReviewsPending, 4);
  assert.equal(overview.reviews.pending, 4);
  assert.equal(overview.reviews.oldestPendingDays, 8);
  assert.equal(overview.reviews.eligible, 6);
  assert.equal(overview.reviews.eligibleWithoutPendingReview, 1);
  assert.equal(overview.routes.byRoute.ENRICH, 4);
  assert.equal(overview.routes.byRecognition.AMBIGUOUS_THIN, 4);
  assert.equal(overview.routes.semanticUsed, 0);
  assert.equal(overview.routes.semanticAttempted, 4);
  assert.equal(overview.quota.dailyLimit, 1000);
  assert.equal(overview.quota.used, 100);
  assert.equal(overview.quota.dueStage1, 10);
  assert.equal(overview.quota.dueStage2, 2);
  assert.equal(overview.quota.recentAutonomousUnits, 100);
  assert.equal(overview.quota.recentEnrichmentUnits, 50);
  assert.deepEqual(
    overview.alerts.map(alert => alert.code),
    [
      'ENRICHMENT_BACKLOG_AGED',
      'ORPHAN_ENRICHMENT_PENDING',
      'GENERIC_TERMINAL_FAILURES',
      'UNRESOLVED_COMPLETED',
      'ELIGIBLE_REVIEW_WITHOUT_PENDING',
      'REVIEW_QUEUE_AGED',
      'SEMANTIC_ROUTE_PRESSURE',
      'YOUTUBE_KEYS_AT_CAP',
    ],
  );
});
