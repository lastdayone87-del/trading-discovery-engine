import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PHASE0_ZOMBIE_APPLY_DEFAULT_MAX_CLOSURES,
  PHASE0_ZOMBIE_APPLY_DEFAULT_MAX_SCAN,
  buildZombieClosureEvidence,
  parsePhase0ZombieApplyArgs,
  phase0ZombieApplyCheckFailures,
  runPhase0ZombieApply,
  type Phase0ZombieApplyReport,
} from './phase0ZombieApply';
import type { Phase0ZombieReconciliationRow } from './phase0ZombieReconciliation';

test('apply arguments default to report-only with the documented bounds', () => {
  assert.deepEqual(parsePhase0ZombieApplyArgs([]), {
    apply: false,
    actor: null,
    maxScan: PHASE0_ZOMBIE_APPLY_DEFAULT_MAX_SCAN,
    maxClosures: PHASE0_ZOMBIE_APPLY_DEFAULT_MAX_CLOSURES,
    offset: 0,
    includeRows: false,
    check: false,
    out: null,
    help: false,
  });
});

test('--apply requires an explicit actor and only known flags are accepted', () => {
  assert.throws(() => parsePhase0ZombieApplyArgs(['--apply']), /--apply requires --actor/);
  assert.throws(() => parsePhase0ZombieApplyArgs(['--apply', '--actor=']), /--actor/);
  assert.throws(
    () => parsePhase0ZombieApplyArgs(['--apply', '--actor=operator', '--job-ids=abc']),
    /unknown argument/,
  );
  assert.deepEqual(
    parsePhase0ZombieApplyArgs(['--apply', '--actor=operator@example']).actor,
    'operator@example',
  );
});

test('apply bounds and actor inputs are validated', () => {
  for (const argv of [
    ['--max-scan=0'],
    ['--max-scan=5001'],
    ['--max-scan=abc'],
    ['--max-closures=0'],
    ['--max-closures=501'],
    ['--max-closures=1.5'],
    ['--offset=-1'],
    ['--offset=1000001'],
    ['--offset=abc'],
    ['--out='],
  ]) {
    assert.throws(() => parsePhase0ZombieApplyArgs(argv), /max-scan|max-closures|offset|out/);
  }
  for (const actor of ['x'.repeat(201), 'operator\nname', 'operator\u0000']) {
    assert.throws(() => parsePhase0ZombieApplyArgs([`--actor=${actor}`]), /--actor/);
  }
  assert.equal(parsePhase0ZombieApplyArgs(['--max-scan=42', '--max-closures=7']).maxScan, 42);
  assert.equal(parsePhase0ZombieApplyArgs(['--max-closures=7']).maxClosures, 7);
  assert.equal(parsePhase0ZombieApplyArgs(['--offset=42']).offset, 42);
});

function evidenceRow(overrides: Record<string, unknown> = {}) {
  const jobId = String(overrides.job_id || randomUUID());
  return {
    job_id: jobId,
    channel_id: `UC-${jobId.slice(0, 8)}`,
    job_status: 'PENDING',
    created_at: '2026-10-01T00:00:00.000Z',
    first_enqueued_at: '2026-10-01T00:00:00.000Z',
    reopen_generation: 0,
    retry_observed_at: '2026-10-02T00:00:00.000Z',
    channel_present: true,
    discord_validation_status: 'SUCCEEDED',
    discord_status: 'FOUND',
    ledger_rows: 0,
    ledger_active_rows: 0,
    ledger_terminal_rows: 0,
    ...overrides,
  };
}

function observationRow(overrides: Record<string, unknown> = {}) {
  return {
    requested_url: 'https://creator.example.com/community',
    outcome: 'ACQUISITION_FAILED',
    retryable: true,
    failure_class: 'TIMEOUT',
    observed_at: '2026-10-03T00:00:00.000Z',
    id: randomUUID(),
    provenance: { surface: 'CREATOR_WEBSITES', required: true },
    ...overrides,
  };
}

