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
  // Assert the whole predicate, not just the four column fragments: an AND
  // rewrite of the legacy OR predicate must fail this test.
  assert.match(
    sql,
    /WHERE country_status='REJECTED' OR scan_status='SKIPPED_EXCLUDED' OR trading_status='NON_TRADING' OR discord_status='NON_TRADING' ORDER BY first_seen DESC$/,
    'rejected diagnostics must keep the legacy OR predicate and ordering'
  );
  assert.ok(!sql.includes('LIMIT'));
});

// The route must never load the full channel table into Node memory.
test('rejected diagnostics route uses the SQL-filtered listing', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const start = server.indexOf("app.get('/api/channels/diagnostics/rejected'");
  assert.ok(start >= 0);
  const nextRoute = server.indexOf('\n  app.', start + 10);
  const route = server.slice(start, nextRoute > start ? nextRoute : undefined);
  assert.ok(route.includes('listRejectedChannelDiagnostics()'));
  assert.ok(!route.includes('getAllChannels'));
});
