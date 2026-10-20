import { getYouTubeQuotaDay } from './youtubeQuotaDay';

/**
 * Shadow-only accounting for a projected per-key YouTube daily cap.
 *
 * Hard guarantees:
 *  - Enabled by `youtube_key_cap_shadow_enabled = 'true'` only; absent/other
 *    values are OFF. Read failures disable the shadow (never throw).
 *  - Observational: records leases + WOULD_DEFER/WOULD_REJECT events only.
 *    It never blocks, defers, retries or rewrites official API traffic, key
 *    configuration, quota rows or provider dispatch.
 *  - Cap is the approved 9,000 units/key/day. Settings may only tighten it.
 *  - Duplicate accounting is prevented by UNIQUE(quota_day, operation_id) on
 *    leases and events; stale leases expire (TTL) and are swept on restart
 *    and periodically thereafter.
 */

export const SHADOW_ENABLED_KEY = 'youtube_key_cap_shadow_enabled';
export const SHADOW_CAP_KEY = 'youtube_key_cap_shadow_cap_units';
export const SHADOW_TTL_KEY = 'youtube_key_cap_shadow_lease_ttl_ms';
export const SHADOW_CAP_UNITS = 9000;
export const SHADOW_LEASE_TTL_MS = 120_000;
export const SHADOW_CONFIG_TTL_MS = 30_000;
export const SHADOW_SWEEP_INTERVAL_MS = 60_000;
export const SHADOW_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const SHADOW_EVENT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const SHADOW_LOCK_TIMEOUT_MS = 100;
/** Maximum time a completed provider response waits for the optional shadow
 * observation before the request is released. The background observation is
 * cancelled and any late insert is fenced by the settlement tombstone. */
export const SHADOW_OBSERVATION_BUDGET_MS = 500;
/** Statement bound for shadow-only database work. A timed-out observation is
 * skipped rather than holding a pool connection indefinitely. */
export const SHADOW_STATEMENT_TIMEOUT_MS = 5_000;
/** Lifetime of the inert settlement tombstone. It must outlive any cancelled
 * observation so a late insert cannot recreate a lease or event. */
export const SHADOW_SETTLEMENT_TOMBSTONE_TTL_MS = 15 * 60_000;

export type ShadowEvent = 'WOULD_DEFER' | 'WOULD_REJECT';
export type ShadowSettingReader = (key: string, fallback: string) => Promise<string>;
export interface ShadowConfig {
  enabled: boolean;
  capUnits: number;
  leaseTtlMs: number;
}
export interface ShadowQueryClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

/** Integer 1..9000; malformed or missing values fall back to 9000. */
export function parseShadowCapUnits(raw: unknown): number {
  if (raw === null || raw === undefined) return SHADOW_CAP_UNITS;
  const text = String(raw).trim();
  if (!text) return SHADOW_CAP_UNITS;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return SHADOW_CAP_UNITS;
  return Math.min(SHADOW_CAP_UNITS, Math.max(1, parsed));
}

/** Lease TTL 5s..15min; malformed or missing values fall back to 120s. */
export function parseShadowLeaseTtlMs(raw: unknown): number {
  if (raw === null || raw === undefined) return SHADOW_LEASE_TTL_MS;
  const text = String(raw).trim();
  if (!text) return SHADOW_LEASE_TTL_MS;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return SHADOW_LEASE_TTL_MS;
  return Math.min(900_000, Math.max(5_000, parsed));
}

/**
 * Boundary semantics (approved): projected + request <= cap is admitted.
 * 8999 + 1 = 9000 -> allowed; 9000 + 1 = 9001 -> WOULD_REJECT; when the
 * projection is below the cap but the request would cross it, WOULD_DEFER.
 */
