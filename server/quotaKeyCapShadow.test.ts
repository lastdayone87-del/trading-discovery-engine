import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SHADOW_CAP_UNITS,
  SHADOW_LEASE_TTL_MS,
  classifyShadowWouldBlock,
  parseShadowCapUnits,
  parseShadowLeaseTtlMs,
  recordShadowDispatchSafe,
  resetShadowConfigCacheForTests,
  resetShadowSweepClockForTests,
  resolveShadowConfig,
  simulateShadowReplay,
  sweepShadowEvents,
  sweepShadowLeases,
  type ShadowPoolPort,
  type ShadowQueryClient,
} from './quotaKeyCapShadow';
import { getYouTubeQuotaDay } from './youtubeQuotaDay';

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
  assert.equal(pool.poolQueries.length, 2, 'first call after restart sweeps leases and old events');
  assert.match(pool.poolQueries[0].text, /DELETE FROM youtube_key_cap_shadow_leases WHERE expires_at <= \$1/);
  assert.match(pool.poolQueries[1].text, /DELETE FROM youtube_key_cap_shadow_events WHERE created_at <= \$1/);
  assert.equal(pool.connections.length, 1);
  const connection = pool.connections[0];
  const texts = connection.queries.map((query) => query.text);
  assert.ok(texts.includes('BEGIN'));
  assert.ok(texts.some((text) => text.startsWith('SET LOCAL lock_timeout')));
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
  assert.equal(pool.poolQueries.length, 2, 'sweeps are throttled');
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

test('sweepShadowLeases deletes expired leases and reports the row count', async () => {
  const client: ShadowQueryClient = {
    query: async (text, values) => {
      assert.match(text, /DELETE FROM youtube_key_cap_shadow_leases WHERE expires_at <= \$1/);
      assert.ok(values?.[0] instanceof Date);
      return { rows: [], rowCount: 3 };
    },
  };
  assert.equal(await sweepShadowLeases(client, new Date()), 3);
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
