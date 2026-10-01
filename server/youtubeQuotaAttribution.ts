import { createHash } from 'node:crypto';

export interface YouTubeQuotaProjectionRow {
  keyFingerprint: string;
  keyIndex: number;
  unitsUsed: number;
  dailyLimit: number;
}

export interface YouTubeQuotaProjection {
  keyIndex: number;
  unitsUsed: number;
  remaining: number;
  limit: number;
  /**
   * Quota project attribution (P0 group-aware reporting). Null for ungrouped keys.
   * `remaining` is project-level capacity (perKeyLimit minus the whole
   * project's attributed usage), NOT per-key headroom: keys sharing one
   * project draw from the same budget. `unitsUsed` stays per-key attribution.
   */
  quotaGroup: string | null;
  /** Total attributed usage across all keys in the same project (or the key itself). */
  projectUnitsUsed: number;
}

/** Stable non-reversible identity used only for per-key quota attribution. */
export function fingerprintYouTubeKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export function clampQuotaUnits(units: unknown, limit: number): number {
  const value = Number(units);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.max(0, Math.trunc(limit)), Math.trunc(value)));
}

/**
 * Projects current configured key order onto durable daily rows without exposing key values.
 * Optional `quotaGroups` (parallel to `keys`; undefined = ungrouped legacy key) makes
 * `remaining` project-aware: grouped keys share one perKeyLimit budget, so each
 * reports the project's remaining capacity. Omitted groups preserve legacy
 * per-key semantics exactly (each key its own project).
 */
export function projectYouTubeQuotaUsage(
  keys: string[],
  rows: YouTubeQuotaProjectionRow[],
  perKeyLimit: number,
  quotaGroups?: Array<string | undefined>,
): YouTubeQuotaProjection[] {
  const usage = new Map(rows.map(row => [row.keyFingerprint, clampQuotaUnits(row.unitsUsed, perKeyLimit)]));
  const perKeyUsed = keys.map(key => usage.get(fingerprintYouTubeKey(key)) ?? 0);
  const groupTotals = new Map<string, number>();
  keys.forEach((_, index) => {
    const group = quotaGroups?.[index]?.trim();
    if (!group) return;
    groupTotals.set(group, (groupTotals.get(group) ?? 0) + perKeyUsed[index]);
  });
  return keys.map((key, index) => {
    const unitsUsed = perKeyUsed[index];
    const group = quotaGroups?.[index]?.trim() || null;
    const projectUnitsUsed = group ? (groupTotals.get(group) ?? 0) : unitsUsed;
    return {
      keyIndex: index + 1,
      unitsUsed,
      remaining: Math.max(0, perKeyLimit - projectUnitsUsed),
      limit: perKeyLimit,
      quotaGroup: group,
      projectUnitsUsed,
    };
  });
}
