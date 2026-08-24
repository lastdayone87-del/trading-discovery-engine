import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'server', 'db', 'migrations', '122_reconcile_orphaned_query_runs.sql'), 'utf8');

test('historical query-run reconciliation is limited to active runs with terminal failed YouTube jobs', () => {
  assert.match(source, /CREATE TEMP TABLE _orphaned_query_run_reconciliation/);
  assert.match(source, /qr\.status IN \('SCHEDULED','RUNNING','RETRYING'\)/);
  assert.match(source, /j\.type = 'SEARCH_YOUTUBE'/);
  assert.match(source, /j\.status = 'FAILED'/);
  assert.match(source, /failureKind', 'ORPHANED_FAILED_JOB_STATE'/);
  assert.match(source, /AUTONOMOUS_QUERY_PAGE/);
  assert.match(source, /operation_id LIKE o\.query_run_id::text \|\| ':%'/);
  assert.match(source, /ON COMMIT DROP/);
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b|\bTRUNCATE\b|DROP\s+TABLE\s+(?!IF\s+EXISTS)/i);
});
