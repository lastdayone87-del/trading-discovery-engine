import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveReviewerIdentity, reviewerDefaultsAvailable, reviewerTokenIsValid } from './reviewerCredentials';

test('uses configured reviewer defaults when request credentials are absent', () => {
  const env = { DEFAULT_REVIEWER_API_TOKEN: 'default-secret', DEFAULT_REVIEWER_IDENTITY: 'sole-operator' };
  assert.equal(reviewerDefaultsAvailable(env), true);
  assert.equal(reviewerTokenIsValid(undefined, env), true);
  assert.equal(resolveReviewerIdentity(undefined, env), 'sole-operator');
});

test('preserves manual credentials when defaults are absent', () => {
  const env = { REVIEW_API_TOKEN: 'manual-secret' };
  assert.equal(reviewerDefaultsAvailable(env), false);
  assert.equal(reviewerTokenIsValid('manual-secret', env), true);
  assert.equal(resolveReviewerIdentity('manual-reviewer', env), 'manual-reviewer');
  assert.equal(reviewerTokenIsValid(undefined, env), false);
});

test('does not let a mismatched default bypass the configured review token', () => {
  const env = {
    REVIEW_API_TOKEN: 'expected-secret',
    DEFAULT_REVIEWER_API_TOKEN: 'wrong-secret',
    DEFAULT_REVIEWER_IDENTITY: 'operator'
  };
  assert.equal(reviewerDefaultsAvailable(env), false);
  assert.equal(reviewerTokenIsValid(undefined, env), false);
  assert.equal(reviewerTokenIsValid('expected-secret', env), true);
});
