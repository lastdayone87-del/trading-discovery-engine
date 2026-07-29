export const DEFAULT_YOUTUBE_DAILY_QUOTA_PER_KEY = 10_000;

/** The usable daily budget is the sum of the independently configured keys. */
export function calculateYouTubeDailyBudget(keyCount: number, unitsPerKey = DEFAULT_YOUTUBE_DAILY_QUOTA_PER_KEY): number {
  const keys = Math.max(0, Math.floor(keyCount));
  const perKey = Number.isFinite(unitsPerKey) && unitsPerKey > 0
    ? Math.floor(unitsPerKey)
    : DEFAULT_YOUTUBE_DAILY_QUOTA_PER_KEY;
  return keys * perKey;
}

export function quotaAllocationBudget(dailyBudget: number, allocationPercent: number): number {
  const budget = Math.max(0, Number.isFinite(dailyBudget) ? dailyBudget : 0);
  const percent = Math.min(100, Math.max(0, Number.isFinite(allocationPercent) ? allocationPercent : 0));
  return Math.floor(budget * percent / 100);
}
