/**
 * Normalize a persisted rotation cursor before using it as an array index.
 * Fractional, negative, NaN, or infinite settings must never make `arr[cursor]`
 * undefined or select a partial index.
 */
export function normalizeRotationCursor(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}