export function classifyShadowWouldBlock(
  projectedUnits: number,
  requestUnits: number,
  capUnits: number
): ShadowEvent | null {
  if (!Number.isFinite(projectedUnits) || !Number.isFinite(requestUnits) || !Number.isFinite(capUnits)) {
    return null;
  }
  if (requestUnits <= 0) return null;
  if (projectedUnits + requestUnits <= capUnits) return null;
  return projectedUnits >= capUnits ? 'WOULD_REJECT' : 'WOULD_DEFER';
}

let cachedConfig: { at: number; config: ShadowConfig } | null = null;

export async function resolveShadowConfig(
  readSetting: ShadowSettingReader,
  now: number = Date.now()
): Promise<ShadowConfig> {
  if (cachedConfig && now - cachedConfig.at < SHADOW_CONFIG_TTL_MS) return cachedConfig.config;
  let enabled = false;
  let capUnits = SHADOW_CAP_UNITS;
  let leaseTtlMs = SHADOW_LEASE_TTL_MS;
  try {
    const [rawEnabled, rawCap, rawTtl] = await Promise.all([
      readSetting(SHADOW_ENABLED_KEY, 'false'),
      readSetting(SHADOW_CAP_KEY, String(SHADOW_CAP_UNITS)),
      readSetting(SHADOW_TTL_KEY, String(SHADOW_LEASE_TTL_MS)),
    ]);
    enabled = String(rawEnabled).trim().toLowerCase() === 'true';
    capUnits = parseShadowCapUnits(rawCap);
    leaseTtlMs = parseShadowLeaseTtlMs(rawTtl);
  } catch {
    enabled = false;
  }
  cachedConfig = { at: now, config: { enabled, capUnits, leaseTtlMs } };
  return cachedConfig.config;
}

export function resetShadowConfigCacheForTests(): void {
  cachedConfig = null;
}

let lastSweepAt = 0;
let lastEventSweepAt = 0;

export function resetShadowSweepClockForTests(): void {
  lastSweepAt = 0;
  lastEventSweepAt = 0;
}

export interface ShadowDispatchInput {
  quotaDay: string;
  keyFingerprint: string;
  operationId: string;
  units: number;
  capUnits: number;
  leaseTtlMs: number;
  now?: Date;
}

export interface ShadowDispatchResult {
  projectedBefore: number;
  event: ShadowEvent | null;
  leaseInserted: boolean;
  lockSkipped: boolean;
}

const DISPATCH_SQL = `
WITH projected AS (
  SELECT COALESCE((
           SELECT units_used FROM youtube_key_quota_usage
            WHERE quota_day = $1 AND key_fingerprint = $2
         ), 0)::int
       + COALESCE((
           SELECT SUM(reserved_units) FROM youtube_key_cap_shadow_leases
            WHERE quota_day = $1 AND key_fingerprint = $2 AND expires_at > $3
              AND operation_id <> $4
         ), 0)::int AS before_units
), settled AS (
  SELECT 1 FROM youtube_key_cap_shadow_settled
   WHERE quota_day = $1 AND operation_id = $4 AND expires_at > $3
), lease AS (
  INSERT INTO youtube_key_cap_shadow_leases
    (quota_day, operation_id, key_fingerprint, reserved_units, reserved_at, expires_at)
  SELECT $1, $4, $2, $5, $3, $6
   WHERE NOT EXISTS (SELECT 1 FROM settled)
  ON CONFLICT (quota_day, operation_id) DO NOTHING
  RETURNING 1 AS inserted
), event AS (
  INSERT INTO youtube_key_cap_shadow_events
    (quota_day, operation_id, key_fingerprint, event, projected_units, request_units, cap_units, created_at)
  SELECT $1, $4, $2,
         CASE WHEN before_units >= $7 THEN 'WOULD_REJECT' ELSE 'WOULD_DEFER' END,
         before_units, $5, $7, $3
    FROM projected
   WHERE before_units + $5 > $7
     -- A settlement tombstone (or a duplicate observation) means this
     -- operation is already accounted; never create a late false event.
     AND EXISTS (SELECT 1 FROM lease)
  ON CONFLICT (quota_day, operation_id) DO NOTHING
  RETURNING event
)
SELECT (SELECT before_units FROM projected) AS projected_before,
       (SELECT count(*) FROM lease)::int AS lease_inserted,
       (SELECT count(*) FROM event)::int AS event_inserted
`;

