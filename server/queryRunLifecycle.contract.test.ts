import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const db = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
const queue = fs.readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');

test('query-run lifecycle reconciliation is generic and not max-attempt gated', () => {
  const start = db.indexOf('export async function reconcileQueryRunJobLifecycleForQuery');
  const end = db.indexOf('/** Backward-compatible count', start);
  const source = db.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(source, /FROM query_runs qr\s+JOIN jobs j/);
  assert.match(source, /j\.type = 'SEARCH_YOUTUBE'/);
  assert.doesNotMatch(source, /j\.attempts\s*>=\s*j\.max_attempts/);
  assert.match(source, /jobStatus: row\.job_status/);
  assert.match(source, /UPDATE query_runs[\s\S]*status='RETRYING'/);
  assert.match(source, /UPDATE quota_reservations[\s\S]*status='RELEASED'/);
});

test('autonomous reservation calls the generic lifecycle reconciler before the reservation update', () => {
  const start = db.indexOf('export async function scheduleAutonomousQueryRuns');
  const reservation = db.slice(start, db.indexOf('const reserved = await client.query', start));
  assert.match(reservation, /reconcileQueryRunJobLifecycleForQuery\(client, candidate\.query\.id\)/);
  assert.match(reservation, /reservationRecoveryOutcome/);
});

test('scheduled retries can resume the same query run and completion remains exactly once', () => {
  const start = db.indexOf('export async function startQueryRun');
  const end = db.indexOf('async function attributeCompletedCountryNativeRun', start);
  const lifecycle = db.slice(start, end);
  assert.match(lifecycle, /status IN \('SCHEDULED','RETRYING'\)/);
  assert.match(lifecycle, /if \(status === 'RUNNING'\) return true/);
  assert.match(db, /INSERT INTO query_run_accounting_attributions\([\s\S]*ON CONFLICT\(query_run_id\) DO NOTHING RETURNING query_run_id/);
  assert.match(db, /INSERT INTO query_execution_logs\([\s\S]*ON CONFLICT\(query_run_id\) WHERE query_run_id IS NOT NULL DO NOTHING/);
});

test('continuation retries use a stable child-job idempotency key', () => {
  assert.match(queue, /idempotencyKey: `search-run:\$\{queryRunId\}:page:\$\{pageNumber \+ 1\}`/);
  assert.match(queue, /enqueueChildAndCommitPageReservation/);
});

test('continuation reservation and child enqueue commit or roll back together', () => {
  const start = queue.indexOf('const continuationDb = await getDb()');
  const end = queue.indexOf('if (!portfolioPage.authorized)', start);
  assert.ok(start >= 0 && end > start);
  const block = queue.slice(start, end);
  assert.match(block, /await continuationClient\.query\('BEGIN'\)/);
  assert.match(block, /reservePortfolioContinuationPage\(\{[\s\S]*?clientOverride: continuationClient/);
  assert.match(block, /enqueueChildAndCommitPageReservation\(\{[\s\S]*?clientOverride: continuationClient/);
  assert.match(block, /if \(portfolioPage\.authorized\) \{[\s\S]*?COMMIT/);
  assert.match(block, /else \{[\s\S]*?ROLLBACK/);
  assert.match(block, /catch \(error\) \{[\s\S]*?ROLLBACK[\s\S]*?throw error/);
});
