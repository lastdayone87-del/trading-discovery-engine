import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENFORCED_CAP_UNITS,
  ENFORCED_KEY,
  ENFORCED_LOCK_TIMEOUT_MS,
  ENFORCED_STATEMENT_TIMEOUT_MS,
  SHADOW_CAP_UNITS,
  SHADOW_LEASE_TTL_MS,
  YouTubeKeyCapExceededError,
  YouTubeKeyCapUnavailableError,
  assertKeyCapReservationDayCurrent,
  classifyShadowWouldBlock,
  isYouTubeKeyCapError,
  parseShadowCapUnits,
  parseShadowLeaseTtlMs,
  recordShadowDispatchSafe,
  reserveEnforcedKeyCap,
  reserveYouTubeKeyCap,
  resetKeyCapEnforcementCacheForTests,
  resetShadowConfigCacheForTests,
  resetShadowSweepClockForTests,
  resolveKeyCapEnforcement,
  resolveShadowConfig,
  settleKeyCapReservation,
  settleShadowLease,
  simulateShadowReplay,
  sweepShadowEvents,
  sweepShadowLeases,
  type KeyCapReservationContext,
  type ShadowPoolPort,
  type ShadowQueryClient,
} from './quotaKeyCapShadow';
import { getNextYouTubeQuotaResetAt, getYouTubeQuotaDay } from './youtubeQuotaDay';

type Rows = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type QueryHandler = (text: string, values?: unknown[]) => Rows;

class FakeConnection implements ShadowQueryClient {
  queries: Array<{ text: string; values?: unknown[] }> = [];
  released = false;
  constructor(private readonly handler: QueryHandler) {}
  async query(text: string, values?: unknown[]): Promise<Rows> {
    this.queries.push({ text, values });
    return this.handler(text, values);
  }
  release() {
    this.released = true;
  }
}

class FakePool implements ShadowPoolPort {
  connections: FakeConnection[] = [];
  poolQueries: Array<{ text: string; values?: unknown[] }> = [];
  constructor(private readonly handler: QueryHandler) {}
  connect = async (): Promise<FakeConnection> => {
    const connection = new FakeConnection(this.handler);
    this.connections.push(connection);
    return connection;
  };
  query = async (text: string, values?: unknown[]): Promise<Rows> => {
    this.poolQueries.push({ text, values });
    return { rows: [], rowCount: 0 };
  };
}

const enabledReader = async (key: string, fallback: string): Promise<string> => {
  if (key === 'youtube_key_cap_shadow_enabled') return 'true';
  if (key === 'youtube_key_cap_shadow_cap_units') return String(SHADOW_CAP_UNITS);
  return fallback;
};

function dispatchHandler(overrides: Partial<Record<string, Rows>> = {}): QueryHandler {
  return (text) => {
    if (overrides[text]) return overrides[text]!;
    if (text.includes('WITH projected')) {
      return { rows: [{ projected_before: 8999, lease_inserted: 1, event_inserted: 0 }] };
    }
    return { rows: [] };
  };
}

test('parseShadowCapUnits clamps to 1..9000 and falls back on malformed input', () => {
  assert.equal(parseShadowCapUnits(undefined), SHADOW_CAP_UNITS);
  assert.equal(parseShadowCapUnits(''), SHADOW_CAP_UNITS);
  assert.equal(parseShadowCapUnits('9500'), SHADOW_CAP_UNITS);
  assert.equal(parseShadowCapUnits('9000'), 9000);
  assert.equal(parseShadowCapUnits('4500'), 4500);
  assert.equal(parseShadowCapUnits('0'), 1);
  assert.equal(parseShadowCapUnits('-5'), 1);
  assert.equal(parseShadowCapUnits('abc'), SHADOW_CAP_UNITS);
  assert.equal(parseShadowCapUnits('12.5'), SHADOW_CAP_UNITS);
});