/**
 * One atomic statement: computes the projection (settled usage + unexpired
 * in-flight leases), inserts the lease idempotently and records the
 * projection event when the request would cross the cap. Pool-safe; no
 * transaction/lock is held at the caller. Concurrent snapshots may
 * collectively over-admit (documented gap); this is observational only.
 */
export async function recordShadowDispatch(
  client: ShadowQueryClient,
  input: ShadowDispatchInput
): Promise<ShadowDispatchResult> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.leaseTtlMs);
  const result = await client.query(DISPATCH_SQL, [
    input.quotaDay,
    input.keyFingerprint,
    now,
    input.operationId,
    input.units,
    expiresAt,
    input.capUnits,
  ]);
  const row = result.rows[0] ?? {};
  const projectedBefore = Number(row.projected_before ?? 0);
  return {
    projectedBefore,
    event: classifyShadowWouldBlock(projectedBefore, input.units, input.capUnits),
    leaseInserted: Number(row.lease_inserted ?? 0) > 0,
    lockSkipped: false,
  };
}

export interface ShadowSettlementInput {
  quotaDay: string;
  keyFingerprint: string;
  units: number;
  /** Exact dispatch operation id when available. Settlement then removes that
   * lease and writes an inert tombstone, so a cancelled/late observation can
   * never recreate the lease or a false cap event. */
  operationId?: string;
  now?: Date;
}

const SETTLE_SQL = `
DELETE FROM youtube_key_cap_shadow_leases
 WHERE id = (
   SELECT id FROM youtube_key_cap_shadow_leases
    WHERE quota_day = $1 AND key_fingerprint = $2 AND reserved_units = $3
      AND expires_at > $4
    ORDER BY reserved_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
 )
`;

const SETTLE_BY_OPERATION_SQL = `
WITH removed AS (
  DELETE FROM youtube_key_cap_shadow_leases
   WHERE quota_day = $1 AND operation_id = $2
   RETURNING 1
)
INSERT INTO youtube_key_cap_shadow_settled
  (quota_day, operation_id, key_fingerprint, settled_at, expires_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (quota_day, operation_id) DO UPDATE
  SET expires_at = GREATEST(youtube_key_cap_shadow_settled.expires_at, EXCLUDED.expires_at)
`;

/**
 * Releases one matching in-flight lease when the official charge settles, so
 * settled usage + leases never double count. With an operation id the release
 * is exact and writes an inert tombstone that fences a late/cancelled
 * observation; without one it falls back to the documented exact-unit match.
 */
