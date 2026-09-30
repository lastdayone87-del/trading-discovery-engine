/**
 * P2 retrieval experiment harness (EXPERIMENTAL testability, no promotion).
 * Pure, deterministic, DB-free. Provides:
 *  - windowed search params (publishedAfter/Before slicing) as opt-in treatment
 *  - hash-based ordering experiment arm assignment with propensity
 * Serving path is UNCHANGED: callers must explicitly opt into treatment with
 * experiment metadata (experimentId, caps). All numeric values here are
 * B (experiment design params) or E (temporary pilot values), never A.
 * UCB1 remains the control; Thompson/contextual challengers arrive in P4.
 */
import { createHash } from 'node:crypto';

export const RETRIEVAL_EXPERIMENT_VERSION = 'retrieval-experiment-v1';

export interface SearchWindow {
  publishedAfter?: string;
  publishedBefore?: string;
}

export interface WindowedSearchParams {
  params: Record<string, string | number>;
  windowApplied: boolean;
  experimentId: string | null;
}

/**
 * Build windowed search params. Control (no window or no experimentId)
 * returns base params unchanged. Treatment requires BOTH a valid window
 * and an experimentId so replay can attribute the extra page cost.
 * Validates RFC3339 timestamps; invalid window throws (fail-closed, no fetch).
 */
export function buildWindowedSearchParams(
  base: Record<string, string | number>,
  window: SearchWindow | null,
  experimentId: string | null,
): WindowedSearchParams {
  if (!window || !experimentId?.trim()) return { params: { ...base }, windowApplied: false, experimentId: null };
  const { publishedAfter, publishedBefore } = window;
  if (publishedAfter !== undefined) {
    if (!Number.isFinite(Date.parse(publishedAfter))) throw new Error('INVALID_WINDOW_PUBLISHED_AFTER');
  }
  if (publishedBefore !== undefined) {
    if (!Number.isFinite(Date.parse(publishedBefore))) throw new Error('INVALID_WINDOW_PUBLISHED_BEFORE');
  }
  if (
    publishedAfter !== undefined &&
    publishedBefore !== undefined &&
    Date.parse(publishedAfter) >= Date.parse(publishedBefore)
  ) {
    throw new Error('INVALID_WINDOW_EMPTY_RANGE');
  }
  return {
    params: {
      ...base,
      ...(publishedAfter !== undefined ? { publishedAfter } : {}),
      ...(publishedBefore !== undefined ? { publishedBefore } : {}),
    },
    windowApplied: true,
    experimentId: experimentId.trim(),
  };
}

export type OrderingExperimentArm = 'CONTROL' | 'TREATMENT';

export interface OrderingExperimentAssignment {
  arm: OrderingExperimentArm;
  /** Propensity in basis points, compatible with outcomeFeedback allocationProbability = bp/10000. */
  propensityBasisPoints: number;
  bucket: number;
  policyVersion: string;
}

function bucketFor(key: string): number {
  const digest = createHash('sha256').update(key).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) % 10000;
}

/**
 * Deterministic ordering experiment assignment (replay-safe, no Math.random).
 * Disabled by default: treatmentBasisPoints=0 forces CONTROL with propensity
 * 10000. Callers pass treatmentBasisPoints as B (experiment metadata).
 * Frozen-pool rule: compare arms only on identical candidate pools.
 */
export function selectOrderingExperimentArm(
  opportunityKey: string,
  treatmentBasisPoints = 0,
): OrderingExperimentAssignment {
  if (!opportunityKey.trim()) throw new Error('OPPORTUNITY_KEY_REQUIRED');
  if (!Number.isInteger(treatmentBasisPoints) || treatmentBasisPoints < 0 || treatmentBasisPoints > 10000) {
    throw new Error('INVALID_TREATMENT_BASIS_POINTS');
  }
  if (treatmentBasisPoints === 0) {
    return { arm: 'CONTROL', propensityBasisPoints: 10000, bucket: bucketFor(opportunityKey), policyVersion: RETRIEVAL_EXPERIMENT_VERSION };
  }
  const bucket = bucketFor(`${RETRIEVAL_EXPERIMENT_VERSION}:${opportunityKey}`);
  const arm: OrderingExperimentArm = bucket < treatmentBasisPoints ? 'TREATMENT' : 'CONTROL';
  return {
    arm,
    propensityBasisPoints: arm === 'TREATMENT' ? treatmentBasisPoints : 10000 - treatmentBasisPoints,
    bucket,
    policyVersion: RETRIEVAL_EXPERIMENT_VERSION,
  };
}