test('parseShadowLeaseTtlMs clamps to 5s..15min with 120s fallback', () => {
  assert.equal(parseShadowLeaseTtlMs(undefined), SHADOW_LEASE_TTL_MS);
  assert.equal(parseShadowLeaseTtlMs('1000'), 5_000);
  assert.equal(parseShadowLeaseTtlMs('99999999'), 900_000);
  assert.equal(parseShadowLeaseTtlMs('30000'), 30_000);
  assert.equal(parseShadowLeaseTtlMs('nope'), SHADOW_LEASE_TTL_MS);
});

test('classifyShadowWouldBlock: 9000 admitted, 9001 blocked, partial fit defers', () => {
  assert.equal(classifyShadowWouldBlock(8999, 1, 9000), null);
  assert.equal(classifyShadowWouldBlock(8998, 2, 9000), null);
  assert.equal(classifyShadowWouldBlock(9000, 1, 9000), 'WOULD_REJECT');
  assert.equal(classifyShadowWouldBlock(9500, 1, 9000), 'WOULD_REJECT');
  assert.equal(classifyShadowWouldBlock(8999, 2, 9000), 'WOULD_DEFER');
  assert.equal(classifyShadowWouldBlock(0, 1, 9000), null);
  assert.equal(classifyShadowWouldBlock(9000, 0, 9000), null);
  assert.equal(classifyShadowWouldBlock(Number.NaN, 1, 9000), null);
});

test('resolveShadowConfig is fail-closed, clamps settings and caches for 30s', async () => {
  resetShadowConfigCacheForTests();
  const calls: string[] = [];
  const reader = async (key: string, fallback: string): Promise<string> => {
    calls.push(key);
    if (key === 'youtube_key_cap_shadow_enabled') return 'true';
    if (key === 'youtube_key_cap_shadow_cap_units') return '4500';
    if (key === 'youtube_key_cap_shadow_lease_ttl_ms') return '30000';
    return fallback;
  };
  const t0 = 1_000_000;
  const config = await resolveShadowConfig(reader, t0);
  assert.deepEqual(config, { enabled: true, capUnits: 4500, leaseTtlMs: 30_000 });
  const before = calls.length;
  const cached = await resolveShadowConfig(reader, t0 + 29_999);
  assert.deepEqual(cached, config);
  assert.equal(calls.length, before, 'second resolve must be served from cache');

  const refreshed = await resolveShadowConfig(reader, t0 + 30_001);
  assert.deepEqual(refreshed, config);
  assert.equal(calls.length, before + 3, 'expired cache must re-read all three settings');

  resetShadowConfigCacheForTests();
  const failingReader = async (): Promise<string> => {
    throw new Error('settings unavailable');
  };
  const failed = await resolveShadowConfig(failingReader);
  assert.deepEqual(failed, { enabled: false, capUnits: SHADOW_CAP_UNITS, leaseTtlMs: SHADOW_LEASE_TTL_MS });
});

test('recordShadowDispatchSafe disabled: zero queries and no connection', async () => {
  resetShadowConfigCacheForTests();
  resetShadowSweepClockForTests();
  const pool = new FakePool(dispatchHandler());
  const result = await recordShadowDispatchSafe(
    { readSetting: async () => 'false', pool },
    { keyFingerprint: 'fp-disabled', operationId: 'op-disabled', units: 1 }
  );
  assert.deepEqual(result, { projectedBefore: 0, event: null, leaseInserted: false, lockSkipped: false });
  assert.equal(pool.connections.length, 0);
  assert.equal(pool.poolQueries.length, 0);
});

