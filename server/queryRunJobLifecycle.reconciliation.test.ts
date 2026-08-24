import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileQueryRunJobLifecycleForQuery } from './db';

function clientFor(row: Record<string, unknown>) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    client: {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes('SELECT qr.id AS query_run_id')) return { rows: [row], rowCount: 1 };
        if (text.includes("SET status='FAILED'")) return { rows: [{ query_id: row.query_id }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }
    }
  };
}

test('pending retry ownership is aligned without releasing query or quota reservations', async () => {
  const { client, calls } = clientFor({
    query_run_id: 'run-pending', query_id: 233, query_run_status: 'RUNNING',
    query_run_error: 'provider cooldown', job_id: 'job-pending', job_status: 'PENDING',
    attempts: 1, max_attempts: 3, last_error: 'OPERATIONALLY_BLOCKED_RETRY_REQUIRED: cooldown',
    run_after: new Date(Date.now() + 60_000), job_completed_at: null
  });
  const summary = await reconcileQueryRunJobLifecycleForQuery(client, 233);
  assert.deepEqual(summary, { retryOwnershipAligned: 1, terminalRunsClosed: 0 });
  assert.equal(calls.filter(call => call.text.includes('UPDATE query_runs')).length, 1);
  assert.equal(calls.some(call => call.text.includes('UPDATE quota_reservations')), false);
  assert.equal(calls.some(call => call.text.includes('UPDATE query_library')), false);
});

test('failed job state closes its active query run and releases both durable reservations', async () => {
  const { client, calls } = clientFor({
    query_run_id: 'run-failed', query_id: 233, query_run_status: 'RUNNING',
    query_run_error: null, job_id: 'job-failed', job_status: 'FAILED',
    attempts: 1, max_attempts: 3, last_error: 'OPERATIONALLY_BLOCKED_RETRY_REQUIRED: stale failure',
    run_after: new Date(Date.now() - 60_000), job_completed_at: null
  });
  const summary = await reconcileQueryRunJobLifecycleForQuery(client, 233);
  assert.deepEqual(summary, { retryOwnershipAligned: 0, terminalRunsClosed: 1 });
  assert.equal(calls.some(call => call.text.includes("SET status='FAILED'")), true);
  const reservationRelease = calls.find(call => call.text.includes('UPDATE quota_reservations'));
  assert.ok(reservationRelease);
  assert.match(reservationRelease.text, /AUTONOMOUS_QUERY_PAGE/);
  assert.match(reservationRelease.text, /operation_id LIKE \$1 \|\| ':%'/);
  assert.match(reservationRelease.text, /SEARCH_YOUTUBE/);
  assert.equal(calls.some(call => call.text.includes('UPDATE query_library')), true);
});
