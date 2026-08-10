/**
 * Immutable calibration artifact for Priority 2. Values are deliberately
 * conservative until replaced by a time-split, human-reviewed artifact.
 * They are policy confidence, not a claim of production probability.
 */
export const SEMANTIC_CALIBRATION_VERSION = 'multilingual-semantic-calibration-bootstrap-1';

const BINS = [
  { max: 49, calibrated: 35 },
  { max: 64, calibrated: 50 },
  { max: 79, calibrated: 64 },
  { max: 89, calibrated: 75 },
  { max: 100, calibrated: 84 }
] as const;

/** Highest confidence tier emitted by the active governed calibration artifact. */
export const SEMANTIC_TOP_CALIBRATED_CONFIDENCE = BINS[BINS.length - 1].calibrated;

export function calibrateSemanticConfidence(raw: number): number {
  const bounded = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0));
  return BINS.find(bin => bounded <= bin.max)!.calibrated;
}
