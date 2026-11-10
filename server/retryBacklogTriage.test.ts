import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildRetryBacklogTriageReport,
  classifyRetryBacklogJob,
  parseRetryBacklogTriageArgs,
  retryBacklogTriageCandidateSql,
  type RetryBacklogTriageEvidence,
} from './retryBacklogTriage';
import {
  parseRetryBacklogApplyArgs,
  runRetryBacklogTriageApply,
} from './retryBacklogTriageApply';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const ANCIENT = '2026-10-01T00:00:00.000Z';
const RECENT = '2026-11-09T00:00:00.000Z';

function evidence(overrides: Partial<RetryBacklogTriageEvidence> = {}): RetryBacklogTriageEvidence {
  return {
    jobId: randomUUID(),
    channelId: 'UCtriage',
    jobStatus: 'PENDING',
    channelPresent: true,
    attempts: 0,
    maxAttempts: 5,
    priority: 100,
    runAfter: RECENT,
    firstEnqueuedAt: RECENT,
    retryObservedAt: RECENT,
    scopeEligibility: 'IN_SCOPE',
    scanStatus: 'FAILED',
    discordStatus: 'UNCERTAIN',
    discordValidationStatus: 'RETRY_PENDING',
    countryStatus: 'CONFIRMED',
    tradingStatus: 'TRADING_CONFIRMED',
    claims: 0,
    lastClaimAt: null,
    startedClaims: 0,
    appliedBucket: null,
    appliedAt: null,
    ...overrides,
  };
}

function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    channel_id: 'UCtriage',
    status: 'PENDING',
    attempts: 0,
    max_attempts: 5,
    priority: 100,
    run_after: RECENT,
    first_enqueued_at: ANCIENT,
    retry_observed_at: ANCIENT,
    channel_present: true,
    scope_eligibility: 'IN_SCOPE',
    scan_status: 'FAILED',
    discord_status: 'UNCERTAIN',
    discord_validation_status: 'RETRY_PENDING',
    country_status: 'CONFIRMED',
    trading_status: 'TRADING_CONFIRMED',
    claims: 0,
    last_claim_at: null,
    started_claims: 0,
    applied_bucket: null,
    applied_at: null,
    ...overrides,
  };
}

test('classifier keeps terminal evidence ahead of quarantine', () => {
  assert.equal(classifyRetryBacklogJob(evidence({ scopeEligibility: 'OUT_OF_SCOPE' }), NOW.getTime()).bucket, 'TERMINAL');
  assert.equal(classifyRetryBacklogJob(evidence({ scanStatus: 'SKIPPED_LOW_AUDIENCE' }), NOW.getTime()).bucket, 'TERMINAL');
  assert.equal(classifyRetryBacklogJob(evidence({ attempts: 5 }), NOW.getTime()).bucket, 'TERMINAL');
  assert.equal(classifyRetryBacklogJob(evidence({ countryStatus: 'REJECTED' }), NOW.getTime()).bucket, 'TERMINAL');
  assert.equal(classifyRetryBacklogJob(evidence({ tradingStatus: 'HUMAN_REJECTED' }), NOW.getTime()).bucket, 'TERMINAL');
  assert.equal(classifyRetryBacklogJob(evidence({ scanStatus: 'NEEDS_REVIEW' }), NOW.getTime()).bucket, 'QUARANTINE');
});

test('classifier quarantines only ancient jobs without recent/started work', () => {
  assert.deepEqual(
    classifyRetryBacklogJob(evidence({ firstEnqueuedAt: ANCIENT, claims: 0 }), NOW.getTime()),
    { bucket: 'QUARANTINE', reason: 'ANCIENT_NO_CLAIMS' },
  );
  assert.deepEqual(
    classifyRetryBacklogJob(evidence({
      firstEnqueuedAt: ANCIENT,
      claims: 3,
      lastClaimAt: '2026-10-02T00:00:00.000Z',
    }), NOW.getTime()),
    { bucket: 'QUARANTINE', reason: 'ANCIENT_STALLED' },
  );
  assert.deepEqual(
    classifyRetryBacklogJob(evidence({
      firstEnqueuedAt: ANCIENT,
      claims: 1,
      lastClaimAt: RECENT,
    }), NOW.getTime()),
    { bucket: 'RECOVERABLE', reason: 'RECENT_ACTIVITY' },
  );
  assert.deepEqual(
    classifyRetryBacklogJob(evidence({
      firstEnqueuedAt: ANCIENT,
      claims: 2,
      startedClaims: 1,
    }), NOW.getTime()),
    { bucket: 'RECOVERABLE', reason: 'WORK_STARTED' },
  );
  assert.deepEqual(
    classifyRetryBacklogJob(evidence({ firstEnqueuedAt: RECENT }), NOW.getTime()),
    { bucket: 'RECOVERABLE', reason: 'RECENT' },
  );
});

