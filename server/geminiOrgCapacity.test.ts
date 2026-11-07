import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideGeminiCapacity } from './providerResilience';

const config = {
  globalMinIntervalMs: 6_000,
  semanticRateLimitCooldownMs: 90_000,
  vocabularyRateLimitSuppressionMs: 900_000,
  vocabularySemanticQuietMs: 120_000,
  vocabularyMinIntervalMs: 30_000,
  maxInlineWaitMs: 8_000,
  semanticMaxInlineWaitMs: 8_000,
  orgRateLimitWindowMs: 60_000,
  orgMaxCallsPerWindow: 10,
};

test('a full per-account token bucket defers instead of sleeping a worker', () => {
  const now = 1_000_000;
  const decision = decideGeminiCapacity('multilingual-semantic-classification', {
    nowMs: now,
    lastGeminiAtMs: now - 10_000,
    orgCallsInWindow: 10,
  }, config);
  assert.equal(decision.action, 'DEFER');
  assert.equal(decision.reasonCode, 'GEMINI_ORG_TOKEN_BUCKET_EMPTY');
  assert.equal(decision.waitMs, 0);
});

test('a below-capacity account runs when its own pacing is clear', () => {
  const now = 1_000_000;
  const decision = decideGeminiCapacity('multilingual-semantic-classification', {
    nowMs: now,
    lastGeminiAtMs: now - 10_000,
    orgCallsInWindow: 9,
  }, config);
  assert.equal(decision.action, 'RUN');
});

test('a bucket of 0 explicitly disables the per-account cap', () => {
  const now = 1_000_000;
  const decision = decideGeminiCapacity('multilingual-semantic-classification', {
    nowMs: now,
    lastGeminiAtMs: now - 10_000,
    orgCallsInWindow: 10_000,
  }, { ...config, orgMaxCallsPerWindow: 0 });
  assert.equal(decision.action, 'RUN');
});

test('GEMINI_ORG_MAX_CALLS_PER_MINUTE tunes the default per-account bucket', () => {
  const previous = process.env.GEMINI_ORG_MAX_CALLS_PER_MINUTE;
  process.env.GEMINI_ORG_MAX_CALLS_PER_MINUTE = '1';
  try {
    const now = 1_000_000;
    const decision = decideGeminiCapacity('multilingual-semantic-classification', {
      nowMs: now,
      lastGeminiAtMs: now - 10_000,
      orgCallsInWindow: 1,
    });
    assert.equal(decision.action, 'DEFER');
    assert.equal(decision.reasonCode, 'GEMINI_ORG_TOKEN_BUCKET_EMPTY');
  } finally {
    if (previous === undefined) delete process.env.GEMINI_ORG_MAX_CALLS_PER_MINUTE;
    else process.env.GEMINI_ORG_MAX_CALLS_PER_MINUTE = previous;
  }
});

test('per-account capacity uses a two-key advisory lock and strict org-scoped ledgers', () => {
  const source = readFileSync('server/providerResilience.ts', 'utf8');
  assert.match(source, /pg_try_advisory_lock\(\$1,hashtext\(\$2\)\)/);
  assert.match(source, /pg_advisory_unlock\(\$1,hashtext\(\$2\)\)/);
  assert.doesNotMatch(source, /pg_try_advisory_lock\(\$1\) AS acquired/);
  assert.match(source, /COUNT\(\*\)::int AS calls[\s\S]*request_metadata->>'geminiOrg'=\$2/);
  assert.match(source, /orgCallsInWindow:Number\(orgWindowCalls\.rows\[0\]\?\.calls\|\|0\)/);
  assert.match(source, /GEMINI_ORG_MAX_CALLS_PER_MINUTE/);
});
