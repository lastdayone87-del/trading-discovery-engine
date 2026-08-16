import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { redactString, sanitizeForLog } = require('./secretSafeLogging.cjs') as {
  redactString: (value: string) => string;
  sanitizeForLog: (value: unknown) => unknown;
};

test('redacts full and abbreviated-looking YouTube API keys from strings and URLs', () => {
  const secret = 'AIzaSyD40wzH4npqS1gKRWkHSk0s1ONaXprO10';
  const redacted = redactString(`provider=${secret} https://youtube.googleapis.com/youtube/v3/search?key=${secret}&part=snippet`);
  assert.doesNotMatch(redacted, /AIza/);
  assert.doesNotMatch(redacted, /D40wzH4n/);
  assert.match(redacted, /REDACTED_YOUTUBE_API_KEY/);
});

test('redacts provider keys recursively while preserving operational error fields', () => {
  const secret = 'AIzaSyWRAPPED_PROVIDER_SECRET_123456789';
  const cause = Object.assign(new Error('YouTube HTTP 429 RESOURCE_EXHAUSTED'), {
    status: 429,
    quotaExceeded: false,
    providerReasons: ['rateLimitExceeded', 'RATE_LIMIT_EXCEEDED'],
    providerKey: secret,
    providerFailureRecorded: true
  });
  const wrapped = Object.assign(new Error('Provider rate limit reached.'), {
    errorClass: 'RATE_LIMIT',
    retryable: true,
    providerKey: secret,
    cause
  });

  const sanitized = sanitizeForLog(wrapped) as any;
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /AIza/);
  assert.equal(sanitized.providerKey, '[REDACTED]');
  assert.equal(sanitized.cause.providerKey, '[REDACTED]');
  assert.equal(sanitized.cause.status, 429);
  assert.deepEqual(sanitized.cause.providerReasons, ['rateLimitExceeded', 'RATE_LIMIT_EXCEEDED']);
  assert.equal(sanitized.cause.providerFailureRecorded, true);
});
