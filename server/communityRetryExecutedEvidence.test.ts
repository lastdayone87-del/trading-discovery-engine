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
  // Order proof: dispatch trace and channel load/guard precede the retry
  // branch; the worker hands its exact claimed attempt number to
  // inspectAndValidateChannel, which marks only after the terminal-state and
  // processing-pause early returns. Failures in recordExecutionStage,
  // getChannelById, the missing-channel guard, or either early return
  // therefore leave unmarked rows that can never count as executed.
  assert.match(
    queueManager,
    /recordExecutionStage\('DISPATCHER','REACHED'[\s\S]*?if\(job\.type==='RETRY_COMMUNITY_ACQUISITION'\)[\s\S]*?getChannelById[\s\S]*?if\(!channel\)[\s\S]*?inspectAndValidateChannel\(channel,undefined,false,false,false,\{jobId:job\.id,attemptNumber:job\.attempts\}\)/,
  );
  assert.match(
    queueManager,
    /isTerminalState\(channel\)[\s\S]*?channelProcessing\.isPaused[\s\S]*?markCommunityInspectionStarted\(executionMarker\.jobId, executionMarker\.attemptNumber\)[\s\S]*?validateChannelCountry/,
  );
});

test('marker binds to the exact claimed attempt and aborts on stale claims', () => {
  // Relationship-canary attempt pattern: a recovered worker waking late must
  // never mark a newer replacement attempt, and a zero-row update (claim
  // recovered or completed, with or without replacement) aborts before
  // inspection instead of running unmarked.
  assert.match(dbCore, /export const COMMUNITY_INSPECTION_STARTED_MARKER = 'communityInspectionStarted'/);
  assert.match(
    dbCore,
    /UPDATE job_attempts SET logs = logs \|\| \$3::jsonb WHERE job_id=\$1 AND attempt_number=\$2 AND status='PROCESSING' AND finished_at IS NULL/,
  );
  assert.match(dbCore, /if\(!res\.rowCount\) throw new Error\(`Community inspection marker found no open attempt/);
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
