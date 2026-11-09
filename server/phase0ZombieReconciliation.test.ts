import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPhase0ZombieReconciliationReport,
  classifyZombieRetryClosure,
  parsePhase0ZombieReconciliationArgs,
  phase0ZombieReconciliationCheckFailures,
  zombieCandidateJobIdsSql,
  zombieClosureEvidenceGuardSql,
  type ZombieRetryEvidence,
} from './phase0ZombieReconciliation';

const baseEvidence: ZombieRetryEvidence = {
  jobStatus: 'PENDING',
  channelPresent: true,
  discordValidationStatus: null,
  discordStatus: null,
  retryObservedAt: '2026-11-01T00:00:00.000Z',
  ledgerRows: 0,
  ledgerActiveRows: 0,
  ledgerTerminalRows: 0,
  newerRetryOwningObservations: 0,
};

test('zombie dry-run arguments default to the documented bound', () => {
  assert.deepEqual(parsePhase0ZombieReconciliationArgs([]), {
    maxJobs: 5_000,
    includeRows: false,
    check: false,
    out: null,
    help: false,
  });
});

test('zombie dry-run arguments reject unknown or malformed tokens', () => {
  for (const argv of [
    ['--max-jobs'],
    ['--max-jobs=0'],
    ['--max-jobs=5001'],
    ['--max-jobs=abc'],
    ['--out='],
    ['--apply'],
  ]) {
    assert.throws(() => parsePhase0ZombieReconciliationArgs(argv), /max-jobs|out|unknown argument/);
  }
  assert.equal(parsePhase0ZombieReconciliationArgs(['--max-jobs=10']).maxJobs, 10);
  assert.equal(parsePhase0ZombieReconciliationArgs(['--check', '--include-rows']).check, true);
});

test('a terminal channel with no active work or fresh retryable evidence is closable', () => {
  assert.deepEqual(
    classifyZombieRetryClosure({ ...baseEvidence, discordValidationStatus: 'SUCCEEDED' }),
    { decision: 'PROPOSE_CLOSE', reason: 'CHANNEL_TERMINAL' },
  );
  assert.deepEqual(
    classifyZombieRetryClosure({ ...baseEvidence, discordValidationStatus: 'COMPLETED' }),
    { decision: 'PROPOSE_CLOSE', reason: 'CHANNEL_TERMINAL' },
  );
  assert.deepEqual(
    classifyZombieRetryClosure({ ...baseEvidence, discordStatus: 'FOUND' }),
    { decision: 'PROPOSE_CLOSE', reason: 'CHANNEL_TERMINAL' },
  );
});

test('a fully terminal ledger is sufficient evidence when the channel row is not terminal', () => {
  assert.deepEqual(
    classifyZombieRetryClosure({
      ...baseEvidence,
      ledgerRows: 3,
      ledgerTerminalRows: 3,
    }),
    { decision: 'PROPOSE_CLOSE', reason: 'LEDGER_ALL_TERMINAL' },
  );
});

test('an active lease is never closed', () => {
  assert.deepEqual(
    classifyZombieRetryClosure({
      ...baseEvidence,
      jobStatus: 'PROCESSING',
      discordValidationStatus: 'SUCCEEDED',
    }),
    { decision: 'SKIP', reason: 'PROCESSING_ACTIVE' },
  );
});

test('an invalid retry epoch makes the newer-evidence test inconclusive', () => {
  for (const retryObservedAt of [null, '', 'not-a-date']) {
    assert.deepEqual(
      classifyZombieRetryClosure({
        ...baseEvidence,
        discordValidationStatus: 'SUCCEEDED',
        retryObservedAt,
      }),
      { decision: 'SKIP', reason: 'MISSING_RETRY_OBSERVED_AT' },
    );
  }
});

test('a missing channel row is not evidence of resolution', () => {
  assert.deepEqual(
    classifyZombieRetryClosure({ ...baseEvidence, channelPresent: false }),
    { decision: 'SKIP', reason: 'CHANNEL_NOT_FOUND' },
  );
});

test('a non-terminal channel with no ledger rows is not closable', () => {
  assert.deepEqual(
    classifyZombieRetryClosure(baseEvidence),
    { decision: 'SKIP', reason: 'CHANNEL_NOT_TERMINAL' },
  );
});