test('recordShadowDispatchSafe enabled: sweeps, locks, records and commits', async () => {
  resetShadowConfigCacheForTests();
  resetShadowSweepClockForTests();
  const pool = new FakePool(dispatchHandler());
  const now = new Date('2026-10-16T07:30:00.000Z');
  const result = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool },
    { keyFingerprint: 'fp-enabled', operationId: 'op-enabled', units: 2, now }
  );
  // 8999 projected + 2 requested = 9001 -> WOULD_DEFER
  assert.deepEqual(result, { projectedBefore: 8999, event: 'WOULD_DEFER', leaseInserted: true, lockSkipped: false });
  assert.equal(pool.poolQueries.length, 3, 'first call after restart sweeps stale leases, settlement tombstones, and old events');
  assert.match(pool.poolQueries[0].text, /DELETE FROM youtube_key_cap_shadow_leases WHERE expires_at <= \$1/);
  assert.match(pool.poolQueries[1].text, /DELETE FROM youtube_key_cap_shadow_settled WHERE expires_at <= \$1/);
  assert.match(pool.poolQueries[2].text, /DELETE FROM youtube_key_cap_shadow_events WHERE created_at <= \$1/);
  assert.equal(pool.connections.length, 1);
  const connection = pool.connections[0];
  const texts = connection.queries.map((query) => query.text);
  assert.ok(texts.includes('BEGIN'));
  assert.ok(texts.some((text) => /SET LOCAL lock_timeout.*SET LOCAL statement_timeout/.test(text)));
  const lockQuery = connection.queries.find((query) => query.text.includes('pg_advisory_xact_lock'));
  assert.ok(lockQuery, 'advisory lock taken');
  assert.equal(
    lockQuery!.values?.[0],
    `youtube-key-cap-shadow:${getYouTubeQuotaDay(now)}:fp-enabled`
  );
  assert.ok(texts.includes('COMMIT'));
  assert.ok(!texts.includes('ROLLBACK'));
  assert.ok(connection.released);

  const second = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool },
    { keyFingerprint: 'fp-enabled', operationId: 'op-enabled-2', units: 1, now: new Date(now.getTime() + 1000) }
  );
  assert.equal(pool.poolQueries.length, 3, 'sweeps are throttled');
  assert.equal(second.event, null, '8999 + 1 = 9000 stays admitted');
});

test('recordShadowDispatchSafe lock timeout skips the observation without blocking', async () => {
  resetShadowConfigCacheForTests();
  resetShadowSweepClockForTests();
  const pool = new FakePool((text) => {
    if (text.includes('pg_advisory_xact_lock')) {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    }
    return { rows: [] };
  });
  const result = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool },
    { keyFingerprint: 'fp-timeout', operationId: 'op-timeout', units: 1 }
  );
  assert.deepEqual(result, { projectedBefore: 0, event: null, leaseInserted: false, lockSkipped: true });
  const texts = pool.connections[0].queries.map((query) => query.text);
  assert.ok(texts.includes('ROLLBACK'));
  assert.ok(!texts.some((text) => text.startsWith('WITH projected')), 'no lease recorded on skip');
  assert.ok(pool.connections[0].released);
});

test('recordShadowDispatchSafe swallows infrastructure failures entirely', async () => {
  resetShadowConfigCacheForTests();
  resetShadowSweepClockForTests();
  const pool: ShadowPoolPort = {
    query: async () => ({ rows: [] }),
    connect: async () => {
      throw new Error('pool exhausted');
    },
  };
  const result = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool },
    { keyFingerprint: 'fp-down', operationId: 'op-down', units: 1 }
  );
  assert.deepEqual(result, { projectedBefore: 0, event: null, leaseInserted: false, lockSkipped: false });
});

test('settlement by operation id removes the lease and writes a dedicated tombstone', async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client: ShadowQueryClient = {
    query: async (text, values) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  const settled = await settleShadowLease(client, {
    quotaDay: '2026-10-20',
    keyFingerprint: 'fp-tombstone',
    units: 1,
    operationId: 'shadow:op-tombstone',
  });
  assert.equal(settled, true);
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /DELETE FROM youtube_key_cap_shadow_leases/);
  assert.match(queries[0].text, /operation_id = \$2/);
  assert.match(queries[0].text, /INSERT INTO youtube_key_cap_shadow_settled/);
  assert.match(queries[0].text, /ON CONFLICT \(quota_day, operation_id\) DO UPDATE/);
  assert.equal(queries[0].values?.[1], 'shadow:op-tombstone');
});

