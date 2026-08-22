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

/** Projects current configured key order onto durable daily rows without exposing key values. */
export function projectYouTubeQuotaUsage(
  keys: string[],
  rows: YouTubeQuotaProjectionRow[],
  perKeyLimit: number
): YouTubeQuotaProjection[] {
  const usage = new Map(rows.map(row => [row.keyFingerprint, clampQuotaUnits(row.unitsUsed, perKeyLimit)]));
  return keys.map((key, index) => {
    const unitsUsed = usage.get(fingerprintYouTubeKey(key)) ?? 0;
    return { keyIndex: index + 1, unitsUsed, remaining: Math.max(0, perKeyLimit - unitsUsed), limit: perKeyLimit };
  });
}
