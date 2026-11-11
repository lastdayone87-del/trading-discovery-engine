import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildResolutionAlerts } from './classificationResolutionMonitoring';

const source = readFileSync(new URL('./classificationResolutionMonitoring.ts', import.meta.url), 'utf8');

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


test('overview queries use the same job set and recovery ledger as the writers', () => {
  assert.match(source, /j\.type IN\('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN'\)/);
  assert.match(source, /event_key LIKE 'operational-enrichment:%'/);
  assert.match(source, /now\(\)-run_after/);
  assert.match(source, /dueStage1 \+ dueStage2/);
  assert.match(source, /job\.status='PROCESSING'/);
  assert.match(source, /job\.status='PENDING'/);
});

test('key-cap alert counts settled usage plus live leases and requires enforcement', () => {
  assert.match(source, /youtube_key_daily_cap_enforced/);
  assert.match(source, /youtube_key_cap_shadow_leases/);
  assert.match(source, /hardCapEnforced && String\(quota\.last_reset\) === quotaDay/);
  assert.match(source, /deterministicRouting' \? 'semanticUsed'/);
  assert.match(source, /gemini_semantic','groq_semantic','gemini_free_semantic/);
});