test('aborted shadow observation performs no queries or connection work', async () => {
  resetShadowConfigCacheForTests();
  resetShadowSweepClockForTests();
  const pool = new FakePool(dispatchHandler());
  const controller = new AbortController();
  controller.abort();
  const result = await recordShadowDispatchSafe(
    { readSetting: enabledReader, pool },
    { keyFingerprint: 'fp-aborted', operationId: 'op-aborted', units: 1, signal: controller.signal }
  );
  assert.deepEqual(result, { projectedBefore: 0, event: null, leaseInserted: false, lockSkipped: false });
  assert.equal(pool.connections.length, 0);
  assert.equal(pool.poolQueries.length, 0);
});

test('sweepShadowLeases deletes expired leases and settlement tombstones', async () => {
  const seen: string[] = [];
  const client: ShadowQueryClient = {
    query: async (text, values) => {
      seen.push(text);
      assert.ok(values?.[0] instanceof Date);
      return { rows: [], rowCount: text.includes('youtube_key_cap_shadow_settled') ? 2 : 3 };
    },
  };
  assert.equal(await sweepShadowLeases(client, new Date()), 5);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /DELETE FROM youtube_key_cap_shadow_leases WHERE expires_at <= \$1/);
  assert.match(seen[1], /DELETE FROM youtube_key_cap_shadow_settled WHERE expires_at <= \$1/);
});

test('sweepShadowEvents deletes observations older than the retention window', async () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  let cutoff: Date | undefined;
  const client: ShadowQueryClient = {
    query: async (text, values) => {
      assert.match(text, /DELETE FROM youtube_key_cap_shadow_events WHERE created_at <= \$1/);
      cutoff = values?.[0] as Date;
      return { rows: [], rowCount: 2 };
    },
  };
  assert.equal(await sweepShadowEvents(client, now), 2);
  assert.equal(cutoff?.toISOString(), '2026-09-20T12:00:00.000Z');
});

test('simulateShadowReplay: boundary exactly at 9000 admitted, 9001 rejected', () => {
  const day = '2026-10-16';
  const calls = [
    { occurredAtMs: 1_000, latencyMs: 0, keyFingerprint: 'k1', reservedUnits: 8999, settledUnits: 8999, day },
    { occurredAtMs: 2_000, latencyMs: 0, keyFingerprint: 'k1', reservedUnits: 1, settledUnits: 1, day },
    { occurredAtMs: 3_000, latencyMs: 0, keyFingerprint: 'k1', reservedUnits: 1, settledUnits: 1, day },
  ];
  const summary = simulateShadowReplay(calls);
  assert.equal(summary.totalAllowed, 2);
  assert.equal(summary.totalWouldReject, 1);
  assert.equal(summary.totalWouldDefer, 0);
  assert.equal(summary.byDay[day].byKey.k1.settledUnits, 9000);
});

test('simulateShadowReplay: in-flight leases prevent concurrent over-admission', () => {
  const day = '2026-10-16';
  const calls = [
    { occurredAtMs: 10_000, latencyMs: 1_000, keyFingerprint: 'k1', reservedUnits: 6, settledUnits: 6, day },
    { occurredAtMs: 10_500, latencyMs: 500, keyFingerprint: 'k1', reservedUnits: 6, settledUnits: 6, day },
  ];
  const withLeases = simulateShadowReplay(calls, { capUnits: 10 });
  assert.equal(withLeases.totalAllowed, 1);
  assert.equal(withLeases.totalWouldDefer, 1);
  assert.equal(withLeases.byDay[day].byKey.k1.peakInFlight, 1);

  const settledOnly = simulateShadowReplay(calls, { capUnits: 10, settledOnly: true });
  assert.equal(settledOnly.totalAllowed, 2, 'settled-only projection misses the concurrent lease');
  assert.equal(settledOnly.totalWouldDefer, 0);
});

test('simulateShadowReplay: cross-midnight settlement stays on completion day', () => {
  // Completion just after Pacific midnight; dispatch was 60s before midnight.
  const completion = Date.parse('2026-10-16T07:00:30.000Z');
  const summary = simulateShadowReplay([
    {
      occurredAtMs: completion,
      latencyMs: 60_000,
      keyFingerprint: 'k1',
      reservedUnits: 9000,
      settledUnits: 9000,
    },
  ]);
  assert.equal(summary.byDay['2026-10-15'].allowed, 1);
  assert.equal(summary.byDay['2026-10-15'].settledUnits, 0);
  assert.equal(summary.byDay['2026-10-16'].settledUnits, 9000);
});

