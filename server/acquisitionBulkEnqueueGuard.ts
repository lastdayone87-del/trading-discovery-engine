/**
 * Phase 0 bulk-enqueue guard.
 *
 * Historical incident shape: a producer loop can enqueue hundreds of durable
 * jobs in one burst, and the queue has no admission bound. Phase 0 only
 * measures and offers a default-off cap; Phase 1 owns scheduling.
 *
 * Semantics:
 *
 *   * A "transaction" is an explicit `withBulkEnqueueTransaction` scope.
 *     Caller-supplied database clients are deliberately not scopes: pools
 *     reuse clients after release(), so per-client counters would grow forever
 *     and eventually reject unrelated enqueues.
 *   * The >250-per-transaction warning is ALWAYS on for explicit scopes, and a
 *     rolling 60s / >250 warning catches scope-less bulk producers. Enforcement
 *     is behind `ACQUISITION_BULK_ENQUEUE_GUARD_ENABLED` (default false).
 *   * A blocked enqueue throws a typed error. Silently dropping work would be
 *     worse than failing the producer, so callers can retry/split the batch.
 *   * The tracker is process-local. It is not a distributed rate limiter and
 *     never claims to be one.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { bumpBulkEnqueueGuardBlock, bumpBulkEnqueueWarning } from './operationsTelemetry';

export const BULK_ENQUEUE_GUARD_ENABLED_ENV = 'ACQUISITION_BULK_ENQUEUE_GUARD_ENABLED';
export const BULK_ENQUEUE_MAX_PER_TRANSACTION_ENV = 'ACQUISITION_BULK_ENQUEUE_MAX_PER_TRANSACTION';
export const BULK_ENQUEUE_MAX_PER_HOUR_ENV = 'ACQUISITION_BULK_ENQUEUE_MAX_PER_HOUR';

/** Always-on warning threshold; not configurable, so a flood is never silent. */
export const BULK_ENQUEUE_TRANSACTION_WARNING_THRESHOLD = 250;
export const DEFAULT_BULK_ENQUEUE_MAX_PER_TRANSACTION = 250;
export const DEFAULT_BULK_ENQUEUE_MAX_PER_HOUR = 500;

const HOUR_MS = 60 * 60 * 1000;
const MAX_CONFIGURED_CAP = 1_000_000;
const MAX_LABEL_LENGTH = 96;

export interface BulkEnqueueGuardConfig {
  enabled: boolean;
  maxPerTransaction: number;
  maxPerHour: number;
}

function envFlag(value: unknown): boolean {
  return String(value || '').trim().toLowerCase() === 'true';
}

function boundedCap(value: unknown, fallback: number): number {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_CONFIGURED_CAP, Math.max(1, Math.floor(parsed)));
}

export function resolveBulkEnqueueGuardConfig(env: NodeJS.ProcessEnv = process.env): BulkEnqueueGuardConfig {
  return {
    enabled: envFlag(env[BULK_ENQUEUE_GUARD_ENABLED_ENV]),
    maxPerTransaction: boundedCap(
      env[BULK_ENQUEUE_MAX_PER_TRANSACTION_ENV],
      DEFAULT_BULK_ENQUEUE_MAX_PER_TRANSACTION,
    ),
    maxPerHour: boundedCap(env[BULK_ENQUEUE_MAX_PER_HOUR_ENV], DEFAULT_BULK_ENQUEUE_MAX_PER_HOUR),
  };
}

export interface BulkEnqueueGuardDecision {
  allowed: boolean;
  kind?: 'transaction' | 'window' | 'hour';
  used?: number;
  limit?: number;
  warned?: boolean;
  /** Opaque reservation released when the durable INSERT fails or is a no-op. */
  reservation?: BulkEnqueueReservation;
}

interface TransactionState {
  label: string;
  labelLocked?: boolean;
  count: number;
  warned: boolean;
}

interface BulkEnqueueReservation {
  state?: TransactionState;
  transactionId?: number;
  hourId?: number;
  released?: boolean;
}

