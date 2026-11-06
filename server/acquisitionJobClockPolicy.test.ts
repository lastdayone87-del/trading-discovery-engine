import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV,
  CAPACITY_LEASE_DURATION_MS,
  MAX_CAPACITY_LEASE_RETRY_DELAY_MS,
  MAX_QUOTA_WAIT_DELAY_MS,
  acquisitionJobClockV2Enabled,
  capacityLeaseRefreshSetSql,
  capacityLeaseRunAfter,
  claimOrderByClause,
  claimQueueAgeOrderColumn,
  isCapacityLeaseFailure,
  isQuotaCapacityFailure,
  normalizeCapacityLeaseRunAfter,
  reopenClockUpdateSql,
  shouldChargeFailureBudget,
} from './acquisitionJobClockPolicy';

test('clock v2 is default-off and opt-in only', () => {
  assert.equal(acquisitionJobClockV2Enabled({}), false);
  assert.equal(acquisitionJobClockV2Enabled({ [ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV]: 'false' }), false);
  assert.equal(acquisitionJobClockV2Enabled({ [ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV]: '0' }), false);
  assert.equal(acquisitionJobClockV2Enabled({ [ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV]: 'true' }), true);
  assert.equal(acquisitionJobClockV2Enabled({ [ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV]: ' TRUE ' }), true);
  assert.equal(claimQueueAgeOrderColumn({}), 'created_at');
  assert.equal(claimQueueAgeOrderColumn({ [ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV]: 'true' }), 'first_enqueued_at');
  assert.equal(claimOrderByClause({}), 'priority DESC,created_at ASC');
  assert.equal(claimOrderByClause({ [ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV]: 'true' }), 'priority DESC,first_enqueued_at ASC');
});

test('capacity waits are separated from genuine retryable failures', () => {
  const deferred = Object.assign(new Error('Community acquisition deferred: browser gate saturated'), {
    code: 'BROWSER_RUNTIME_UNAVAILABLE',
    retryable: true,
  });
  assert.equal(isCapacityLeaseFailure(deferred), true);
  assert.equal(shouldChargeFailureBudget(deferred), false);

  const enrichment = new Error('ENRICHMENT YouTube quota allocation is exhausted; retry is scheduled for tomorrow.');
  assert.equal(isCapacityLeaseFailure(enrichment), true);
  assert.equal(shouldChargeFailureBudget(enrichment), false);

  // QuotaAllocationExhaustedError carries no message prefix in every caller;
  // its code alone must classify as an attempt-free capacity wait.
  const quotaAllocation = Object.assign(new Error('ENRICHMENT allocation wait'), {
    code: 'QUOTA_ALLOCATION_EXHAUSTED',
  });
  assert.equal(isCapacityLeaseFailure(quotaAllocation), true);
  assert.equal(shouldChargeFailureBudget(quotaAllocation), false);
  assert.equal(isQuotaCapacityFailure(quotaAllocation), true);

  const network = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  assert.equal(isCapacityLeaseFailure(network), false);
  assert.equal(shouldChargeFailureBudget(network), true);

  // A browser failure that did not prove it was attempt-free must consume the
  // genuine failure budget; only the retryable/attempt-free shape is capacity.
  const rawBrowser = Object.assign(new Error('browser crashed'), { code: 'BROWSER_LAUNCH_FAILED' });
  assert.equal(isCapacityLeaseFailure(rawBrowser), false);
  assert.equal(shouldChargeFailureBudget(rawBrowser), true);
  const retryableBrowser = Object.assign(new Error('browser crashed'), { code: 'BROWSER_LAUNCH_FAILED', retryable: true });
  assert.equal(isCapacityLeaseFailure(retryableBrowser), true);
  assert.equal(shouldChargeFailureBudget(retryableBrowser), false);

  const upstream = Object.assign(new Error('upstream unavailable'), { status: 503 });
  assert.equal(isCapacityLeaseFailure(upstream), false);
  assert.equal(shouldChargeFailureBudget(upstream), true);

  assert.equal(isCapacityLeaseFailure(null), false);
});