function fakeApplyDb(config: {
  ledgerTablePresent?: boolean;
  closureColumnsPresent?: boolean;
  pendingRetries?: number;
  processingRetries?: number;
  scannable?: number;
  ledgerRows?: number;
  candidateIds: string[];
  evidenceRows: any[];
  newerObservations?: any[];
  updateSucceeds?: (jobId: string) => boolean;
} = { candidateIds: [], evidenceRows: [] }) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const jobUpdates: Array<{ jobId: string; values: unknown[] }> = [];
  const attemptUpdates: unknown[][] = [];
  const db = {
    async query(text: string, values: unknown[] = []) {
      sql.push(text);
      params.push(values);
      if (text.includes('to_regclass')) {
        return {
          rows: [{
            ledger_table_present: config.ledgerTablePresent !== false,
            closure_columns_present: config.closureColumnsPresent !== false,
          }],
        };
      }
      if (text.includes('pending_retries')) {
        return {
          rows: [{
            pending_retries: config.pendingRetries ?? config.candidateIds.length,
            processing_retries: config.processingRetries ?? 0,
            scannable: config.scannable ?? config.candidateIds.length,
          }],
        };
      }
      if (text.includes('count(*)::int AS rows')) {
        return { rows: [{ rows: config.ledgerRows ?? 0 }] };
      }
      if (text.includes('FOR UPDATE SKIP LOCKED')) {
        return { rows: config.candidateIds.map(jobId => ({ job_id: jobId })) };
      }
      if (text.includes('UPDATE job_attempts')) {
        attemptUpdates.push(values);
        return { rows: [] };
      }
      if (text.includes('UPDATE jobs')) {
        const jobId = String(values[0] || '');
        jobUpdates.push({ jobId, values });
        const succeeds = config.updateSucceeds ? config.updateSucceeds(jobId) : true;
        return { rows: succeeds ? [{ id: jobId }] : [] };
      }
      if (text.includes('external_acquisition_observations')) {
        return { rows: config.newerObservations ?? [] };
      }
      if (text.includes('WITH candidate_channels AS')) {
        return { rows: config.evidenceRows };
      }
      return { rows: [] };
    },
  };
  return { db, sql, params, jobUpdates, attemptUpdates };
}

test('report-only mode classifies the bounded batch and issues no writes', async () => {
  const closable = evidenceRow();
  const skipped = evidenceRow({
    discord_validation_status: null,
    discord_status: 'UNCERTAIN',
  });
  const { db, sql, jobUpdates } = fakeApplyDb({
    candidateIds: [String(closable.job_id), String(skipped.job_id)],
    evidenceRows: [closable, skipped],
  });

  const report = await runPhase0ZombieApply(db, { maxScan: 10, maxClosures: 5 });

  assert.equal(report.dryRun, true);
  assert.equal(report.actor, null);
  assert.equal(report.scan.locked, 2);
  assert.equal(report.scan.offset, 0);
  assert.equal(report.scan.nextOffset, null);
  assert.equal(report.summary.examined, 2);
  assert.equal(report.summary.proposedClosures, 1);
  assert.equal(report.summary.appliedClosures, 0);
  assert.equal(report.summary.skipped, 1);
  assert.equal(report.closures.length, 1);
  assert.equal(report.closures[0].applied, false);
  assert.equal(report.closures[0].closedAt, null);
  assert.equal(jobUpdates.length, 0);
  const mutatingSql = sql.filter(text =>
    /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i.test(text.replace(/FOR\s+UPDATE/gi, '')));
  assert.deepEqual(mutatingSql, []);
  assert.ok(sql.some(text => /FOR UPDATE SKIP LOCKED/.test(text)));
});

test('closure evidence that appears before classification blocks the closure', async () => {
  const closable = evidenceRow();
  const { db, jobUpdates } = fakeApplyDb({
    candidateIds: [String(closable.job_id)],
    evidenceRows: [closable],
    newerObservations: [observationRow({ job_id: closable.job_id })],
  });

  const report = await runPhase0ZombieApply(db, {
    apply: true,
    actor: 'operator',
    maxScan: 10,
    maxClosures: 5,
  });

  assert.equal(report.summary.proposedClosures, 0);
  assert.equal(report.summary.appliedClosures, 0);
  assert.equal(report.summary.skipped, 1);
  assert.equal(report.summary.byReason.NEWER_RETRY_OWNING_OBSERVATION, 1);
  assert.equal(jobUpdates.length, 0);
});

