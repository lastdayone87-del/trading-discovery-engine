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
  /** The covering row with candidates explicitly stripped: the borrow result
   * is candidate-free at the API boundary so no future caller can reintroduce
   * cross-creator candidate propagation through `borrowed.row.candidates`. */
  row: CachedSiteInspection;
  /** Borrowed observations reuse the cached outcome verbatim — including
   * PARTIALLY_INSPECTED and ACQUISITION_FAILED — so downstream retry and
   * freshness policy treats a borrow exactly like a fresh crawl with the
   * same result. Existing maxAttempts/terminal safeguards terminate
   * repeated borrows of still-failing sites.
   * Cross-creator invariant: borrows carry coverage observations ONLY.
   * Cached discovery candidates are never returned here and must never be
   * merged into another creator's investigation. */
  observations: Array<Record<string, unknown>>;
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
 * crawled vs reused evidence stays distinguishable downstream.
 * Candidates are deliberately excluded: discoveries belong to the
 * originating investigation and are never transferred across creators. */
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
  return { row: { ...row, candidates: [] }, observations };
}

/** Root-page terminal for coverage rows: reflects ONLY the root page's own
 * evidence (direct-in-URL candidates and children live on their own rows).
 * An invite found solely on a child never marks the root FOUND. Pure. */
export function rootCoverageTerminal(rootYield: number, truncated: boolean): 'FOUND' | 'PARTIALLY_INSPECTED' | 'INSPECTED_NO_MATCH' {
  if (Math.max(0, Math.trunc(rootYield) || 0) > 0) return 'FOUND';
  if (truncated) return 'PARTIALLY_INSPECTED';
  return 'INSPECTED_NO_MATCH';
}

/** Whether a rendered run counts as sufficient rendered coverage for the
 * site cache. Attempted is not covered: timeouts, interruptions, partial
 * page processing, and zero-page runs must never satisfy renderedCovered —
 * only a complete, processed run does. Retryable partial results stay
 * retryable through the row's own retryable flag, not through this bit. */
export function isSufficientRenderedCoverage(
  rendered: { complete?: unknown; timedOut?: unknown },
  processed: boolean,
): boolean {
  return processed === true && rendered.complete === true && rendered.timedOut !== true;
}

/** Normalized page key for coverage checks: scheme plus lowercased host
 * plus non-default port plus pathname (trailing slash trimmed, empty path
 * normalized to root). Scheme and port are load-bearing: http vs https and
 * distinct ports can serve different content and follow different
 * redirects, so they must never share a coverage identity. Query strings
 * are kept verbatim: query-driven content differences fail toward recrawl,
 * never toward assuming coverage. Fragments are dropped. Returns null for
 * unparsable input (callers treat that as uncovered and crawl). */
