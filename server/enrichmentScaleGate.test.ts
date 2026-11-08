import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_ENRICHMENT_SCALE_THRESHOLDS,
  ENRICHMENT_WORKER_BASELINE,
  ENRICHMENT_WORKER_SCALE_CEILING,
  enrichmentScaleThresholds,
  evaluateBacklogStability,
  evaluateEnrichmentScaleGate,
  type EnrichmentScaleMetrics,
} from './enrichmentScaleGate';

const healthy: EnrichmentScaleMetrics = {
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
  assert.match(source, /startWorkerPool\('ENRICH_CHANNEL', enrichmentSplit\.classificationWorkers/);
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
  assert.ok(disabledBranch.indexOf('enrichmentScaleGateEnabled()') < disabledBranch.indexOf('loadEnrichmentScaleMetrics()'));
});
