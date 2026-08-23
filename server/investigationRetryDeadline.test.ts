import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRefreshOperationalRetryDeadline } from './investigationWorkflow';

test('retryable infrastructure failure classes refresh an expired investigation deadline', () => {
  for (const failureClass of [
    'QUOTA_ALLOCATION_EXHAUSTED',
    'YOUTUBE_PROVIDERS_COOLING_DOWN',
    'YOUTUBE_PROVIDER_POOL_EXHAUSTED',
    'PROVIDER_CONCURRENCY_CAP_EXCEEDED',
    'ETIMEDOUT',
    'ECONNRESET',
    'BRAVE_API_RATE_LIMIT_429',
    'OperationalEnrichmentProviderError'
  ]) {
    assert.equal(
      shouldRefreshOperationalRetryDeadline('RETRYING', failureClass),
      true,
      `${failureClass} should keep the resumable investigation alive`
    );
  }
});

test('non-retryable and non-retrying investigation states do not refresh deadlines', () => {
  assert.equal(shouldRefreshOperationalRetryDeadline('RETRYING', 'VALIDATION_FAILED'), false);
  assert.equal(shouldRefreshOperationalRetryDeadline('RUNNING', 'QUOTA_ALLOCATION_EXHAUSTED'), false);
  assert.equal(shouldRefreshOperationalRetryDeadline('FAILED', 'ETIMEDOUT'), false);
});
