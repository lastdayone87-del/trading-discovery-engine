/**
 * Crawl-path robots policy.
 *
 * - Explicit Disallow is enforced.
 * - 4xx/403/429/5xx/unreachable/malformed robots.txt is UNKNOWN, not a block:
 *   an unavailable policy file must not make a legitimate creator site
 *   uninspectable (RFC 9309 treats 4xx as unavailable; this is deliberately
 *   conservative for discovery).
 * - Crawl-delay is returned to the caller for per-host pacing.
 *
 * The policy is cached per origin for one crawl. `siteProfiler` owns the
 * RFC 9309 parser and evaluator; this module only adds crawl-time enforcement.
 */
import type { DnsResolver } from './publicDestination';
import {
  PROFILER_USER_AGENT,
  ROBOTS_MAX_BYTES,
  evaluateRobotsForPath,
  fetchProfilerUrl,
  parseRobotsTxt,
  type ParsedRobots,
} from './siteProfiler';

export type RobotsCrawlDecisionReason = 'ALLOWED' | 'DISALLOWED' | 'UNKNOWN';

export interface RobotsCrawlDecision {
  allowed: boolean;
  reason: RobotsCrawlDecisionReason;
  /** Bounded to 30s; 0 when the host publishes no Crawl-delay. */
  crawlDelayMs: number;
  matchedRule?: string | null;
}

interface CachedPolicy {
  parsed: ParsedRobots | null;
  state: 'FETCHED' | 'UNKNOWN';
}

const MAX_CRAWL_DELAY_MS = 30_000;

export class RobotsCrawlPolicy {
  private readonly policies = new Map<string, Promise<CachedPolicy>>();

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly resolveHost?: DnsResolver,
    private readonly timeoutMs = 5_000,
  ) {}

  private load(origin: string): Promise<CachedPolicy> {
    const existing = this.policies.get(origin);
    if (existing) return existing;
    const pending = (async (): Promise<CachedPolicy> => {
      try {
        const fetched = await fetchProfilerUrl(
          `${origin}/robots.txt`,
          this.fetchImpl,
          ROBOTS_MAX_BYTES,
          this.timeoutMs,
          this.resolveHost,
        );
        // Any non-success response means the policy is unavailable. 4xx, 403,
        // 429 and 5xx must not become a site-wide block.
        if (!fetched || fetched.status < 200 || fetched.status >= 300) {
          return { parsed: null, state: 'UNKNOWN' };
        }
        const parsed = parseRobotsTxt(fetched.text);
        return { parsed, state: parsed.malformed ? 'UNKNOWN' : 'FETCHED' };
      } catch {
        return { parsed: null, state: 'UNKNOWN' };
      }
    })();
    this.policies.set(origin, pending);
    return pending;
  }

  async decide(rawUrl: string): Promise<RobotsCrawlDecision> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return { allowed: true, reason: 'UNKNOWN', crawlDelayMs: 0 };
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { allowed: true, reason: 'UNKNOWN', crawlDelayMs: 0 };
    }
    const policy = await this.load(parsedUrl.origin);
    if (!policy.parsed || policy.state === 'UNKNOWN') {
      return { allowed: true, reason: 'UNKNOWN', crawlDelayMs: 0 };
    }
    let evaluation;
    try {
      evaluation = evaluateRobotsForPath(
        policy.parsed,
        PROFILER_USER_AGENT,
        `${parsedUrl.pathname || '/'}${parsedUrl.search || ''}`,
      );
    } catch {
      return { allowed: true, reason: 'UNKNOWN', crawlDelayMs: 0 };
    }
    const delay = Number(evaluation.crawlDelaySeconds);
    return {
      allowed: evaluation.allowed !== false,
      reason: evaluation.allowed === false ? 'DISALLOWED' : evaluation.allowed === true ? 'ALLOWED' : 'UNKNOWN',
      crawlDelayMs: Number.isFinite(delay) && delay > 0 ? Math.min(MAX_CRAWL_DELAY_MS, Math.trunc(delay * 1000)) : 0,
      matchedRule: evaluation.matchedRule,
    };
  }
}

/** Canary switch. Default off so existing tests/callers are unchanged; the
 * production deployment enables it explicitly. */
export function isRobotsCrawlEnforcementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.CRAWLER_ROBOTS_ENFORCEMENT || '').toLowerCase() === 'true';
}
