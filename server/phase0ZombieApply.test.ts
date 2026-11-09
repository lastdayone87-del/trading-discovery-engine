import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PHASE0_ZOMBIE_APPLY_DEFAULT_MAX_CLOSURES,
  PHASE0_ZOMBIE_APPLY_DEFAULT_MAX_SCAN,
  buildZombieClosureEvidence,
  encodePhase0ZombieApplyCursor,
  finalizePhase0ZombieApplyReport,
  parsePhase0ZombieApplyArgs,
  parsePhase0ZombieApplyCursor,
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
    cursor: null,
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
    ['--cursor='],
    ['--cursor=not-a-cursor'],
    ['--out='],
  ]) {
    assert.throws(() => parsePhase0ZombieApplyArgs(argv), /max-scan|max-closures|cursor|out/);
  }
  for (const actor of ['x'.repeat(201), 'operator\nname', 'operator\u0000']) {
    assert.throws(() => parsePhase0ZombieApplyArgs([`--actor=${actor}`]), /--actor/);
  }
  assert.equal(parsePhase0ZombieApplyArgs(['--max-scan=42', '--max-closures=7']).maxScan, 42);
  assert.equal(parsePhase0ZombieApplyArgs(['--max-closures=7']).maxClosures, 7);
});

test('the keyset cursor round-trips both nullable and populated queue clocks', () => {
  const populated = {
    job_id: randomUUID(),
    first_enqueued_at: '2026-10-01T00:00:00.000Z',
  };
  const populatedToken = encodePhase0ZombieApplyCursor(populated);
  assert.ok(populatedToken);
  assert.deepEqual(parsePhase0ZombieApplyCursor(populatedToken), {
    at: '2026-10-01T00:00:00.000Z',
    id: populated.job_id,
  });
  assert.equal(parsePhase0ZombieApplyArgs([`--cursor=${populatedToken}`]).cursor, populatedToken);

  const legacy = { job_id: randomUUID(), first_enqueued_at: null };
  const legacyToken = encodePhase0ZombieApplyCursor(legacy);
  assert.ok(legacyToken);
  assert.deepEqual(parsePhase0ZombieApplyCursor(legacyToken), {
    at: null,
    id: legacy.job_id,
  });

  const dateRow = { job_id: randomUUID(), first_enqueued_at: new Date('2026-10-02T00:00:00Z') };
  assert.deepEqual(
    parsePhase0ZombieApplyCursor(encodePhase0ZombieApplyCursor(dateRow)),
    { at: '2026-10-02T00:00:00.000Z', id: dateRow.job_id },
  );

  // PostgreSQL stores microseconds; the SQL-provided key must survive intact.
  const precise = {
    job_id: randomUUID(),
    first_enqueued_at: new Date('2026-10-01T00:00:00.123Z'),
    first_enqueued_at_key: '2026-10-01T00:00:00.123456Z',
  };
  const preciseToken = encodePhase0ZombieApplyCursor(precise);
  assert.deepEqual(parsePhase0ZombieApplyCursor(preciseToken), {
    at: '2026-10-01T00:00:00.123456Z',
    id: precise.job_id,
  });

  for (const token of [
    'not-a-cursor',
    Buffer.from(JSON.stringify({ v: 2, at: null, id: randomUUID() })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, at: null, id: 'bad' })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, at: 'not-a-date', id: randomUUID() })).toString('base64url'),
    'x'.repeat(300),
  ]) {
    assert.throws(() => parsePhase0ZombieApplyCursor(token), /--cursor is invalid/);
  }
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
  windowRows?: Array<{ job_id: string; first_enqueued_at?: string | null }>;
  evidenceRows: any[];
  newerObservations?: any[];
  updateSucceeds?: (jobId: string) => boolean;
} = { candidateIds: [], evidenceRows: [] }) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const jobUpdates: Array<{ jobId: string; values: unknown[] }> = [];
  const attemptUpdates: unknown[][] = [];
  const windowRows = config.windowRows
    ?? config.candidateIds.map(jobId => ({
      job_id: jobId,
      first_enqueued_at: '2026-10-01T00:00:00.000Z',
    }));
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
      if (text.includes('first_enqueued_at AS first_enqueued_at')) {
        return { rows: windowRows };
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
  assert.equal(report.scan.window, 2);
  assert.equal(report.scan.cursor, null);
  assert.equal(report.scan.nextCursor, null);
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
  // Unapplied proposals stay pending, so a fresh run must revisit this page.
  assert.equal(report.scan.nextCursor, null);
});

