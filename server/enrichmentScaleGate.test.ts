import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_ENRICHMENT_SCALE_METRICS_TIMEOUT_MS,
  DEFAULT_ENRICHMENT_SCALE_METRICS_WINDOW_HOURS,
  DEFAULT_ENRICHMENT_SCALE_THRESHOLDS,
  ENRICHMENT_WORKER_BASELINE,
  ENRICHMENT_WORKER_SCALE_CEILING,
  enrichmentScaleMetricsTimeoutMs,
  enrichmentScaleMetricsWindowHours,
  enrichmentScaleThresholds,
  evaluateBacklogStability,
  evaluateEnrichmentScaleGate,
  loadEnrichmentScaleMetrics,
  loadEnrichmentScaleMetricsWithinDeadline,
  semanticScaleGateProvider,
  type EnrichmentScaleMetrics,
} from './enrichmentScaleGate';

const healthy: EnrichmentScaleMetrics = {
  semanticWindowHours: 2,
  semanticCalls: 200,
  semanticSuccesses: 190,
  semanticSuccessRate: 0.95,
  semanticP95LatencyMs: 12_000,
  pendingEnrichmentJobs: 20,
  enrichmentCreatedLastHour: 10,
  enrichmentCompletedLastHour: 12,
  backlogStable: true,
  measuredAt: new Date(0).toISOString(),
};

test('baseline stays exactly 3 and is never gated', () => {
  const decision = evaluateEnrichmentScaleGate(undefined, DEFAULT_ENRICHMENT_SCALE_THRESHOLDS, ENRICHMENT_WORKER_BASELINE);
  assert.equal(decision.allowed, true);
  assert.equal(decision.effectiveWorkers, 3);
  assert.deepEqual(decision.reasons, ['BASELINE_REQUEST']);
});

test('healthy measured service permits 6 workers', () => {
  const decision = evaluateEnrichmentScaleGate(healthy, DEFAULT_ENRICHMENT_SCALE_THRESHOLDS, 6);
  assert.equal(decision.allowed, true);
  assert.equal(decision.effectiveWorkers, 6);
  assert.deepEqual(decision.reasons, ['MEASURED_SCALE_GATE_PASSED']);
});

test('the success-rate threshold is strict (>90%)', () => {
  const decision = evaluateEnrichmentScaleGate({ ...healthy, semanticSuccessRate: 0.9 }, DEFAULT_ENRICHMENT_SCALE_THRESHOLDS, 6);
  assert.equal(decision.allowed, false);
  assert.equal(decision.effectiveWorkers, ENRICHMENT_WORKER_BASELINE);
  assert.ok(decision.reasons.includes('SEMANTIC_SUCCESS_RATE_NOT_ABOVE_THRESHOLD'));
});

test('the p95 threshold is strict (<30s)', () => {
  const decision = evaluateEnrichmentScaleGate({ ...healthy, semanticP95LatencyMs: 30_000 }, DEFAULT_ENRICHMENT_SCALE_THRESHOLDS, 6);
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes('SEMANTIC_P95_NOT_BELOW_THRESHOLD'));
});

test('unstable backlog, excess pending work, and thin samples all block scale', () => {
  const unstable = evaluateEnrichmentScaleGate({ ...healthy, backlogStable: false }, DEFAULT_ENRICHMENT_SCALE_THRESHOLDS, 6);
  assert.ok(unstable.reasons.includes('ENRICHMENT_BACKLOG_NOT_STABLE'));
  const pending = evaluateEnrichmentScaleGate({ ...healthy, pendingEnrichmentJobs: 501 }, DEFAULT_ENRICHMENT_SCALE_THRESHOLDS, 6);
  assert.ok(pending.reasons.includes('ENRICHMENT_BACKLOG_NOT_STABLE'));
  const thin = evaluateEnrichmentScaleGate({ ...healthy, semanticCalls: 49 }, DEFAULT_ENRICHMENT_SCALE_THRESHOLDS, 6);
  assert.ok(thin.reasons.includes('INSUFFICIENT_SEMANTIC_SAMPLE'));
});

