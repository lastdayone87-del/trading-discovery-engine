/**
 * Phase 4 enrichment scale gate.
 *
 * The approved policy permits raising enrichment concurrency from 3 to 6
 * only when measured semantic service is healthy:
 *   - success rate > 90%
 *   - p95 semantic latency < 30s
 *   - enrichment backlog stable
 *
 * Defaults stay at 3. `ENRICHMENT_WORKER_CONCURRENCY` may request more, but
 * startup clamps the request through this gate unless the operator explicitly
 * disables it (`ENRICHMENT_SCALE_GATE_ENABLED=false`).
 */
export const ENRICHMENT_SCALE_GATE_VERSION = 'enrichment-scale-gate-v1';
export const ENRICHMENT_WORKER_BASELINE = 3;
export const ENRICHMENT_WORKER_SCALE_CEILING = 6;

export interface EnrichmentScaleMetrics {
  semanticCalls: number;
  semanticSuccesses: number;
  semanticSuccessRate: number;
  semanticP95LatencyMs: number;
  pendingEnrichmentJobs: number;
  enrichmentCreatedLastHour: number;
  enrichmentCompletedLastHour: number;
  backlogStable: boolean;
  measuredAt: string;
}

export interface EnrichmentScaleThresholds {
  minSuccessRate: number;
  maxP95LatencyMs: number;
  minSemanticSample: number;
  maxPendingEnrichmentJobs: number;
  minCompletionToCreationRatio: number;
}

export interface EnrichmentScaleDecision {
  allowed: boolean;
  requestedWorkers: number;
  effectiveWorkers: number;
  reasons: string[];
  metrics?: EnrichmentScaleMetrics;
  thresholds: EnrichmentScaleThresholds;
  gateVersion: string;
}

export const DEFAULT_ENRICHMENT_SCALE_THRESHOLDS: EnrichmentScaleThresholds = {
  minSuccessRate: 0.9,
  maxP95LatencyMs: 30_000,
  minSemanticSample: 50,
  maxPendingEnrichmentJobs: 500,
  minCompletionToCreationRatio: 0.9,
};

export function enrichmentScaleThresholds(env: NodeJS.ProcessEnv = process.env): EnrichmentScaleThresholds {
  const number = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    minSuccessRate: number('ENRICHMENT_SCALE_MIN_SUCCESS_RATE', DEFAULT_ENRICHMENT_SCALE_THRESHOLDS.minSuccessRate),
    maxP95LatencyMs: number('ENRICHMENT_SCALE_MAX_P95_MS', DEFAULT_ENRICHMENT_SCALE_THRESHOLDS.maxP95LatencyMs),
    minSemanticSample: number('ENRICHMENT_SCALE_MIN_SAMPLE', DEFAULT_ENRICHMENT_SCALE_THRESHOLDS.minSemanticSample),
    maxPendingEnrichmentJobs: number('ENRICHMENT_SCALE_MAX_PENDING', DEFAULT_ENRICHMENT_SCALE_THRESHOLDS.maxPendingEnrichmentJobs),
    minCompletionToCreationRatio: number('ENRICHMENT_SCALE_MIN_COMPLETION_RATIO', DEFAULT_ENRICHMENT_SCALE_THRESHOLDS.minCompletionToCreationRatio),
  };
}

export function enrichmentScaleGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENRICHMENT_SCALE_GATE_ENABLED !== 'false';
}

/**
 * Backlog stability from the one-hour creation/completion counters. Extracted
 * so the below-threshold case is behaviorally testable without a database.
 */
export function evaluateBacklogStability(
  createdLastHour: number,
  completedLastHour: number,
  pending: number,
  thresholds: EnrichmentScaleThresholds = DEFAULT_ENRICHMENT_SCALE_THRESHOLDS,
): boolean {
  return createdLastHour === 0
    ? pending <= thresholds.maxPendingEnrichmentJobs
    : completedLastHour >= createdLastHour * thresholds.minCompletionToCreationRatio;
}

/**
 * The worker count actually started in this process. Startup records it after
 * the gate and classification split, so diagnostics can distinguish the live
 * what-if decision from the running pool.
 */
let runningEnrichmentWorkerCount = 0;

export function setRunningEnrichmentWorkerCount(count: number): void {
  runningEnrichmentWorkerCount = Math.max(0, Math.floor(Number(count) || 0));
}

export function getRunningEnrichmentWorkerCount(): number {
  return runningEnrichmentWorkerCount;
}

export function resetRunningEnrichmentWorkerCountForTests(): void {
  runningEnrichmentWorkerCount = 0;
}

