import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { QuotaAllocationExhaustedError } from './quotaCapacity';
import { getNextYouTubeQuotaResetAt, getYouTubeQuotaDayStartAt, minutesSinceYouTubeQuotaDayStart } from './youtubeQuotaDay';

test('YouTube quota helpers use Pacific midnight during daylight saving time', () => {
  const now = new Date('2026-08-16T08:29:00.000Z');
  assert.equal(new Date(getYouTubeQuotaDayStartAt(now)).toISOString(), '2026-08-16T07:00:00.000Z');
  assert.equal(new Date(getNextYouTubeQuotaResetAt(now)).toISOString(), '2026-08-17T07:00:00.000Z');
  assert.equal(minutesSinceYouTubeQuotaDayStart(now), 89);
});

test('quota allocation retry follows the next Pacific reset instead of UTC midnight', () => {
  const now = new Date('2026-08-16T06:30:00.000Z');
  const retryAt = getNextYouTubeQuotaResetAt(now);
  const error = new QuotaAllocationExhaustedError('AUTONOMOUS', retryAt);
  assert.equal(new Date(error.retryAt).toISOString(), '2026-08-16T07:00:00.000Z');
});

test('rollover reconciler wakes only previous-day quota deferrals and preserves runtime rate limits', () => {
  const source = readFileSync(new URL('./quotaRolloverReconciliation.ts', import.meta.url), 'utf8');
  assert.match(source, /updated_at<\$2/);
  assert.match(source, /YouTube quota allocation is exhausted/);
  assert.match(source, /daily quota/);
  assert.match(source, /last_error !~\* 'rate\.\?limit\|429'/);
});

test('autonomous producer uses the reconciled Pacific-day snapshot', () => {
  const source = readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  assert.match(source, /reconcileYouTubeQuotaRolloverAndGetAutonomousSnapshot/);
  assert.match(source, /minutesSinceUtcMidnight: snapshot\.minutesSinceQuotaDayStart/);
  assert.doesNotMatch(source, /getAutonomousSchedulingSnapshot/);
});
