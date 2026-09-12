import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyBenchmarkOutcome, INNERTUBE_RATE_LIMITED_CODE } from './youtubeInnertubeProvider';

const coded = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...extra });

test('local cooldown rejections are never reported as upstream throttles', () => {
  assert.equal(
    classifyBenchmarkOutcome(
      coded(INNERTUBE_RATE_LIMITED_CODE, 'YouTube.js provider cooling down for 90000ms.', {
        retryable: true,
        retryAfterMs: 90000,
      }),
    ),
    'LOCAL_COOLDOWN',
  );
});

test('upstream 429s classify as throttled with or without the shared code', () => {
  assert.equal(
    classifyBenchmarkOutcome(coded(INNERTUBE_RATE_LIMITED_CODE, 'YouTube.js InnerTube search failed: 429 too many requests')),
    'UPSTREAM_THROTTLED',
  );
  assert.equal(
    classifyBenchmarkOutcome(Object.assign(new Error('Request failed with status 429'), { status: 429 })),
    'UPSTREAM_THROTTLED',
  );
});

test('cooldown expiry and retry produce ordinary attempted outcomes', () => {
  // After the window lapses the same call path either succeeds (caller-side)
  // or fails upstream — neither outcome may classify as LOCAL_COOLDOWN.
  assert.equal(
    classifyBenchmarkOutcome(coded('INNERTUBE_API_FAILURE', 'InnerTube session cannot list channel videos.')),
    'FAILED',
  );
  assert.equal(classifyBenchmarkOutcome(new Error('socket hang up')), 'FAILED');
});