test('apply mode closes only proposals and records append-only evidence', async () => {
  const closable = evidenceRow();
  const skipped = evidenceRow({
    discord_validation_status: null,
    discord_status: 'UNCERTAIN',
  });
  const { db, sql, jobUpdates, attemptUpdates } = fakeApplyDb({
    candidateIds: [String(closable.job_id), String(skipped.job_id)],
    evidenceRows: [closable, skipped],
  });

  const report = await runPhase0ZombieApply(db, {
    apply: true,
    actor: 'operator@example',
    maxScan: 10,
    maxClosures: 5,
  });

  assert.equal(report.dryRun, false);
  assert.equal(report.actor, 'operator@example');
  assert.equal(report.summary.appliedClosures, 1);
  assert.equal(report.closures[0].jobId, closable.job_id);
  assert.equal(report.closures[0].reason, 'CHANNEL_TERMINAL');
  assert.equal(report.closures[0].applied, true);
  assert.equal(report.closures[0].actor, 'operator@example');
  assert.equal(jobUpdates.length, 1);
  assert.equal(jobUpdates[0].jobId, closable.job_id);
  const values = jobUpdates[0].values;
  assert.equal(values[0], closable.job_id);
  assert.equal(values[1], 'CHANNEL_TERMINAL');
  assert.equal(values[3], 'operator@example');
  assert.equal(typeof values[4], 'string');
  assert.deepEqual(values[5], [
    'CHANNEL_LINKS', 'CHANNEL_EXTERNAL_LINKS', 'EXTERNAL_LINKS', 'LINKED_WEBSITES',
    'CUSTOM_DOMAINS', 'SOCIAL_PROFILES', 'SOCIAL_BIO', 'CREATOR_WEBSITES',
  ]);
  const evidence = JSON.parse(String(values[2]));
  assert.equal(evidence.classifier, 'phase0-zombie-retry-closure');
  assert.equal(evidence.reason, 'CHANNEL_TERMINAL');
  assert.equal(evidence.criterion, 'channel_terminal');
  assert.equal(evidence.job.id, closable.job_id);
  assert.equal(evidence.channel.id, closable.channel_id);
  assert.equal(typeof evidence.closedAt, 'string');
  const updateSql = sql.find(text => text.includes('UPDATE jobs'));
  assert.ok(updateSql);
  assert.match(updateSql, /completed_at=COALESCE\(completed_at,\$5::timestamptz\)/);
  assert.match(updateSql, /NOT EXISTS \(\s*SELECT 1\s+FROM external_acquisition_observations/);
  assert.match(updateSql, /NOT EXISTS \(\s*SELECT 1\s+FROM community_acquisition_url_state/);
  assert.match(updateSql, /AND status='PENDING'/);
  assert.match(updateSql, /AND closed_at IS NULL/);
  assert.deepEqual(attemptUpdates, [[[closable.job_id]]]);
  assert.equal(
    report.warnings.some(warning => warning.startsWith('closure_update_skipped')),
    false,
  );
});

test('maxClosures bounds the applied batch even when more proposals exist', async () => {
  const rows = [evidenceRow(), evidenceRow(), evidenceRow()];
  const { db, jobUpdates } = fakeApplyDb({
    candidateIds: rows.map(row => String(row.job_id)),
    evidenceRows: rows,
  });
  const report = await runPhase0ZombieApply(db, {
    apply: true,
    actor: 'operator',
    maxClosures: 2,
  });

  assert.equal(report.summary.proposedClosures, 3);
  assert.equal(report.summary.appliedClosures, 2);
  assert.equal(report.summary.closureLimitReached, true);
  assert.ok(report.warnings.includes('closure_limit_reached'));
  assert.equal(jobUpdates.length, 2);
});

test('maxScan is reported when the candidate window truncates the backlog', async () => {
  const rows = [evidenceRow(), evidenceRow()];
  const { db, sql, params } = fakeApplyDb({
    candidateIds: rows.map(row => String(row.job_id)),
    evidenceRows: rows,
    scannable: 9,
  });
  const report = await runPhase0ZombieApply(db, { maxScan: 2 });

  assert.equal(report.summary.scanLimitReached, true);
  assert.equal(report.scan.nextOffset, 2);
  assert.ok(report.warnings.includes('scan_limit_reached'));
  const candidateIndex = sql.findIndex(text => text.includes('FOR UPDATE SKIP LOCKED'));
  assert.ok(candidateIndex >= 0);
  assert.match(sql[candidateIndex], /OFFSET \$2/);
  assert.deepEqual(params[candidateIndex], [2, 0]);
});

test('offset advances the bounded candidate window past permanent skips', async () => {
  const rows = [evidenceRow(), evidenceRow()];
  const { db, sql, params } = fakeApplyDb({
    candidateIds: rows.map(row => String(row.job_id)),
    evidenceRows: rows,
    scannable: 9,
  });
  const report = await runPhase0ZombieApply(db, { maxScan: 2, offset: 4 });

  assert.equal(report.scan.offset, 4);
  assert.equal(report.summary.scanLimitReached, true);
  assert.equal(report.scan.nextOffset, 6);
  const candidateIndex = sql.findIndex(text => text.includes('FOR UPDATE SKIP LOCKED'));
  assert.ok(candidateIndex >= 0);
  assert.match(sql[candidateIndex], /OFFSET \$2/);
  assert.deepEqual(params[candidateIndex], [2, 4]);

  const exhausted = await runPhase0ZombieApply(
    fakeApplyDb({ candidateIds: [], evidenceRows: [], scannable: 4 }).db,
    { maxScan: 2, offset: 4 },
  );
  assert.equal(exhausted.summary.scanLimitReached, false);
  assert.equal(exhausted.scan.nextOffset, null);
});

test('an explicit job-id batch is bounded and does not report scan truncation', async () => {
  const rows = [evidenceRow(), evidenceRow()];
  const jobIds = rows.map(row => String(row.job_id));
  const { db, sql, params } = fakeApplyDb({
    candidateIds: jobIds,
    evidenceRows: rows,
    scannable: 9,
  });
  const report = await runPhase0ZombieApply(db, { maxScan: 2, jobIds });

  assert.equal(report.restricted, true);
  assert.equal(report.summary.scanLimitReached, false);
  assert.equal(report.warnings.includes('scan_limit_reached'), false);
  const candidateIndex = sql.findIndex(text => text.includes('FOR UPDATE SKIP LOCKED'));
  assert.ok(candidateIndex >= 0);
  assert.match(sql[candidateIndex], /OFFSET \$3/);
  assert.deepEqual(params[candidateIndex], [2, jobIds, 0]);
});

test('a skipped update is surfaced instead of being counted as a closure', async () => {
  const row = evidenceRow();
  const { db } = fakeApplyDb({
    candidateIds: [String(row.job_id)],
    evidenceRows: [row],
    updateSucceeds: () => false,
  });
  const report = await runPhase0ZombieApply(db, {
    apply: true,
    actor: 'operator',
    maxClosures: 5,
  });

  assert.equal(report.summary.appliedClosures, 0);
  assert.equal(report.closures.length, 0);
  assert.ok(report.warnings.includes(`closure_update_skipped:${row.job_id}`));
  assert.deepEqual(phase0ZombieApplyCheckFailures(report), ['closure_update_skipped']);
});

test('the apply path refuses to run before the closure migration is present', async () => {
  const { db } = fakeApplyDb({
    closureColumnsPresent: false,
    candidateIds: [],
    evidenceRows: [],
  });
  await assert.rejects(
    runPhase0ZombieApply(db, { maxScan: 1 }),
    /ZOMBIE_APPLY_SCHEMA_MISSING: migration 167/,
  );
});

test('malformed explicit job ids are rejected before any query', async () => {
  const { db, sql } = fakeApplyDb({ candidateIds: [], evidenceRows: [] });
  await assert.rejects(
    runPhase0ZombieApply(db, { jobIds: ['not-a-uuid'] }),
    /malformed UUID/,
  );
  assert.equal(sql.length, 0);
});

test('closure evidence is self-contained and carries the shared criterion', () => {
  const row: Phase0ZombieReconciliationRow = {
    jobId: randomUUID(),
    channelId: 'UCevidence',
    jobStatus: 'PENDING',
    channelPresent: true,
    discordValidationStatus: 'COMPLETED',
    discordStatus: 'NOT_FOUND',
    retryObservedAt: '2026-10-01T00:00:00.000Z',
    firstEnqueuedAt: '2026-09-30T00:00:00.000Z',
    jobAgeHours: 24,
    reopenGeneration: 2,
    ledgerRows: 0,
    ledgerActiveRows: 0,
    ledgerTerminalRows: 0,
    newerRetryOwningObservations: 0,
    decision: 'PROPOSE_CLOSE',
    reason: 'CHANNEL_TERMINAL',
    evidence: ['channel=COMPLETED:NOT_FOUND', 'criterion=channel_terminal'],
  };

  const evidence = buildZombieClosureEvidence(row, '2026-11-07T00:00:00.000Z');
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.reason, 'CHANNEL_TERMINAL');
  assert.equal(evidence.criterion, 'channel_terminal');
  assert.deepEqual(evidence.job, {
    id: row.jobId,
    type: 'RETRY_COMMUNITY_ACQUISITION',
    statusAtClosure: 'PENDING',
    firstEnqueuedAt: row.firstEnqueuedAt,
    retryObservedAt: row.retryObservedAt,
    reopenGeneration: 2,
  });
  assert.deepEqual(evidence.supportingEvidence, row.evidence);
  assert.equal(evidence.closedAt, '2026-11-07T00:00:00.000Z');

  const syntheticReport: Phase0ZombieApplyReport = {
    generatedAt: '2026-11-07T00:00:00.000Z',
    dryRun: true,
    actor: null,
    maxScan: 1,
    maxClosures: 1,
    restricted: false,
    schema: { ledgerTablePresent: true, closureColumnsPresent: true },
    population: { pendingRetries: 1, processingRetries: 0, scannable: 1 },
    ledger: { rows: 0 },
    scan: { locked: 1, offset: 0, nextOffset: null },
    summary: {
      examined: 1,
      proposedClosures: 1,
      appliedClosures: 0,
      skipped: 0,
      closureLimitReached: false,
      scanLimitReached: false,
      byReason: { CHANNEL_TERMINAL: 1 },
    },
    closures: [],
    warnings: [],
  };
  assert.deepEqual(phase0ZombieApplyCheckFailures(syntheticReport), []);
  syntheticReport.schema.closureColumnsPresent = false;
  assert.deepEqual(phase0ZombieApplyCheckFailures(syntheticReport), ['closure_columns_missing']);
});

test('the apply module and CLI keep the write path explicit and bounded', () => {
  const moduleSource = readFileSync(
    new URL('./phase0ZombieApply.ts', import.meta.url),
    'utf8',
  );
  const reconciliationSource = readFileSync(
    new URL('./phase0ZombieReconciliation.ts', import.meta.url),
    'utf8',
  );
  const scriptSource = readFileSync(
    new URL('../scripts/phase0ZombieApply.ts', import.meta.url),
    'utf8',
  );
  for (const source of [moduleSource, scriptSource]) {
    assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
    assert.doesNotMatch(source, /\bTRUNCATE\b/i);
  }
  assert.match(moduleSource, /zombieCandidateJobIdsSql/);
  assert.match(moduleSource, /statuses: \['PENDING'\]/);
  assert.match(moduleSource, /excludeClosed: true/);
  assert.match(moduleSource, /lock: true/);
  assert.match(moduleSource, /zombieClosureEvidenceGuardSql/);
  assert.match(reconciliationSource, /FOR UPDATE SKIP LOCKED/);
  assert.match(reconciliationSource, /j\.closed_at IS NULL/);
  assert.match(moduleSource, /migration 167/);
  assert.match(scriptSource, /createOperatorWriteDbPool/);
  assert.match(scriptSource, /BEGIN ISOLATION LEVEL READ COMMITTED/);
  assert.match(scriptSource, /phase0ZombieApplyCheckFailures/);
  assert.match(scriptSource, /args\.apply && failures\.length === 0/);
  const checkIndex = scriptSource.indexOf('args.check ? phase0ZombieApplyCheckFailures(report) : []');
  const commitIndex = scriptSource.indexOf("await client.query('COMMIT')");
  assert.ok(checkIndex >= 0);
  assert.ok(commitIndex >= 0);
  assert.ok(checkIndex < commitIndex, 'the check gate must run before COMMIT');
});