test('capacity lease SQL updates only capacity bookkeeping', () => {
  const sql = capacityLeaseRefreshSetSql('$4');
  assert.match(sql, /capacity_lease_started_at=COALESCE\(capacity_lease_started_at,now\(\)\)/);
  assert.match(sql, /capacity_lease_expires_at=now\(\)\+\(\$4\|\|' milliseconds'\)::interval/);
  assert.match(sql, /capacity_lease_renewed_at=/);
  assert.match(sql, /capacity_lease_renewals=capacity_lease_renewals\+/);
  assert.match(sql, /updated_at=now\(\)/);
  assert.doesNotMatch(sql, /created_at/);
  assert.doesNotMatch(sql, /first_transient_failure_at/);
  assert.doesNotMatch(sql, /run_after/);
  assert.doesNotMatch(sql, /attempts/);
});

test('reopen clock SQL is flag-gated and never touches failure or queue clocks', () => {
  assert.equal(reopenClockUpdateSql(false), '');
  const sql = reopenClockUpdateSql(true);
  assert.match(sql, /last_enqueued_at=CASE WHEN jobs\.status IN \('COMPLETED','FAILED'\) THEN now\(\) ELSE jobs\.last_enqueued_at END/);
  assert.match(sql, /reopen_generation=CASE WHEN jobs\.status IN \('COMPLETED','FAILED'\) THEN jobs\.reopen_generation\+1 ELSE jobs\.reopen_generation END/);
  assert.match(sql, /last_reopened_at=CASE WHEN jobs\.status IN \('COMPLETED','FAILED'\) THEN now\(\) ELSE jobs\.last_reopened_at END/);
  assert.doesNotMatch(sql, /first_enqueued_at/);
  assert.doesNotMatch(sql, /first_transient_failure_at/);
  assert.doesNotMatch(sql, /created_at/);
});

test('capacity retry scheduling honors provider hints and stays bounded', () => {
  const now = 1_000_000;
  assert.equal(capacityLeaseRunAfter({ retryAt: now + 5_000 }, 1, now), now + 5_000);
  assert.equal(capacityLeaseRunAfter({ retryAfterMs: 4_000 }, 1, now), now + 4_000);
  assert.equal(capacityLeaseRunAfter({}, 1, now), now + 30_000);
  assert.equal(capacityLeaseRunAfter({}, 10, now), now + 15 * 60_000);
  assert.equal(capacityLeaseRunAfter({ retryAt: now - 1 }, 1, now), now + 30_000);

  // Ordinary capacity waits never honor an unbounded provider hint.
  assert.equal(
    capacityLeaseRunAfter({ retryAt: now + 6 * 60 * 60_000 }, 1, now),
    now + MAX_CAPACITY_LEASE_RETRY_DELAY_MS,
  );
  assert.equal(
    capacityLeaseRunAfter({ retryAfterMs: 6 * 60 * 60_000 }, 1, now),
    now + MAX_CAPACITY_LEASE_RETRY_DELAY_MS,
  );

  // Quota waits may follow the next reset, but still cap at 24 hours.
  const quotaError = Object.assign(new Error('quota exhausted'), { code: 'QUOTA_ALLOCATION_EXHAUSTED' });
  assert.equal(
    capacityLeaseRunAfter({ ...quotaError, retryAt: now + 20 * 60 * 60_000 }, 1, now),
    now + 20 * 60 * 60_000,
  );
  assert.equal(
    capacityLeaseRunAfter({ ...quotaError, retryAt: now + 30 * 60 * 60_000 }, 1, now),
    now + MAX_QUOTA_WAIT_DELAY_MS,
  );

  // A decision.runAfter is normalized through the same bound, and a bad
  // candidate falls back instead of producing an invalid Date.
  assert.equal(
    normalizeCapacityLeaseRunAfter({}, now + 6 * 60 * 60_000, 1, now),
    now + MAX_CAPACITY_LEASE_RETRY_DELAY_MS,
  );
  assert.equal(normalizeCapacityLeaseRunAfter({}, Number.POSITIVE_INFINITY, 1, now), now + 30_000);
  assert.equal(normalizeCapacityLeaseRunAfter({}, Number.NaN, 1, now), now + 30_000);
  assert.equal(isQuotaCapacityFailure(quotaError), true);
  assert.equal(isQuotaCapacityFailure({ code: 'ECONNRESET' }), false);
});

test('capacity lease horizon remains the five-hour production lease', () => {
  assert.equal(CAPACITY_LEASE_DURATION_MS, 5 * 60 * 60_000);
});
