/**
 * Official YouTube Data API quota fence.
 *
 * Probe retrieval uses InnerTube for discovery. Downstream hydration,
 * enrichment, queued jobs and retries may spend official YouTube quota, but
 * probe-origin work draws from the independent probe allocation enforced in
 * `quotaKeyCapShadow.ts`. Every official call establishes provenance here;
 * unknown origin fails closed.
 *
 * The fence is intentionally small and dependency-free so it can be imported
 * from the probe layer, the ingestion pipeline, queue dispatch, and the
 * official YouTube dispatcher without creating a cycle or pulling in the
 * database.
 *
 * Semantics:
 *  - no AsyncLocalStorage context => NORMAL (legacy production callers)
 *  - PROBE is sticky: a nested NORMAL context can never downgrade it
 *  - UNKNOWN dominates NORMAL and is fail-closed
 *  - PROBE dominates UNKNOWN/NORMAL so a probe's provenance cannot be
 *    downgraded by a nested caller
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { QuotaOrigin } from '../src/types';

export type ResolvedQuotaOrigin = QuotaOrigin | 'UNKNOWN';

interface FenceStore {
  origin: ResolvedQuotaOrigin;
  entry: string;
}

const storage = new AsyncLocalStorage<FenceStore>();

export class OfficialYouTubeQuotaFenceError extends Error {
  readonly code = 'OFFICIAL_YOUTUBE_QUOTA_FENCE';
  readonly retryable = false;

  constructor(
    readonly origin: ResolvedQuotaOrigin,
    readonly entry: string,
    detail?: string,
  ) {
    super(
      `Official YouTube quota fence blocked ${entry} (origin=${origin})${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'OfficialYouTubeQuotaFenceError';
  }
}

export function isOfficialYouTubeQuotaFenceError(
  error: unknown,
): error is OfficialYouTubeQuotaFenceError {
  return (
    error instanceof OfficialYouTubeQuotaFenceError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'OFFICIAL_YOUTUBE_QUOTA_FENCE')
  );
}

/**
 * Merges origin evidence. PROBE always wins, then UNKNOWN, then NORMAL.
 * Returns undefined when no evidence was supplied.
 */
export function mergeQuotaOrigins(
  ...origins: Array<QuotaOrigin | ResolvedQuotaOrigin | null | undefined>
): ResolvedQuotaOrigin | undefined {
  let sawUnknown = false;
  let sawNormal = false;
  for (const origin of origins) {
    if (origin === 'PROBE') return 'PROBE';
    if (origin === 'UNKNOWN') sawUnknown = true;
    if (origin === 'NORMAL') sawNormal = true;
  }
  if (sawUnknown) return 'UNKNOWN';
  return sawNormal ? 'NORMAL' : undefined;
}

/** The persisted channel marker can only be NORMAL or PROBE. Fail closed. */
export function persistedQuotaOrigin(
  ...origins: Array<QuotaOrigin | ResolvedQuotaOrigin | null | undefined>
): QuotaOrigin {
  const merged = mergeQuotaOrigins(...origins);
  return merged === 'PROBE' || merged === 'UNKNOWN' ? 'PROBE' : 'NORMAL';
}

export function currentOfficialYouTubeQuotaOrigin(): ResolvedQuotaOrigin {
  return storage.getStore()?.origin ?? 'NORMAL';
}

export function currentOfficialYouTubeQuotaEntry(): string | null {
  return storage.getStore()?.entry ?? null;
}

export function isOfficialYouTubeQuotaOriginKnown(): boolean {
  return currentOfficialYouTubeQuotaOrigin() !== 'UNKNOWN';
}

export function isProbeOfficialYouTubeQuotaOrigin(): boolean {
  return currentOfficialYouTubeQuotaOrigin() === 'PROBE';
}

/**
 * Every official entry point must establish provenance before dispatch. NORMAL
 * and PROBE are both allowed; PROBE spends from the independent probe
 * allocation. UNKNOWN is not allowed to spend and fails closed.
 */
export function assertOfficialYouTubeQuotaOriginKnown(entry: string): void {
  const origin = currentOfficialYouTubeQuotaOrigin();
  if (origin === 'UNKNOWN') {
    throw new OfficialYouTubeQuotaFenceError(origin, entry);
  }
}

/**
 * Runs `fn` inside an explicit quota-origin context.
 *
 * A nested call can only make the context more restrictive. This is important
 * for probe ingestion: even if an inner helper tries to mark work NORMAL, the
 * outer PROBE context remains authoritative.
 */
export function runWithOfficialYouTubeQuotaOrigin<T>(
  origin: ResolvedQuotaOrigin | QuotaOrigin,
  entry: string,
  fn: () => T,
): T {
  const inherited = storage.getStore()?.origin;
  const effective = mergeQuotaOrigins(inherited, origin) ?? 'UNKNOWN';
  return storage.run({ origin: effective, entry }, fn);
}

/**
 * Runs `fn` in an exact origin context, ignoring any inherited context.
 *
 * Only for work that crosses an asynchronous queue boundary: the origin
 * captured when the request was enqueued is authoritative, not the origin of
 * whichever queue drain happens to execute it. Ordinary callers must use
 * `runWithOfficialYouTubeQuotaOrigin` so probe provenance stays sticky.
 */
export function runWithExactOfficialYouTubeQuotaOrigin<T>(
  origin: ResolvedQuotaOrigin | QuotaOrigin,
  entry: string,
  fn: () => T,
): T {
  return storage.run({ origin, entry }, fn);
}
