import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const queueManager = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
const resultsTable = readFileSync(new URL('../src/components/ResultsTable.tsx', import.meta.url), 'utf8');

// A FAILED attempt row is NOT evidence of execution by itself: the worker can
// fail at dispatch trace, channel load, or on a stale/pre-dispatch crash —
// all before community inspection begins. Execution requires the durable
// inspection-start marker written at the inspection boundary.

test('inspection-start marker lands after channel load and immediately before inspection', () => {
  // Order proof: dispatch trace and channel load/guard precede the marker;
  // the marker immediately precedes inspectAndValidateChannel. Failures in
  // recordExecutionStage, getChannelById, or the missing-channel guard therefore
  // leave unmarked rows that can never count as executed.
  assert.match(
    queueManager,
    /recordExecutionStage\('DISPATCHER','REACHED'[\s\S]*?if\(job\.type==='RETRY_COMMUNITY_ACQUISITION'\)[\s\S]*?getChannelById[\s\S]*?if\(!channel\)[\s\S]*?markCommunityInspectionStarted\(job\.id\)[\s\S]*?inspectAndValidateChannel/,
  );
});

test('marker appends to the open processing attempt only', () => {
  // Same established `logs ||` array pattern as relationship-canary attempt
  // logs; scoped to the open PROCESSING row so finished history is immutable.
  // No schema change: job_attempts.logs is already JSONB.
  assert.match(dbCore, /export const COMMUNITY_INSPECTION_STARTED_MARKER = 'communityInspectionStarted'/);
  assert.match(
    dbCore,
    /UPDATE job_attempts SET logs = logs \|\| \$2::jsonb WHERE job_id=\$1 AND status='PROCESSING' AND finished_at IS NULL/,
  );
});

test('executed count requires the marker plus a terminal state', () => {
  // Bare claims (in-flight PROCESSING rows) and unmarked rows are excluded:
  // only marked rows that reached COMPLETED or FAILED can count.
  assert.match(dbCore, /a\.logs \? 'communityInspectionStarted'/);
  assert.match(dbCore, /\(a\.status='COMPLETED' OR \(a\.status='FAILED'/);
});

test('executed count still excludes deferrals and stale recoveries', () => {
  // A marked row that deferred for capacity never ran acquisition; a marked
  // row that went stale died with an unproven outcome. Both stay excluded.
  // (Matched against the whole listing query: these guards are distinctive to
  // the executed-count select.)
  assert.match(dbCore, /community_retry_job_executed_count/);
  assert.match(dbCore, /COALESCE\(a\.error,''\) NOT LIKE '%Community acquisition deferred:%'/);
  assert.match(dbCore, /COALESCE\(a\.error,''\) NOT LIKE '%Worker heartbeat expired%'/);
});

test('dashboard consumes the marker-derived executed counter', () => {
  assert.match(resultsTable, /community_retry_job_executed_count/);
  assert.match(resultsTable, /Worker claims/);
  assert.match(resultsTable, /executed attempts/);
});
