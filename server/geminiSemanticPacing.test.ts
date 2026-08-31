import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideJobFailure } from './dbCore';
import { decideGeminiCapacity } from './providerResilience';
import { GeminiSemanticProvider } from './evidenceEngine/providers/GeminiSemanticProvider';
import type { RawChannelInput } from './evidenceEngine/types';

describe('Gemini semantic pacing regression', () => {
  const now = 1_000_000_000;
  const ninetySeconds = 90_000;
  const thirtySeconds = 30_000;
  const semanticRateLimitCooldownMs = 90_000;
  const defaultConfig = {
    globalMinIntervalMs: 6_000,
    semanticRateLimitCooldownMs,
    vocabularyRateLimitSuppressionMs: 900_000,
    vocabularySemanticQuietMs: 120_000,
    vocabularyMinIntervalMs: 30_000,
    maxInlineWaitMs: 8_000,
    semanticMaxInlineWaitMs: 8_000
  };

  function geminiSemanticDeferError(): any {
    return {
      message: 'Gemini semantic classification deferred during provider rate pressure.',
      retryable: true,
      errorClass: 'TRANSIENT',
      providerReasons: ['SEMANTIC_DEFERRED_RATE_PRESSURE']
    };
  }

  function operationalEnrichmentDeferError(): any {
    return {
      name: 'OperationalEnrichmentProviderError',
      message: 'Enrichment classification provider coverage is operationally degraded (gemini[PROVIDER_RATE_LIMIT|SEMANTIC_DEFERRED_RATE_PRESSURE]); retry after provider recovery.',
      retryable: true,
      errorClass: 'TRANSIENT',
      providerReasons: ['PROVIDER_TRANSIENT_FAILURE', 'SEMANTIC_DEFERRED_RATE_PRESSURE']
    };
  }

  it('Test 1 — Same-job retry: retry is NOT scheduled ~1 second later and respects cooldown', () => {
    const cooldownExpiry = now + ninetySeconds;
    const result = decideJobFailure(geminiSemanticDeferError(), 1, 4, now, now, cooldownExpiry);
    assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
    assert.ok(result.runAfter !== undefined, 'runAfter must be set');
    assert.ok(result.runAfter! >= cooldownExpiry, `runAfter (${result.runAfter}) must be >= cooldown expiry (${cooldownExpiry})`);
    assert.ok(result.runAfter! - now >= ninetySeconds, `retry delay must be >= 90s cooldown, got ${result.runAfter! - now}ms`);
  });

  it('Test 1b — Same-job retry: attempt count is not burned (RETRYING_WITHOUT_ATTEMPT)', () => {
    const cooldownExpiry = now + ninetySeconds;
    const result = decideJobFailure(geminiSemanticDeferError(), 3, 4, now, now, cooldownExpiry);
    assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
  });

  it('Test 1c — Same-job retry: cooldown expiry takes precedence over exponential backoff when longer', () => {
    const cooldownExpiry = now + 120_000;
    const result = decideJobFailure(geminiSemanticDeferError(), 1, 4, now, now, cooldownExpiry);
    assert.ok(result.runAfter! >= cooldownExpiry, `runAfter (${result.runAfter}) must be >= cooldown expiry (${cooldownExpiry})`);
  });

  it('Test 1d — Same-job retry: exponential backoff takes precedence when longer than cooldown', () => {
    const cooldownExpiry = now + 10_000;
    const result = decideJobFailure(geminiSemanticDeferError(), 5, 10, now, now, cooldownExpiry);
    assert.ok(result.runAfter! > cooldownExpiry, `runAfter (${result.runAfter}) must respect exponential backoff`);
  });

  it('Test 1e — Same-job retry: no cooldown provided still uses exponential backoff', () => {
    const result = decideJobFailure(geminiSemanticDeferError(), 1, 4, now, now);
    assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
    assert.ok(result.runAfter! >= now + thirtySeconds, `minimum retry delay must be >= 30s, got ${result.runAfter! - now}ms`);
  });

  it('Test 2 — Many-job amplification: multiple DEFER errors schedule retries past cooldown', () => {
    const cooldownExpiry = now + ninetySeconds;
    const jobResults = [];
    for (let i = 0; i < 10; i++) {
      const result = decideJobFailure(geminiSemanticDeferError(), 1, 4, now, now, cooldownExpiry);
      jobResults.push(result);
      assert.ok(result.runAfter! >= cooldownExpiry, `Job ${i}: runAfter (${result.runAfter}) must be >= cooldown expiry (${cooldownExpiry})`);
    }
    const allSchedulePastCooldown = jobResults.every(r => r.runAfter! >= cooldownExpiry);
    assert.ok(allSchedulePastCooldown, 'All 10 jobs must be scheduled no earlier than the cooldown expiry');
  });

  it('Test 2b — Many-job amplification: OperationalEnrichmentProviderError with Gemini rate pressure also schedules past cooldown', () => {
    const cooldownExpiry = now + ninetySeconds;
    const result = decideJobFailure(operationalEnrichmentDeferError(), 1, 4, now, now, cooldownExpiry);
    assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
    assert.ok(result.runAfter! >= cooldownExpiry, `runAfter (${result.runAfter}) must be >= cooldown expiry (${cooldownExpiry})`);
  });

  it('Test 3 — Multi-worker: identical state produces identical scheduling regardless of which worker calls decideJobFailure', () => {
    const cooldownExpiry = now + ninetySeconds;
    const worker1Result = decideJobFailure(geminiSemanticDeferError(), 1, 4, now, now, cooldownExpiry);
    const worker2Result = decideJobFailure(geminiSemanticDeferError(), 1, 4, now, now, cooldownExpiry);
    const worker3Result = decideJobFailure(geminiSemanticDeferError(), 1, 4, now, now, cooldownExpiry);
    assert.equal(worker1Result.runAfter, worker2Result.runAfter, 'Worker 1 and 2 must produce identical runAfter');
    assert.equal(worker2Result.runAfter, worker3Result.runAfter, 'Worker 2 and 3 must produce identical runAfter');
  });

  it('Test 4 — Cooldown expiry: when cooldown has elapsed, normal exponential backoff resumes', () => {
    const expiredCooldown = now - 10_000;
    const result = decideJobFailure(geminiSemanticDeferError(), 1, 4, now, now, expiredCooldown);
    assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
    assert.ok(result.runAfter! < now + ninetySeconds, 'expired cooldown must not force a 90s delay');
    assert.ok(result.runAfter! - now >= thirtySeconds, 'must still use standard exponential backoff (30s)');
  });

  it('Test 4b — Cooldown expiry: non-Gemini errors are unaffected by cooldown parameter', () => {
    const genericTransientError = {
      message: 'Transient network failure',
      retryable: true,
      errorClass: 'TRANSIENT'
    };
    const cooldownExpiry = now + ninetySeconds;
    const result = decideJobFailure(genericTransientError, 1, 4, now, now, cooldownExpiry);
    assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
    assert.ok(result.runAfter! >= now + thirtySeconds, 'must use standard exponential backoff');
    assert.ok(result.runAfter! < cooldownExpiry, 'non-Gemini error must NOT be delayed to Gemini cooldown');
  });

  it('Test 5 — Unrelated work: non-ENRICH_CHANNEL failures are completely unaffected', () => {
    const unrelatedError = {
      message: 'YouTube provider quota exhausted',
      code: 'YOUTUBE_PROVIDERS_COOLING_DOWN',
      retryable: true
    };
    const cooldownExpiry = now + ninetySeconds;
    const result = decideJobFailure(unrelatedError, 2, 5, now, now, cooldownExpiry);
    assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
    assert.ok(result.runAfter! - now < 120_000, 'unrelated error must not be affected by Gemini cooldown');
  });

  it('Test 6 — Existing retry policy: ≥30s infrastructure retry is preserved', () => {
    const cooldownExpiry = now;
    const genericTransientError = {
      message: 'Transient network failure',
      retryable: true,
      errorClass: 'TRANSIENT'
    };
    const result = decideJobFailure(genericTransientError, 1, 4, now, now, cooldownExpiry);
    assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
    assert.ok(result.runAfter! - now >= thirtySeconds, 'minimum retry delay must be >= 30s');
    assert.ok(result.runAfter! - now <= sixtySeconds(), 'retry delay must not exceed 60s for first attempt');
  });

  it('Test 6b — Existing retry policy: exponential backoff increases with attempts', () => {
    const cooldownExpiry = now;
    const genericTransientError = {
      message: 'Transient network failure',
      retryable: true,
      errorClass: 'TRANSIENT'
    };
    const result1 = decideJobFailure(genericTransientError, 1, 10, now, now, cooldownExpiry);
    const result2 = decideJobFailure(genericTransientError, 2, 10, now, now, cooldownExpiry);
    const result3 = decideJobFailure(genericTransientError, 3, 10, now, now, cooldownExpiry);
    assert.ok(result2.runAfter! >= result1.runAfter!, 'attempt 2 must wait >= attempt 1');
    assert.ok(result3.runAfter! >= result2.runAfter!, 'attempt 3 must wait >= attempt 2');
  });

  it('Test 6c — Existing retry policy: max transient retry age causes terminal failure', () => {
    const maxTransientRetryAge = 6 * 60 * 60_000;
    const firstFailureAt = now - maxTransientRetryAge - 1000;
    const genericTransientError = {
      message: 'Transient network failure',
      retryable: true,
      errorClass: 'TRANSIENT'
    };
    const result = decideJobFailure(genericTransientError, 1, 4, now, firstFailureAt);
    assert.equal(result.disposition, 'FAILED');
    assert.equal(result.operationallyBlocked, true);
  });

  it('Test 6d — Existing retry policy: no-attempt-burn for retryable infrastructure failures', () => {
    const genericTransientError = {
      message: 'Transient network failure',
      retryable: true,
      errorClass: 'TRANSIENT'
    };
    const result = decideJobFailure(genericTransientError, 3, 4, now, now, now);
    assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT', 'infrastructure failures must not burn attempts');
  });

  it('Test 6e — Existing retry policy: INVESTIGATION_DEADLINE_EXCEEDED is terminal', () => {
    const deadlineError = {
      code: 'INVESTIGATION_DEADLINE_EXCEEDED',
      message: 'Deadline exceeded'
    };
    const result = decideJobFailure(deadlineError, 1, 4, now, now);
    assert.equal(result.disposition, 'FAILED');
  });

  it('decideGeminiCapacity returns SEMANTIC_DEFERRED_RATE_PRESSURE during active cooldown', () => {
    const decision = decideGeminiCapacity('multilingual-semantic-classification', {
      nowMs: now,
      lastRateLimitAtMs: now - 30_000
    }, defaultConfig);
    assert.equal(decision.action, 'DEFER');
    assert.equal(decision.reasonCode, 'SEMANTIC_DEFERRED_RATE_PRESSURE');
    assert.equal(decision.waitMs, 0);
  });

  it('decideGeminiCapacity returns RUN when cooldown has expired', () => {
    const decision = decideGeminiCapacity('multilingual-semantic-classification', {
      nowMs: now,
      lastRateLimitAtMs: now - 100_000,
      lastGeminiAtMs: now - 10_000
    }, defaultConfig);
    assert.equal(decision.action, 'RUN');
    assert.equal(decision.waitMs, 0);
  });

  describe('Architectural invariant: ENRICH_CHANNEL always requires Gemini', () => {
    const mockClient = { classify: async () => ({}) };
    function baseCandidate(): RawChannelInput {
      return {
        channel_name: 'Test Channel',
        description: 'Trading education channel about crypto and forex markets',
        video_titles: ['How I Trade Forex', 'Day Trading Strategy'],
        video_descriptions: ['Full strategy breakdown', 'Beginner guide to trading'],
        external_links: ['https://example.com'],
        country: 'US',
        enrichment_stage: 1
      };
    }

    it('GeminiSemanticProvider is AVAILABLE for enrichment_stage 1 (initial ENRICH_CHANNEL)', () => {
      const provider = new GeminiSemanticProvider(mockClient);
      const input = baseCandidate();
      const result = provider.availability(input);
      assert.equal(result.availability, 'AVAILABLE', `Expected AVAILABLE, got ${result.availability}: ${result.reason || ''}`);
    });

    it('GeminiSemanticProvider is AVAILABLE for enrichment_stage 2 (follow-up ENRICH_CHANNEL)', () => {
      const provider = new GeminiSemanticProvider(mockClient);
      const input = { ...baseCandidate(), enrichment_stage: 2 };
      const result = provider.availability(input);
      assert.equal(result.availability, 'AVAILABLE', `Expected AVAILABLE, got ${result.availability}: ${result.reason || ''}`);
    });

    it('GeminiSemanticProvider is AVAILABLE for enrichment_stage 3 (final ENRICH_CHANNEL)', () => {
      const provider = new GeminiSemanticProvider(mockClient);
      const input = { ...baseCandidate(), enrichment_stage: 3 };
      const result = provider.availability(input);
      assert.equal(result.availability, 'AVAILABLE', `Expected AVAILABLE, got ${result.availability}: ${result.reason || ''}`);
    });

    it('GeminiSemanticProvider is NOT_APPLICABLE only for retrieval-only candidates (enrichment_stage 0 with search_match_context)', () => {
      const provider = new GeminiSemanticProvider(mockClient);
      const input: RawChannelInput = {
        channel_name: 'Sparse Channel',
        description: '',
        video_titles: [],
        video_descriptions: [],
        external_links: [],
        enrichment_stage: 0,
        search_match_context: { type: 'VIDEO', provider_native_id: 'test', title: 'test', description: 'test', published_at: '2025-01-01', locator: 'test' }
      };
      const result = provider.availability(input);
      assert.equal(result.availability, 'NOT_APPLICABLE', 'Retrieval-only with no creator context should be NOT_APPLICABLE');
    });

    it('GeminiSemanticProvider is AVAILABLE when enrichment_stage 0 but has creator-level context', () => {
      const provider = new GeminiSemanticProvider(mockClient);
      const input: RawChannelInput = {
        channel_name: 'Context Channel',
        description: 'A channel about trading',
        video_titles: ['Trading Basics'],
        video_descriptions: ['Learn to trade'],
        external_links: [],
        enrichment_stage: 0,
        search_match_context: { type: 'VIDEO', provider_native_id: 'test', title: 'test', description: 'test', published_at: '2025-01-01', locator: 'test' }
      };
      const result = provider.availability(input);
      assert.equal(result.availability, 'AVAILABLE', 'enrichment_stage 0 with description should be AVAILABLE');
    });
  });
});

function sixtySeconds(): number {
  return 60_000;
}
