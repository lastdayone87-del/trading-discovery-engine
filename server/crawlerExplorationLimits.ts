/**
 * Progressive static-exploration bounds.
 *
 * Defaults preserve the current 12-link queue, depth 2 and 12-page cap so
 * existing behavior and tests are unchanged. A canary deployment can raise
 * them without a code change:
 *
 *   CRAWLER_MAX_DEPTH=3
 *   CRAWLER_QUEUE_CAP=24
 *   CRAWLER_PAGE_CAP=24
 *
 * These are still bounded for safety (max depth 8, max 200 queue/pages);
 * the frontier/stopping arbiter remains the long-term adaptive mechanism.
 */

export interface CrawlerExplorationLimits {
  maxDepth: number;
  queueCap: number;
  pageCap: number;
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(String(value ?? '').trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function resolveCrawlerExplorationLimits(env: NodeJS.ProcessEnv = process.env): CrawlerExplorationLimits {
  return {
    maxDepth: boundedInt(env.CRAWLER_MAX_DEPTH, 2, 2, 8),
    queueCap: boundedInt(env.CRAWLER_QUEUE_CAP, 12, 12, 200),
    pageCap: boundedInt(env.CRAWLER_PAGE_CAP, 12, 12, 200),
  };
}

/** Deterministic 0–10000 canary bucket for a seed/site. The default is a 5%
 * rollout; 10000 = all, 0 = none. Used by frontier/site-profiler canaries so
 * a retry cannot flip treatment. */
export function isCrawlerCanarySelected(seed: string, basisPoints: number): boolean {
  const bp = Number.isFinite(basisPoints) ? Math.max(0, Math.min(10_000, Math.floor(basisPoints))) : 0;
  if (bp <= 0) return false;
  if (bp >= 10_000) return true;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 10_000 < bp;
}