test('simulateShadowReplay: settlement releases capacity for later calls', () => {
  const day = '2026-10-16';
  const calls = [
    { occurredAtMs: 10_000, latencyMs: 100, keyFingerprint: 'k1', reservedUnits: 6, settledUnits: 6, day },
    { occurredAtMs: 10_200, latencyMs: 100, keyFingerprint: 'k1', reservedUnits: 6, settledUnits: 6, day },
  ];
  const summary = simulateShadowReplay(calls, { capUnits: 12 });
  assert.equal(summary.totalAllowed, 2);
  assert.equal(summary.byDay[day].byKey.k1.settledUnits, 12);
});

test('simulateShadowReplay: a slow call holds its lease only through the TTL', () => {
  const day = '2026-10-16';
  const calls = [
    // Starts at t=0, completes at t=300s; the lease expires at t=120s.
    { occurredAtMs: 300_000, latencyMs: 300_000, keyFingerprint: 'k1', reservedUnits: 10, settledUnits: 10, day },
    // At t=100s the slow call is still inside its lease window and must block.
    { occurredAtMs: 100_000, latencyMs: 0, keyFingerprint: 'k1', reservedUnits: 10, settledUnits: 10, day },
  ];
  const summary = simulateShadowReplay(calls, { capUnits: 10 });
  assert.equal(summary.totalAllowed, 1);
  assert.equal(summary.totalWouldReject, 1);
  assert.equal(summary.byDay[day].byKey.k1.settledUnits, 10);
});

test('simulateShadowReplay: an expiring lease frees capacity at the exact TTL instant', () => {
  const day = '2026-10-16';
  const calls = [
    // Dispatches at t=0, completes and expires at t=120s.
    { occurredAtMs: SHADOW_LEASE_TTL_MS, latencyMs: SHADOW_LEASE_TTL_MS, keyFingerprint: 'k1', reservedUnits: 10, settledUnits: 10, day },
    // Dispatches at the exact instant the first lease expires.
    { occurredAtMs: SHADOW_LEASE_TTL_MS, latencyMs: 0, keyFingerprint: 'k1', reservedUnits: 10, settledUnits: 10, day },
  ];
  const summary = simulateShadowReplay(calls, { capUnits: 10 });
  assert.equal(summary.totalAllowed, 2);
  assert.equal(summary.totalWouldDefer + summary.totalWouldReject, 0);
});

// ---------------------------------------------------------------------------
// Hard enforcement (default OFF) — pure/unit coverage with mock clients
// ---------------------------------------------------------------------------

function enforcementHandler(
  projected: number,
  options: {
    existing?: Record<string, unknown> | null;
    insert?: boolean;
    failQuery?: string;
    lockCode?: string;
  } = {},
): QueryHandler {
  return (text) => {
    if (options.failQuery && text.includes(options.failQuery)) throw new Error('database unavailable');
    if (text.includes('pg_advisory_xact_lock')) {
      if (options.lockCode) throw Object.assign(new Error('lock failure'), { code: options.lockCode });
      return { rows: [] };
    }
    if (text.includes('SELECT id, key_fingerprint')) {
      return { rows: options.existing ? [options.existing] : [] };
    }
    if (text.includes('SELECT COALESCE((')) {
      return { rows: [{ projected_units: projected }] };
    }
    if (text.includes('INSERT INTO youtube_key_cap_shadow_leases')) {
      return options.insert === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: 'lease-1' }], rowCount: 1 };
    }
    if (text.includes('UPDATE youtube_key_cap_shadow_leases SET expires_at')) return { rows: [] };
    return { rows: [] };
  };
}

const enforcedReader = async (key: string, fallback: string): Promise<string> => {
  if (key === ENFORCED_KEY) return 'true';
  return fallback;
};

