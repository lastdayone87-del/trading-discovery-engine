import { effectiveBenchmarkKnobs } from './benchmarkPreregV1';

/**
 * Non-frozen benchmark capacity guard (see
 * docs/operations-capacity-defaults.md). server/benchmarkPreregV1.ts is
 * frozen with queue-depth fallback '15' while the runtime default is 30, and
 * drift detection resolves plan and execute through the same frozen table —
 * so it cannot catch a fallback-governed record. This guard fails a benchmark
 * BEFORE plan creation or execution unless the record will evidence depth 30
 * via an explicit database/environment value. It only READS the frozen
 * resolver; the frozen contract is never modified.
 */

/** Queue depth every benchmark record must evidence (production database value). */
export const BENCHMARK_REQUIRED_QUEUE_DEPTH = 30;

export function resolveBenchmarkQueueDepth(
  settings: Record<string, string>,
  env: Record<string, string | undefined> = process.env
): { resolved: string; explicit: boolean } {
  const resolved = effectiveBenchmarkKnobs(settings, env).discovery_target_queue_depth;
  const explicit =
    (settings['discovery_target_queue_depth'] ?? '') !== '' ||
    (env['DISCOVERY_TARGET_QUEUE_DEPTH'] ?? '') !== '';
  return { resolved, explicit };
}

/**
 * Live guard for the --plan and --execute paths of
 * scripts/runBenchmarkPreregV1.ts. Passes only when the frozen resolution
 * evidences exactly 30 (which, given the frozen '15' fallback, proves an
 * explicit database/environment value). Throws BENCHMARK_QUEUE_DEPTH_UNESTABLISHED
 * otherwise, before any snapshot, file, or status mutation.
 */
export function assertBenchmarkQueueDepthEstablished(
  settings: Record<string, string>,
  env: Record<string, string | undefined>,
  phase: 'plan' | 'execute'
): void {
  const { resolved, explicit } = resolveBenchmarkQueueDepth(settings, env);
  if (explicit && Number(resolved) === BENCHMARK_REQUIRED_QUEUE_DEPTH) return;
  throw new Error(
    `BENCHMARK_QUEUE_DEPTH_UNESTABLISHED: refusing to ${phase} — ` +
      `discovery_target_queue_depth resolves to '${resolved}' ` +
      `(explicit value ${explicit ? 'present but not 30' : 'absent; frozen fallback 15 would govern the record'}). ` +
      `Set an explicit database app_settings or DISCOVERY_TARGET_QUEUE_DEPTH=30 matching production before benchmarking.`
  );
}

/**
 * Record cross-check for the --execute path: a plan file created before this
 * guard (or against a divergent environment) must never execute, even when
 * the live environment now resolves 30. Uses the same numeric comparison as
 * the live guard, so equivalent valid representations ('30', '30.0') round-
 * trip from plan to execute under unchanged configuration; invalid,
 * non-finite, and non-30 values still fail closed.
 */
export function assertBenchmarkPlannedQueueDepth(
  plannedKnobs: Record<string, string>,
  phase: 'plan' | 'execute'
): void {
  const recorded = plannedKnobs['discovery_target_queue_depth'];
  if (Number(recorded) === BENCHMARK_REQUIRED_QUEUE_DEPTH) return;
  throw new Error(
    `BENCHMARK_QUEUE_DEPTH_UNESTABLISHED: refusing to ${phase} — ` +
      `plan records discovery_target_queue_depth='${recorded ?? '<absent>'}', ` +
      `not '30'. Re-plan against an environment with an explicit value of 30.`
  );
}
