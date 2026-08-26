import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderCapacityFailure, classifyProviderRunOutcome } from './providerCapacityDiagnostics';

test('classifies all-key cooldown without exposing provider payloads', () => {
  assert.deepEqual(classifyProviderCapacityFailure({ code: 'YOUTUBE_PROVIDERS_COOLING_DOWN', retryAt: 1_800_000_000_000 }), {
    reason: 'ALL_KEYS_COOLING_DOWN', retryable: true, retryAt: '2027-01-15T08:00:00.000Z'
  });
});

test('classifies all-project daily quota exhaustion', () => {
  assert.deepEqual(classifyProviderCapacityFailure({ code: 'YOUTUBE_PROVIDER_POOL_EXHAUSTED', retryAt: 1_800_000_000_000 }), {
    reason: 'ALL_KEYS_DAILY_QUOTA_EXHAUSTED', retryable: true, retryAt: '2027-01-15T08:00:00.000Z'
  });
});

test('classifies runtime pressure, quota allocation, cooldown, and concurrency separately', () => {
  assert.equal(classifyProviderCapacityFailure({ code: 'YOUTUBE_RUNTIME_RATE_PRESSURE' })?.reason, 'PROVIDER_RUNTIME_RATE_PRESSURE');
  assert.equal(classifyProviderCapacityFailure({ code: 'QUOTA_ALLOCATION_EXHAUSTED' })?.reason, 'PROVIDER_QUOTA_ALLOCATION_EXHAUSTED');
  assert.equal(classifyProviderCapacityFailure({ code: 'PROVIDER_COOLDOWN' })?.reason, 'PROVIDER_COOLDOWN');
  assert.equal(classifyProviderCapacityFailure({ code: 'PROVIDER_CONCURRENCY_CAP_EXCEEDED' })?.reason, 'PROVIDER_CONCURRENCY_CAP');
});

test('does not classify unrelated provider failures as capacity', () => {
  assert.equal(classifyProviderCapacityFailure({ code: 'YOUTUBE_HTTP_403' }), undefined);
  assert.equal(classifyProviderCapacityFailure({ code: 'INVALID_QUERY' }), undefined);
});

test('distinguishes successful non-empty and authoritative empty results', () => {
  assert.equal(classifyProviderRunOutcome({ rawResults: 4, providerRequestsAttempted: 1, providerRequestsSucceeded: 1, providerRequestsFailed: 0, providerRateLimited: 0 }), 'SUCCESS_NON_EMPTY');
  assert.equal(classifyProviderRunOutcome({ rawResults: 0, providerRequestsAttempted: 1, providerRequestsSucceeded: 1, providerRequestsFailed: 0, providerRateLimited: 0 }), 'SUCCESS_EMPTY');
});

test('distinguishes recovered fallback from all-provider failure', () => {
  assert.equal(classifyProviderRunOutcome({ rawResults: 0, providerRequestsAttempted: 2, providerRequestsSucceeded: 1, providerRequestsFailed: 1, providerRateLimited: 0 }), 'RECOVERED_AFTER_PROVIDER_FAILURE');
  assert.equal(classifyProviderRunOutcome({ rawResults: 0, providerRequestsAttempted: 2, providerRequestsSucceeded: 0, providerRequestsFailed: 1, providerRateLimited: 1, terminalFailure: true }), 'FAILED_ALL_PROVIDERS');
});

test('keeps capacity deferral and post-response failure distinct', () => {
  assert.equal(classifyProviderRunOutcome({ rawResults: 0, providerRequestsAttempted: 0, providerRequestsSucceeded: 0, providerRequestsFailed: 0, providerRateLimited: 0, capacityDeferred: true }), 'DEFERRED_PROVIDER_CAPACITY');
  assert.equal(classifyProviderRunOutcome({ rawResults: 0, providerRequestsAttempted: 1, providerRequestsSucceeded: 1, providerRequestsFailed: 0, providerRateLimited: 0, terminalFailure: true }), 'FAILED_AFTER_PROVIDER_RESPONSE');
});