test('resolveKeyCapEnforcement is literal-true, caches 30s, and fails closed on settings read errors', async () => {
  resetKeyCapEnforcementCacheForTests();
  assert.equal(await resolveKeyCapEnforcement(async (_key, fallback) => fallback), false, 'absent flag is OFF');
  resetKeyCapEnforcementCacheForTests();
  assert.equal(await resolveKeyCapEnforcement(async () => ' TRUE '), false, 'case/whitespace variants are not activation');
  resetKeyCapEnforcementCacheForTests();
  assert.equal(await resolveKeyCapEnforcement(async () => 'true'), true, 'only literal true enables enforcement');
  const before = Date.now();
  assert.equal(await resolveKeyCapEnforcement(async () => 'false', before + 1_000), true, 'cached true is not bypassed by a transient re-read');
  resetKeyCapEnforcementCacheForTests();
  await assert.rejects(
    resolveKeyCapEnforcement(async () => { throw new Error('settings down'); }),
    (error: unknown) => error instanceof YouTubeKeyCapUnavailableError
      && isYouTubeKeyCapError(error)
      && /enforcement setting/.test((error as Error).message),
    'a cold settings failure is not evidence of OFF'
  );
  resetKeyCapEnforcementCacheForTests();
  const base = Date.now();
  assert.equal(await resolveKeyCapEnforcement(async () => 'false', base), false);
  await assert.rejects(
    resolveKeyCapEnforcement(async () => { throw new Error('settings down'); }, base + 31_000),
    (error: unknown) => error instanceof YouTubeKeyCapUnavailableError,
    'a stale OFF cache cannot outlive a later ON change'
  );
  resetKeyCapEnforcementCacheForTests();
  assert.equal(await resolveKeyCapEnforcement(async () => 'true', base), true);
  await assert.rejects(
    resolveKeyCapEnforcement(async () => { throw new Error('settings down'); }, base + 31_000),
    (error: unknown) => error instanceof YouTubeKeyCapUnavailableError,
    'a previously observed ON state fails closed'
  );
});

test('a reservation that crosses Pacific midnight fails closed before dispatch', () => {
  const context: KeyCapReservationContext = {
    mode: 'enforce', quotaDay: '2026-03-08', operationId: 'op-midnight', keyFingerprint: 'fp-midnight', units: 1,
  };
  assert.doesNotThrow(() => assertKeyCapReservationDayCurrent(context, new Date('2026-03-09T06:59:59.000Z')));
  assert.throws(
    () => assertKeyCapReservationDayCurrent(context, new Date('2026-03-09T07:00:00.000Z')),
    (error: unknown) => error instanceof YouTubeKeyCapUnavailableError
      && /crossed the Pacific quota day/.test((error as Error).message)
  );
});

test('reserveYouTubeKeyCap disabled is a zero-query no-op (legacy behavior preserved)', async () => {
  resetKeyCapEnforcementCacheForTests();
  const pool = new FakePool(enforcementHandler(0));
  const reservation = await reserveYouTubeKeyCap(
    { readSetting: async (_key, fallback) => fallback, pool },
    { keyFingerprint: 'fp-off', operationId: 'op-off', units: 100 }
  );
  assert.equal(reservation, null);
  assert.equal(pool.connections.length, 0);
  assert.equal(pool.poolQueries.length, 0);
});

