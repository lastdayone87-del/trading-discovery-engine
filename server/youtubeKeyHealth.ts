import { createHash } from 'node:crypto';
import { clearYouTubeProviderSuspension, getYouTubeKeyPool, loadActiveYouTubeProviderSuspensions } from './db';
import { fingerprintYouTubeKey } from './youtubeQuotaAttribution';
import { youtubeProviderCooldown } from './youtubeProviderCooldown';

/** Invalid inputs stay quarantined for 7 days: long enough to break daily
 * rescan loops, short enough that a fixed upstream input recovers on its own. */
export const YOUTUBE_INPUT_QUARANTINE_TTL_MS = 7 * 24 * 60 * 60_000;

/** Durable suspension horizon (7 days) is deliberately longer than the
 * in-memory 24h quarantine it backs: a Google-suspended key does not
 * recover overnight, and reprobing it daily only generates fresh 403s.
 * Success clears both layers immediately. */
export const YOUTUBE_SUSPENSION_RETRY_AFTER_MS = 7 * 24 * 60 * 60_000;

export type YouTubeQuarantineInputKind = 'channelId' | 'searchQuery';

const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

/** Normalizes a raw input into its stable quarantine identity, or null when
 * the value is not worth remembering (empty, unparsable). Channel IDs are
 * stored raw (bounded format, not secrets); search queries are normalized in
 * full and stored as SHA-256 digests so no query text is persisted and
 * long queries sharing a prefix cannot collide. */
export function normalizeYouTubeQuarantineInput(kind: YouTubeQuarantineInputKind, raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (kind === 'channelId') {
    const candidate = raw.trim();
    return CHANNEL_ID_PATTERN.test(candidate) ? candidate : null;
  }
  const candidate = raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
  if (!candidate) return null;
  return createHash('sha256').update(candidate).digest('hex');
}

/** Derives the quarantinable input for an operation from its dispatched URL.
 * Channel-scoped operations attribute to the channel; query operations
 * attribute to the normalized query text. Returns null when the URL carries
 * neither (nothing to remember). */
export function extractYouTubeQuarantineInput(operation: string, url: string): { kind: YouTubeQuarantineInputKind; value: string } | null {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  void operation;
  const channelId = params.get('channelId') || params.get('id');
  const normalizedChannel = normalizeYouTubeQuarantineInput('channelId', channelId);
  if (normalizedChannel) return { kind: 'channelId', value: normalizedChannel };
  const query = params.get('q');
  const normalizedQuery = normalizeYouTubeQuarantineInput('searchQuery', query);
  if (normalizedQuery) return { kind: 'searchQuery', value: normalizedQuery };
  return null;
}

/** HTTP statuses that prove the *input* is bad (not the key, quota, or
 * transport): quarantine the input instead of failing over to another key. */
export function isYouTubeInputFailure(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status);
  return status === 400 || status === 404 || status === 422;
}

/** Whether a successful response may clear a durable suspension row: only
 * when the response generation is still current (not overtaken by a newer
 * suspension event while in flight) AND the request was actually operating
 * under suspension. A stale success must never rehabilitate the key. */
export function shouldClearYouTubeSuspension(providerSuccessIsCurrent: boolean, wasSuspended: boolean): boolean {
  return providerSuccessIsCurrent === true && wasSuspended === true;
}

/** Generation-gated durable clear: removes the suspension row only when no
 * newer failure was recorded after this response validated. failed() and
 * restoreSuspended() bump the in-memory failure generation synchronously,
 * so any suspension created between validation and this call compares
 * unequal and its fresh durable row survives. The caller awaits this (never
 * fire-and-forget) so the recheck lands as late as possible. Returns false
 * without touching the database when the response is not eligible; errors
 * propagate so the caller decides (read path swallows them: a missed clear
 * only delays rehabilitation, never resurrects a dead key). Dependencies
 * are injectable for unit tests; production callers omit them. */
export async function clearYouTubeSuspensionIfCurrent(
  providerKey: string,
  observedGeneration: number | undefined,
  deps: {
    currentGeneration?: (key: string) => number;
    clear?: (keyFingerprint: string) => Promise<void>;
  } = {},
): Promise<boolean> {
  if (!providerKey || observedGeneration === undefined) return false;
  const current = (deps.currentGeneration || ((key: string) => youtubeProviderCooldown.failureGeneration(key)))(providerKey);
  if (current !== observedGeneration) return false;
  await (deps.clear || clearYouTubeProviderSuspension)(fingerprintYouTubeKey(providerKey));
  return true;
}

/** Retries quota accounting against the SAME successful provider response
 * instead of issuing another provider request: the quota was already spent
 * at Google, so a transient accounting failure must not trigger key
 * failover and a wasteful refetch. Throws after maxAttempts so a persistently
 * down ledger still surfaces instead of publishing an unaccounted checkpoint.
 * Pure dependency injection: runtime-testable without a database. */
export async function retryYouTubeQuotaAccounting(
  account: (units: number) => Promise<void>,
  units: number,
  maxAttempts = 2,
): Promise<void> {
  const attempts = Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 ? maxAttempts : 1;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await account(units);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
    }
  }
}
/** Thrown when quota accounting exhausts its retries after a successful
 * provider response. Unlike provider failures, this must never trigger key
 * failover or a refetch: the quota was already spent at Google, another key
 * would burn a second provider call, and the first call's units would stay
 * unrecorded. The enrichment attempt flow rethrows these immediately,
 * mirroring the quotaAdmissionError precedent. */
