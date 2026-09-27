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