test('a non-terminal ledger blocks closure when the channel row is not terminal', () => {
  assert.deepEqual(
    classifyZombieRetryClosure({
      ...baseEvidence,
      ledgerRows: 2,
      ledgerTerminalRows: 1,
      ledgerActiveRows: 1,
    }),
    { decision: 'SKIP', reason: 'LEDGER_NOT_TERMINAL' },
  );
});

test('active ledger work blocks closure even for a terminal channel', () => {
  assert.deepEqual(
    classifyZombieRetryClosure({
      ...baseEvidence,
      discordValidationStatus: 'SUCCEEDED',
      ledgerRows: 3,
      ledgerTerminalRows: 2,
      ledgerActiveRows: 1,
    }),
    { decision: 'SKIP', reason: 'LEDGER_ACTIVE_WORK' },
  );
});

test('fresh retry-owning evidence blocks closure', () => {
  assert.deepEqual(
    classifyZombieRetryClosure({
      ...baseEvidence,
      discordValidationStatus: 'SUCCEEDED',
      newerRetryOwningObservations: 1,
    }),
    { decision: 'SKIP', reason: 'NEWER_RETRY_OWNING_OBSERVATION' },
  );
});

function fixtureRow(overrides: Record<string, unknown> = {}) {
  return {
    job_id: `job-${Math.random().toString(16).slice(2)}`,
    channel_id: `UCzombie-${Math.random().toString(16).slice(2)}`,
    job_status: 'PENDING',
    created_at: '2026-10-01T00:00:00.000Z',
    first_enqueued_at: '2026-10-01T00:00:00.000Z',
    reopen_generation: 0,
    closed_at: null,
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
    job_id: 'fresh-evidence',
    requested_url: 'https://creator.example.com/community',
    outcome: 'ACQUISITION_FAILED',
    retryable: true,
    failure_class: 'TIMEOUT',
    observed_at: '2026-10-03T00:00:00.000Z',
    id: `observation-${Math.random().toString(16).slice(2)}`,
    provenance: { surface: 'CREATOR_WEBSITES', required: true },
    ...overrides,
  };
}

function fakeDb(candidateRows: any[], options: {
  ledgerTablePresent?: boolean;
  closureColumnsPresent?: boolean;
  pendingRetries?: number;
  processingRetries?: number;
  ledgerRows?: number;
  newerObservations?: any[];
} = {}) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const closureColumnsPresent = options.closureColumnsPresent !== false;
  const isScannable = (row: any) => !closureColumnsPresent || (row.closed_at === null && (row.reopen_generation ?? 0) === 0);
  let candidateIds: string[] | null = null;
  const db = {
    async query(text: string, values: unknown[] = []) {
      sql.push(text);
      params.push(values);
      if (text.includes('to_regclass')) {
        return {
          rows: [{
            ledger_table_present: options.ledgerTablePresent !== false,
            closure_columns_present: closureColumnsPresent,
          }],
        };
      }
      if (text.includes('pending_retries')) {
        const pending = candidateRows.filter(row => row.job_status === 'PENDING');
        const processing = candidateRows.filter(row => row.job_status === 'PROCESSING');
        return {
          rows: [{
            pending_retries: options.pendingRetries ?? pending.length,
            processing_retries: options.processingRetries ?? processing.length,
            // `pendingRetries` also simulates a backlog larger than the rows
            // returned by the bounded candidate window.
            scannable_pending: options.pendingRetries
              ?? pending.filter(isScannable).length,
            scannable_processing: processing.filter(isScannable).length,
          }],
        };
      }
      if (text.includes('external_acquisition_observations')) {
        return { rows: options.newerObservations ?? [] };
      }
      if (text.includes('WITH candidate_channels AS')) {
        return {
          rows: candidateIds === null
            ? candidateRows
            : candidateRows.filter(row => candidateIds!.includes(row.job_id)),
        };
      }
      if (text.includes('SELECT j.id AS job_id')) {
        const limit = Number(values[0] ?? candidateRows.length);
        const scannable = candidateRows.filter(row =>
          (row.job_status === 'PENDING' || row.job_status === 'PROCESSING')
          && isScannable(row));
        const ids = scannable.slice(0, limit).map(row => row.job_id);
        candidateIds = ids;
        return { rows: ids.map(jobId => ({ job_id: jobId })) };
      }
      if (text.includes('FROM community_acquisition_url_state')) {
        return { rows: [{ rows: options.ledgerRows ?? 0 }] };
      }
      return { rows: [] };
    },
  };
  return { db, sql, params };
}