export function evaluateEnrichmentScaleGate(
  metrics: EnrichmentScaleMetrics | undefined,
  thresholds?: EnrichmentScaleThresholds,
  requestedWorkers: number = ENRICHMENT_WORKER_BASELINE,
  env: NodeJS.ProcessEnv = process.env,
): EnrichmentScaleDecision {
  const requested = Math.max(1, Math.floor(Number(requestedWorkers) || ENRICHMENT_WORKER_BASELINE));
  // Resolve here, not only in callers: startup, diagnostics, and tests all
  // must honor the operator's configured thresholds when they omit the arg.
  const resolvedThresholds = thresholds ?? enrichmentScaleThresholds(env);
  const base = {
    requestedWorkers: requested,
    metrics,
    thresholds: resolvedThresholds,
    gateVersion: ENRICHMENT_SCALE_GATE_VERSION,
  };
  if (!enrichmentScaleGateEnabled(env)) {
    // The documented hard ceiling is not a gate decision: a rollback restores
    // the explicit request, still bounded by the approved maximum.
    return {
      ...base,
      allowed: true,
      effectiveWorkers: Math.min(ENRICHMENT_WORKER_SCALE_CEILING, requested),
      reasons: ['SCALE_GATE_DISABLED'],
    };
  }
  if (requested <= ENRICHMENT_WORKER_BASELINE) {
    return { ...base, allowed: true, effectiveWorkers: requested, reasons: ['BASELINE_REQUEST'] };
  }
  const reasons: string[] = [];
  if (!metrics) {
    reasons.push('SCALE_METRICS_UNAVAILABLE');
  } else {
    if (metrics.semanticCalls < resolvedThresholds.minSemanticSample) reasons.push('INSUFFICIENT_SEMANTIC_SAMPLE');
    if (!(metrics.semanticSuccessRate > resolvedThresholds.minSuccessRate)) reasons.push('SEMANTIC_SUCCESS_RATE_NOT_ABOVE_THRESHOLD');
    if (!(metrics.semanticP95LatencyMs < resolvedThresholds.maxP95LatencyMs)) reasons.push('SEMANTIC_P95_NOT_BELOW_THRESHOLD');
    if (!metrics.backlogStable || metrics.pendingEnrichmentJobs > resolvedThresholds.maxPendingEnrichmentJobs) reasons.push('ENRICHMENT_BACKLOG_NOT_STABLE');
  }
  const allowed = reasons.length === 0;
  return {
    ...base,
    allowed,
    effectiveWorkers: allowed ? Math.min(ENRICHMENT_WORKER_SCALE_CEILING, Math.max(ENRICHMENT_WORKER_BASELINE, requested)) : ENRICHMENT_WORKER_BASELINE,
    reasons: allowed ? ['MEASURED_SCALE_GATE_PASSED'] : reasons,
  };
}

/**
 * Read the measured inputs from the durable ledgers. Any database failure is
 * the caller's signal to stay at baseline; it never authorizes scale.
 */
export async function loadEnrichmentScaleMetrics(nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<EnrichmentScaleMetrics> {
  const { getDb } = await import('./db');
  const db = await getDb();
  const thresholds = enrichmentScaleThresholds(env);
  const [provider, backlog, throughput] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE status='SUCCESS')::int AS successes,
         COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
           FILTER (WHERE status='SUCCESS'),0) AS p95
       FROM provider_call_events
       WHERE operation='multilingual-semantic-classification'
         AND occurred_at > now() - interval '24 hours'
         AND status <> 'CANCELLED'`
    ),
    db.query(
      `SELECT COUNT(*)::int AS pending
       FROM jobs
       WHERE type='ENRICH_CHANNEL' AND status IN ('PENDING','PROCESSING')`
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS created_last_hour,
         COUNT(*) FILTER (WHERE completed_at > now() - interval '1 hour' AND status='COMPLETED')::int AS completed_last_hour
       FROM jobs
       WHERE type='ENRICH_CHANNEL'
         AND (created_at > now() - interval '1 hour' OR completed_at > now() - interval '1 hour')`
    ),
  ]);
  const calls = Number(provider.rows[0]?.calls || 0);
  const successes = Number(provider.rows[0]?.successes || 0);
  const createdLastHour = Number(throughput.rows[0]?.created_last_hour || 0);
  const completedLastHour = Number(throughput.rows[0]?.completed_last_hour || 0);
  const pending = Number(backlog.rows[0]?.pending || 0);
  const backlogStable = evaluateBacklogStability(createdLastHour, completedLastHour, pending, thresholds);
  return {
    semanticCalls: calls,
    semanticSuccesses: successes,
    semanticSuccessRate: calls > 0 ? successes / calls : 0,
    semanticP95LatencyMs: Number(provider.rows[0]?.p95 || 0),
    pendingEnrichmentJobs: pending,
    enrichmentCreatedLastHour: createdLastHour,
    enrichmentCompletedLastHour: completedLastHour,
    backlogStable,
    measuredAt: new Date(nowMs).toISOString(),
  };
}