test('reserveEnforcedKeyCap boundary: 8999 + 1 admitted, 9000 + 1 typed exceeded', async () => {
  resetKeyCapEnforcementCacheForTests();
  const now = new Date('2026-10-16T07:30:00.000Z');
  const day = getYouTubeQuotaDay(now);
  const admittedPool = new FakePool(enforcementHandler(8999));
  const admitted = await reserveEnforcedKeyCap(
    { readSetting: enforcedReader, pool: admittedPool },
    { keyFingerprint: 'fp-boundary', operationId: 'op-boundary-1', units: 1, now }
  );
  assert.equal(admitted.mode, 'enforce');
  assert.equal(admitted.quotaDay, day);
  assert.equal(admitted.projectedBefore, 8999);
  const connection = admittedPool.connections[0];
  const texts = connection.queries.map(query => query.text);
  assert.ok(texts.includes('BEGIN'));
  assert.ok(texts.some(text => text.startsWith(`SET LOCAL lock_timeout = '${ENFORCED_LOCK_TIMEOUT_MS}ms'`)));
  assert.ok(texts.some(text => text.startsWith(`SET LOCAL statement_timeout = '${ENFORCED_STATEMENT_TIMEOUT_MS}ms'`)));
  assert.equal(
    connection.queries.find(query => query.text.includes('pg_advisory_xact_lock'))?.values?.[0],
    `youtube-key-cap-enforce:${day}:fp-boundary`
  );
  assert.ok(texts.includes('COMMIT'));
  assert.ok(connection.released);

  const insert = connection.queries.find(query => query.text.includes('INSERT INTO youtube_key_cap_shadow_leases'));
  assert.ok(insert);
  assert.equal(
    (insert!.values?.[5] as Date).getTime(),
    getNextYouTubeQuotaResetAt(now),
    'enforced leases remain reserved until the Pacific day resets, not a short TTL'
  );

  const deniedPool = new FakePool(enforcementHandler(9000));
  await assert.rejects(
    reserveEnforcedKeyCap(
      { readSetting: enforcedReader, pool: deniedPool },
      { keyFingerprint: 'fp-boundary', operationId: 'op-boundary-2', units: 1, now }
    ),
    (error: unknown) => error instanceof YouTubeKeyCapExceededError
      && error.code === 'YOUTUBE_KEY_CAP_EXCEEDED'
      && error.projectedUnits === 9000
      && error.requestUnits === 1
      && error.capUnits === ENFORCED_CAP_UNITS
      && error.rotateKey === true
      && error.markSuspension === false
  );
  const deniedTexts = deniedPool.connections[0].queries.map(query => query.text);
  assert.ok(deniedTexts.includes('ROLLBACK'));
  assert.ok(!deniedTexts.includes('COMMIT'));
});

test('enforce reservation failures are typed and fail closed (lock, DB, connect)', async () => {
  const now = new Date('2026-10-16T07:30:00.000Z');
  const lockPool = new FakePool(enforcementHandler(0, { lockCode: '55P03' }));
  await assert.rejects(
    reserveEnforcedKeyCap(
      { readSetting: enforcedReader, pool: lockPool },
      { keyFingerprint: 'fp-lock', operationId: 'op-lock', units: 1, now }
    ),
    (error: unknown) => error instanceof YouTubeKeyCapUnavailableError
      && /lock timed out/.test((error as Error).message)
      && isYouTubeKeyCapError(error)
  );
  assert.ok(lockPool.connections[0].queries.map(query => query.text).includes('ROLLBACK'));
  assert.ok(lockPool.connections[0].released);

  const dbPool = new FakePool(enforcementHandler(0, { failQuery: 'SELECT COALESCE((' }));
  await assert.rejects(
    reserveEnforcedKeyCap(
      { readSetting: enforcedReader, pool: dbPool },
      { keyFingerprint: 'fp-db', operationId: 'op-db', units: 1, now }
    ),
    (error: unknown) => error instanceof YouTubeKeyCapUnavailableError && /transaction failed/.test((error as Error).message)
  );

  const downPool: ShadowPoolPort = {
    query: async () => ({ rows: [] }),
    connect: async () => { throw new Error('pool exhausted'); },
  };
  await assert.rejects(
    reserveEnforcedKeyCap(
      { readSetting: enforcedReader, pool: downPool },
      { keyFingerprint: 'fp-down', operationId: 'op-down', units: 1, now }
    ),
    (error: unknown) => error instanceof YouTubeKeyCapUnavailableError && /connection failed/.test((error as Error).message)
  );
});

