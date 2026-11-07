import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPhase0ZombieReconciliationReport,
  classifyZombieRetryClosure,
  parsePhase0ZombieReconciliationArgs,
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
  newerRetryableRequiredObservations: 0,
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

test('fresh required retryable evidence blocks closure', () => {
  assert.deepEqual(
    classifyZombieRetryClosure({
      ...baseEvidence,
      discordValidationStatus: 'SUCCEEDED',
      newerRetryableRequiredObservations: 1,
    }),
    { decision: 'SKIP', reason: 'NEWER_RETRYABLE_OBSERVATION' },
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
    retry_observed_at: '2026-10-02T00:00:00.000Z',
    channel_present: true,
    discord_validation_status: 'SUCCEEDED',
    discord_status: 'FOUND',
    ledger_rows: 0,
    ledger_active_rows: 0,
    ledger_terminal_rows: 0,
    newer_retryable_required: 0,
    ...overrides,
  };
}

function fakeDb(candidateRows: any[], options: {
  ledgerTablePresent?: boolean;
  pendingRetries?: number;
  processingRetries?: number;
  ledgerRows?: number;
} = {}) {
  const sql: string[] = [];
  const db = {
    async query(text: string) {
      sql.push(text);
      if (text.includes('to_regclass')) {
        return { rows: [{ ledger_table_present: options.ledgerTablePresent !== false }] };
      }
      if (text.includes('pending_retries')) {
        return {
          rows: [{
            pending_retries: options.pendingRetries ?? candidateRows
              .filter(row => row.job_status === 'PENDING').length,
            processing_retries: options.processingRetries ?? candidateRows
              .filter(row => row.job_status === 'PROCESSING').length,
          }],
        };
      }
      if (text.includes('WITH candidates AS')) return { rows: candidateRows };
      if (text.includes('FROM community_acquisition_url_state')) {
        return { rows: [{ rows: options.ledgerRows ?? 0 }] };
      }
      return { rows: [] };
    },
  };
  return { db, sql };
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
    fixtureRow({ job_id: 'fresh-evidence', channel_id: 'UCfresh', newer_retryable_required: 1 }),
  ];
  const { db, sql } = fakeDb(candidateRows);
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
  assert.equal(report.summary.byReason.NEWER_RETRYABLE_OBSERVATION, 1);
  assert.equal(report.skippedRows, undefined, 'skipped rows are opt-in');

  const proposals = report.proposals.map(row => row.jobId).join(',');
  const skipped = report.summary.skipped;
  assert.equal(proposals.split(',').length, 2);
  assert.equal(report.summary.proposedClosures + skipped, report.population.examined);

  const candidateSql = sql.find(text => text.includes('WITH candidates AS'));
  assert.ok(candidateSql);
  assert.match(candidateSql, /pg_input_is_valid/);
  assert.match(candidateSql, /o\.provenance->'required' = 'true'::jsonb/);
  assert.match(candidateSql, /o\.retryable = true/);
  assert.match(candidateSql, /o\.observed_at > c\.retry_observed_at/);
  assert.match(candidateSql, /RESOLVED','PARKED_EXTERNAL','EXHAUSTED/);
  assert.match(candidateSql, /PENDING','RUNNING','PARKED_INFRA/);
  assert.match(candidateSql, /LIMIT \$1/);
  assert.doesNotMatch(candidateSql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
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
