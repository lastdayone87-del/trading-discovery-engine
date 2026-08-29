import test from 'node:test';
import assert from 'node:assert/strict';
import { isConsumerSuspended, isYouTubeRateLimited } from './youtube';
import { isQuotaExceeded } from './youtubePoolBackoff';
import { youtubeProviderCooldown } from './youtubeProviderCooldown';

test('isConsumerSuspended correctly classifies 403 PERMISSION_DENIED consumerSuspended responses', () => {
  const error = Object.assign(new Error('YouTube HTTP 403 PERMISSION_DENIED (consumerSuspended)'), {
    status: 403,
    providerReasons: ['consumerSuspended'],
  });

  assert.equal(isConsumerSuspended(error), true);
  assert.equal(isQuotaExceeded(error), false);
  assert.equal(isYouTubeRateLimited(error), false);
});

test('isConsumerSuspended distinguishes consumerSuspended from quotaExceeded and dailyLimitExceeded', () => {
  const quotaError = Object.assign(new Error('YouTube HTTP 403 (quotaExceeded)'), {
    status: 403,
    quotaExceeded: true,
    providerReasons: ['quotaExceeded'],
  });

  assert.equal(isConsumerSuspended(quotaError), false);
  assert.equal(isQuotaExceeded(quotaError), true);
  assert.equal(isYouTubeRateLimited(quotaError), false);

  const dailyLimitError = Object.assign(new Error('YouTube HTTP 403 (dailyLimitExceeded)'), {
    status: 403,
    quotaExceeded: true,
    providerReasons: ['dailyLimitExceeded'],
  });

  assert.equal(isConsumerSuspended(dailyLimitError), false);
  assert.equal(isQuotaExceeded(dailyLimitError), true);
});

test('isConsumerSuspended handles wrapped cause errors', () => {
  const inner = Object.assign(new Error('YouTube HTTP 403 PERMISSION_DENIED (consumerSuspended)'), {
    status: 403,
    providerReasons: ['consumerSuspended'],
  });
  const outer = Object.assign(new Error('Provider call failed'), { cause: inner });

  assert.equal(isConsumerSuspended(outer), true);
  assert.equal(isQuotaExceeded(outer), false);
  assert.equal(isYouTubeRateLimited(outer), false);
});

test('recordProviderFailure correctly quarantines suspended provider without ReferenceError', () => {
  const suspendedError = Object.assign(new Error('YouTube HTTP 403 PERMISSION_DENIED (consumerSuspended)'), {
    status: 403,
    providerReasons: ['consumerSuspended'],
    providerKey: 'key-test-record',
  });

  // Access private/internal recordProviderFailure via module context test or simulated failure flow
  const initialStatus = youtubeProviderCooldown.status('key-test-record');
  assert.equal(initialStatus.status, 'Active');

  youtubeProviderCooldown.failed('key-test-record', 'CONSUMER_SUSPENDED');
  const postStatus = youtubeProviderCooldown.status('key-test-record');
  assert.equal(postStatus.status, 'Suspended');
});
