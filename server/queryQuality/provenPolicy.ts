/**
 * PROVEN admission policy. The production default is unchanged; operators can
 * calibrate the threshold and minimum sample through app settings after
 * reviewing a labelled/accounted run distribution. Out-of-range or malformed
 * values are rejected and fall back to the default, so a bad setting can
 * never make every query PROVEN or ban every query.
 */
export interface ProvenPolicy {
  threshold: number;
  minRuns: number;
  source: 'setting' | 'default';
}

export const DEFAULT_PROVEN_POLICY: ProvenPolicy = Object.freeze({
  threshold: 0.5,
  minRuns: 2,
  source: 'default',
});

export const MIN_PROVEN_THRESHOLD = 0.01;
export const MAX_PROVEN_THRESHOLD = 1;
export const MAX_PROVEN_MIN_RUNS = 20;

export function resolveProvenPolicy(thresholdRaw: unknown, minRunsRaw: unknown): ProvenPolicy {
  const threshold = Number(thresholdRaw);
  const minRuns = Number(minRunsRaw);
  const hasThreshold = Number.isFinite(threshold)
    && threshold >= MIN_PROVEN_THRESHOLD
    && threshold <= MAX_PROVEN_THRESHOLD;
  const hasMinRuns = Number.isFinite(minRuns)
    && Number.isInteger(minRuns)
    && minRuns >= 1
    && minRuns <= MAX_PROVEN_MIN_RUNS;
  if (!hasThreshold && !hasMinRuns) return { ...DEFAULT_PROVEN_POLICY };
  return {
    threshold: hasThreshold ? threshold : DEFAULT_PROVEN_POLICY.threshold,
    minRuns: hasMinRuns ? minRuns : DEFAULT_PROVEN_POLICY.minRuns,
    source: 'setting',
  };
}
