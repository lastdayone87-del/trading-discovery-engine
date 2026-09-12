import assert from 'node:assert/strict';
import test from 'node:test';
import { isInvalidApiKey, recordProviderFailure } from './youtube';
import { youtubeProviderCooldown } from './youtubeProviderCooldown';

const deadKeyError = () =>
  Object.assign(new Error('YouTube HTTP 400 (keyInvalid)'), {
    status: 400,
    providerReasons: ['keyInvalid'],
  });

test('dead API key errors are detected without touching other failure classes', () => {
  assert.equal(isInvalidApiKey(deadKeyError()), true);
  assert.equal(
    isInvalidApiKey(
      Object.assign(new Error('YouTube HTTP 400 (API_KEY_INVALID)'), {
        status: 400,
        providerReasons: ['API_KEY_INVALID'],
      }),
    ),
    true,
  );
  assert.equal(isInvalidApiKey(new Error('YouTube HTTP 400 (keyInvalid)')), true);
  assert.equal(
    isInvalidApiKey({ cause: deadKeyError(), message: 'wrapped dispatch failure' }),
    true,
  );
  // Per-channel input errors must never look like a dead key.
  assert.equal(
    isInvalidApiKey(
      Object.assign(new Error('YouTube HTTP 400 (invalidChannelId)'), {
        status: 400,
        providerReasons: ['invalidChannelId'],
      }),
    ),
    false,
  );
  // Quota, suspension, rate-limit and transport failures are other detectors' jobs.
  assert.equal(
    isInvalidApiKey(
      Object.assign(new Error('YouTube HTTP 403 (quotaExceeded)'), {
        status: 403,
        quotaExceeded: true,
        providerReasons: ['quotaExceeded'],
      }),
    ),
    false,
  );
  assert.equal(
    isInvalidApiKey(
      Object.assign(new Error('YouTube HTTP 403 (consumerSuspended)'), {
        status: 403,
        providerReasons: ['consumerSuspended'],
      }),
    ),
    false,
  );
  assert.equal(isInvalidApiKey(Object.assign(new Error('ratelimited'), { status: 429 })), false);
  assert.equal(isInvalidApiKey(new Error('socket hang up')), false);
});

test('a dead key is quarantined so rotation skips it instead of failing every call', () => {
  const key = `test-dead-key-${Date.now()}`;
  assert.equal(youtubeProviderCooldown.eligible(key), true);
  recordProviderFailure(key, deadKeyError());
  assert.equal(youtubeProviderCooldown.eligible(key), false);
  assert.equal(youtubeProviderCooldown.status(key).status, 'Suspended');
});

test('a per-channel 400 never quarantines a healthy key', () => {
  const key = `test-healthy-key-${Date.now()}`;
  recordProviderFailure(
    key,
    Object.assign(new Error('YouTube HTTP 400 (invalidChannelId)'), {
      status: 400,
      providerReasons: ['invalidChannelId'],
    }),
  );
  assert.equal(youtubeProviderCooldown.eligible(key), true);
});
