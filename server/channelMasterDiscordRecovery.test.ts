import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nextChannelScanAttempts} from './queueManager';

const db=readFileSync('server/db.ts','utf8');
const queue=readFileSync('server/queueManager.ts','utf8');
const migration=readFileSync('server/db/migrations/110_discord_candidates.sql','utf8');
const ui=readFileSync('src/components/ResultsTable.tsx','utf8');

test('master listing retains rows but excludes low-audience skips unless explicitly selected',()=>{
  assert.match(db,/const clauses=\[args\.diagnosticsOnly\?[\s\S]+:'TRUE'\]/);
  assert.match(db,/scope:args\.diagnosticsOnly\?'DIAGNOSTICS_ONLY':'ALL_STORED_CHANNELS'/);
  assert.match(db,/const explicitlyViewingLowAudience=args\.scanStatus==='SKIPPED_LOW_AUDIENCE'/);
  assert.match(db,/!explicitlyViewingLowAudience\)clauses\.push\(`scan_status <> 'SKIPPED_LOW_AUDIENCE'`\)/);
});

test('Stored Channels is an unqualified persisted row count',()=>{
  const summary=db.slice(db.indexOf('export async function getDashboardOperationalSummary'),db.indexOf('export async function getChannelById'));
  assert.match(summary,/COUNT\(\*\)::int stored_channels/);
  assert.match(summary,/FROM channels`/);
  assert.doesNotMatch(summary,/FROM channels WHERE/);
  assert.match(summary,/storedChannels:'ALL_STORED_CHANNELS'/);
});

test('operational retry exhaustion remains recoverable instead of FAILED_PERMANENT',()=>{
  const retryFailure=queue.slice(queue.indexOf("job.type === 'RETRY_COMMUNITY_ACQUISITION'"),queue.indexOf('const runId',queue.indexOf("job.type === 'RETRY_COMMUNITY_ACQUISITION'")));
  assert.match(retryFailure,/scan_status='FAILED'/);
  assert.match(retryFailure,/discord_validation_status='RETRY_PENDING'/);
  assert.doesNotMatch(retryFailure,/FAILED_PERMANENT/);
  assert.equal(nextChannelScanAttempts(6,false),7);
  assert.equal(nextChannelScanAttempts(7,true),0);
  assert.match(queue,/nextChannelScanAttempts\(channel\.scan_attempts/);
  assert.doesNotMatch(queue,/channel\.scan_attempts\+selected\.attempts\.length/);
});

test('candidate authority is durable, normalized unique, selected, and returned to dashboard',()=>{
  assert.match(migration,/PRIMARY KEY\(channel_id,candidate_id\)/);
  assert.match(migration,/UNIQUE\(channel_id,normalized_locator\)/);
  assert.match(migration,/attempt_count INTEGER/);
  assert.match(db,/jsonb_agg\(to_jsonb\(dc\)/);
  assert.match(queue,/persistDiscordCandidates/);
  assert.match(queue,/selectDiscordCandidate/);
  assert.match(ui,/candidate\.failure_reason/);
  assert.match(ui,/candidate\.retryable\?'Retryable':'Terminal'/);
});
