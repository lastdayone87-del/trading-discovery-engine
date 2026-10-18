import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listRejectedChannelDiagnostics } from './dbCore';

// The rejected diagnostics endpoint must filter in SQL with exactly the
// predicate the route previously applied in Node, in the same order, with
// no result cap that could drop rows.
test('rejected diagnostics filters in SQL with the legacy predicate', async () => {
  const statements: string[] = [];
  const fakeDb = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    }
  };
  await listRejectedChannelDiagnostics(fakeDb as never);
  assert.equal(statements.length, 1);
  const sql = statements[0];
  for (const cond of [
    `country_status='REJECTED'`,
    `scan_status='SKIPPED_EXCLUDED'`,
    `trading_status='NON_TRADING'`,
    `discord_status='NON_TRADING'`
  ]) {
    assert.ok(sql.includes(cond), cond);
  }
  assert.ok(sql.includes('ORDER BY first_seen DESC'));
  assert.ok(!sql.includes('LIMIT'));
});

// The route must never load the full channel table into Node memory.
test('rejected diagnostics route uses the SQL-filtered listing', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.ok(server.includes('listRejectedChannelDiagnostics()'));
  assert.ok(!server.includes('getAllChannels'));
});