test('duplicate operation ID is idempotent for the same units and rejects changed units', async () => {
  const now = new Date('2026-10-16T07:30:00.000Z');
  const existing = { id: 'lease-1', key_fingerprint: 'fp-dup', reserved_units: 1 };
  const pool = new FakePool(enforcementHandler(9000, { existing }));
  const reservation = await reserveEnforcedKeyCap(
    { readSetting: enforcedReader, pool },
    { keyFingerprint: 'fp-dup', operationId: 'op-dup', units: 1, now }
  );
  assert.equal(reservation.operationId, 'op-dup');
  const texts = pool.connections[0].queries.map(query => query.text);
  assert.ok(texts.some(text => text.includes('UPDATE youtube_key_cap_shadow_leases SET expires_at')));
  assert.ok(!texts.some(text => text.includes('INSERT INTO youtube_key_cap_shadow_leases')));
  assert.ok(texts.includes('COMMIT'));

  const mismatchPool = new FakePool(enforcementHandler(8999, { existing }));
  await assert.rejects(
    reserveEnforcedKeyCap(
      { readSetting: enforcedReader, pool: mismatchPool },
      { keyFingerprint: 'fp-dup', operationId: 'op-dup', units: 9000, now }
    ),
    (error: unknown) => error instanceof YouTubeKeyCapUnavailableError
      && /different units/.test((error as Error).message)
  );
  const mismatchTexts = mismatchPool.connections[0].queries.map(query => query.text);
  assert.ok(mismatchTexts.includes('ROLLBACK'));
  assert.ok(!mismatchTexts.includes('COMMIT'));
});

test('settleKeyCapReservation uses exact day/operation/key and keeps enforce failures fatal', async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client: ShadowQueryClient = {
    query: async (text, values) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  const context: KeyCapReservationContext = {
    mode: 'enforce', quotaDay: '2026-10-16', operationId: 'op-settle', keyFingerprint: 'fp-settle', units: 1,
  };
  assert.equal(await settleKeyCapReservation(client, context), true);
  assert.match(queries[0].text, /DELETE FROM youtube_key_cap_shadow_leases/);
  assert.match(queries[0].text, /quota_day = \$1 AND operation_id = \$2 AND key_fingerprint = \$3/);
  assert.deepEqual(queries[0].values?.slice(0, 3), ['2026-10-16', 'op-settle', 'fp-settle']);
  assert.equal(queries[0].values?.length, 5);
  assert.ok(queries[0].values?.[3] instanceof Date);
  assert.ok(!queries.some(query => query.text.startsWith('SAVEPOINT')));

  const failing: ShadowQueryClient = {
    query: async () => { throw new Error('settlement down'); },
  };
  await assert.rejects(settleKeyCapReservation(failing, context), /settlement down/);
});

test('shadow context settlement is savepoint-guarded and swallows failure', async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client: ShadowQueryClient = {
    query: async (text, values) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  const context: KeyCapReservationContext = {
    mode: 'shadow', quotaDay: '2026-10-16', operationId: 'op-shadow-settle', keyFingerprint: 'fp-shadow-settle', units: 1,
  };
  assert.equal(await settleKeyCapReservation(client, context), true);
  assert.ok(queries.some(query => query.text === 'SAVEPOINT youtube_cap_shadow_settle'));
  assert.ok(queries.some(query => query.text === 'RELEASE SAVEPOINT youtube_cap_shadow_settle'));

  const failing: ShadowQueryClient = {
    query: async (text) => {
      if (text === 'SAVEPOINT youtube_cap_shadow_settle') return { rows: [] };
      throw new Error('shadow settlement down');
    },
  };
  assert.equal(await settleKeyCapReservation(failing, context), false);
});

test('settleShadowLease exact operation ID releases only that day/key lease', async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client: ShadowQueryClient = {
    query: async (text, values) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  assert.equal(await settleShadowLease(client, {
    quotaDay: '2026-10-16', operationId: 'op-exact', keyFingerprint: 'fp-exact',
  }), true);
  assert.match(queries[0].text, /operation_id = \$2 AND key_fingerprint = \$3/);
  assert.deepEqual(queries[0].values?.slice(0, 3), ['2026-10-16', 'op-exact', 'fp-exact']);
  assert.equal(queries[0].values?.length, 5);
  assert.ok(queries[0].values?.[3] instanceof Date);
});
