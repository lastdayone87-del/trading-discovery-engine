import test from 'node:test';
import assert from 'node:assert/strict';
import { isConsumerSuspended, isYouTubeRateLimited, youtubeHttpError, selectYouTubeDispatchProviderIndex } from './youtube';
import { isQuotaExceeded } from './youtubePoolBackoff';
import { youtubeProviderCooldown } from './youtubeProviderCooldown';

test('youtubeHttpError correctly extracts providerReasons from legacy and google.rpc error responses', async () => {
  // Test camelCase reason: consumerSuspended
  const response1 = new Response(JSON.stringify({
    error: {
      code: 403,
      message: 'The caller does not have permission',
      status: 'PERMISSION_DENIED',
      errors: [{ reason: 'consumerSuspended', domain: 'youtube.quota' }]
    }
  }), { status: 403, headers: { 'content-type': 'application/json' } });

  const error1 = await youtubeHttpError(response1);
  assert.equal(error1.message.includes('403 PERMISSION_DENIED'), true);
  assert.equal(error1.message.includes('consumerSuspended'), true);
  assert.equal((error1 as any).status, 403);
  assert.deepEqual((error1 as any).providerReasons, ['consumerSuspended']);
  assert.equal(isConsumerSuspended(error1), true);
  assert.equal(isQuotaExceeded(error1), false);
  assert.equal(isYouTubeRateLimited(error1), false);

  // Test UPPER_CASE reason: CONSUMER_SUSPENDED
  const response2 = new Response(JSON.stringify({
    error: {
      code: 403,
      message: 'The caller does not have permission',
      status: 'PERMISSION_DENIED',
      details: [{ reason: 'CONSUMER_SUSPENDED' }]
    }
  }), { status: 403, headers: { 'content-type': 'application/json' } });

  const error2 = await youtubeHttpError(response2);
  assert.equal(isConsumerSuspended(error2), true);
  assert.equal(isQuotaExceeded(error2), false);
  assert.equal(isYouTubeRateLimited(error2), false);
});

test('youtubeHttpError distinguishes quotaExceeded from consumerSuspended', async () => {
  const quotaResponse = new Response(JSON.stringify({
    error: {
      code: 403,
      message: 'The request cannot be completed because you have exceeded your quota.',
      status: 'PERMISSION_DENIED',
      errors: [{ reason: 'quotaExceeded' }]
    }
  }), { status: 403, headers: { 'content-type': 'application/json' } });

  const quotaError = await youtubeHttpError(quotaResponse);
  assert.equal(isConsumerSuspended(quotaError), false);
  assert.equal(isQuotaExceeded(quotaError), true);
  assert.equal(isYouTubeRateLimited(quotaError), false);

  const dailyLimitResponse = new Response(JSON.stringify({
    error: {
      code: 403,
      message: 'Daily limit exceeded.',
      status: 'PERMISSION_DENIED',
      errors: [{ reason: 'dailyLimitExceeded' }]
    }
  }), { status: 403, headers: { 'content-type': 'application/json' } });

  const dailyLimitError = await youtubeHttpError(dailyLimitResponse);
  assert.equal(isConsumerSuspended(dailyLimitError), false);
  assert.equal(isQuotaExceeded(dailyLimitError), true);
});

test('full production classification path: 403 PERMISSION_DENIED response -> youtubeHttpError -> isConsumerSuspended -> quarantine -> provider exclusion', async () => {
  const keys = ['key-prod-1', 'key-prod-2'];

  // 1. Initially both keys are active and eligible
  assert.equal(youtubeProviderCooldown.eligible('key-prod-1'), true);
  assert.equal(youtubeProviderCooldown.eligible('key-prod-2'), true);

  // 2. Simulate 403 PERMISSION_DENIED / consumerSuspended HTTP response on key-prod-1
  const httpResponse = new Response(JSON.stringify({
    error: {
      code: 403,
      message: 'Project key suspended by administrator',
      status: 'PERMISSION_DENIED',
      errors: [{ reason: 'consumerSuspended' }]
    }
  }), { status: 403, headers: { 'content-type': 'application/json' } });

  const error = await youtubeHttpError(httpResponse);
  Object.assign(error, { providerKey: 'key-prod-1' });

  // 3. Classify and record failure
  assert.equal(isConsumerSuspended(error), true);
  const failureKind = isConsumerSuspended(error) ? 'CONSUMER_SUSPENDED' : (isQuotaExceeded(error) ? 'DAILY_QUOTA_EXHAUSTED' : 'RATE_LIMITED');
  youtubeProviderCooldown.failed('key-prod-1', failureKind);

  // 4. Verify key-prod-1 is quarantined and ineligible
  assert.equal(youtubeProviderCooldown.eligible('key-prod-1'), false);
  assert.deepEqual(youtubeProviderCooldown.status('key-prod-1').status, 'Suspended');

  // 5. Verify provider selection automatically selects key-prod-2 instead of key-prod-1
  const selectedIndex = selectYouTubeDispatchProviderIndex(keys, 'key-prod-1');
  assert.equal(selectedIndex, 1); // Selects key-prod-2 at index 1
  assert.equal(keys[selectedIndex], 'key-prod-2');
});

test('concurrent in-flight request behavior: already running requests finish, but subsequent selection excludes suspended provider', async () => {
  const keys = ['key-concurrent-1', 'key-concurrent-2'];

  // In-flight request A was already dispatched using key-concurrent-1 before suspension
  const inFlightRequestAKey = 'key-concurrent-1';

  // Key 1 experiences 403 CONSUMER_SUSPENDED failure
  youtubeProviderCooldown.failed(inFlightRequestAKey, 'CONSUMER_SUSPENDED');

  // Request A finishes its error handling / cleanup
  assert.equal(youtubeProviderCooldown.eligible(inFlightRequestAKey), false);

  // Subsequent dispatch attempt for new request B must exclude key-concurrent-1 and choose key-concurrent-2
  const nextIndex = selectYouTubeDispatchProviderIndex(keys, inFlightRequestAKey);
  assert.equal(nextIndex, 1);
  assert.equal(keys[nextIndex], 'key-concurrent-2');
});