test('a truncated scan reports a keyset cursor instead of an offset', async () => {
  const rows = [evidenceRow(), evidenceRow(), evidenceRow()];
  const windowRows = rows.map((row, index) => ({
    job_id: String(row.job_id),
    first_enqueued_at: '2026-10-01T00:00:00.000Z',
    first_enqueued_at_key: `2026-10-01T00:00:0${index}.123456Z`,
  }));
  const { db, sql, params } = fakeApplyDb({
    candidateIds: rows.slice(0, 2).map(row => String(row.job_id)),
    windowRows,
    evidenceRows: rows.slice(0, 2),
    scannable: 9,
  });
  const report = await runPhase0ZombieApply(db, { maxScan: 2 });

  assert.equal(report.summary.scanLimitReached, true);
  assert.equal(report.scan.window, 2);
  assert.equal(report.scan.locked, 2);
  assert.equal(
    report.scan.nextCursor,
    encodePhase0ZombieApplyCursor(windowRows[1]),
  );
  assert.ok(report.warnings.includes('scan_limit_reached'));
  const windowIndex = sql.findIndex(text =>
    text.includes('first_enqueued_at AS first_enqueued_at'));
  assert.ok(windowIndex >= 0);
  assert.match(sql[windowIndex], /LIMIT \$1/);
  assert.doesNotMatch(sql[windowIndex], /OFFSET/);
  assert.deepEqual(params[windowIndex], [3]);
});

test('a keyset cursor resumes past permanent skips and survives closures', async () => {
  const rows = [evidenceRow(), evidenceRow(), evidenceRow()];
  const windowRows = rows.map(row => ({
    job_id: String(row.job_id),
    first_enqueued_at: '2026-10-02T00:00:00.000Z',
  }));
  const cursorToken = encodePhase0ZombieApplyCursor({
    job_id: randomUUID(),
    first_enqueued_at: '2026-10-01T00:00:00.000Z',
  });
  const cursor = parsePhase0ZombieApplyCursor(cursorToken);
  const { db, sql, params } = fakeApplyDb({
    candidateIds: rows.slice(0, 2).map(row => String(row.job_id)),
    windowRows,
    evidenceRows: rows.slice(0, 2),
  });
  const report = await runPhase0ZombieApply(db, { maxScan: 2, cursor: cursorToken });

  assert.equal(report.scan.cursor, cursorToken);
  assert.equal(report.summary.scanLimitReached, true);
  assert.equal(report.scan.nextCursor, encodePhase0ZombieApplyCursor(windowRows[1]));
  const windowIndex = sql.findIndex(text =>
    text.includes('first_enqueued_at AS first_enqueued_at'));
  assert.ok(windowIndex >= 0);
  assert.match(sql[windowIndex], /j\.id > \$3::uuid/);
  assert.doesNotMatch(sql[windowIndex], /OFFSET/);
  assert.deepEqual(params[windowIndex], [3, cursor.at, cursor.id]);

  const exhausted = await runPhase0ZombieApply(
    fakeApplyDb({ candidateIds: [], windowRows: [], evidenceRows: [] }).db,
    { maxScan: 2, cursor: cursorToken },
  );
  assert.equal(exhausted.summary.scanLimitReached, false);
  assert.equal(exhausted.scan.nextCursor, null);
});