export class YouTubeQuotaAccountingError extends Error {
  readonly code = 'YOUTUBE_QUOTA_ACCOUNTING';
  constructor(
    readonly units: number,
    readonly providerKey: string,
    options?: { cause?: unknown },
  ) {
    super(`YouTube quota accounting failed for ${units} unit(s) after a successful provider response.`);
    this.name = 'YouTubeQuotaAccountingError';
    if (options && 'cause' in options) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isYouTubeQuotaAccountingError(error: unknown): boolean {
  return error instanceof YouTubeQuotaAccountingError
    || (error as { code?: unknown } | null)?.code === 'YOUTUBE_QUOTA_ACCOUNTING';
}

/** Next rotation slot after a success: healthy keys share the workload in
 * stable order instead of one key absorbing everything until it fails. */
export function advanceYouTubeRotation(poolLength: number, validatedIndex: number): number {
  if (!Number.isSafeInteger(poolLength) || poolLength < 1) return 0;
  if (!Number.isSafeInteger(validatedIndex) || validatedIndex < 0) return 0;
  return (validatedIndex + 1) % poolLength;
}

export function youtubeDeploymentId(environment: NodeJS.ProcessEnv = process.env): string | null {
  const candidate = environment.RAILWAY_DEPLOYMENT_ID || environment.RAILWAY_REPLICA_ID || '';
  return candidate.trim() ? candidate.trim() : null;
}

/** Per-call attribution stamped into provider_call_events.request_metadata.
 * The fingerprint is the existing non-reversible sha256 prefix (same as the
 * quota table), never the key. All values stay strings to satisfy the
 * provider-event metadata contract. */
export function buildYouTubeTelemetryMetadata(input: {
  providerKey?: string;
  poolKeys?: string[];
  quotaGroup?: string | null;
  deploymentId?: string | null;
}): Record<string, string | null> {
  const metadata: Record<string, string | null> = {};
  if (input.providerKey) {
    metadata.youtubeKeyFingerprint = fingerprintYouTubeKey(input.providerKey);
    const pool = input.poolKeys || [];
    const index = pool.indexOf(input.providerKey);
    metadata.youtubeKeyIndex = index >= 0 ? String(index + 1) : null;
  }
  metadata.youtubeQuotaGroup = input.quotaGroup || null;
  metadata.youtubeDeploymentId = input.deploymentId || null;
  return metadata;
}

const SAFE_REASON_CHARS = /^[A-Za-z0-9_.,:-]{1,80}$/;

/** Annotates the live metadata object with the failure's HTTP status and API
 * reasons (mutates in place: the provider-event emitter holds the same
 * reference, so both success and failure events carry attribution). */
export function annotateYouTubeErrorMetadata(metadata: Record<string, string | null>, error: unknown): void {
  const record = (error || {}) as { status?: unknown; providerReasons?: unknown };
  const status = Number(record.status);
  if (Number.isFinite(status) && status > 0) metadata.youtubeHttpStatus = String(Math.trunc(status));
  const reasons = Array.isArray(record.providerReasons)
    ? record.providerReasons.map(String).filter(reason => SAFE_REASON_CHARS.test(reason)).slice(0, 6)
    : [];
  if (reasons.length) metadata.youtubeApiReasons = reasons.join(',');
}

export interface YouTubeSuspensionHydration {
  restored: number;
  skipped: number;
}

/** Shared hydration promise: YouTube dispatch awaits the same promise the
 * startup task triggers, so workers cannot use a durably suspended key
 * before its cooldown is restored. Resolves (never rejects) with the
 * fallback result when hydration is unavailable, preserving existing
 * error behavior. A failed load is NOT cached: the shared promise is reset
 * so a later dispatch retries after the database recovers, while successful
 * loads stay cached for the process lifetime. The health endpoint never
 * touches this path. */
let sharedSuspensionHydration: Promise<YouTubeSuspensionHydration> | null = null;

export function ensureYouTubeSuspensionHydration(): Promise<YouTubeSuspensionHydration> {
  if (!sharedSuspensionHydration) {
    sharedSuspensionHydration = hydrateYouTubeProviderSuspensions().catch(() => {
      sharedSuspensionHydration = null;
      return { restored: 0, skipped: 0 };
    });
  }
  return sharedSuspensionHydration;
}

/** Restores durable suspensions into the in-memory cooldown after a
 * restart/redeploy. Fingerprints are resolved against the *current* pool:
 * rows whose key is gone (pool edited) are skipped, never applied to the
 * wrong key. Returns counts for startup logging. Throws when the load
 * itself fails so ensureYouTubeSuspensionHydration() can retry later
 * instead of caching the zero-count fallback; callers that need a
 * non-rejecting gate must use ensureYouTubeSuspensionHydration(). */
export async function hydrateYouTubeProviderSuspensions(
  loadRows: () => Promise<Array<{ keyFingerprint: string; retryAfter: string | null }>> = loadActiveYouTubeProviderSuspensions,
): Promise<YouTubeSuspensionHydration> {
  const summary: YouTubeSuspensionHydration = { restored: 0, skipped: 0 };
  let rows;
  try {
    rows = await loadRows();
  } catch (error) {
    console.warn('[YouTube] Suspension hydration unavailable (migration pending?):', String((error as Error)?.message || error));
    throw error;
  }
  if (!rows.length) return summary;
  const pool = getYouTubeKeyPool();
  const byFingerprint = new Map(pool.map(key => [fingerprintYouTubeKey(key), key] as const));
  for (const row of rows) {
    const key = byFingerprint.get(row.keyFingerprint);
    if (!key) {
      summary.skipped += 1;
      continue;
    }
    const retryAfterMs = row.retryAfter ? Date.parse(row.retryAfter) : NaN;
    youtubeProviderCooldown.restoreSuspended(key, Number.isFinite(retryAfterMs) ? retryAfterMs : Date.now() + YOUTUBE_SUSPENSION_RETRY_AFTER_MS);
    summary.restored += 1;
  }
  return summary;
}
