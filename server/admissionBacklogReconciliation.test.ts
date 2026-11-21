import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/reconcileAdmissionDecisions.ts', import.meta.url), 'utf8');

test('admission backlog reconciliation is dry-run by default and bounded', () => {
  assert.match(source, /const apply = args\.includes\('--apply'\)/);
  assert.match(source, /dryRun: !apply/);
  assert.match(source, /Math\.min\(200/);
  assert.match(source, /ADMITTED_AMBIGUOUS/);
  assert.match(source, /NEEDS_REVIEW/);
  assert.match(source, /archiveRejectedExistingChannel: true/);
});

test('backlog reconciliation never bulk-approves and skips active jobs', () => {
  assert.match(source, /NOT EXISTS \(/);
  assert.match(source, /VERIFY_CHANNEL_ADMISSION/);
  assert.doesNotMatch(source, /UPDATE channels[\s\S]*admission_status\s*=\s*'ADMITTED'/);
  assert.doesNotMatch(source, /insertChannelIfAbsent/);
});