test('missing measurements fail closed at baseline', () => {
  const decision = evaluateEnrichmentScaleGate(undefined, DEFAULT_ENRICHMENT_SCALE_THRESHOLDS, 6);
  assert.equal(decision.allowed, false);
  assert.equal(decision.effectiveWorkers, 3);
  assert.deepEqual(decision.reasons, ['SCALE_METRICS_UNAVAILABLE']);
});

test('backlog stability is behaviorally below-threshold on the creation/completion ratio', () => {
  // Fewer completions than 90% of creations is unstable.
  assert.equal(evaluateBacklogStability(10, 8, 20), false);
  assert.equal(evaluateBacklogStability(10, 9, 20), true);
  // No creations: stability is the pending cap.
  assert.equal(evaluateBacklogStability(0, 0, 500), true);
  assert.equal(evaluateBacklogStability(0, 0, 501), false);
  const decision = evaluateEnrichmentScaleGate({ ...healthy, enrichmentCreatedLastHour: 10, enrichmentCompletedLastHour: 8, backlogStable: false }, DEFAULT_ENRICHMENT_SCALE_THRESHOLDS, 6);
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes('ENRICHMENT_BACKLOG_NOT_STABLE'));
});

test('the metrics loader derives stability from the shared ratio helper', () => {
  const source = readFileSync('server/enrichmentScaleGate.ts', 'utf8');
  assert.match(source, /const backlogStable = evaluateBacklogStability\(createdLastHour, completedLastHour, pending, thresholds\)/);
});

test('an allowed request is capped at the approved ceiling of 6', () => {
  const decision = evaluateEnrichmentScaleGate(healthy, DEFAULT_ENRICHMENT_SCALE_THRESHOLDS, 12);
  assert.equal(decision.allowed, true);
  assert.equal(decision.effectiveWorkers, ENRICHMENT_WORKER_SCALE_CEILING);
});

test('the operator rollback switch restores explicit concurrency', () => {
  const decision = evaluateEnrichmentScaleGate(undefined, DEFAULT_ENRICHMENT_SCALE_THRESHOLDS, 6, { ENRICHMENT_SCALE_GATE_ENABLED: 'false' } as any);
  assert.equal(decision.allowed, true);
  assert.equal(decision.effectiveWorkers, 6);
  assert.deepEqual(decision.reasons, ['SCALE_GATE_DISABLED']);
});

test('thresholds are environment-tunable and reject invalid values', () => {
  const parsed = enrichmentScaleThresholds({
    ENRICHMENT_SCALE_MIN_SUCCESS_RATE: '0.95',
    ENRICHMENT_SCALE_MAX_P95_MS: '20000',
    ENRICHMENT_SCALE_MIN_SAMPLE: '100',
    ENRICHMENT_SCALE_MAX_PENDING: '100',
    ENRICHMENT_SCALE_MIN_COMPLETION_RATIO: '0.8',
  } as any);
  assert.deepEqual(parsed, { minSuccessRate: 0.95, maxP95LatencyMs: 20_000, minSemanticSample: 100, maxPendingEnrichmentJobs: 100, minCompletionToCreationRatio: 0.8 });
  assert.deepEqual(enrichmentScaleThresholds({ ENRICHMENT_SCALE_MIN_SUCCESS_RATE: 'garbage' } as any), DEFAULT_ENRICHMENT_SCALE_THRESHOLDS);
});

test('thresholds ignore blank and non-numeric env values', () => {
  assert.deepEqual(enrichmentScaleThresholds({ ENRICHMENT_SCALE_MIN_SUCCESS_RATE: '' } as any), DEFAULT_ENRICHMENT_SCALE_THRESHOLDS);
  assert.deepEqual(enrichmentScaleThresholds({ ENRICHMENT_SCALE_MIN_SUCCESS_RATE: 'not-a-number' } as any), DEFAULT_ENRICHMENT_SCALE_THRESHOLDS);
});

