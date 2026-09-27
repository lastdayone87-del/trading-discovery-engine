import { createHash } from 'node:crypto';
import type { SiteInspectionRow, upsertSiteInspection } from './dbCore';
import { canonicalSiteIdentity, type SiteIdentity } from './siteIdentity';

/** Persistence seam for global site-inspection dedup. Production uses the
 * site_inspections / creator_site_links tables; tests inject an in-memory
 * fake. All methods are best-effort at call sites: any failure falls back
 * to crawling exactly as before (fail open toward inspection). */
export interface SiteInspectionStore {
  read(identities: string[]): Promise<SiteInspectionRow[]>;
  write(row: Parameters<typeof upsertSiteInspection>[0]): Promise<void>;
  recordLinks(channelId: string, links: Array<{ siteIdentity: string; sourceSurface: string; sourceUrl: string }>): Promise<void>;
}

/** Freshness windows grounded in established roadmap semantics (never
 * invented): 30 days matches COMMUNITY_FRESHNESS_INTERVAL_EXPIRED
 * (communityRecovery.ts), 24 hours matches the HIGH_CREATOR_ACTIVITY
 * reactivation cooldown scale for retryable failures. */
export const SITE_INSPECTION_FRESH_TTL_MS = 30 * 24 * 60 * 60_000;
export const SITE_INSPECTION_RETRYABLE_FAILURE_TTL_MS = 24 * 60 * 60_000;
export const SITE_INSPECTION_POLICY_VERSION = 'site-inspection-cache-v1';

/** Minimal structural view of a site_inspections row (DB mapping lives in
 * dbCore.ts). Candidates/observations are the raw crawl outputs:
 * ownership is always re-inferred per borrower, never stored. */
export interface CachedSiteInspection {
  siteIdentity: string;
  identityTier: string;
  canonicalUrl: string;
  finalUrl: string | null;
  outcome: string;
  retryable: boolean;
  httpStatus: number | null;
  failureClass: string;
  detail: string;
  payloadChecksum: string | null;
  candidates: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
  renderedCovered: boolean;
  lastObservedAt: string | null;
}

export interface BorrowedSiteInspection {
  row: CachedSiteInspection;
  /** Borrowed observations reuse the cached outcome verbatim — including
   * PARTIALLY_INSPECTED and ACQUISITION_FAILED — so downstream retry and
   * freshness policy treats a borrow exactly like a fresh crawl with the
   * same result. Existing maxAttempts/terminal safeguards terminate
   * repeated borrows of still-failing sites. */
  observations: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
}

const ageMs = (lastObservedAt: string | null, nowMs: number): number | null => {
  const parsed = lastObservedAt ? Date.parse(lastObservedAt) : NaN;
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
};

/** Whether a cached site inspection may be reused instead of crawling.
 * Borrows never refresh last_observed_at (only real crawls upsert), so a
 * popular site cannot pin a stale row fresh forever: it expires on the
 * original crawl's clock and the next borrower recrawls. */
export function isSiteInspectionReusable(row: CachedSiteInspection | null | undefined, nowMs: number = Date.now()): boolean {
  if (!row || !row.siteIdentity) return false;
  const age = ageMs(row.lastObservedAt, nowMs);
  if (age === null) return false;
  if (row.outcome === 'ACQUISITION_FAILED' && row.retryable) {
    return age <= SITE_INSPECTION_RETRYABLE_FAILURE_TTL_MS;
  }
  return age <= SITE_INSPECTION_FRESH_TTL_MS;
}

/** Builds the borrower's per-creator observations from a cached row. The
 * requested/root URLs and observedAt reflect THIS inspection (fresh audit
 * trail); outcome, retryable, failure class, telemetry, and the cached
 * final URL are site-facts carried over. Required flags are preserved
 * verbatim: the borrowing call has identical structure to the original, so
 * retry attribution matches a fresh crawl. Provenance marks the borrow so
 * crawled vs reused evidence stays distinguishable downstream. */
export function buildBorrowedSiteInspection(
  row: CachedSiteInspection,
  borrower: { requestedUrl: string; surface: string; required: boolean; wrapperUrl?: string; observedAt: string },
): BorrowedSiteInspection {
  const observations = (Array.isArray(row.observations) ? row.observations : []).map(item => {
    const source = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return {
      ...source,
      requestedUrl: borrower.requestedUrl,
      rootUrl: borrower.requestedUrl,
      finalUrl: typeof row.finalUrl === 'string' ? row.finalUrl : source.finalUrl,
      wrapperUrl: borrower.wrapperUrl ?? source.wrapperUrl,
      surface: borrower.surface,
      // Each observation keeps its own required flag (static seeds are
      // non-required, rendered escalations required): the borrowing call
      // has identical structure to the original, so retry attribution
      // matches a fresh crawl exactly.
      required: typeof source.required === 'boolean' ? source.required : borrower.required,
      observedAt: borrower.observedAt,
      siteCacheHit: true,
      siteIdentity: row.siteIdentity,
      siteObservedAt: row.lastObservedAt,
    };
  });
  const candidates = Array.isArray(row.candidates) ? row.candidates.map(item => ({ ...(item as Record<string, unknown>) })) : [];
  return { row, observations, candidates };
}

/** Whether the borrower must recrawl despite a reusable row because it
 * would escalate to the rendered fallback and the cached row has no
 * rendered coverage. Conservative toward inspection: when in doubt,
 * recrawl. Callers compute hasCreatorOwned by merging the borrowed
 * candidates with the current creator's ownership input first. */
export function needsRenderedRecrawl(
  row: CachedSiteInspection,
  input: { creatorLikelyTrading: boolean; staticOutcome: string; hasCreatorOwned: boolean },
): boolean {
  if (!input.creatorLikelyTrading || row.renderedCovered) return false;
  return input.staticOutcome !== 'FOUND' || !input.hasCreatorOwned;
}

/** Stable checksum over site-facts (outcome + sorted invite codes + final
 * URL). Conservative use only: stored for change detection on recrawl,
 * never an identity or ownership input. */
export function checksumSiteFacts(input: { outcome: string; inviteCodes: string[]; finalUrl?: string | null }): string {
  const codes = Array.from(new Set((input.inviteCodes || []).filter(code => typeof code === 'string'))).sort();
  return createHash('sha256').update(JSON.stringify({ outcome: input.outcome, codes, finalUrl: input.finalUrl || null })).digest('hex');
}

export type { SiteIdentity };
export { canonicalSiteIdentity };
