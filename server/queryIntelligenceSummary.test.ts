import assert from 'node:assert/strict';
import test from 'node:test';
import { isQueryIntelligenceSummaryCacheFresh } from './dbCore';

test('summary cache reuse is bounded and fails closed on invalid clocks', () => {
  assert.equal(isQueryIntelligenceSummaryCacheFresh(1_000, 10_000, 15_000), true);
  assert.equal(isQueryIntelligenceSummaryCacheFresh(1_000, 16_000, 15_000), false);
  assert.equal(isQueryIntelligenceSummaryCacheFresh(1_000, 999, 15_000), false, 'a clock moving backwards must not reuse');
  assert.equal(isQueryIntelligenceSummaryCacheFresh(null, 10_000, 15_000), false);
  assert.equal(isQueryIntelligenceSummaryCacheFresh(Number.NaN, 10_000, 15_000), false);
  assert.equal(isQueryIntelligenceSummaryCacheFresh(1_000, 10_000, 0), false, 'ttl is clamped to at least one millisecond');
});