export class BulkEnqueueGuardError extends Error {
  readonly code: 'BULK_ENQUEUE_TRANSACTION_CAP_EXCEEDED' | 'BULK_ENQUEUE_WINDOW_CAP_EXCEEDED' | 'BULK_ENQUEUE_HOURLY_CAP_EXCEEDED';
  readonly kind: 'transaction' | 'window' | 'hour';
  readonly limit: number;

  constructor(kind: 'transaction' | 'window' | 'hour', limit: number) {
    const code = kind === 'transaction'
      ? 'BULK_ENQUEUE_TRANSACTION_CAP_EXCEEDED'
      : kind === 'window'
        ? 'BULK_ENQUEUE_WINDOW_CAP_EXCEEDED'
        : 'BULK_ENQUEUE_HOURLY_CAP_EXCEEDED';
    const scope = kind === 'transaction' ? 'transaction' : kind === 'window' ? '60s window' : 'hour';
    super(`${code}: ${limit} acquisition jobs already admitted in this ${scope}`);
    this.name = 'BulkEnqueueGuardError';
    this.code = code;
    this.kind = kind;
    this.limit = limit;
  }
}

/**
 * A logical batch context. Counters are intentionally NOT keyed to a database
 * client: pools reuse clients after release(), so per-client state would grow
 * forever and eventually reject unrelated enqueues. Callers that want the
 * per-transaction cap declare the batch with withBulkEnqueueTransaction().
 */
const bulkEnqueueScope = new AsyncLocalStorage<TransactionState>();
let hourAdmissions: Array<{ id: number; at: number }> = [];
let rollingAdmissions: Array<{ id: number; at: number }> = [];
let rollingWarnedAt = 0;
let reservationSequence = 0;
const ROLLING_WARNING_WINDOW_MS = 60_000;

function boundedLabel(value: unknown): string {
  const flat = String(value || 'bulk-enqueue').replace(/\s+/g, ' ').trim();
  return flat.slice(0, MAX_LABEL_LENGTH) || 'bulk-enqueue';
}

function transactionStateFor(): TransactionState | undefined {
  return bulkEnqueueScope.getStore();
}

function warnBulkEnqueue(state: TransactionState, now: number): void {
  if (state.warned || state.count <= BULK_ENQUEUE_TRANSACTION_WARNING_THRESHOLD) return;
  state.warned = true;
  bumpBulkEnqueueWarning();
  console.warn(JSON.stringify({
    event: 'bulk_enqueue_transaction_warning',
    scope: state.label,
    admitted: state.count,
    threshold: BULK_ENQUEUE_TRANSACTION_WARNING_THRESHOLD,
    enforcementEnabled: resolveBulkEnqueueGuardConfig().enabled,
    timestamp: new Date(now).toISOString(),
  }));
}

function pruneRolling(now: number): void {
  const cutoff = now - ROLLING_WARNING_WINDOW_MS;
  while (rollingAdmissions.length && rollingAdmissions[0].at <= cutoff) rollingAdmissions.shift();
}

/** Always-on backstop for scope-less producers: no client object can opt out. */
function warnRollingBulkEnqueue(now: number): void {
  pruneRolling(now);
  if (rollingAdmissions.length <= BULK_ENQUEUE_TRANSACTION_WARNING_THRESHOLD) return;
  if (rollingWarnedAt && now - rollingWarnedAt < ROLLING_WARNING_WINDOW_MS) return;
  rollingWarnedAt = now;
  bumpBulkEnqueueWarning();
  console.warn(JSON.stringify({
    event: 'bulk_enqueue_transaction_warning',
    scope: 'process-rolling-60s',
    admitted: rollingAdmissions.length,
    threshold: BULK_ENQUEUE_TRANSACTION_WARNING_THRESHOLD,
    enforcementEnabled: resolveBulkEnqueueGuardConfig().enabled,
    timestamp: new Date(now).toISOString(),
  }));
}

/**
 * Reserve one enqueue slot. Called by `enqueueJob` before the INSERT. When the
 * guard is disabled this only counts and warns, so production behavior is
 * unchanged apart from bounded observability. The returned reservation must be
 * released if the durable INSERT fails or is a no-op.
 */