export async function settleShadowLease(
  client: ShadowQueryClient,
  input: ShadowSettlementInput
): Promise<boolean> {
  const now = input.now ?? new Date();
  if (input.operationId) {
    const expiresAt = new Date(now.getTime() + SHADOW_SETTLEMENT_TOMBSTONE_TTL_MS);
    const result = await client.query(SETTLE_BY_OPERATION_SQL, [
      input.quotaDay,
      input.operationId,
      input.keyFingerprint,
      now,
      expiresAt,
    ]);
    return (result.rowCount ?? 0) > 0;
  }
  const result = await client.query(SETTLE_SQL, [
    input.quotaDay,
    input.keyFingerprint,
    input.units,
    now,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/** Wraps settlement in a savepoint so a shadow failure can never poison the
 * surrounding quota-charge transaction (migration absent => 42P01, etc.). */
export async function settleShadowLeaseWithSavepoint(
  client: ShadowQueryClient,
  input: ShadowSettlementInput
): Promise<boolean> {
  try {
    await client.query('SAVEPOINT youtube_cap_shadow_settle');
    const settled = await settleShadowLease(client, input);
    await client.query('RELEASE SAVEPOINT youtube_cap_shadow_settle');
    return settled;
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT youtube_cap_shadow_settle').catch(() => undefined);
    await client.query('RELEASE SAVEPOINT youtube_cap_shadow_settle').catch(() => undefined);
    return false;
  }
}

export async function sweepShadowLeases(
  client: ShadowQueryClient,
  now: Date = new Date()
): Promise<number> {
  const [leases, settled] = await Promise.all([
    client.query(`DELETE FROM youtube_key_cap_shadow_leases WHERE expires_at <= $1`, [now]),
    // Settlement tombstones are inert and excluded from projections; once
    // expired they no longer need to fence a late observation.
    client.query(`DELETE FROM youtube_key_cap_shadow_settled WHERE expires_at <= $1`, [now]),
  ]);
  return (leases.rowCount ?? 0) + (settled.rowCount ?? 0);
}

/** Bounded retention for the observational event log (30 days by default). */
export async function sweepShadowEvents(
  client: ShadowQueryClient,
  now: Date = new Date(),
  retentionMs: number = SHADOW_EVENT_RETENTION_MS
): Promise<number> {
  const cutoff = new Date(now.getTime() - Math.max(0, retentionMs));
  const result = await client.query(
    `DELETE FROM youtube_key_cap_shadow_events WHERE created_at <= $1`,
    [cutoff]
  );
  return result.rowCount ?? 0;
}

export interface ShadowConnectionPort extends ShadowQueryClient {
  release?: () => void;
}
export interface ShadowPoolPort {
  query: ShadowQueryClient['query'];
  connect(): Promise<ShadowConnectionPort>;
}
export interface ShadowDispatchDeps {
  readSetting: ShadowSettingReader;
  pool: ShadowPoolPort;
}

const SHADOW_DISPATCH_DISABLED: ShadowDispatchResult = {
  projectedBefore: 0,
  event: null,
  leaseInserted: false,
  lockSkipped: false,
};

/**
 * Guarded dispatch hook: disabled => zero queries; any failure => no-op.
 *
 * Concurrency: one short transaction per observation with a per-key/day
 * advisory lock (`pg_advisory_xact_lock`) bounded by `lock_timeout`
 * (default 100ms). The sweep runs on first use after a restart and at most
 * once per minute. On lock timeout the observation is skipped
 * (lockSkipped=true) rather than delaying the request; this is the only
 * accounting gap under same-key contention and is reported.
 */
export async function recordShadowDispatchSafe(
  deps: ShadowDispatchDeps,
  input: {
    keyFingerprint: string;
    operationId: string;
    units: number;
    now?: Date;
    lockTimeoutMs?: number;
    /** Cancels optional shadow work after the request has been released. */
    signal?: AbortSignal;
  }
): Promise<ShadowDispatchResult> {
  const aborted = (): boolean => input.signal?.aborted === true;
  try {
    if (aborted()) return SHADOW_DISPATCH_DISABLED;
    const config = await resolveShadowConfig(deps.readSetting);
    if (!config.enabled || aborted()) return SHADOW_DISPATCH_DISABLED;
    const units = Math.max(1, Math.round(input.units));
    const operationId = String(input.operationId || '');
    if (!input.keyFingerprint || !operationId || !Number.isFinite(units)) return SHADOW_DISPATCH_DISABLED;
    const now = input.now ?? new Date();
    if (now.getTime() - lastSweepAt >= SHADOW_SWEEP_INTERVAL_MS) {
      lastSweepAt = now.getTime();
      await sweepShadowLeases(deps.pool, now).catch(() => 0);
      if (aborted()) return SHADOW_DISPATCH_DISABLED;
    }
    if (now.getTime() - lastEventSweepAt >= SHADOW_EVENT_SWEEP_INTERVAL_MS) {
      lastEventSweepAt = now.getTime();
      await sweepShadowEvents(deps.pool, now).catch(() => 0);
    }
    const quotaDay = getYouTubeQuotaDay(now);
    const lockTimeoutMs = Math.max(
      1,
      Math.min(5000, Math.round(Number(input.lockTimeoutMs ?? SHADOW_LOCK_TIMEOUT_MS)))
    );
    const client = await deps.pool.connect();
    if (aborted()) {
      client.release?.();
      return SHADOW_DISPATCH_DISABLED;
    }
    try {
      await client.query('BEGIN');
      // One round trip for both bounds: the lock wait is short, and the
      // remaining shadow-only statements cannot hold the connection after
      // the caller's observation budget.
      await client.query(
        `SET LOCAL lock_timeout = '${lockTimeoutMs}ms'; SET LOCAL statement_timeout = '${SHADOW_STATEMENT_TIMEOUT_MS}ms'`
      );
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `youtube-key-cap-shadow:${quotaDay}:${input.keyFingerprint}`,
        ]);
      } catch (lockError) {
        await client.query('ROLLBACK').catch(() => undefined);
        if ((lockError as { code?: unknown } | null)?.code === '55P03') {
          return { ...SHADOW_DISPATCH_DISABLED, lockSkipped: true };
        }
        throw lockError;
      }
      if (aborted()) {
        await client.query('ROLLBACK').catch(() => undefined);
        return SHADOW_DISPATCH_DISABLED;
      }
      const result = await recordShadowDispatch(client, {
        quotaDay,
        keyFingerprint: input.keyFingerprint,
        operationId,
        units,
        capUnits: config.capUnits,
        leaseTtlMs: config.leaseTtlMs,
        now,
      });
      if (aborted()) {
        await client.query('ROLLBACK').catch(() => undefined);
        return SHADOW_DISPATCH_DISABLED;
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release?.();
    }
  } catch {
    return SHADOW_DISPATCH_DISABLED;
  }
}

// ---------------------------------------------------------------------------
// Replay simulation (pure; shared by scripts/quota_shadow_replay.ts and tests)
// ---------------------------------------------------------------------------

export interface ShadowReplayCall {
  occurredAtMs: number;
  latencyMs: number;
  keyFingerprint: string;
  reservedUnits: number;
  settledUnits: number;
  day?: string;
}

export interface ShadowReplayKeyDay {
  allowed: number;
  wouldDefer: number;
  wouldReject: number;
  settledUnits: number;
  peakInFlight: number;
}

export interface ShadowReplaySummary {
  capUnits: number;
  settledOnly: boolean;
  totalAllowed: number;
  totalWouldDefer: number;
  totalWouldReject: number;
  peakInFlight: number;
  byDay: Record<string, { allowed: number; wouldDefer: number; wouldReject: number; settledUnits: number; byKey: Record<string, ShadowReplayKeyDay> }>;
}

export function simulateShadowReplay(
  calls: ShadowReplayCall[],
  options: { capUnits?: number; settledOnly?: boolean } = {}
): ShadowReplaySummary {
  const capUnits = options.capUnits ?? SHADOW_CAP_UNITS;
  const settledOnly = options.settledOnly === true;
  type State = { settled: number; active: Map<number, number>; summary: ShadowReplayKeyDay; dayTotals: ShadowReplaySummary['byDay'][string] };
  const states = new Map<string, State>();
  const callLatency = (call: ShadowReplayCall): number =>
    Number.isFinite(call.latencyMs) && call.latencyMs > 0 ? call.latencyMs : 0;
  const dispatchDay = (call: ShadowReplayCall): string =>
    call.day ?? getYouTubeQuotaDay(new Date(call.occurredAtMs - callLatency(call)));
  const settleDay = (call: ShadowReplayCall): string =>
    call.day ?? getYouTubeQuotaDay(new Date(call.occurredAtMs));
  const stateFor = (day: string, key: string): State => {
    const id = `${day}|${key}`;
    let state = states.get(id);
    if (!state) {
      state = {
        settled: 0,
        active: new Map(),
        summary: { allowed: 0, wouldDefer: 0, wouldReject: 0, settledUnits: 0, peakInFlight: 0 },
        dayTotals: { allowed: 0, wouldDefer: 0, wouldReject: 0, settledUnits: 0, byKey: {} },
      };
      states.set(id, state);
    }
    return state;
  };
  const summary: ShadowReplaySummary = {
    capUnits,
    settledOnly,
    totalAllowed: 0,
    totalWouldDefer: 0,
    totalWouldReject: 0,
    peakInFlight: 0,
    byDay: {},
  };
  const events: Array<{ t: number; kind: 0 | 1; index: number }> = [];
  calls.forEach((call, index) => {
    if (!(call.reservedUnits > 0)) return;
    const latency = Number.isFinite(call.latencyMs) && call.latencyMs > 0 ? call.latencyMs : 0;
    events.push({ t: call.occurredAtMs - latency, kind: 0, index });
    events.push({ t: call.occurredAtMs, kind: 1, index });
  });
  events.sort((a, b) => (a.t === b.t ? a.kind - b.kind : a.t - b.t));
  const allowed = new Set<number>();
  const leaseState = new Map<number, { state: State; key: string }>();
  for (const event of events) {
    const call = calls[event.index];
    const key = call.keyFingerprint;
    const dispatchState = stateFor(dispatchDay(call), key);
    if (event.kind === 0) {
      const activeUnits = settledOnly
        ? 0
        : Array.from(dispatchState.active.values()).reduce((sum, units) => sum + units, 0);
      const wouldBlock = classifyShadowWouldBlock(
        dispatchState.settled + activeUnits,
        call.reservedUnits,
        capUnits
      );
      if (wouldBlock) {
        dispatchState.summary[wouldBlock === 'WOULD_DEFER' ? 'wouldDefer' : 'wouldReject'] += 1;
        dispatchState.dayTotals[wouldBlock === 'WOULD_DEFER' ? 'wouldDefer' : 'wouldReject'] += 1;
        summary[wouldBlock === 'WOULD_DEFER' ? 'totalWouldDefer' : 'totalWouldReject'] += 1;
        continue;
      }
      allowed.add(event.index);
      leaseState.set(event.index, { state: dispatchState, key });
      dispatchState.active.set(event.index, call.reservedUnits);
      dispatchState.summary.allowed += 1;
      dispatchState.summary.peakInFlight = Math.max(
        dispatchState.summary.peakInFlight,
        dispatchState.active.size
      );
      dispatchState.dayTotals.allowed += 1;
      summary.peakInFlight = Math.max(summary.peakInFlight, dispatchState.active.size);
    } else if (allowed.has(event.index)) {
      const settledUnits = Number.isFinite(call.settledUnits) ? call.settledUnits : call.reservedUnits;
      const lease = leaseState.get(event.index);
      const dispatch = lease?.state ?? dispatchState;
      dispatch.active.delete(event.index);
      // The official charge settles on the completion day. Keep admission
      // capacity on the dispatch day (where the lease was created); only the
      // settled usage moves to the completion day when they differ.
      const settleState = stateFor(settleDay(call), lease?.key ?? key);
      settleState.settled += settledUnits;
      settleState.summary.settledUnits += settledUnits;
      settleState.dayTotals.settledUnits += settledUnits;
    }
  }
  for (const [id, state] of states) {
    const [day, key] = id.split('|');
    if (!summary.byDay[day]) {
      summary.byDay[day] = { allowed: 0, wouldDefer: 0, wouldReject: 0, settledUnits: 0, byKey: {} };
    }
    const dayTotals = summary.byDay[day];
    dayTotals.allowed += state.dayTotals.allowed;
    dayTotals.wouldDefer += state.dayTotals.wouldDefer;
    dayTotals.wouldReject += state.dayTotals.wouldReject;
    dayTotals.settledUnits += state.dayTotals.settledUnits;
    dayTotals.byKey[key] = state.summary;
  }
  summary.totalAllowed = Object.values(summary.byDay).reduce((sum, day) => sum + day.allowed, 0);
  return summary;
}
