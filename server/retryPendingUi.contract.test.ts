import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const resultsTable=readFileSync(new URL('../src/components/ResultsTable.tsx',import.meta.url),'utf8');
const db=readFileSync(new URL('./db.ts',import.meta.url),'utf8');

test('recoverable Discord validation distinguishes queued, exhausted, and manual retry states',()=>{
  assert.match(resultsTable,/Automatic retry/);
  assert.match(resultsTable,/RETRY QUEUED/);
  assert.match(resultsTable,/RETRY EXHAUSTED/);
  assert.match(resultsTable,/RECHECK REQUIRED/);
  assert.match(resultsTable,/community_retry_job_status === 'PENDING'/);
  assert.match(resultsTable,/community_retry_job_status === 'PROCESSING'/);
  assert.match(resultsTable,/community_retry_job_status === 'FAILED'/);
  assert.match(resultsTable,/discord_validation_status==='RETRY_PENDING'/);
  assert.doesNotMatch(resultsTable,/Validation retry pending/);
  assert.match(db,/community_retry_job_status/);
  assert.match(db,/community_retry_job_attempts/);
  assert.match(db,/community_retry_job_max_attempts/);
  assert.match(db,/community_retry_job_run_after/);
});