function normalizeCoverageKey(raw: string): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}${parsed.search}`;
}

/** Whether a cached row actually covers the requested surface/path.
 * Positive site-facts (FOUND rows) are borrowed regardless of path — the
 * invite genuinely exists on the site and ownership is always recomputed
 * per borrower. Negative outcomes (INSPECTED_NO_MATCH, PARTIALLY_INSPECTED,
 * ACQUISITION_FAILED) assert absence, so they are only reusable where the
 * cached crawl demonstrably went: any observation requested/root/final URL,
 * the row's canonical/final URLs, or a retained candidate's source URL.
 * Uncovered negatives force acquisition instead of masquerading as complete
 * coverage of another page. REDIRECTED alias rows are never borrowed
 * directly; resolve them with redirectBindingFor first. */
export function siteInspectionCoversRequest(
  row: Pick<CachedSiteInspection, 'outcome' | 'canonicalUrl' | 'finalUrl' | 'observations' | 'candidates'>,
  requestedUrl: string,
  options?: { strictFoundCoverage?: boolean },
): boolean {
  // Path-aware FOUND borrowing (R6 follow-up, explicit opt-in by caller):
  // legacy borrows FOUND regardless of path (registrable-domain-only),
  // letting unrelated short-link slugs inherit another URL's FOUND merely
  // via shared domain. Strict mode requires a valid coverage-key/binding
  // match for FOUND too; borrowers without a match fall through to their
  // own acquisition. Same-site brand sharing that spans paths recrawls
  // (recall-safe cost); genuine redirect chains resolve via exact bindings.
  // Default is legacy (opt-in strict): existing callers omitting options keep
  // prior behavior byte-identically; the inspector passes strict explicitly
  // when its flag resolves enabled.
  const strictFound = options?.strictFoundCoverage === true;
  if (row.outcome === 'FOUND' && !strictFound) return true;
  // Strict: FOUND falls through to coverage-key check below.
  const want = normalizeCoverageKey(requestedUrl);
  if (!want) return false;
  const covered = new Set<string>();
  for (const url of [row.canonicalUrl, row.finalUrl]) {
    if (typeof url === 'string' && url) {
      const key = normalizeCoverageKey(url);
      if (key) covered.add(key);
    }
  }
  for (const item of row.observations || []) {
    const source = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    for (const field of ['requestedUrl', 'rootUrl', 'finalUrl'] as const) {
      if (typeof source[field] === 'string') {
        const key = normalizeCoverageKey(source[field] as string);
        if (key) covered.add(key);
      }
    }
  }
  for (const item of row.candidates || []) {
    const source = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (typeof source.sourceUrl === 'string') {
      const key = normalizeCoverageKey(source.sourceUrl);
      if (key) covered.add(key);
    }
  }
  return covered.has(want);
}

/** Redirect-alias binding stored on REDIRECTED rows. One site identity
 * (e.g. a shared shortener host) can carry many distinct requested-URL ->
 * destination bindings so wrappers never overwrite each other. Resolution
 * is exact requested-URL match only: bindings never merge destinations. */
export const REDIRECT_BINDING_KIND = 'REDIRECT_BINDING';
/** Storage safety bound on bindings per alias row (oldest evicted). */
export const MAX_REDIRECT_BINDINGS = 50;

export type RedirectBinding = {
  kind: typeof REDIRECT_BINDING_KIND;
  requestedUrl: string;
  finalUrl: string;
  observedAt: string;
};

function isRedirectBinding(item: unknown): item is RedirectBinding {
  if (!item || typeof item !== 'object') return false;
  const record = item as Record<string, unknown>;
  return (
    record.kind === REDIRECT_BINDING_KIND &&
    typeof record.requestedUrl === 'string' &&
    typeof record.finalUrl === 'string' &&
    typeof record.observedAt === 'string'
  );
}

/** Merge one binding into an alias row's observations: same requested URL
 * (normalized) replaces in place, otherwise append; oldest evicted past the
 * cap. Pure and deterministic. */
export function mergeRedirectBinding(
  existing: Array<Record<string, unknown>>,
  binding: RedirectBinding,
): Array<Record<string, unknown>> {
  const list = (Array.isArray(existing) ? existing : []).filter(isRedirectBinding);
  const key = normalizeCoverageKey(binding.requestedUrl);
  const slot = key === null ? -1 : list.findIndex(entry => normalizeCoverageKey(entry.requestedUrl) === key);
  const merged = [...list];
  if (slot >= 0) merged[slot] = binding;
  else merged.push(binding);
  while (merged.length > MAX_REDIRECT_BINDINGS) {
    let oldest = 0;
    for (let i = 1; i < merged.length; i++) {
      if (merged[i].observedAt < merged[oldest].observedAt) oldest = i;
    }
    merged.splice(oldest, 1);
  }
  return merged as Array<Record<string, unknown>>;
}

/** Resolve the destination bound to an exact requested URL on a REDIRECTED
 * alias row, or null. Freshness is evaluated per exact binding against the
 * row-independent fresh TTL: one binding refreshing (which rewrites the
 * row's last_observed_at) never extends another binding's window, so stale
 * bindings fall through to normal inspection/re-resolution. Malformed or
 * missing observedAt on a listed binding also fails closed to null. Legacy
 * single-binding rows (canonicalUrl + finalUrl, no bindings list) resolve
 * exactly as before; their freshness remains governed by the row-level
 * reusable check the caller already performs. Never merges destinations. */
export function redirectBindingFor(
  row: Pick<CachedSiteInspection, 'outcome' | 'canonicalUrl' | 'finalUrl' | 'observations'>,
  requestedUrl: string,
  nowMs: number = Date.now(),
): { requestedUrl: string; finalUrl: string; observedAt: string | null } | null {
  if (row.outcome !== 'REDIRECTED') return null;
  const want = normalizeCoverageKey(requestedUrl);
  if (!want) return null;
  const bindings: RedirectBinding[] = [];
  for (const item of Array.isArray(row.observations) ? row.observations : []) {
    if (isRedirectBinding(item)) bindings.push(item);
  }
  for (const binding of bindings) {
    if (normalizeCoverageKey(binding.requestedUrl) !== want || !binding.finalUrl) continue;
    const observedAt = Date.parse(binding.observedAt);
    if (!Number.isFinite(observedAt)) continue;
    if (Math.max(0, nowMs - observedAt) > SITE_INSPECTION_FRESH_TTL_MS) continue;
    return { requestedUrl: binding.requestedUrl, finalUrl: binding.finalUrl, observedAt: binding.observedAt };
  }
  if (bindings.length === 0 && typeof row.finalUrl === 'string' && row.finalUrl) {
    const canonical = typeof row.canonicalUrl === 'string' ? normalizeCoverageKey(row.canonicalUrl) : null;
    if (canonical !== null && canonical === want) {
      return { requestedUrl: row.canonicalUrl, finalUrl: row.finalUrl, observedAt: null };
    }
  }
  return null;
}

/** Exact-page cover check for terminal-barrier rows (LOGIN_WALL,
 * PAYWALL_WALL, PERMANENT_ACCESS_BLOCK): the borrower's URL matches the
 * row's canonical/final URL or a previously requested/root URL on the row
 * (same page, e.g. after a login redirect) — never another path on the same
 * host. Pure and fail-closed (any error → false → recrawl). */
export function isExactBarrierPageCover(
  row: Pick<CachedSiteInspection, 'canonicalUrl' | 'finalUrl' | 'observations'>,
  coverageUrl: string,
): boolean {
  try {
    const norm = (u: unknown): string => String(u || '').trim().toLowerCase().replace(/\/+$/, '');
    const want = norm(coverageUrl);
    if (!want) return false;
    const finals = [row.canonicalUrl, row.finalUrl].filter(Boolean).map(norm);
    if (finals.includes(want)) return true;
    for (const item of row.observations || []) {
      const source = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      for (const field of ['requestedUrl', 'rootUrl'] as const) {
        if (typeof source[field] === 'string' && norm(source[field] as string) === want) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Every destination referenced by an alias row (bindings plus legacy
 * finalUrl) for prefetch. Deduped, order-stable. */
export function redirectDestinations(row: Pick<CachedSiteInspection, 'outcome' | 'finalUrl' | 'observations'>): string[] {
  if (row.outcome !== 'REDIRECTED') return [];
  const out: string[] = [];
  for (const item of Array.isArray(row.observations) ? row.observations : []) {
    if (isRedirectBinding(item) && item.finalUrl && !out.includes(item.finalUrl)) out.push(item.finalUrl);
  }
  if (typeof row.finalUrl === 'string' && row.finalUrl && !out.includes(row.finalUrl)) out.push(row.finalUrl);
  return out;
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
