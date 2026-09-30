export const DEFAULT_YOUTUBE_DAILY_QUOTA_PER_KEY = 10_000;

/** The usable daily budget is the sum of the independently configured keys. */
export function calculateYouTubeDailyBudget(keyCount: number, unitsPerKey = DEFAULT_YOUTUBE_DAILY_QUOTA_PER_KEY): number {
  const keys = Math.max(0, Math.floor(keyCount));
  const perKey = Number.isFinite(unitsPerKey) && unitsPerKey > 0
    ? Math.floor(unitsPerKey)
    : DEFAULT_YOUTUBE_DAILY_QUOTA_PER_KEY;
  return keys * perKey;
}

/**
 * P0 project/quota map (CORE infrastructure).
 * Google quota is per Cloud project, not per key: keys sharing one
 * `*_QUOTA_GROUP` share one budget. Ungrouped keys retain legacy
 * per-key assumption for backwards compatibility (each assumed independent).
 * Pure, deterministic, DB-free. Classification: counting logic = A
 * (architectural constant); unitsPerKey default = E (pilot value, not frozen).
 */
export interface QuotaProjectEntry {
  group: string;
  keyCount: number;
}

export interface QuotaProjectMap {
  /** Distinct grouped projects. */
  projectCount: number;
  /** Keys without any group label (each assumed independent). */
  ungroupedKeyCount: number;
  /** Keys carrying a group label. */
  groupedKeyCount: number;
  /** Per-project breakdown in deterministic sorted order. */
  projects: QuotaProjectEntry[];
  /** True when multiple keys share one group (legacy per-key sum would overcount). */
  sharedProjectDetected: boolean;
}

export function describeQuotaProjectMap(
  providers: Array<{ quotaGroup?: string }>,
): QuotaProjectMap {
  const byGroup = new Map<string, number>();
  let ungrouped = 0;
  for (const provider of providers) {
    const group = provider.quotaGroup?.trim();
    if (!group) {
      ungrouped += 1;
      continue;
    }
    byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
  }
  const projects: QuotaProjectEntry[] = [...byGroup.entries()]
    .map(([group, keyCount]) => ({ group, keyCount }))
    .sort((left, right) => (left.group < right.group ? -1 : left.group > right.group ? 1 : 0));
  return {
    projectCount: projects.length,
    ungroupedKeyCount: ungrouped,
    groupedKeyCount: providers.length - ungrouped,
    projects,
    sharedProjectDetected: projects.some(entry => entry.keyCount > 1),
  };
}

/**
 * Group-aware budget: one budget unit per distinct project plus one per
 * ungrouped key. Identical to calculateYouTubeDailyBudget when no groups
 * are configured (replay-safe fallback).
 */
export function calculateYouTubeDailyBudgetByProject(
  projectCount: number,
  ungroupedKeyCount: number,
  unitsPerKey = DEFAULT_YOUTUBE_DAILY_QUOTA_PER_KEY,
): number {
  const projects = Math.max(0, Math.floor(projectCount));
  const ungrouped = Math.max(0, Math.floor(ungroupedKeyCount));
  const perKey = Number.isFinite(unitsPerKey) && unitsPerKey > 0
    ? Math.floor(unitsPerKey)
    : DEFAULT_YOUTUBE_DAILY_QUOTA_PER_KEY;
  return (projects + ungrouped) * perKey;
}

/** Convenience: effective budget directly from provider list. */
export function calculateEffectiveYouTubeBudget(
  providers: Array<{ quotaGroup?: string }>,
  unitsPerKey = DEFAULT_YOUTUBE_DAILY_QUOTA_PER_KEY,
): number {
  const map = describeQuotaProjectMap(providers);
  return calculateYouTubeDailyBudgetByProject(map.projectCount, map.ungroupedKeyCount, unitsPerKey);
}

export function quotaAllocationBudget(dailyBudget: number, allocationPercent: number): number {
  const budget = Math.max(0, Number.isFinite(dailyBudget) ? dailyBudget : 0);
  const percent = Math.min(100, Math.max(0, Number.isFinite(allocationPercent) ? allocationPercent : 0));
  return Math.floor(budget * percent / 100);
}
