import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const resultsTable=readFileSync(new URL('../src/components/ResultsTable.tsx',import.meta.url),'utf8');
const db=readFileSync(new URL('./db.ts',import.meta.url),'utf8');
const dbCore=readFileSync(new URL('./dbCore.ts',import.meta.url),'utf8');

test('recoverable Discord validation distinguishes queued, budget-exhausted, terminal, and governed recovery states',()=>{
  assert.match(resultsTable,/Automatic retry/);
  assert.match(resultsTable,/RETRY QUEUED/);
  assert.match(resultsTable,/RETRY BUDGET EXHAUSTED/);
  assert.match(resultsTable,/RETRY TERMINAL/);
  assert.match(resultsTable,/governed recovery available/);
  assert.match(resultsTable,/community_retry_job_status === 'PENDING'/);
  assert.match(resultsTable,/community_retry_job_status === 'PROCESSING'/);
  assert.match(resultsTable,/community_retry_job_status === 'FAILED'/);
  assert.match(resultsTable,/discord_validation_status==='RETRY_PENDING'/);
  assert.doesNotMatch(resultsTable,/Validation retry pending/);
  assert.doesNotMatch(resultsTable,/Re-check Now required/);
  assert.match(dbCore,/community_retry_job_status/);
  assert.match(dbCore,/community_retry_job_attempts/);
  assert.match(dbCore,/community_retry_job_max_attempts/);
  assert.match(dbCore,/community_retry_job_run_after/);
  assert.match(dbCore,/community_retry_job_execution_count/);
  assert.match(dbCore,/community_retry_job_deferral_count/);
  assert.match(dbCore,/community_retry_job_executed_count/);
  assert.match(dbCore,/community_retry_job_last_execution_at/);
  assert.match(dbCore,/community_retry_job_retry_reason/);
  assert.match(dbCore,/community_retry_job_reconciliation_status/);
  assert.match(dbCore,/payload->>'retryReason'/);
  assert.match(dbCore,/payload->>'reconciliationCode'/);
  assert.match(dbCore,/a\.error LIKE '%Community acquisition deferred:%'/);
  assert.match(dbCore,/job_attempts/);
  assert.match(resultsTable,/Retry-window attempts/);
  assert.match(resultsTable,/Worker claims/);
  assert.match(resultsTable,/capacity deferrals/);
  assert.match(resultsTable,/executed attempts/);
  assert.match(resultsTable,/RETRY DUE/);
  assert.match(resultsTable,/reason: \$\{retryReasonLabel\}/);
  assert.match(resultsTable,/RECONCILIATION REQUIRED/);
  assert.match(resultsTable,/LEGACY UNCLASSIFIED/);
});

test('pending retries (attempts=0) read as not-yet-executed, executed retries show counts',()=>{
  assert.match(resultsTable,/Pending · not yet executed/);
  assert.match(resultsTable,/Retry-window attempts/);
});

test('executed attempts require affirmative execution evidence, never a bare claim',()=>{
  // A worker claim persisted before dispatch (PROCESSING), a capacity
  // deferral, or a pre-dispatch stale recovery must NOT display as an
  // executed inspection. Only COMPLETED rows or FAILED rows with a
  // non-deferral, non-stale error count.
  assert.match(dbCore,/community_retry_job_executed_count/);
  assert.match(dbCore,/a\.status='COMPLETED'/);
  assert.match(dbCore,/COALESCE\(a\.error,''\) NOT LIKE '%Community acquisition deferred:%'/);
  assert.match(dbCore,/COALESCE\(a\.error,''\) NOT LIKE '%Worker heartbeat expired%'/);
  assert.match(resultsTable,/community_retry_job_executed_count/);
  assert.match(resultsTable,/Worker claims/);
  assert.match(resultsTable,/executed attempts/);
});