test('classifier quarantines missing channels and skips applied rows', () => {
  assert.deepEqual(
    classifyRetryBacklogJob(evidence({ channelPresent: false }), NOW.getTime()),
    { bucket: 'QUARANTINE', reason: 'CHANNEL_MISSING' },
  );
  assert.deepEqual(
    classifyRetryBacklogJob(evidence({ appliedAt: NOW.toISOString(), appliedBucket: 'QUARANTINE' }), NOW.getTime()),
    { bucket: 'SKIP', reason: 'ALREADY_TRIAGED' },
  );
});

test('report partitions buckets and preserves terminal/quarantine evidence', async () => {
  const rows = [
    rawRow({ id: randomUUID(), scope_eligibility: 'OUT_OF_SCOPE' }),
    rawRow({ id: randomUUID(), scan_status: 'NEEDS_REVIEW' }),
    rawRow({ id: randomUUID(), first_enqueued_at: ANCIENT, claims: 0 }),
    rawRow({ id: randomUUID(), first_enqueued_at: RECENT }),
  ];
  const db = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('to_regclass')) {
        return { rows: [{ present: true, pending_retries: rows.length }] };
      }
      assert.match(sql, /WITH claim_stats/);
      return { rows: rows.slice(0, Number(values?.[0] || rows.length)) };
    },
  };
  const report = await buildRetryBacklogTriageReport(db, {
    now: () => NOW,
    includeRows: true,
    maxJobs: 10,
  });
  assert.equal(report.summary.terminal, 1);
  assert.equal(report.summary.quarantine, 2);
  assert.equal(report.summary.recoverable, 1);
  assert.equal(report.summary.skipped, 0);
  assert.equal(report.population.examined, 4);
  assert.equal(report.rows?.length, 4);
  assert.equal(report.rows?.find(row => row.reason === 'OUT_OF_SCOPE')?.bucket, 'TERMINAL');
  assert.equal(report.rows?.find(row => row.reason === 'HUMAN_REVIEW')?.bucket, 'QUARANTINE');
  assert.equal(report.rows?.find(row => row.reason === 'ANCIENT_NO_CLAIMS')?.bucket, 'QUARANTINE');
});

test('report tolerates a pre-migration database and detects truncation', async () => {
  const db = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('to_regclass')) {
        return { rows: [{ present: false, pending_retries: 3 }] };
      }
      return { rows: [rawRow(), rawRow(), rawRow()].slice(0, Number(values?.[0] || 3)) };
    },
  };
  const report = await buildRetryBacklogTriageReport(db, { now: () => NOW, maxJobs: 2 });
  assert.equal(report.schema.triageTablePresent, false);
  assert.equal(report.population.examined, 2);
  assert.equal(report.population.truncated, true);
  assert.ok(report.warnings.includes('triage_table_missing_report_only'));
  assert.ok(report.warnings.includes('candidate_limit_reached'));
});

test('candidate SQL locks only jobs and can restrict/exclude applied rows', () => {
  const sql = retryBacklogTriageCandidateSql(true, {
    lock: true,
    restrictJobIds: true,
    excludeApplied: true,
  });
  assert.match(sql, /FOR UPDATE OF j SKIP LOCKED/);
  assert.match(sql, /j\.id=ANY\(\$2\)/);
  assert.match(sql, /t\.applied_at IS NULL/);
});

test('triage argument parser is strict and bounded', () => {
  assert.deepEqual(parseRetryBacklogTriageArgs([]), {
    maxJobs: 5000,
    includeRows: false,
    check: false,
    out: null,
    help: false,
  });
  assert.throws(() => parseRetryBacklogTriageArgs(['--max-jobs=0']), /--max-jobs/);
  assert.throws(() => parseRetryBacklogTriageArgs(['--check=true']), /unknown argument/);
});

