import test from 'node:test';
import assert from 'node:assert/strict';
import { claimYouTubeQuotaOperation } from './dbCore';

interface MockState {
  inTxn: boolean;
  aborted: boolean;
  savepoints: boolean[];
  opsTable: boolean;
  ops: Map<string, number>;
  charges: string[];
  failOpsWith: string | null;
}

/** Faithful emulation of the PostgreSQL transaction semantics this guard
 * depends on: any statement error aborts the transaction, and every later
 * statement fails with in_failed_sql_transaction (25P02) until ROLLBACK
 * (or ROLLBACK TO SAVEPOINT, which restores the pre-savepoint state).
 * SAVEPOINT/RELEASE/ROLLBACK TO themselves never fail here. */
function makePgClient(overrides: Partial<Pick<MockState, 'opsTable' | 'failOpsWith'>> = {}) {
  const state: MockState = {
    inTxn: false,
    aborted: false,
    savepoints: [],
    opsTable: true,
    ops: new Map(),
    charges: [],
    failOpsWith: null,
    ...overrides,
  };
  const fail = (code: string): never => {
    state.aborted = true;
    throw Object.assign(new Error(`mock pg ${code}`), { code });
  };
  return {
    state,
    async query(text: string, values: unknown[] = []): Promise<{ rowCount: number; rows: unknown[] }> {
      if (text.startsWith('BEGIN')) {
        state.inTxn = true;
        state.aborted = false;
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith('SAVEPOINT')) {
        state.savepoints.push(state.aborted);
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith('ROLLBACK TO SAVEPOINT')) {
        state.aborted = state.savepoints.pop() || false;
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith('RELEASE SAVEPOINT')) {
        state.savepoints.pop();
        return { rowCount: 0, rows: [] };
      }
      if (text === 'COMMIT') {
        if (state.aborted) fail('25P02');
        state.inTxn = false;
        return { rowCount: 0, rows: [] };
      }
      if (text === 'ROLLBACK') {
        state.aborted = false;
        state.inTxn = false;
        return { rowCount: 0, rows: [] };
      }
      if (text.includes('youtube_quota_accounting_ops')) {
        if (!state.opsTable) fail('42P01');
        if (state.failOpsWith) fail(state.failOpsWith);
        const opId = String(values[0]);
        if (state.ops.has(opId)) return { rowCount: 0, rows: [] };
        state.ops.set(opId, Number(values[3] || 0));
        return { rowCount: 1, rows: [{ op_id: opId }] };
      }
      if (state.aborted) fail('25P02');
      state.charges.push(text.slice(0, 48));
      return { rowCount: 1, rows: [] };
    },
  };
}

/** Replicates the pre-savepoint guard: BEGIN, try the dedup INSERT,
 * swallow only undefined_table, then continue the charge inline. */
async function legacyGuardSequence(client: { query: (t: string, v?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }> }, opId: string): Promise<void> {
  await client.query('BEGIN');
  try {
    const seen = await client.query(`INSERT INTO youtube_quota_accounting_ops(op_id) VALUES($1) ON CONFLICT(op_id) DO NOTHING RETURNING op_id`, [opId]);
    if ((seen.rowCount || 0) === 0) {
      await client.query('COMMIT');
      return;
    }
  } catch (guardError) {
    if ((guardError as { code?: unknown } | null)?.code !== '42P01') throw guardError;
  }
  await client.query(`UPDATE quota_tracker SET units_used=units_used+1 WHERE id='youtube'`);
  await client.query('COMMIT');
}

test('pre-migration guard without a savepoint cannot proceed (aborted transaction)', async () => {
  // Documents the proven defect: after undefined_table, PostgreSQL aborts
  // the transaction, so the "fall through to the plain charge" path dies
  // with in_failed_sql_transaction at COMMIT. This is why the guard needs
  // its savepoint; the fixed claim() below must not repeat this sequence.
  const legacy = makePgClient({ opsTable: false });
  await assert.rejects(legacyGuardSequence(legacy, 'op-1'), /25P02/);
});

test('claim() proceeds on pre-migration databases with a usable transaction', async () => {
  const client = makePgClient({ opsTable: false });
  await client.query('BEGIN');
  assert.equal(await claimYouTubeQuotaOperation(client, 'op-1', '2026-09-27', 'fp', 100), true);
  await client.query(`UPDATE quota_tracker SET units_used=units_used+100 WHERE id='youtube'`);
  await client.query('COMMIT');
  assert.deepEqual(client.state.charges.length, 1, 'the plain charge runs after the tolerated guard failure');
});

test('claim() deduplicates a retry after an unknown commit outcome', async () => {
  const client = makePgClient({ opsTable: true });
  await client.query('BEGIN');
  assert.equal(await claimYouTubeQuotaOperation(client, 'op-9', '2026-09-27', 'fp', 100), true);
  await client.query(`UPDATE quota_tracker SET units_used=units_used+100 WHERE id='youtube'`);
  await client.query('COMMIT');
  await client.query('BEGIN');
  assert.equal(await claimYouTubeQuotaOperation(client, 'op-9', '2026-09-27', 'fp', 100), false, 'same operation ID must not charge twice');
  await client.query('COMMIT');
  assert.equal(client.state.charges.length, 1, 'exactly one charge for two claims');
  await client.query('BEGIN');
  assert.equal(await claimYouTubeQuotaOperation(client, 'op-10', '2026-09-27', 'fp', 1), true, 'distinct responses keep distinct identities');
  await client.query('COMMIT');
});

