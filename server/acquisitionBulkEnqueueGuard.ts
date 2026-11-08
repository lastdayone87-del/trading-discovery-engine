/**
 * Phase 0 bulk-enqueue guard.
 *
 * Historical incident shape: a producer loop can enqueue hundreds of durable
 * jobs in one burst, and the queue has no admission bound. Phase 0 only
 * measures and offers a default-off cap; Phase 1 owns scheduling.
 *
 * Semantics:
 *
 *   * A "transaction" is either an explicit `withBulkEnqueueTransaction`
 *     scope, or one caller-supplied database client (`clientOverride`), which
 *     is how existing recovery sweeps share one SQL transaction.
 *   * The >250-per-transaction warning is ALWAYS on. Enforcement is behind
 *     `ACQUISITION_BULK_ENQUEUE_GUARD_ENABLED` (default false).
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
  kind?: 'transaction' | 'hour';
  used?: number;
  limit?: number;
  warned?: boolean;
}

interface TransactionState {
  label: string;
  count: number;
  warned: boolean;
}

export class BulkEnqueueGuardError extends Error {
  readonly code: 'BULK_ENQUEUE_TRANSACTION_CAP_EXCEEDED' | 'BULK_ENQUEUE_HOURLY_CAP_EXCEEDED';
  readonly kind: 'transaction' | 'hour';
  readonly limit: number;

  constructor(kind: 'transaction' | 'hour', limit: number) {
    const code = kind === 'transaction'
      ? 'BULK_ENQUEUE_TRANSACTION_CAP_EXCEEDED'
      : 'BULK_ENQUEUE_HOURLY_CAP_EXCEEDED';
    super(`${code}: ${limit} acquisition jobs already admitted in this ${kind === 'transaction' ? 'transaction' : 'hour'}`);
    this.name = 'BulkEnqueueGuardError';
    this.code = code;
    this.kind = kind;
    this.limit = limit;
  }
}

/** A logical batch context for callers that do not share a SQL client. */
const bulkEnqueueScope = new AsyncLocalStorage<TransactionState>();
let clientScopes = new WeakMap<object, TransactionState>();
let hourAdmissions: number[] = [];

function boundedLabel(value: unknown): string {
  const flat = String(value || 'bulk-enqueue').replace(/\s+/g, ' ').trim();
  return flat.slice(0, MAX_LABEL_LENGTH) || 'bulk-enqueue';
}

function transactionStateFor(client: unknown): TransactionState | undefined {
  if (typeof client === 'object' && client !== null) {
    let state = clientScopes.get(client);
    if (!state) {
      state = { label: 'db-client-transaction', count: 0, warned: false };
      clientScopes.set(client, state);
    }
    return state;
  }
  if (typeof client === 'function') {
    let state = clientScopes.get(client as unknown as object);
    if (!state) {
      state = { label: 'db-client-transaction', count: 0, warned: false };
      clientScopes.set(client as unknown as object, state);
    }
    return state;
  }
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

/**
 * Reserve one enqueue slot. Called by `enqueueJob` before the INSERT. When the
 * guard is disabled this only counts and warns, so production behavior is
 * unchanged apart from bounded observability.
 */
export function admitBulkEnqueue(input: {
  client?: unknown;
  label?: string;
  now?: number;
  config?: BulkEnqueueGuardConfig;
} = {}): BulkEnqueueGuardDecision {
  const config = input.config || resolveBulkEnqueueGuardConfig();
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const state = transactionStateFor(input.client);
  if (state && input.label) state.label = boundedLabel(input.label);

  if (config.enabled) {
    if (state && state.count >= config.maxPerTransaction) {
      bumpBulkEnqueueGuardBlock('transaction');
      return { allowed: false, kind: 'transaction', used: state.count, limit: config.maxPerTransaction };
    }
    const cutoff = now - HOUR_MS;
    while (hourAdmissions.length && hourAdmissions[0] <= cutoff) hourAdmissions.shift();
    if (hourAdmissions.length >= config.maxPerHour) {
      bumpBulkEnqueueGuardBlock('hour');
      return { allowed: false, kind: 'hour', used: hourAdmissions.length, limit: config.maxPerHour };
    }
  }

  if (state) {
    state.count += 1;
    warnBulkEnqueue(state, now);
  }
  if (config.enabled) hourAdmissions.push(now);
  return {
    allowed: true,
    used: state?.count,
    limit: config.maxPerTransaction,
    warned: state?.warned,
  };
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
  return bulkEnqueueScope.run({ label: boundedLabel(label), count: 0, warned: false }, operation);
}

/** Snapshot for tests/diagnostics; the durable record is lane/orchestration telemetry. */
export function bulkEnqueueGuardSnapshot(): {
  config: BulkEnqueueGuardConfig;
  hourlyAdmissions: number;
  scopes: number;
} {
  let scopes = 0;
  // WeakMap is not enumerable; scopes requested by callers are counted via the
  // async scope only. Exposed for test observability, not capacity accounting.
  if (bulkEnqueueScope.getStore()) scopes += 1;
  return {
    config: resolveBulkEnqueueGuardConfig(),
    hourlyAdmissions: hourAdmissions.length,
    scopes,
  };
}

/** Test-only reset; never called from serving paths. */
export function resetBulkEnqueueGuardForTests(): void {
  clientScopes = new WeakMap<object, TransactionState>();
  hourAdmissions = [];
}