test('percent-style rate thresholds fall back instead of silently blocking scale', () => {
  assert.deepEqual(enrichmentScaleThresholds({
    ENRICHMENT_SCALE_MIN_SUCCESS_RATE: '90',
    ENRICHMENT_SCALE_MIN_COMPLETION_RATIO: '80',
  } as any), DEFAULT_ENRICHMENT_SCALE_THRESHOLDS);
  // Explicit endpoints are valid fractions.
  assert.equal(enrichmentScaleThresholds({ ENRICHMENT_SCALE_MIN_SUCCESS_RATE: '1' } as any).minSuccessRate, 1);
  assert.equal(enrichmentScaleThresholds({ ENRICHMENT_SCALE_MIN_COMPLETION_RATIO: '0' } as any).minCompletionToCreationRatio, 0);
});

test('scale gate mirrors classification provider routing', () => {
  assert.equal(semanticScaleGateProvider({} as any), 'gemini');
  assert.equal(semanticScaleGateProvider({ SEMANTIC_PROVIDER: 'gemini' } as any), 'gemini');
  assert.equal(semanticScaleGateProvider({ SEMANTIC_PROVIDER: 'gemini-free', GEMINI_FREE_API_KEY: 'k' } as any), 'gemini-free');
  assert.equal(semanticScaleGateProvider({ SEMANTIC_PROVIDER: 'groq', GROQ_API_KEY: 'k' } as any), 'groq');
  assert.equal(semanticScaleGateProvider({ SEMANTIC_PROVIDER: 'unknown' } as any), 'gemini');
  assert.equal(semanticScaleGateProvider({ SEMANTIC_PROVIDER: 'GROQ', GROQ_API_KEY: 'k' } as any), 'gemini',
    'runtime routing is exact-case; the gate must not normalize it');
  assert.equal(semanticScaleGateProvider({ SEMANTIC_PROVIDER: 'groq' } as any), 'gemini',
    'a selected provider without a configured route falls back to Gemini');
  assert.equal(semanticScaleGateProvider({ SEMANTIC_PROVIDER: 'gemini-free' } as any), 'gemini');
  assert.equal(semanticScaleGateProvider({ SEMANTIC_PROVIDER: 'groq', GROQ_API_KEY: 'k', SEMANTIC_PROVIDER_FORCE_GEMINI: 'true' } as any), 'gemini');
});

test('metrics queries inherit the live deadline and abort signal', async () => {
  const controller = new AbortController();
  const deadlineAtMs = Date.now() + 1_000;
  const seen: Array<{ query_timeout: number; signal?: AbortSignal }> = [];
  await loadEnrichmentScaleMetrics(0, { ENRICHMENT_SCALE_METRICS_TIMEOUT_MS: '5000' } as any, {
    signal: controller.signal,
    deadlineAtMs,
    query: async config => {
      seen.push({ query_timeout: config.query_timeout, signal: config.signal });
      return { rows: [{}] };
    },
  });
  assert.equal(seen.length, 3);
  for (const query of seen) {
    assert.equal(query.signal, controller.signal);
    assert.ok(query.query_timeout > 0 && query.query_timeout <= 1_000, `expected a live-deadline budget, got ${query.query_timeout}`);
  }
});

test('the gate resolves configured thresholds when callers omit them', () => {
  const decision = evaluateEnrichmentScaleGate(
    { ...healthy, semanticSuccessRate: 0.95 },
    undefined,
    6,
    { ENRICHMENT_SCALE_MIN_SUCCESS_RATE: '0.99' } as any,
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.thresholds.minSuccessRate, 0.99);
  assert.ok(decision.reasons.includes('SEMANTIC_SUCCESS_RATE_NOT_ABOVE_THRESHOLD'));
});

