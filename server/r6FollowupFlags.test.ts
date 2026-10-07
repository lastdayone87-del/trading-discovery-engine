import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRelevanceEnforcementEnabled,
  isLoginBlockSemanticsEnabled,
  isPathAwareShortlinkBorrowEnabled,
  isPartialStaticRetryEnabled,
} from './r6FollowupFlags';

describe('R6 independent flags (fail-open, independently toggleable)', () => {
  it('relevance ships DISABLED pending review; others default ON', async () => {
    delete process.env.RELEVANCE_ENFORCEMENT_ENABLED;
    delete process.env.LOGIN_BLOCK_SEMANTICS_ENABLED;
    delete process.env.PATH_AWARE_SHORTLINK_BORROW_ENABLED;
    delete process.env.PARTIAL_STATIC_RETRY_ENABLED;
    const failing = async () => {
      throw new Error('no db');
    };
    // Failing reader fails open to defaults.
    assert.equal(await isRelevanceEnforcementEnabled(failing as never), false);
    assert.equal(await isLoginBlockSemanticsEnabled(failing as never), true);
    assert.equal(await isPathAwareShortlinkBorrowEnabled(failing as never), true);
    assert.equal(await isPartialStaticRetryEnabled(failing as never), true);
  });

  it('env overrides each flag independently', async () => {
    process.env.RELEVANCE_ENFORCEMENT_ENABLED = 'true';
    process.env.LOGIN_BLOCK_SEMANTICS_ENABLED = 'false';
    try {
      assert.equal(await isRelevanceEnforcementEnabled(), true);
      assert.equal(await isLoginBlockSemanticsEnabled(), false);
      // Others unaffected.
      delete process.env.PATH_AWARE_SHORTLINK_BORROW_ENABLED;
      delete process.env.PARTIAL_STATIC_RETRY_ENABLED;
    } finally {
      delete process.env.RELEVANCE_ENFORCEMENT_ENABLED;
      delete process.env.LOGIN_BLOCK_SEMANTICS_ENABLED;
    }
  });
});
