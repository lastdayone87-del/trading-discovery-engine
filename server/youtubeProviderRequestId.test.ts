import assert from 'node:assert/strict';
import test from 'node:test';
import { buildYouTubeProviderRequestId } from './youtube';

test('provider request identity is unique for each actual scheduler dispatch attempt', () => {
  const logical = 'query-run:run-1:job:job-1:attempt:1:page:1';
  const first = buildYouTubeProviderRequestId(logical, 1);
  const second = buildYouTubeProviderRequestId(logical, 2);
  assert.equal(first, `${logical}:provider-attempt:1`);
  assert.equal(second, `${logical}:provider-attempt:2`);
  assert.notEqual(first, second);
});

test('provider request identity remains absent when no lifecycle identity is supplied', () => {
  assert.equal(buildYouTubeProviderRequestId(undefined, 1), undefined);
});

test('provider request identity rejects invalid dispatch attempts', () => {
  assert.throws(() => buildYouTubeProviderRequestId('logical-request', 0), /INVALID_PROVIDER_DISPATCH_ATTEMPT/);
  assert.throws(() => buildYouTubeProviderRequestId('logical-request', 1.5), /INVALID_PROVIDER_DISPATCH_ATTEMPT/);
});
