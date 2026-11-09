/**
 * PROVEN admission policy. The production default is unchanged; operators can
 * calibrate the threshold and minimum sample through app settings after
 * reviewing a labelled/accounted run distribution. The values are clamped so a
 * malformed setting can never make every query PROVEN or ban every query.
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

export function resolveProvenPolicy(thresholdRaw: unknown, minRunsRaw: unknown): ProvenPolicy {
  const threshold = Number(thresholdRaw);
  const minRuns = Number(minRunsRaw);
  const hasThreshold = Number.isFinite(threshold) && threshold > 0;
  const hasMinRuns = Number.isFinite(minRuns) && minRuns > 0;
  if (!hasThreshold && !hasMinRuns) return { ...DEFAULT_PROVEN_POLICY };
  return {
    threshold: hasThreshold ? Math.min(100, Math.max(0.001, threshold)) : DEFAULT_PROVEN_POLICY.threshold,
    minRuns: hasMinRuns ? Math.min(20, Math.max(1, Math.trunc(minRuns))) : DEFAULT_PROVEN_POLICY.minRuns,
    source: 'setting',
  };
}