function applyDb(rows: Array<Record<string, unknown>>, present = true) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes('to_regclass')) {
        return { rows: [{ present, pending_retries: rows.length }] };
      }
      if (sql.includes('WITH claim_stats')) {
        return { rows: rows.slice(0, Number(values?.[0] || rows.length)) };
      }
      if (sql.includes(`closed_reason='CHANNEL_TERMINAL'`)) return { rows: [{ id: values?.[0] }] };
      if (sql.includes('UPDATE job_attempts')) return { rows: [] };
      if (sql.includes('SET priority=$2')) return { rows: [{ id: values?.[0] }] };
      if (sql.includes('INSERT INTO retry_backlog_triage')) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql.slice(0, 120)}`);
    },
  };
}

test('apply dry-run writes nothing and reports the plan', async () => {
  const rows = [rawRow({ scope_eligibility: 'OUT_OF_SCOPE' }), rawRow({ first_enqueued_at: ANCIENT })];
  const db = applyDb(rows);
  const report = await runRetryBacklogTriageApply(db, {
    now: () => NOW,
    includeRows: true,
    maxActions: 10,
  });
  assert.equal(report.dryRun, true);
  assert.equal(report.summary.terminal, 1);
  assert.equal(report.summary.quarantine, 1);
  assert.equal(report.summary.applied, 0);
  assert.equal(report.actions?.length, 2);
  assert.ok(report.actions?.every(action => action.applied === false));
  assert.ok(!db.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql.trim())));
});

test('apply closes terminal and quarantines ancient rows with original queue state', async () => {
  const terminal = rawRow({ scope_eligibility: 'OUT_OF_SCOPE' });
  const ancient = rawRow({ first_enqueued_at: ANCIENT, priority: 42, run_after: '2026-01-01T00:00:00.000Z' });
  const db = applyDb([terminal, ancient]);
  const report = await runRetryBacklogTriageApply(db, {
    apply: true,
    actor: 'operator@test',
    now: () => NOW,
    maxActions: 10,
  });
  assert.equal(report.summary.applied, 2);
  const terminalUpdate = db.calls.find(call => call.sql.includes(`closed_reason='CHANNEL_TERMINAL'`));
  assert.ok(terminalUpdate);
  assert.equal(terminalUpdate?.values?.[0], terminal.id);
  assert.equal(terminalUpdate?.values?.[2], 'operator@test');
  assert.match(terminalUpdate!.sql, /scope_eligibility='OUT_OF_SCOPE'/);
  const quarantineUpdate = db.calls.find(call => call.sql.includes('SET priority=$2'));
  assert.ok(quarantineUpdate);
  assert.equal(quarantineUpdate?.values?.[1], -1000);
  assert.equal(quarantineUpdate?.values?.[2], '2026-12-10T12:00:00.000Z');
  const triageInsert = db.calls.filter(call => call.sql.includes('INSERT INTO retry_backlog_triage'));
  assert.equal(triageInsert.length, 2);
  const quarantineInsert = triageInsert.find(call => call.sql.includes("'QUARANTINE'"));
  assert.ok(quarantineInsert);
  assert.equal(quarantineInsert?.values?.[3], 42);
  assert.equal(quarantineInsert?.values?.[4], '2026-01-01T00:00:00.000Z');
});

test('apply requires an actor and honors bucket/action bounds', async () => {
  const rows = [rawRow({ scope_eligibility: 'OUT_OF_SCOPE' }), rawRow({ first_enqueued_at: ANCIENT })];
  await assert.rejects(
    runRetryBacklogTriageApply(applyDb(rows), { apply: true, now: () => NOW }),
    /requires a non-empty actor/,
  );

  const db = applyDb(rows);
  const report = await runRetryBacklogTriageApply(db, {
    apply: true,
    actor: 'operator@test',
    buckets: ['QUARANTINE'],
    maxActions: 1,
    now: () => NOW,
  });
  assert.equal(report.summary.applied, 1);
  assert.equal(report.summary.quarantine, 1);
  assert.ok(!db.calls.some(call => call.sql.includes(`closed_reason='CHANNEL_TERMINAL'`)));
  assert.ok(!report.warnings.includes('action_limit_reached'));
});

test('migration 176 is additive and enforces the triage contract', () => {
  const sql = readFileSync(new URL('./db/migrations/176_retry_backlog_triage.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.retry_backlog_triage/);
  assert.match(sql, /bucket IN \('TERMINAL','QUARANTINE','RECOVERABLE'\)/);
  assert.match(sql, /original_priority/);
  assert.match(sql, /original_run_after/);
  assert.match(sql, /deferred_until/);
  assert.doesNotMatch(sql, /^\s*(DELETE\s+FROM|TRUNCATE\s+TABLE)/im);
});

test('apply argument parser refuses unsafe apply invocations', () => {
  assert.throws(() => parseRetryBacklogApplyArgs(['--apply']), /--actor/);
  assert.throws(() => parseRetryBacklogApplyArgs(['--buckets=RECOVERABLE']), /--buckets/);
  assert.throws(() => parseRetryBacklogApplyArgs(['--max-actions=0']), /--max-actions/);
  const parsed = parseRetryBacklogApplyArgs([
    '--apply', '--actor=operator@test', '--max-actions=25', '--buckets=TERMINAL',
  ]);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.maxActions, 25);
  assert.deepEqual(parsed.buckets, ['TERMINAL']);
});