test('closure truncation repeats the same cursor page', async () => {
  const rows = [evidenceRow(), evidenceRow(), evidenceRow()];
  const cursorToken = encodePhase0ZombieApplyCursor({
    job_id: randomUUID(),
    first_enqueued_at: '2026-10-01T00:00:00.000Z',
  });
  const { db } = fakeApplyDb({
    candidateIds: rows.map(row => String(row.job_id)),
    evidenceRows: rows,
  });
  const report = await runPhase0ZombieApply(db, {
    apply: true,
    actor: 'operator',
    maxClosures: 2,
    cursor: cursorToken,
  });

  assert.equal(report.summary.closureLimitReached, true);
  assert.equal(report.scan.nextCursor, cursorToken);
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
  const windowIndex = sql.findIndex(text =>
    text.includes('first_enqueued_at AS first_enqueued_at'));
  assert.ok(windowIndex >= 0);
  assert.match(sql[windowIndex], /j\.id = ANY\(\$2::uuid\[\]\)/);
  assert.doesNotMatch(sql[windowIndex], /OFFSET/);
  assert.deepEqual(params[windowIndex], [3, jobIds]);
  const lockIndex = sql.findIndex(text => text.includes('FOR UPDATE SKIP LOCKED'));
  assert.ok(lockIndex >= 0);
  assert.deepEqual(params[lockIndex], [2, jobIds]);
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
    scan: { window: 1, locked: 1, cursor: null, nextCursor: null },
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

test('a rollback rewrites applied markers and re-examines the rows it tried to close', () => {
  const jobId = randomUUID();
  const cursor = encodePhase0ZombieApplyCursor({
    job_id: randomUUID(),
    first_enqueued_at: '2026-10-01T00:00:00.000Z',
  });
  const nextCursor = encodePhase0ZombieApplyCursor({
    job_id: jobId,
    first_enqueued_at: '2026-11-01T00:00:00.000Z',
  });
  assert.ok(cursor && nextCursor);
  const report: Phase0ZombieApplyReport = {
    generatedAt: '2026-11-07T00:00:00.000Z',
    dryRun: false,
    actor: 'operator',
    maxScan: 1,
    maxClosures: 1,
    restricted: false,
    schema: { ledgerTablePresent: true, closureColumnsPresent: true },
    population: { pendingRetries: 1, processingRetries: 0, scannable: 1 },
    ledger: { rows: 1 },
    scan: { window: 1, locked: 1, cursor, nextCursor },
    summary: {
      examined: 1,
      proposedClosures: 1,
      appliedClosures: 1,
      skipped: 0,
      closureLimitReached: false,
      scanLimitReached: true,
      byReason: { CHANNEL_TERMINAL: 1 },
    },
    closures: [{
      jobId,
      channelId: 'UCrollback',
      reason: 'CHANNEL_TERMINAL',
      applied: true,
      closedAt: '2026-11-07T00:00:00.000Z',
      actor: 'operator',
      evidence: { reason: 'CHANNEL_TERMINAL' },
    }],
    warnings: [],
  };

  const committed = finalizePhase0ZombieApplyReport(report, 'COMMITTED');
  assert.equal(committed.transaction, 'COMMITTED');
  assert.equal(committed.summary.appliedClosures, 1);
  assert.equal(committed.closures[0].applied, true);
  assert.equal(committed.closures[0].closedAt, '2026-11-07T00:00:00.000Z');
  assert.equal(committed.scan.nextCursor, nextCursor);

  const rolledBack = finalizePhase0ZombieApplyReport(report, 'ROLLED_BACK');
  assert.equal(rolledBack.transaction, 'ROLLED_BACK');
  assert.equal(rolledBack.summary.appliedClosures, 0);
  assert.equal(rolledBack.summary.proposedClosures, 1);
  assert.deepEqual(rolledBack.closures[0], {
    ...report.closures[0],
    applied: false,
    closedAt: null,
    actor: null,
  });
  // The closures did not persist, so the rows are still PENDING. Resuming
  // from the advanced cursor would skip them.
  assert.equal(rolledBack.scan.nextCursor, cursor);

  // A report-only scan never attempted writes and keeps its paging cursor.
  const dryRun = finalizePhase0ZombieApplyReport({
    ...report,
    dryRun: true,
    actor: null,
    summary: { ...report.summary, appliedClosures: 0 },
    closures: [{ ...report.closures[0], applied: false, closedAt: null, actor: null }],
  }, 'ROLLED_BACK');
  assert.equal(dryRun.scan.nextCursor, nextCursor);
});

test('the write guard excludes evidence the batch already classified', async () => {
  const closable = evidenceRow();
  // A newer required, retryable row that `observationOwnsRetry` rejects as
  // low-value. It must not block the closure, and its id must be excluded from
  // the statement-time guard because the batch snapshot already judged it.
  const demoted = observationRow({
    job_id: closable.job_id,
    provenance: { surface: 'CREATOR_WEBSITES', required: true, relevanceTier: 'DEMOTE' },
  });
  const { db, sql, jobUpdates } = fakeApplyDb({
    candidateIds: [String(closable.job_id)],
    evidenceRows: [closable],
    newerObservations: [demoted],
  });

  const report = await runPhase0ZombieApply(db, {
    apply: true,
    actor: 'operator',
    maxScan: 10,
    maxClosures: 5,
  });

  assert.equal(report.summary.proposedClosures, 1);
  assert.equal(report.summary.appliedClosures, 1);
  assert.equal(report.summary.skipped, 0);
  assert.equal(jobUpdates.length, 1);
  assert.deepEqual(jobUpdates[0].values[6], [demoted.id]);
  const updateSql = sql.find(text => text.includes('UPDATE jobs'));
  assert.ok(updateSql);
  assert.match(updateSql, /o\.id <> ALL\(\$7::uuid\[\]\)/);
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
  assert.match(moduleSource, /after: cursor !== null/);
  assert.match(moduleSource, /zombieClosureEvidenceGuardSql/);
  assert.match(reconciliationSource, /FOR UPDATE SKIP LOCKED/);
  assert.match(reconciliationSource, /j\.closed_at IS NULL/);
  assert.match(reconciliationSource, /COALESCE\(j\.reopen_generation,0\) = 0/);
  assert.match(reconciliationSource, /o\.id <> ALL\(\$\{knownObservationIdsParam\}::uuid\[\]\)/);
  assert.match(reconciliationSource, /j\.first_enqueued_at > \$\{atParam\}::timestamptz/);
  assert.match(moduleSource, /nextCursor/);
  assert.match(moduleSource, /problemIds/);
  assert.match(moduleSource, /migration 167/);
  assert.match(scriptSource, /createOperatorWriteDbPool/);
  assert.match(scriptSource, /BEGIN ISOLATION LEVEL READ COMMITTED/);
  assert.match(scriptSource, /phase0ZombieApplyCheckFailures/);
  assert.match(scriptSource, /finalizePhase0ZombieApplyReport/);
  assert.match(scriptSource, /const committed = args\.apply && failures\.length === 0/);
  const checkIndex = scriptSource.indexOf('args.check ? phase0ZombieApplyCheckFailures(report) : []');
  const commitIndex = scriptSource.indexOf("await client.query('COMMIT')");
  assert.ok(checkIndex >= 0);
  assert.ok(commitIndex >= 0);
  assert.ok(checkIndex < commitIndex, 'the check gate must run before COMMIT');
});