test('the disabled rollback still never exceeds the approved ceiling of 6', () => {
  const decision = evaluateEnrichmentScaleGate(undefined, undefined, 12, { ENRICHMENT_SCALE_GATE_ENABLED: 'false' } as any);
  assert.equal(decision.allowed, true);
  assert.equal(decision.effectiveWorkers, ENRICHMENT_WORKER_SCALE_CEILING);
});

test('worker startup routes every above-baseline request through the measured gate and split', () => {
  const source = readFileSync('server/queueManager.ts', 'utf8');
  assert.match(source, /void startGatedEnrichmentWorkers\(\)/);
  assert.match(source, /requested > ENRICHMENT_WORKER_BASELINE && enrichmentScaleGateEnabled\(\)/);
  assert.match(source, /evaluateEnrichmentScaleGate\(metrics, enrichmentScaleThresholds\(\), requested\)/);
  assert.match(source, /resolveEnrichmentWorkerSplit\(Math\.min\(ENRICHMENT_WORKER_SCALE_CEILING, effectiveWorkers\), decoupling\.enabled\)/);
  assert.match(source, /setRunningEnrichmentWorkerCount\(/);
  assert.match(source, /startEnrichmentWorkerLanes\(enrichmentSplit\)/);
});

test('diagnostics separate the live decision from the running worker count', () => {
  const source = readFileSync('server/enrichmentBacklogDiagnostics.ts', 'utf8');
  assert.match(source, /runningWorkers:getRunningEnrichmentWorkerCount\(\)/);
  assert.match(source, /liveDecision:true/);
  assert.match(source, /evaluateEnrichmentScaleGate\(metrics,thresholds,requestedWorkers\)/);
  assert.match(source, /evaluateEnrichmentScaleGate\(undefined,thresholds,requestedWorkers\)/);
});

test('the disabled gate skips the metrics load entirely', () => {
  const source = readFileSync('server/queueManager.ts', 'utf8');
  assert.match(source, /requested > ENRICHMENT_WORKER_BASELINE && enrichmentScaleGateEnabled\(\)/);
  const disabledBranch = source.slice(source.indexOf('async function startGatedEnrichmentWorkers'));
  assert.ok(disabledBranch.indexOf('enrichmentScaleGateEnabled()') < disabledBranch.indexOf('loadEnrichmentScaleMetricsWithinDeadline()'));
});

test('startup uses the deadline-bounded metrics loader', () => {
  const source = readFileSync('server/queueManager.ts', 'utf8');
  assert.match(source, /metrics = await loadEnrichmentScaleMetricsWithinDeadline\(\)/);
  assert.doesNotMatch(source, /metrics = await loadEnrichmentScaleMetrics\(\)/);
});

test('the metrics deadline defaults safely and clamps explicit values', () => {
  assert.equal(DEFAULT_ENRICHMENT_SCALE_METRICS_TIMEOUT_MS, 5_000);
  assert.equal(enrichmentScaleMetricsTimeoutMs({} as any), 5_000);
  assert.equal(enrichmentScaleMetricsTimeoutMs({ ENRICHMENT_SCALE_METRICS_TIMEOUT_MS: '' } as any), 5_000);
  assert.equal(enrichmentScaleMetricsTimeoutMs({ ENRICHMENT_SCALE_METRICS_TIMEOUT_MS: 'nonsense' } as any), 5_000);
  assert.equal(enrichmentScaleMetricsTimeoutMs({ ENRICHMENT_SCALE_METRICS_TIMEOUT_MS: '-1' } as any), 5_000);
  assert.equal(enrichmentScaleMetricsTimeoutMs({ ENRICHMENT_SCALE_METRICS_TIMEOUT_MS: '10' } as any), 250);
  assert.equal(enrichmentScaleMetricsTimeoutMs({ ENRICHMENT_SCALE_METRICS_TIMEOUT_MS: '999999' } as any), 60_000);
});

test('scale-gate health window defaults to two hours and stays operator-bounded', () => {
  assert.equal(DEFAULT_ENRICHMENT_SCALE_METRICS_WINDOW_HOURS, 2);
  assert.equal(enrichmentScaleMetricsWindowHours({} as any), 2);
  assert.equal(enrichmentScaleMetricsWindowHours({ ENRICHMENT_SCALE_METRICS_WINDOW_HOURS: '' } as any), 2);
  assert.equal(enrichmentScaleMetricsWindowHours({ ENRICHMENT_SCALE_METRICS_WINDOW_HOURS: 'nonsense' } as any), 2);
  assert.equal(enrichmentScaleMetricsWindowHours({ ENRICHMENT_SCALE_METRICS_WINDOW_HOURS: '0' } as any), 2);
  assert.equal(enrichmentScaleMetricsWindowHours({ ENRICHMENT_SCALE_METRICS_WINDOW_HOURS: '25' } as any), 2);
  assert.equal(enrichmentScaleMetricsWindowHours({ ENRICHMENT_SCALE_METRICS_WINDOW_HOURS: '4' } as any), 4);
  assert.equal(enrichmentScaleMetricsWindowHours({ ENRICHMENT_SCALE_METRICS_WINDOW_HOURS: '1.5' } as any), 1.5);
  assert.equal(enrichmentScaleMetricsWindowHours({ ENRICHMENT_SCALE_METRICS_WINDOW_HOURS: '24' } as any), 24);
});

test('every scale-metrics query carries the configured query timeout', async () => {
  const seen: number[] = [];
  const statements: string[] = [];
  const metrics = await loadEnrichmentScaleMetrics(0, { ENRICHMENT_SCALE_METRICS_TIMEOUT_MS: '1500' } as any, {
    query: async config => {
      seen.push(config.query_timeout);
      statements.push(config.text);
      const call = seen.length;
      if (call === 1) return { rows: [{ calls: 100, successes: 95, p95: 9000 }] };
      if (call === 2) return { rows: [{ pending: 20 }] };
      return { rows: [{ created_last_hour: 10, completed_last_hour: 10 }] };
    },
  });
  assert.deepEqual(seen, [1500, 1500, 1500]);
  assert.match(statements[0], /provider = 'gemini'/, 'only the active classification provider may enter the scale gate');
  assert.match(statements[0], /geminiScaleGateDeferral/, 'reason-coded capacity deferrals must not count as semantic failures');
  assert.doesNotMatch(statements[0], /geminiCapacityDeferral/, 'lock-wait contention must stay in the scale-gate denominator');
  assert.match(statements[0], /groqCooldownDeferral/, 'local Groq cooldown deferrals must not count as semantic failures');
  assert.match(statements[0], /geminiFreeCooldownDeferral/, 'local free-Gemini deferrals must not count as semantic failures');
  assert.match(statements[0], /COALESCE\(request_metadata->>'providerReasons',''\) NOT LIKE '%SEMANTIC_DEFERRED_RATE_PRESSURE%'/, 'local semantic deferrals must be excluded, not merely named');
  assert.match(statements[0], /COALESCE\(request_metadata->>'providerReasons',''\) NOT LIKE '%VOCABULARY_DEFERRED_RATE_PRESSURE%'/, 'local vocabulary deferrals must be excluded, not merely named');
  assert.match(statements[0], /now\(\) - \(2 \* interval '1 hour'\)/, 'the gate must measure recent provider health, not a full day of stale failures');
  assert.equal(metrics.semanticWindowHours, 2);
  assert.equal(metrics.semanticCalls, 100);
  assert.equal(metrics.semanticSuccesses, 95);
  assert.equal(metrics.backlogStable, true);
});

test('scale-gate health window can be widened for sparse traffic', async () => {
  const statements: string[] = [];
  let call = 0;
  await loadEnrichmentScaleMetrics(0, {
    ENRICHMENT_SCALE_METRICS_WINDOW_HOURS: '4',
    ENRICHMENT_SCALE_METRICS_TIMEOUT_MS: '1500',
  } as any, {
    query: async config => {
      statements.push(config.text);
      call += 1;
      if (call === 1) return { rows: [{ calls: 10, successes: 9, p95: 1000 }] };
      if (call === 2) return { rows: [{ pending: 1 }] };
      return { rows: [{ created_last_hour: 1, completed_last_hour: 1 }] };
    },
  });
  assert.match(statements[0], /now\(\) - \(4 \* interval '1 hour'\)/);
});

test('fractional health windows reach the provider query unchanged', async () => {
  const statements: string[] = [];
  let call = 0;
  const metrics = await loadEnrichmentScaleMetrics(0, {
    ENRICHMENT_SCALE_METRICS_WINDOW_HOURS: '1.5',
    ENRICHMENT_SCALE_METRICS_TIMEOUT_MS: '1500',
  } as any, {
    query: async config => {
      statements.push(config.text);
      call += 1;
      if (call === 1) return { rows: [{ calls: 10, successes: 9, p95: 1000 }] };
      if (call === 2) return { rows: [{ pending: 1 }] };
      return { rows: [{ created_last_hour: 1, completed_last_hour: 1 }] };
    },
  });
  assert.match(statements[0], /now\(\) - \(1\.5 \* interval '1 hour'\)/);
  assert.equal(metrics.semanticWindowHours, 1.5);
});

test('metrics query follows an explicitly configured non-default provider', async () => {
  const statements: string[] = [];
  let call = 0;
  await loadEnrichmentScaleMetrics(0, {
    SEMANTIC_PROVIDER: 'groq',
    GROQ_API_KEY: 'test-key',
    ENRICHMENT_SCALE_METRICS_TIMEOUT_MS: '1500',
  } as any, {
    query: async config => {
      statements.push(config.text);
      call += 1;
      if (call === 1) return { rows: [{ calls: 10, successes: 9, p95: 1000 }] };
      if (call === 2) return { rows: [{ pending: 1 }] };
      return { rows: [{ created_last_hour: 1, completed_last_hour: 1 }] };
    },
  });
  assert.match(statements[0], /provider = 'groq'/);
});

test('a stalled metrics load resolves at the deadline so startup can use baseline', async () => {
  const started = Date.now();
  let signal: AbortSignal | undefined;
  const metrics = await loadEnrichmentScaleMetricsWithinDeadline(
    0,
    { ENRICHMENT_SCALE_METRICS_TIMEOUT_MS: '50' } as any,
    (loadSignal?: AbortSignal) => {
      signal = loadSignal;
      return new Promise<EnrichmentScaleMetrics>(() => {});
    },
  );
  const elapsed = Date.now() - started;
  assert.equal(metrics, undefined);
  // The 50 ms input clamps to the 250 ms floor. Keep the assertion close
  // enough to that deadline that a multi-second regression cannot pass.
  assert.ok(elapsed >= 240, `expected at least the 250 ms deadline, got ${elapsed} ms`);
  assert.ok(elapsed < 1_500, `expected the wrapper to settle near 250 ms, got ${elapsed} ms`);
  assert.equal(signal?.aborted, true, 'the deadline must cancel in-flight metrics work');
});

test('a completed metrics load is returned by the deadline wrapper', async () => {
  const metrics = await loadEnrichmentScaleMetricsWithinDeadline(
    0,
    { ENRICHMENT_SCALE_METRICS_TIMEOUT_MS: '5000' } as any,
    async () => ({ ...healthy }),
  );
  assert.equal(metrics?.semanticCalls, healthy.semanticCalls);
});