export function admitBulkEnqueue(input: {
  /** @deprecated Clients are not transaction boundaries; use withBulkEnqueueTransaction. */
  client?: unknown;
  label?: string;
  now?: number;
  config?: BulkEnqueueGuardConfig;
} = {}): BulkEnqueueGuardDecision {
  const config = input.config || resolveBulkEnqueueGuardConfig();
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const state = transactionStateFor();
  if (state && input.label && !state.labelLocked) state.label = boundedLabel(input.label);
  pruneRolling(now);

  if (config.enabled) {
    if (state && state.count >= config.maxPerTransaction) {
      bumpBulkEnqueueGuardBlock('transaction');
      return { allowed: false, kind: 'transaction', used: state.count, limit: config.maxPerTransaction };
    }
    // Scope-less producers get the same default budget over a rolling 60s
    // window, so the default-off cap is not merely a warning in production.
    if (!state && rollingAdmissions.length >= config.maxPerTransaction) {
      bumpBulkEnqueueGuardBlock('window');
      return { allowed: false, kind: 'window', used: rollingAdmissions.length, limit: config.maxPerTransaction };
    }
    const cutoff = now - HOUR_MS;
    while (hourAdmissions.length && hourAdmissions[0].at <= cutoff) hourAdmissions.shift();
    if (hourAdmissions.length >= config.maxPerHour) {
      bumpBulkEnqueueGuardBlock('hour');
      return { allowed: false, kind: 'hour', used: hourAdmissions.length, limit: config.maxPerHour };
    }
  }

  const transactionId = ++reservationSequence;
  rollingAdmissions.push({ id: transactionId, at: now });
  if (state) {
    state.count += 1;
    warnBulkEnqueue(state, now);
  } else {
    warnRollingBulkEnqueue(now);
  }
  const hourId = config.enabled ? transactionId : undefined;
  if (hourId !== undefined) hourAdmissions.push({ id: hourId, at: now });
  return {
    allowed: true,
    used: state?.count,
    limit: config.maxPerTransaction,
    warned: state?.warned,
    reservation: { state, transactionId, hourId },
  };
}

/** Mark a reservation as committed; no counter changes. */
export function commitBulkEnqueue(decision?: BulkEnqueueGuardDecision): void {
  if (decision?.reservation) decision.reservation.released = true;
}

/** Release a reservation after a failed or no-op durable insert. */
export function releaseBulkEnqueue(decision?: BulkEnqueueGuardDecision): void {
  const reservation = decision?.reservation;
  if (!reservation || reservation.released) return;
  reservation.released = true;
  if (reservation.state) reservation.state.count = Math.max(0, reservation.state.count - 1);
  if (reservation.hourId !== undefined) {
    hourAdmissions = hourAdmissions.filter(entry => entry.id !== reservation.hourId);
  }
  if (reservation.transactionId !== undefined) {
    rollingAdmissions = rollingAdmissions.filter(entry => entry.id !== reservation.transactionId);
  }
}

/**
 * Run a logical bulk-enqueue batch under one transaction counter. Nested calls
 * reuse the outer scope: a nested helper must never reset the batch budget.
 */
export async function withBulkEnqueueTransaction<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const existing = bulkEnqueueScope.getStore();
  if (existing) return operation();
  return bulkEnqueueScope.run({ label: boundedLabel(label), labelLocked: true, count: 0, warned: false }, operation);
}

/** Snapshot for tests/diagnostics; the durable record is lane/orchestration telemetry. */
export function bulkEnqueueGuardSnapshot(): {
  config: BulkEnqueueGuardConfig;
  hourlyAdmissions: number;
  scopes: number;
} {
  let scopes = 0;
  // Scopes requested by callers are counted via the async scope only. Exposed
  // for test observability, not capacity accounting.
  if (bulkEnqueueScope.getStore()) scopes += 1;
  return {
    config: resolveBulkEnqueueGuardConfig(),
    hourlyAdmissions: hourAdmissions.length,
    scopes,
  };
}

/** Test-only reset; never called from serving paths. */
export function resetBulkEnqueueGuardForTests(): void {
  hourAdmissions = [];
  rollingAdmissions = [];
  rollingWarnedAt = 0;
  reservationSequence = 0;
}