test('the dry-run report partitions every examined job into proposals or skips', async () => {
  const candidateRows = [
    fixtureRow({ job_id: 'close-terminal', channel_id: 'UCclose1' }),
    fixtureRow({
      job_id: 'close-ledger',
      channel_id: 'UCclose2',
      discord_validation_status: null,
      discord_status: 'UNCERTAIN',
      ledger_rows: 2,
      ledger_terminal_rows: 2,
    }),
    fixtureRow({ job_id: 'processing', job_status: 'PROCESSING', channel_id: 'UCproc' }),
    fixtureRow({
      job_id: 'missing-epoch',
      channel_id: 'UCmissing',
      retry_observed_at: null,
    }),
    fixtureRow({ job_id: 'missing-channel', channel_id: 'UCgone', channel_present: false }),
    fixtureRow({
      job_id: 'not-terminal',
      channel_id: 'UCopen',
      discord_validation_status: null,
      discord_status: 'UNCERTAIN',
    }),
    fixtureRow({
      job_id: 'ledger-open',
      channel_id: 'UCledgeropen',
      discord_validation_status: null,
      discord_status: 'UNCERTAIN',
      ledger_rows: 2,
      ledger_terminal_rows: 1,
    }),
    fixtureRow({ job_id: 'ledger-active', channel_id: 'UCledgeractive', ledger_active_rows: 1 }),
    fixtureRow({ job_id: 'fresh-evidence', channel_id: 'UCfresh' }),
  ];
  const { db, sql, params } = fakeDb(candidateRows, {
    newerObservations: [observationRow({ job_id: 'fresh-evidence' })],
  });
  const report = await buildPhase0ZombieReconciliationReport(db, { maxJobs: 100 });

  assert.equal(report.dryRun, true);
  assert.equal(report.population.examined, 9);
  assert.equal(report.summary.proposedClosures, 2);
  assert.equal(report.summary.skipped, 7);
  assert.deepEqual(
    report.proposals.map(row => [row.jobId, row.reason]),
    [['close-terminal', 'CHANNEL_TERMINAL'], ['close-ledger', 'LEDGER_ALL_TERMINAL']],
  );
  assert.equal(report.summary.byReason.PROCESSING_ACTIVE, 1);
  assert.equal(report.summary.byReason.MISSING_RETRY_OBSERVED_AT, 1);
  assert.equal(report.summary.byReason.CHANNEL_NOT_FOUND, 1);
  assert.equal(report.summary.byReason.CHANNEL_NOT_TERMINAL, 1);
  assert.equal(report.summary.byReason.LEDGER_NOT_TERMINAL, 1);
  assert.equal(report.summary.byReason.LEDGER_ACTIVE_WORK, 1);
  assert.equal(report.summary.byReason.NEWER_RETRY_OWNING_OBSERVATION, 1);
  assert.equal(report.skippedRows, undefined, 'skipped rows are opt-in');

  const proposals = report.proposals.map(row => row.jobId).join(',');
  const skipped = report.summary.skipped;
  assert.equal(proposals.split(',').length, 2);
  assert.equal(report.summary.proposedClosures + skipped, report.population.examined);

  const candidateIndex = sql.findIndex(text => text.includes('SELECT j.id AS job_id'));
  assert.ok(candidateIndex >= 0);
  assert.deepEqual(params[candidateIndex], [100]);
  const candidateSql = sql[candidateIndex];
  assert.doesNotMatch(candidateSql, /external_acquisition_observations/);
  assert.match(candidateSql, /LIMIT \$1/);
  assert.match(candidateSql, /closed_at IS NULL/);
  assert.equal(report.schema.closureColumnsPresent, true);
  assert.equal(report.population.scannable, 9);
  assert.doesNotMatch(candidateSql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);

  const evidenceSql = sql.find(text => text.includes('WITH candidate_channels AS'));
  assert.ok(evidenceSql);
  assert.match(evidenceSql, /pg_input_is_valid/);
  assert.match(evidenceSql, /ANY\(\$1::uuid\[\]\)/);
  assert.match(evidenceSql, /RESOLVED','PARKED_EXTERNAL','EXHAUSTED/);
  assert.match(evidenceSql, /PENDING','RUNNING','PARKED_INFRA/);
  assert.doesNotMatch(evidenceSql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);

  const newerSql = sql.find(text => text.includes('external_acquisition_observations'));
  assert.ok(newerSql);
  assert.match(newerSql, /o\.provenance->>'surface' = ANY\(\$2::text\[\]\)/);
  assert.match(newerSql, /CASE\s+WHEN pg_input_is_valid/);
  assert.match(newerSql, /THEN o\.observed_at > btrim\(j\.payload->>'retryObservedAt'\)::timestamptz/);
  assert.doesNotMatch(newerSql, /AND o\.observed_at >/);
  assert.match(newerSql, /ANY\(\$1::uuid\[\]\)/);
  assert.match(newerSql, /o\.retryable = true/);
  assert.match(newerSql, /o\.provenance->'required' = 'true'::jsonb/);
  assert.match(newerSql, /o\.outcome = 'PARTIALLY_INSPECTED'/);
  assert.match(newerSql, /o\.failure_class = 'STATIC_BUDGET_GAP'/);
  assert.doesNotMatch(newerSql, /\bLIMIT\s+\$1\b/);
  assert.doesNotMatch(newerSql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
});

test('the dry-run filters closed epochs only when closure columns exist', async () => {
  const present = fakeDb([fixtureRow()]);
  const presentReport = await buildPhase0ZombieReconciliationReport(present.db);
  assert.equal(presentReport.schema.closureColumnsPresent, true);
  const presentCandidate = present.sql.find(text =>
    text.includes('SELECT j.id AS job_id')
    && !text.includes('external_acquisition_observations'));
  assert.ok(presentCandidate);
  assert.match(presentCandidate, /closed_at IS NULL/);
  assert.match(presentCandidate, /COALESCE\(j\.reopen_generation,0\) = 0/);

  const absent = fakeDb([fixtureRow()], { closureColumnsPresent: false });
  const absentReport = await buildPhase0ZombieReconciliationReport(absent.db);
  assert.equal(absentReport.schema.closureColumnsPresent, false);
  assert.ok(absentReport.warnings.includes('closure_columns_missing_historical_epochs_not_filtered'));
  const absentCandidate = absent.sql.find(text =>
    text.includes('SELECT j.id AS job_id')
    && !text.includes('external_acquisition_observations'));
  assert.ok(absentCandidate);
  assert.doesNotMatch(absentCandidate, /closed_at IS NULL/);
});

test('open reopened epochs do not inflate the scannable population or truncate the check', async () => {
  const openNew = fixtureRow({ job_id: 'open-new', channel_id: 'UCnew', reopen_generation: 0 });
  const openReopened = fixtureRow({
    job_id: 'open-reopened',
    channel_id: 'UCreopened',
    reopen_generation: 1,
    closed_at: null,
  });
  const report = await buildPhase0ZombieReconciliationReport(fakeDb([openNew, openReopened]).db);
  assert.equal(report.population.scannable, 1);
  assert.equal(report.population.examined, 1);
  assert.ok(!report.warnings.includes('candidate_limit_reached'));
});

test('a closed reopened processing row does not make a complete report look truncated', async () => {
  const openPending = fixtureRow({ job_id: 'reopened-pending' });
  const closedProcessing = fixtureRow({
    job_id: 'closed-processing-epoch',
    job_status: 'PROCESSING',
    closed_at: '2026-10-05T00:00:00.000Z',
  });
  const { db, sql } = fakeDb([openPending, closedProcessing]);
  const report = await buildPhase0ZombieReconciliationReport(db);
  assert.equal(report.population.pendingRetries, 1);
  assert.equal(report.population.processingRetries, 1);
  // The closed processing epoch is excluded from both the candidate window
  // and the scannable bound, so it cannot make a complete report look
  // truncated forever.
  assert.equal(report.population.examined, 1);
  assert.equal(report.population.scannable, 1);
  assert.equal(report.warnings.includes('candidate_limit_reached'), false);
  assert.deepEqual(phase0ZombieReconciliationCheckFailures(report), []);
  const candidateSql = sql.find(text => text.includes('SELECT j.id AS job_id'));
  assert.ok(candidateSql);
  assert.match(candidateSql, /closed_at IS NULL/);
});

test('candidate paging is a keyset and the write guard excludes known evidence', () => {
  const base = zombieCandidateJobIdsSql({ excludeClosed: true });
  assert.match(base, /ORDER BY j\.first_enqueued_at ASC NULLS FIRST, j\.id ASC/);
  assert.doesNotMatch(base, /OFFSET/);
  assert.doesNotMatch(base, /CASE/);

  const page = zombieCandidateJobIdsSql({
    excludeClosed: true,
    after: true,
    includeKey: true,
  });
  assert.match(page, /j\.first_enqueued_at AS first_enqueued_at/);
  assert.match(page, /to_char\(\s*j\.first_enqueued_at AT TIME ZONE 'UTC',\s*'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\s*\) AS first_enqueued_at_key/);
  assert.match(page, /WHEN \$2::timestamptz IS NULL THEN/);
  assert.match(page, /j\.id > \$3::uuid/);
  assert.match(page, /j\.first_enqueued_at = \$2::timestamptz AND j\.id > \$3::uuid/);
  assert.doesNotMatch(page, /OFFSET/);

  const lockedPage = zombieCandidateJobIdsSql({
    excludeClosed: true,
    restricted: true,
    lock: true,
  });
  assert.match(lockedPage, /j\.id = ANY\(\$2::uuid\[\]\)/);
  assert.match(lockedPage, /FOR UPDATE SKIP LOCKED/);
  assert.doesNotMatch(lockedPage, /OFFSET/);

  const guard = zombieClosureEvidenceGuardSql('$6', '$7');
  assert.match(guard, /o\.id <> ALL\(\$7::uuid\[\]\)/);
  assert.match(guard, /NOT EXISTS \(\s*SELECT 1\s+FROM external_acquisition_observations/);
  assert.match(guard, /NOT EXISTS \(\s*SELECT 1\s+FROM community_acquisition_url_state/);
  assert.match(guard, /pg_input_is_valid/);
});

test('newer observations are classified by shared retry ownership, not raw flags', async () => {
  const candidateRows = [
    fixtureRow({ job_id: 'owning-required', channel_id: 'UCowning-required' }),
    fixtureRow({ job_id: 'owning-static-gap', channel_id: 'UCowning-static-gap' }),
    fixtureRow({ job_id: 'owning-found-gap', channel_id: 'UCowning-found-gap' }),
    fixtureRow({ job_id: 'close-redirect-limit', channel_id: 'UCclose-redirect-limit' }),
    fixtureRow({ job_id: 'close-demoted', channel_id: 'UCclose-demoted' }),
    fixtureRow({ job_id: 'close-auxiliary', channel_id: 'UCclose-auxiliary' }),
    fixtureRow({ job_id: 'close-upstream', channel_id: 'UCclose-upstream' }),
    fixtureRow({ job_id: 'close-shared', channel_id: 'UCclose-shared' }),
    fixtureRow({ job_id: 'close-none', channel_id: 'UCclose-none' }),
  ];
  const newerObservations = [
    observationRow({ job_id: 'owning-required' }),
    observationRow({
      job_id: 'owning-static-gap',
      outcome: 'PARTIALLY_INSPECTED',
      failure_class: 'STATIC_BUDGET_GAP',
      provenance: { surface: 'CREATOR_WEBSITES', required: false },
    }),
    observationRow({
      job_id: 'owning-found-gap',
      outcome: 'FOUND',
      failure_class: 'RENDERED_BUDGET_EXPIRED',
    }),
    observationRow({
      job_id: 'close-redirect-limit',
      failure_class: 'REDIRECT_LIMIT',
    }),
    observationRow({
      job_id: 'close-demoted',
      provenance: { surface: 'CREATOR_WEBSITES', required: true, relevanceTier: 'DEMOTE' },
    }),
    observationRow({
      job_id: 'close-auxiliary',
      requested_url: 'https://creator.example.com/?ref=BRANDON',
    }),
    observationRow({
      job_id: 'close-upstream',
      provenance: { surface: 'YOUTUBE_ABOUT', required: true },
    }),
    observationRow({
      job_id: 'close-shared',
      provenance: {
        surface: 'CREATOR_WEBSITES',
        required: true,
        sharedEvidenceFrom: 'https://creator.example.com/lender',
      },
    }),
  ];
  const { db } = fakeDb(candidateRows, { newerObservations });
  const report = await buildPhase0ZombieReconciliationReport(db, { includeRows: true });

  const allRows = [...report.proposals, ...(report.skippedRows || [])];
  const byJob = new Map(allRows.map(row => [row.jobId, row]));
  const decision = (jobId: string) => {
    const row = byJob.get(jobId);
    assert.ok(row, `missing decision for ${jobId}`);
    return [row.decision, row.reason];
  };

  assert.deepEqual(decision('owning-required'), ['SKIP', 'NEWER_RETRY_OWNING_OBSERVATION']);
  assert.deepEqual(decision('owning-static-gap'), ['SKIP', 'NEWER_RETRY_OWNING_OBSERVATION']);
  assert.deepEqual(decision('owning-found-gap'), ['SKIP', 'NEWER_RETRY_OWNING_OBSERVATION']);
  for (const jobId of [
    'close-redirect-limit',
    'close-demoted',
    'close-auxiliary',
    'close-upstream',
    'close-shared',
    'close-none',
  ]) {
    assert.deepEqual(decision(jobId), ['PROPOSE_CLOSE', 'CHANNEL_TERMINAL']);
  }
  assert.equal(byJob.get('owning-required')?.newerRetryOwningObservations, 1);
  assert.equal(byJob.get('close-demoted')?.newerRetryOwningObservations, 0);
  assert.ok(
    byJob.get('owning-required')?.evidence.includes('newer_retry_owning_observations=1'),
  );
});

test('a non-finite maxJobs falls back to the documented bound', async () => {
  for (const maxJobs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const { db, sql, params } = fakeDb([fixtureRow()]);
    const report = await buildPhase0ZombieReconciliationReport(db, { maxJobs });
    assert.equal(report.maxJobs, 5_000);
    const candidateIndex = sql.findIndex(text =>
      text.includes('SELECT j.id AS job_id')
      && !text.includes('external_acquisition_observations'));
    assert.ok(candidateIndex >= 0);
    assert.equal(params[candidateIndex]?.[0], 5_000);
  }
});

test('--check fails when the candidate window truncates the report', async () => {
  const healthy = await buildPhase0ZombieReconciliationReport(
    fakeDb([fixtureRow()], { ledgerRows: 1 }).db,
  );
  assert.deepEqual(phase0ZombieReconciliationCheckFailures(healthy), []);

  const truncated = await buildPhase0ZombieReconciliationReport(
    fakeDb([fixtureRow()], { pendingRetries: 10 }).db,
    { maxJobs: 1 },
  );
  assert.deepEqual(phase0ZombieReconciliationCheckFailures(truncated), [
    'candidate_limit_reached',
  ]);
});

test('the report warns when the ledger is absent or empty and when the bound truncates', async () => {
  const { db } = fakeDb([fixtureRow()], {
    ledgerTablePresent: false,
    pendingRetries: 10,
    processingRetries: 0,
  });
  const report = await buildPhase0ZombieReconciliationReport(db, { maxJobs: 1 });
  assert.equal(report.schema.ledgerTablePresent, false);
  assert.ok(report.warnings.includes('ledger_table_missing_channel_evidence_only'));
  assert.ok(report.warnings.includes('candidate_limit_reached'));

  const emptyLedger = await buildPhase0ZombieReconciliationReport(
    fakeDb([fixtureRow()], { ledgerRows: 0 }).db,
  );
  assert.ok(emptyLedger.warnings.includes('phase0_ledger_empty_channel_evidence_only'));
});

test('--include-rows exposes the skipped decisions for audit', async () => {
  const { db } = fakeDb([
    fixtureRow({ job_id: 'close' }),
    fixtureRow({ job_id: 'skip', discord_validation_status: null, discord_status: 'UNCERTAIN' }),
  ]);
  const report = await buildPhase0ZombieReconciliationReport(db, { includeRows: true });
  assert.equal(report.skippedRows?.length, 1);
  assert.equal(report.skippedRows?.[0].jobId, 'skip');
  assert.ok(report.skippedRows?.[0].evidence.some(line => line.startsWith('ledger_rows=0')));
});

test('the dry-run module and CLI are read-only by construction', () => {
  const moduleSource = readFileSync(
    new URL('./phase0ZombieReconciliation.ts', import.meta.url),
    'utf8',
  );
  const scriptSource = readFileSync(
    new URL('../scripts/phase0ZombieReconciliationDryRun.ts', import.meta.url),
    'utf8',
  );
  for (const source of [moduleSource, scriptSource]) {
    assert.doesNotMatch(source, /\.query\(\s*`\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    assert.doesNotMatch(source, /db\.query\(\s*['"`]\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  }
  assert.match(scriptSource, /createReadOnlyDbPool/);
  assert.match(scriptSource, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.match(moduleSource, /dryRun: true/);
});
