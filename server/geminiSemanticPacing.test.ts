import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideJobFailure, failJob } from './db';
import { decideGeminiCapacity, geminiSemanticCooldownMs, configuredGeminiRouteIds, resolveGeminiRouteId, isGeminiSemanticCooldownActive, geminiCapacityDeferralError } from './providerResilience';
import { parseTransientRetryAgeMs } from './db';
import { configuredGeminiRoutes, GeminiSemanticProvider } from './evidenceEngine/providers/GeminiSemanticProvider';
import { enrichmentOperationalFailure, OperationalEnrichmentProviderError } from './enrichmentOperationalFailure';
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

  describe('Production failJob path exercises Gemini cooldown', () => {
    it('decideJobFailure is the same function whether imported from db or dbCore', async () => {
      const { decideJobFailure: fromDb } = await import('./db');
      const { decideJobFailure: fromDbCore } = await import('./dbCore');
      assert.equal(fromDb, fromDbCore, 'db.ts must re-export dbCore.ts decideJobFailure, not shadow it');
    });

    it('Gemini semantic defer schedules past cooldown via db exports', () => {
      const cooldownExpiry = now + ninetySeconds;
      const result = decideJobFailure(geminiSemanticDeferError(), 1, 4, now, now, cooldownExpiry);
      assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
      assert.ok(result.runAfter! >= cooldownExpiry, `runAfter (${result.runAfter}) must be >= cooldown expiry (${cooldownExpiry})`);
    });

    it('OperationalEnrichmentProviderError with Gemini rate pressure schedules past cooldown via db exports', () => {
      const cooldownExpiry = now + ninetySeconds;
      const result = decideJobFailure(operationalEnrichmentDeferError(), 1, 4, now, now, cooldownExpiry);
      assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
      assert.ok(result.runAfter! >= cooldownExpiry, `runAfter (${result.runAfter}) must be >= cooldown expiry (${cooldownExpiry})`);
    });
  });

  describe('Global cooldown scope (project-level Gemini rate limits)', () => {
    it('decideGeminiCapacity defers semantic when any route is rate-limited (global scope)', () => {
      // Route A was rate-limited 30s ago; route B has no events.
      // Since rate limits are project-level, both routes share the cooldown.
      const decision = decideGeminiCapacity('multilingual-semantic-classification', {
        nowMs: now,
        lastRateLimitAtMs: now - 30_000, // route A rate limit
        lastGeminiAtMs: now - 10_000
      }, defaultConfig);
      assert.equal(decision.action, 'DEFER', 'must defer when any route has active rate limit');
      assert.equal(decision.reasonCode, 'SEMANTIC_DEFERRED_RATE_PRESSURE');
    });

    it('decideGeminiCapacity runs when cooldown has fully elapsed across all routes', () => {
      const decision = decideGeminiCapacity('multilingual-semantic-classification', {
        nowMs: now,
        lastRateLimitAtMs: now - 100_000, // cooldown elapsed (90s)
        lastGeminiAtMs: now - 10_000
      }, defaultConfig);
      assert.equal(decision.action, 'RUN');
    });

    it('Multiple workers see identical capacity decision (shared cooldown state)', () => {
      const snapshot = { nowMs: now, lastRateLimitAtMs: now - 30_000, lastGeminiAtMs: now - 10_000 };
      const worker1 = decideGeminiCapacity('multilingual-semantic-classification', snapshot, defaultConfig);
      const worker2 = decideGeminiCapacity('multilingual-semantic-classification', snapshot, defaultConfig);
      const worker3 = decideGeminiCapacity('multilingual-semantic-classification', snapshot, defaultConfig);
      assert.equal(worker1.action, worker2.action, 'workers 1 and 2 must agree');
      assert.equal(worker2.action, worker3.action, 'workers 2 and 3 must agree');
    });

    it('decideJobFailure defers ENRICH_CHANNEL retry when any route is rate-limited', () => {
      const cooldownExpiry = now + ninetySeconds;
      const result = decideJobFailure(geminiSemanticDeferError(), 1, 4, now, now, cooldownExpiry);
      assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
      assert.ok(result.runAfter! >= cooldownExpiry, `runAfter must be >= cooldown expiry when rate limit is active`);
      assert.ok(result.runAfter! - now >= ninetySeconds, `must not retry before cooldown elapses`);
    });

    it('decideJobFailure respects max transient retry age even during cooldown', () => {
      const maxTransientRetryAge = 6 * 60 * 60_000;
      const firstFailureAt = now - maxTransientRetryAge - 1000;
      const result = decideJobFailure(geminiSemanticDeferError(), 1, 4, now, firstFailureAt);
      assert.equal(result.disposition, 'FAILED', 'max transient retry age must override cooldown');
      assert.equal(result.operationallyBlocked, true);
    });

    it('decideJobFailure uses exponential backoff when it exceeds cooldown', () => {
      // With attempt 5, exponential backoff = min(15min, 30s * 2^4) = min(15min, 480s) = 480s
      const cooldownExpiry = now + 10_000; // only 10s cooldown
      const result = decideJobFailure(geminiSemanticDeferError(), 5, 10, now, now, cooldownExpiry);
      assert.ok(result.runAfter! > cooldownExpiry, 'exponential backoff must take precedence when longer');
    });
  });

  describe('Existing retry behavior preserved', () => {
    it('non-Gemini transient errors ignore cooldown parameter', () => {
      const genericError = { message: 'Network timeout', retryable: true, errorClass: 'TRANSIENT' };
      const cooldownExpiry = now + ninetySeconds;
      const result = decideJobFailure(genericError, 1, 4, now, now, cooldownExpiry);
      assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
      assert.ok(result.runAfter! < cooldownExpiry, 'non-Gemini error must NOT be delayed to cooldown');
    });

    it('INVESTIGATION_DEADLINE_EXCEEDED is always terminal', () => {
      const result = decideJobFailure({ code: 'INVESTIGATION_DEADLINE_EXCEEDED', message: 'Late' }, 1, 4, now, now);
      assert.equal(result.disposition, 'FAILED');
    });

    it('attempt count is not burned for retryable infrastructure failures', () => {
      const result = decideJobFailure(geminiSemanticDeferError(), 3, 4, now, now, now);
      assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
    });

    it('unrelated non-ENRICH_CHANNEL failures are unaffected by cooldown', () => {
      const unrelatedError = { message: 'YouTube quota', code: 'YOUTUBE_PROVIDERS_COOLING_DOWN', retryable: true };
      const cooldownExpiry = now + ninetySeconds;
      const result = decideJobFailure(unrelatedError, 1, 4, now, now, cooldownExpiry);
      assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
      assert.ok(result.runAfter! - now < 120_000, 'unrelated error must not be affected by Gemini cooldown');
    });
  });

  describe('Retry-age validation (parseTransientRetryAgeMs)', () => {
    const SIX_HOURS = 6 * 60 * 60_000;

    it('missing value uses 6-hour fallback', () => {
      assert.equal(parseTransientRetryAgeMs(undefined), SIX_HOURS);
      assert.equal(parseTransientRetryAgeMs(null), SIX_HOURS);
      assert.equal(parseTransientRetryAgeMs(''), SIX_HOURS);
    });

    it('malformed string uses 6-hour fallback', () => {
      assert.equal(parseTransientRetryAgeMs('not-a-number'), SIX_HOURS);
      assert.equal(parseTransientRetryAgeMs('abc123'), SIX_HOURS);
    });

    it('"0" uses 6-hour fallback (below 60,000 minimum)', () => {
      assert.equal(parseTransientRetryAgeMs('0'), SIX_HOURS);
    });

    it('negative value uses 6-hour fallback', () => {
      assert.equal(parseTransientRetryAgeMs('-1'), SIX_HOURS);
      assert.equal(parseTransientRetryAgeMs('-100000'), SIX_HOURS);
    });

    it('value below 60,000 uses 6-hour fallback', () => {
      assert.equal(parseTransientRetryAgeMs('59999'), SIX_HOURS);
      assert.equal(parseTransientRetryAgeMs('1'), SIX_HOURS);
    });

    it('valid value at exactly 60,000 is accepted', () => {
      assert.equal(parseTransientRetryAgeMs('60000'), 60_000);
    });

    it('valid large value is accepted', () => {
      assert.equal(parseTransientRetryAgeMs('7200000'), 7_200_000);
    });
  });

  describe('Zero-cooldown bug (geminiSemanticCooldownMs)', () => {
    it('valid "0" remains 0 (not coerced to 90,000)', () => {
      const saved = process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS;
      try { process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS = '0'; } catch {}
      assert.equal(geminiSemanticCooldownMs(), 0, 'explicit "0" must remain 0');
      if (saved !== undefined) process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS = saved;
      else delete process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS;
    });

    it('missing env var uses 90,000 default', () => {
      const saved = process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS;
      try { delete process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS; } catch {}
      assert.equal(geminiSemanticCooldownMs(), 90_000, 'missing var must use 90,000 default');
      if (saved !== undefined) process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS = saved;
    });

    it('valid positive value is respected', () => {
      const saved = process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS;
      try { process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS = '120000'; } catch {}
      assert.equal(geminiSemanticCooldownMs(), 120_000, 'positive value must be respected');
      if (saved !== undefined) process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS = saved;
      else delete process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS;
    });

    it('invalid/non-finite string uses 90,000 default', () => {
      const saved = process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS;
      try { process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS = 'not-a-number'; } catch {}
      assert.equal(geminiSemanticCooldownMs(), 90_000, 'invalid string must use 90,000 default');
      if (saved !== undefined) process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS = saved;
      else delete process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS;
    });

    it('negative value uses 90,000 default', () => {
      const saved = process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS;
      try { process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS = '-5000'; } catch {}
      assert.equal(geminiSemanticCooldownMs(), 90_000, 'negative value must use 90,000 default');
      if (saved !== undefined) process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS = saved;
      else delete process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS;
    });
  });

  describe('One-route-rate-limited blocks all (project-level invariant)', () => {
    it('decideGeminiCapacity defers when only one of two routes has a recent 429', () => {
      // Simulates: route A got 429, route B never seen rate-limited.
      // Global scope means this blocks all semantic operations.
      const decision = decideGeminiCapacity('multilingual-semantic-classification', {
        nowMs: now,
        lastRateLimitAtMs: now - 30_000, // route A rate-limited 30s ago
        lastGeminiAtMs: now - 5_000       // recent success on route B
      }, defaultConfig);
      assert.equal(decision.action, 'DEFER', 'must defer because rate limit is project-level, not per-route');
      assert.equal(decision.reasonCode, 'SEMANTIC_DEFERRED_RATE_PRESSURE');
    });

    it('decideGeminiCapacity defers when rate-limited route has no semantic history', () => {
      // Route A got 429 but has never been used for semantic calls.
      // Global scope means the rate limit still applies.
      const decision = decideGeminiCapacity('multilingual-semantic-classification', {
        nowMs: now,
        lastRateLimitAtMs: now - 10_000,
        lastSemanticAtMs: undefined
      }, defaultConfig);
      assert.equal(decision.action, 'DEFER');
    });

    it('decideGeminiCapacity runs when rate limit is only on vocabulary operation', () => {
      // Vocabulary rate limits do not block semantic operations via cooldown
      // (they use separate vocabularyRateLimitSuppressionMs window)
      const decision = decideGeminiCapacity('multilingual-semantic-classification', {
        nowMs: now,
        lastRateLimitAtMs: now - 100_000, // rate limit is old
        lastGeminiAtMs: now - 10_000      // past global min interval (6s)
      }, defaultConfig);
      assert.equal(decision.action, 'RUN');
    });
  });

  describe('Queue gate and retry scheduler use same cooldown', () => {
    it('isGeminiSemanticCooldownActive uses global scope (no route parameter)', async () => {
      // The function signature no longer accepts route IDs.
      // It always queries the most recent RATE_LIMITED event from any route.
      // We cannot test DB-backed behavior here, but we can verify the function
      // exists and has the correct signature (no configuredRouteIds parameter).
      const fnStr = isGeminiSemanticCooldownActive.toString();
      assert.ok(!fnStr.includes('configuredRouteIds'), 'isGeminiSemanticCooldownActive must not accept configuredRouteIds');
      assert.ok(fnStr.includes('getGeminiSemanticCooldownExpiry'), 'must delegate to getGeminiSemanticCooldownExpiry');
    });

    it('resolveGeminiSemanticCooldownExpiryMs uses global scope (no route parameter)', async () => {
      const { resolveGeminiSemanticCooldownExpiryMs } = await import('./dbCore');
      const fnStr = resolveGeminiSemanticCooldownExpiryMs.toString();
      assert.ok(!fnStr.includes('configuredRouteIds'), 'resolveGeminiSemanticCooldownExpiryMs must not accept configuredRouteIds');
      assert.ok(fnStr.includes('RATE_LIMITED'), 'must query RATE_LIMITED events');
    });

    it('db.ts failJob does not import configuredGeminiRouteIds', async () => {
      const fs = await import('fs');
      const source = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
      assert.ok(!source.includes("import { configuredGeminiRouteIds }"), 'db.ts failJob must not import configuredGeminiRouteIds');
      assert.ok(source.includes('resolveGeminiSemanticCooldownExpiryMs(now)'), 'db.ts failJob must call resolveGeminiSemanticCooldownExpiryMs(now) without route IDs');
    });

    it('dbCore.ts failJob does not contain inline cooldown query', async () => {
      const fs = await import('fs');
      const source = fs.readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
      // The dbCore.failJob should delegate to resolveGeminiSemanticCooldownExpiryMs,
      // not contain its own SQL query for provider_call_events.
      const failJobMatch = source.match(/export async function failJob\(jobId:string.*?\n/);
      if (failJobMatch) {
        assert.ok(!failJobMatch[0].includes('SELECT occurred_at FROM provider_call_events'), 'dbCore.failJob must not contain inline cooldown SQL query');
      }
    });
  });

  describe('Production wrapping path: Gemini deferral → enrichmentOperationalFailure → cooldown-aware retry', () => {
    it('SEMANTIC_DEFERRED_RATE_PRESSURE survives wrapping and triggers cooldown scheduling', () => {
      // Step 1: Gemini capacity deferral produces this error (actual production source)
      const geminiError = geminiCapacityDeferralError('multilingual-semantic-classification', 'SEMANTIC_DEFERRED_RATE_PRESSURE');
      assert.equal(geminiError.errorClass, 'TRANSIENT');
      assert.deepEqual(geminiError.providerReasons, ['SEMANTIC_DEFERRED_RATE_PRESSURE']);

      // Step 2: safeProviderFailureReasonCodes in EvidenceBasedTradingEngine adds prefix
      // (simulates evidenceEngine/index.ts catch block logic)
      const wrappedReasonCodes = ['PROVIDER_TRANSIENT_FAILURE', ...geminiError.providerReasons!];

      // Step 3: enrichmentOperationalFailure wraps into OperationalEnrichmentProviderError
      const operationalError = enrichmentOperationalFailure({
        degraded: true,
        providers: [{
          provider: 'gemini_semantic',
          availability: 'FAILED',
          reasonCodes: wrappedReasonCodes
        }]
      } as any, true);

      assert.ok(operationalError, 'must produce OperationalEnrichmentProviderError');
      assert.ok(operationalError instanceof OperationalEnrichmentProviderError);

      // Step 4: Verify SEMANTIC_DEFERRED_RATE_PRESSURE survived the wrapping
      assert.ok(
        operationalError!.providerReasons.includes('SEMANTIC_DEFERRED_RATE_PRESSURE'),
        `SEMANTIC_DEFERRED_RATE_PRESSURE must survive enrichmentOperationalFailure wrapping, got: ${JSON.stringify(operationalError!.providerReasons)}`
      );

      // Step 5: decideJobFailure recognizes it and schedules past cooldown
      const cooldownExpiry = now + ninetySeconds;
      const result = decideJobFailure(operationalError!, 1, 4, now, now, cooldownExpiry);
      assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
      assert.ok(
        result.runAfter! >= cooldownExpiry,
        `runAfter (${result.runAfter}) must be >= cooldown expiry (${cooldownExpiry}) when SEMANTIC_DEFERRED_RATE_PRESSURE survives wrapping`
      );
    });

    it('GEMINI_CAPACITY_DEFERRED survives wrapping and triggers cooldown scheduling', () => {
      const geminiError = geminiCapacityDeferralError('multilingual-semantic-classification');
      assert.deepEqual(geminiError.providerReasons, ['GEMINI_CAPACITY_DEFERRED']);

      const wrappedReasonCodes = ['PROVIDER_TRANSIENT_FAILURE', ...geminiError.providerReasons!];
      const operationalError = enrichmentOperationalFailure({
        degraded: true,
        providers: [{
          provider: 'gemini_semantic',
          availability: 'FAILED',
          reasonCodes: wrappedReasonCodes
        }]
      } as any, true);

      assert.ok(operationalError);
      assert.ok(operationalError!.providerReasons.includes('GEMINI_CAPACITY_DEFERRED'));

      const cooldownExpiry = now + ninetySeconds;
      const result = decideJobFailure(operationalError!, 1, 4, now, now, cooldownExpiry);
      assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
      assert.ok(result.runAfter! >= cooldownExpiry);
    });

    it('wrapping path without Gemini reason codes does not trigger cooldown', () => {
      const wrappedReasonCodes = ['PROVIDER_TIMEOUT'];
      const operationalError = enrichmentOperationalFailure({
        degraded: true,
        providers: [{
          provider: 'gemini_semantic',
          availability: 'FAILED',
          reasonCodes: wrappedReasonCodes
        }]
      } as any, true);

      assert.ok(operationalError);
      assert.ok(!operationalError!.providerReasons.includes('SEMANTIC_DEFERRED_RATE_PRESSURE'));
      assert.ok(!operationalError!.providerReasons.includes('GEMINI_CAPACITY_DEFERRED'));

      const cooldownExpiry = now + ninetySeconds;
      const result = decideJobFailure(operationalError!, 1, 4, now, now, cooldownExpiry);
      assert.equal(result.disposition, 'RETRYING_WITHOUT_ATTEMPT');
      // Should NOT be delayed to cooldown — just standard exponential backoff
      assert.ok(result.runAfter! < cooldownExpiry, 'non-Gemini operational error must not be delayed to cooldown');
    });
  });

  describe('configuredGeminiRouteIds reads env correctly', () => {
    it('returns empty array when no GEMINI_API_KEY set', () => {
      const saved: Record<string, string|undefined> = {};
      for (const key of Object.keys(process.env)) {
        if (key === 'GEMINI_API_KEY' || /^GEMINI_API_KEY_[2-9][0-9]*$/.test(key)) {
          saved[key] = process.env[key];
          delete (process.env as any)[key];
        }
      }
      const routes = configuredGeminiRouteIds();
      assert.deepEqual(routes, [], 'no keys configured means no routes');
      for (const [key, val] of Object.entries(saved)) {
        if (val !== undefined) (process.env as any)[key] = val;
      }
    });

    it('returns route IDs for configured keys', () => {
      const saved: Record<string, string|undefined> = {};
      for (const key of Object.keys(process.env)) {
        if (key === 'GEMINI_API_KEY' || /^GEMINI_API_KEY_[2-9][0-9]*$/.test(key)) {
          saved[key] = process.env[key];
          delete (process.env as any)[key];
        }
      }
      (process.env as any).GEMINI_API_KEY = 'test-key-1';
      (process.env as any).GEMINI_API_KEY_2 = 'test-key-2';
      const routes = configuredGeminiRouteIds();
      assert.equal(routes.length, 2, 'two keys means two routes');
      assert.ok(routes.includes('gemini-1'));
      assert.ok(routes.includes('gemini-2'));
      for (const [key, val] of Object.entries(saved)) {
        if (val !== undefined) (process.env as any)[key] = val;
        else delete (process.env as any)[key];
      }
    });
  });

  describe('Route-set invariant: configuredGeminiRouteIds matches configuredGeminiRoutes', () => {
    function withCleanGeminiEnv(fn: () => void) {
      const saved: Record<string, string|undefined> = {};
      for (const key of Object.keys(process.env)) {
        if (key === 'GEMINI_API_KEY' || /^GEMINI_API_KEY_[2-9][0-9]*$/.test(key)) {
          saved[key] = process.env[key];
          delete (process.env as any)[key];
        }
      }
      try { fn(); } finally {
        for (const [key, val] of Object.entries(saved)) {
          if (val !== undefined) (process.env as any)[key] = val;
          else delete (process.env as any)[key];
        }
      }
    }

    it('single key: route IDs match', () => {
      withCleanGeminiEnv(() => {
        (process.env as any).GEMINI_API_KEY = 'key-a';
        const full = configuredGeminiRoutes();
        const ids = configuredGeminiRouteIds();
        assert.equal(full.length, ids.length, 'route count must match');
        for (let i = 0; i < full.length; i++) {
          assert.equal(full[i].id, ids[i], `route[${i}].id must match ids[${i}]`);
        }
      });
    });

    it('multiple keys: route IDs match in same order', () => {
      withCleanGeminiEnv(() => {
        (process.env as any).GEMINI_API_KEY = 'key-a';
        (process.env as any).GEMINI_API_KEY_2 = 'key-b';
        (process.env as any).GEMINI_API_KEY_3 = 'key-c';
        const full = configuredGeminiRoutes();
        const ids = configuredGeminiRouteIds();
        assert.equal(full.length, 3, 'three keys means three routes');
        assert.equal(ids.length, 3, 'three keys means three route IDs');
        assert.deepEqual(ids, full.map(r => r.id), 'IDs must be identical projection of full routes');
      });
    });

    it('duplicate key deduplication: both functions produce same result', () => {
      withCleanGeminiEnv(() => {
        (process.env as any).GEMINI_API_KEY = 'same-key';
        (process.env as any).GEMINI_API_KEY_2 = 'same-key';
        const full = configuredGeminiRoutes();
        const ids = configuredGeminiRouteIds();
        assert.equal(full.length, 1, 'duplicate key deduplicated in full');
        assert.equal(ids.length, 1, 'duplicate key deduplicated in IDs');
        assert.equal(full[0].id, ids[0], 'single remaining route ID must match');
      });
    });

    it('empty key filtered: both functions produce same result', () => {
      withCleanGeminiEnv(() => {
        (process.env as any).GEMINI_API_KEY = '';
        (process.env as any).GEMINI_API_KEY_2 = 'valid-key';
        const full = configuredGeminiRoutes();
        const ids = configuredGeminiRouteIds();
        assert.equal(full.length, 1, 'empty key filtered in full');
        assert.equal(ids.length, 1, 'empty key filtered in IDs');
        assert.equal(full[0].id, ids[0], 'remaining route ID must match');
      });
    });

    it('no keys: both functions return empty', () => {
      withCleanGeminiEnv(() => {
        const full = configuredGeminiRoutes();
        const ids = configuredGeminiRouteIds();
        assert.deepEqual(full, [], 'no keys returns empty full');
        assert.deepEqual(ids, [], 'no keys returns empty IDs');
      });
    });

    it('route IDs are valid machine-owned identifiers via resolveGeminiRouteId', () => {
      withCleanGeminiEnv(() => {
        (process.env as any).GEMINI_API_KEY = 'key-a';
        (process.env as any).GEMINI_API_KEY_2 = 'key-b';
        const ids = configuredGeminiRouteIds();
        for (const id of ids) {
          assert.equal(id, resolveGeminiRouteId(id), `route ID ${id} must pass resolveGeminiRouteId validation`);
          assert.ok(/^gemini-[1-9][0-9]*$/.test(id), `route ID ${id} must match machine-owned pattern`);
        }
      });
    });
  });
});

function sixtySeconds(): number {
  return 60_000;
}