test('claim() propagates non-42P01 guard errors with the transaction intact', async () => {
  const client = makePgClient({ opsTable: true, failOpsWith: 'XX000' });
  await client.query('BEGIN');
  await assert.rejects(claimYouTubeQuotaOperation(client, 'op-x', '2026-09-27', 'fp', 1), /XX000/);
  await client.query('ROLLBACK');
  await client.query('BEGIN');
  await client.query(`UPDATE quota_tracker SET units_used=units_used+1 WHERE id='youtube'`);
  await client.query('COMMIT');
  assert.equal(client.state.charges.length, 1, 'rollback-to-savepoint left later work usable');
});

/** Fake ledger for bounded-prune tests: serves a scripted rowCount per
 * DELETE batch and records every statement for shape assertions. */
function makePruneDb(rowCounts: number[], failWith: string | null = null) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let step = 0;
  return {
    calls,
    async query(text: string, values: unknown[] = []): Promise<{ rowCount: number | null }> {
      calls.push({ text, values });
      if (failWith) throw Object.assign(new Error(`mock pg ${failWith}`), { code: failWith });
      return { rowCount: rowCounts[Math.min(step++, rowCounts.length - 1)] ?? 0 };
    },
  };
}

test('prune batch size defaults, sanitizes, and clamps to the safety maximum', async () => {
  const { quotaAccountingPruneBatchSize } = await import('./dbCore');
  assert.equal(quotaAccountingPruneBatchSize(), 1000);
  assert.equal(quotaAccountingPruneBatchSize(50), 50);
  for (const bad of [0, -5, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(quotaAccountingPruneBatchSize(bad), 1000, `invalid batch size ${String(bad)} falls back to default`);
  }
  assert.equal(quotaAccountingPruneBatchSize(1_000_000), 10_000, 'oversized batches clamp to the maximum');
});

test('prune deletes in bounded oldest-first batches until a short batch', async () => {
  const { pruneYouTubeQuotaAccountingOps } = await import('./dbCore');
  const db = makePruneDb([2, 2, 1]);
  assert.equal(await pruneYouTubeQuotaAccountingOps(7 * 24 * 60 * 60_000, 2, db), 5);
  assert.equal(db.calls.length, 3, 'loops while batches are full, stops on the short batch');
  for (const call of db.calls) {
    assert.match(call.text, /WHERE ctid IN \(SELECT ctid FROM youtube_quota_accounting_ops WHERE created_at </);
    assert.match(call.text, /ORDER BY created_at LIMIT \$2/);
    assert.deepEqual(call.values[1], 2);
  }
});

test('prune stops after an empty batch and tolerates a missing table', async () => {
  const { pruneYouTubeQuotaAccountingOps } = await import('./dbCore');
  const exact = makePruneDb([2, 2, 0]);
  assert.equal(await pruneYouTubeQuotaAccountingOps(1000, 2, exact), 4);
  assert.equal(exact.calls.length, 3, 'exact multiples terminate on the empty batch');
  const missing = makePruneDb([], '42P01');
  assert.equal(await pruneYouTubeQuotaAccountingOps(1000, 2, missing), 0, 'pre-migration database resolves to zero pruned');
  const broken = makePruneDb([], 'XX000');
  await assert.rejects(pruneYouTubeQuotaAccountingOps(1000, 2, broken), /XX000/);
});

test('prune validates retention before touching the database', async () => {
  const { pruneYouTubeQuotaAccountingOps } = await import('./dbCore');
  for (const bad of [0, -1, NaN]) {
    const db = makePruneDb([99]);
    assert.equal(await pruneYouTubeQuotaAccountingOps(bad, 2, db), 0);
    assert.equal(db.calls.length, 0, 'invalid retention issues no statements');
  }
});

test('incrementQuota combines group-aware budgeting, operationId idempotency, and dispatch-day per-key accounting', async () => {
  const { readFileSync } = await import('node:fs');
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const start = dbCore.indexOf('export async function incrementQuota');
  const end = dbCore.indexOf('export async function getSchemaInfo', start);
  assert.ok(start >= 0 && end > start, 'incrementQuota must remain discoverable');
  const charge = dbCore.slice(start, end);
  // QUOTA_GROUP budgeting: the reservation limit must come from the
  // group-aware budget, never the legacy raw key count.
  assert.match(charge, /const limit=getDailyYouTubeQuotaBudget\(\)/);
  assert.doesNotMatch(charge, /calculateYouTubeDailyBudget\(keys\.length/);
  // Idempotency: the same-transaction operationId guard must survive
  // alongside group-aware budgeting (neither side taken wholesale).
  assert.match(charge, /if \(operationId\)/);
  assert.match(charge, /claimYouTubeQuotaOperation\(client, operationId/);
  // Per-key usage and lease settlement follow the dispatch day, while the
  // singleton quota_tracker stays on the current Pacific day. A late prior-day
  // settlement must not rewind last_reset and zero current-day usage.
  assert.match(charge, /const keyQuotaDay=reservation\?\.quotaDay\|\|probeReservation\?\.quotaDay\|\|getYouTubeQuotaDay\(\);/);
  assert.ok(charge.includes('const trackerDay=getYouTubeQuotaDay();'));
  // Probe allocation settlement is part of the same official-charge
  // transaction; it cannot be silently skipped or moved outside the charge.
  assert.ok(charge.includes('settleProbeQuotaReservation(client,probeReservation)'));
  const probeSettleIndex = charge.indexOf('settleProbeQuotaReservation');
  assert.ok(probeSettleIndex >= 0 && charge.indexOf("await client.query('COMMIT')", probeSettleIndex) > probeSettleIndex);
  const beginIndex = charge.indexOf("await client.query('BEGIN')");
  const trackerIndex = charge.indexOf('const trackerDay=getYouTubeQuotaDay();');
  assert.ok(beginIndex >= 0 && trackerIndex > beginIndex, 'tracker day is sampled after pool acquisition/BEGIN');
  assert.ok(charge.includes('ensureYouTubeQuotaDay(client,trackerDay,limit)'));
  assert.ok(charge.includes('ensureYouTubeKeyRows(client,keyQuotaDay,keys,perKey)'));
  assert.ok(charge.includes('[units,limit,trackerDay]'));
  assert.ok(charge.includes('[units,keyQuotaDay,keyFingerprint]'));
  // getQuota reports the same group-aware daily limit.
  const quotaStart = dbCore.indexOf('export async function getQuota');
  const quotaEnd = dbCore.indexOf('export async function incrementQuota', quotaStart);
  const quota = dbCore.slice(quotaStart, quotaEnd);
  assert.match(quota, /const limit=getDailyYouTubeQuotaBudget\(\)/);
});

test('probe allocation and per-key cap exhaustion defer without consuming an attempt', async () => {
  const { decideJobFailure } = await import('./dbCore');
  const { ProbeQuotaExceededError, ProbeQuotaDisabledError } = await import('./quotaKeyCapShadow');
  const { getNextYouTubeQuotaResetAt } = await import('./youtubeQuotaDay');
  const now = new Date('2026-10-20T19:00:00.000Z').getTime();
  const probe = new ProbeQuotaExceededError('2026-10-20', 90, 20, 100, new Date(now));
  const probeDecision = decideJobFailure(probe, 1, 5, now);
  assert.equal(probeDecision.disposition, 'RETRYING_WITHOUT_ATTEMPT');
  assert.equal(probeDecision.runAfter, getNextYouTubeQuotaResetAt(new Date(now)));

  const disabled = new ProbeQuotaDisabledError('2026-10-20');
  const disabledDecision = decideJobFailure(disabled, 1, 5, now);
  assert.equal(disabledDecision.disposition, 'RETRYING_WITHOUT_ATTEMPT');

  const keyCap = Object.assign(new Error('key cap'), { code: 'YOUTUBE_KEY_CAP_EXCEEDED' });
  const keyDecision = decideJobFailure(keyCap, 1, 5, now);
  assert.equal(keyDecision.disposition, 'RETRYING_WITHOUT_ATTEMPT');
  assert.equal(keyDecision.runAfter, getNextYouTubeQuotaResetAt(new Date(now)));
});

test('normal allocation exhaustion keeps its transient age limit; probe markers do not', async () => {
  const { decideJobFailure } = await import('./dbCore');
  const { ProbeQuotaExceededError, ProbeQuotaUnavailableError } = await import('./quotaKeyCapShadow');
  const now = new Date('2026-10-20T19:00:00.000Z').getTime();
  const sevenHoursAgo = now - 7 * 60 * 60_000;

  // The shared QUOTA_ALLOCATION_EXHAUSTED code is also the pre-existing normal
  // allocation error. It must not inherit the probe terminal's unbounded defer.
  const normal = decideJobFailure({ code: 'QUOTA_ALLOCATION_EXHAUSTED', retryAt: now + 60_000 }, 3, 3, now, sevenHoursAgo);
  assert.equal(normal.disposition, 'FAILED');
  assert.equal(normal.operationallyBlocked, true);

  const probe = new ProbeQuotaExceededError('2026-10-20', 90, 20, 100, new Date(now));
  assert.equal(decideJobFailure(probe, 3, 3, now, sevenHoursAgo).disposition, 'RETRYING_WITHOUT_ATTEMPT');

  // Unavailable probe storage keeps the transient age limit and its 60s retry.
  const unavailable = new ProbeQuotaUnavailableError('probe settings read failed');
  const unavailableDecision = decideJobFailure(unavailable, 3, 3, now, sevenHoursAgo);
  assert.equal(unavailableDecision.disposition, 'FAILED');
  assert.equal(unavailableDecision.operationallyBlocked, true);
  assert.equal(decideJobFailure(unavailable, 3, 3, now, now).disposition, 'RETRYING_WITHOUT_ATTEMPT');
});
