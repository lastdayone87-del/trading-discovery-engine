import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/reconcileAdmissionDecisions.ts', import.meta.url), 'utf8');

test('admission backlog reconciliation is dry-run by default and bounded', () => {
  assert.match(source, /const apply = args\.includes\('--apply'\)/);
  assert.match(source, /dryRun: !apply/);
  assert.match(source, /Math\.min\(200/);
  assert.match(source, /LIMIT \$3/);
  assert.match(source, /\[statuses, channelArg \|\| null, limit\]/);
  assert.match(source, /ADMITTED_AMBIGUOUS/);
  assert.match(source, /NEEDS_REVIEW/);
  assert.match(source, /archiveRejectedExistingChannel: true/);
});

test('backlog reconciliation respects admission mode, backoff and retry scheduling', () => {
  assert.match(source, /getAdmissionMode\(\)/);
  assert.match(source, /ADMISSION_MODE_NOT_ACTIVE/);
  assert.match(source, /next_check_at <= now\(\)/);
  assert.match(source, /ORDER BY cand\.created_at/);
  assert.match(source, /enqueueAdmissionVerification\(/);
  assert.match(source, /process\.exitCode = 1/);
});

test('backlog reconciliation never bulk-approves and skips active jobs', () => {
  assert.match(source, /NOT EXISTS \(/);
  assert.match(source, /status IN \('PENDING','PROCESSING'\)/);
  assert.match(source, /VERIFY_CHANNEL_ADMISSION','ENRICH_CHANNEL','CLASSIFY_DISCOVERED_CHANNEL/);
  assert.match(source, /j\.payload->>'channelId' = cand\.channel_id/);
  assert.doesNotMatch(source, /UPDATE channels/i);
  assert.doesNotMatch(source, /insertChannelIfAbsent/);
});
