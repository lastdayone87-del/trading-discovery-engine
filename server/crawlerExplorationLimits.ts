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

export interface NavigationQueueItem {
  url: string;
  score: number;
  from?: string;
  depth?: number;
}

/** Merge newly discovered navigation targets into the pending queue by URL.
 * A shallower path stays authoritative for the same URL even when a deeper
 * path has a higher hint score; otherwise the deeper copy can push the URL
 * past maxDepth and lose an otherwise reachable page. The cap applies to the
 * merged queue, not just to the additions. */
export function mergeNavigationQueue(
  existing: readonly NavigationQueueItem[],
  additions: readonly NavigationQueueItem[],
  cap: number,
): { queue: NavigationQueueItem[]; overflow: number } {
  const byUrl = new Map<string, NavigationQueueItem>();
  for (const item of existing) byUrl.set(item.url, { ...item });
  for (const item of additions) {
    const prior = byUrl.get(item.url);
    if (!prior) {
      byUrl.set(item.url, { ...item });
      continue;
    }
    const best = item.score > prior.score ? item : prior;
    byUrl.set(item.url, {
      ...best,
      depth: Math.min(prior.depth ?? Number.POSITIVE_INFINITY, item.depth ?? Number.POSITIVE_INFINITY),
    });
  }
  const merged = [...byUrl.values()].sort((a, b) => b.score - a.score);
  const boundedCap = Math.max(1, Math.trunc(cap) || 1);
  return { queue: merged.slice(0, boundedCap), overflow: Math.max(0, merged.length - boundedCap) };
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
