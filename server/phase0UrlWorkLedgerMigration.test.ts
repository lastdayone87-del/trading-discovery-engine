import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('./db/migrations/', import.meta.url));
const migrationName = '166_community_acquisition_url_state.sql';
const migration = readFileSync(`${migrationsDir}${migrationName}`, 'utf8');
const withoutSqlComments = migration
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');
const ledgerModule = readFileSync(new URL('./communityAcquisitionWorkLedger.ts', import.meta.url), 'utf8');
const reportBuilder = readFileSync(new URL('./phase0UrlWorkLedgerReport.ts', import.meta.url), 'utf8');
const reportScript = readFileSync(new URL('../scripts/phase0UrlWorkLedgerReport.ts', import.meta.url), 'utf8');

test('migration 166 is present and sorts after the classification migration', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes('163_job_attempt_failure_classification.sql'));
  assert.ok(files.includes(migrationName));
  assert.ok(files.indexOf(migrationName) > files.indexOf('163_job_attempt_failure_classification.sql'));
});

test('migration 166 adds the mutable URL work ledger additively', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.community_acquisition_url_state/);
  for (const column of [
    'work_key TEXT PRIMARY KEY',
    'channel_id TEXT NOT NULL',
    'url TEXT NOT NULL',
    'normalized_url TEXT NOT NULL',
    'surface TEXT NOT NULL',
    "state TEXT NOT NULL DEFAULT 'PENDING'",
    'never_executed BOOLEAN NOT NULL DEFAULT TRUE',
    'attempts INTEGER NOT NULL DEFAULT 0',
    'max_attempts INTEGER NOT NULL DEFAULT 5',
    'retryable BOOLEAN NOT NULL DEFAULT FALSE',
    'browser_executed BOOLEAN NOT NULL DEFAULT FALSE',
    'first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now()',
    'last_attempt_at TIMESTAMPTZ',
    'next_eligible_at TIMESTAMPTZ NOT NULL DEFAULT now()',
    'last_failure_class TEXT',
    'last_outcome TEXT',
    'terminal_reason TEXT',
    "terminal_evidence JSONB NOT NULL DEFAULT '{}'::jsonb",
    'created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
    'updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
  ]) {
    assert.ok(migration.includes(column), `missing column definition: ${column}`);
  }
});

test('migration 166 constrains the lifecycle and idempotent work identity', () => {
  for (const state of ['PENDING', 'RUNNING', 'RESOLVED', 'PARKED_INFRA', 'PARKED_EXTERNAL', 'EXHAUSTED']) {
    assert.ok(migration.includes(`'${state}'`), `missing state: ${state}`);
  }
  assert.match(migration, /UNIQUE \(channel_id, normalized_url, surface\)/);
  assert.match(migration, /attempts INTEGER NOT NULL DEFAULT 0 CHECK \(attempts >= 0\)/);
  assert.match(migration, /max_attempts INTEGER NOT NULL DEFAULT 5 CHECK \(max_attempts > 0\)/);
  assert.match(migration, /CHECK \(jsonb_typeof\(terminal_evidence\) = 'object'\)/);
  assert.match(migration, /CHECK \(never_executed OR attempts > 0\)/);
  assert.match(migration, /CHECK \(NOT browser_executed OR NOT never_executed\)/);
});

test('migration 166 indexes the due, channel, and never-executed claims', () => {
  assert.match(migration, /idx_community_url_state_due/);
  assert.match(
    migration,
    /ON public\.community_acquisition_url_state \(state, next_eligible_at\)\s+WHERE state IN \('PENDING', 'RUNNING'\)/,
  );
  assert.match(migration, /idx_community_url_state_channel/);
  assert.match(migration, /idx_community_url_state_never_executed/);
  assert.match(migration, /WHERE never_executed/);
});

test('migration 166 touches updated_at without rewriting history', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.touch_community_acquisition_url_state_updated_at\(\)/);
  assert.match(migration, /NEW\.updated_at := clock_timestamp\(\)/);
  assert.match(migration, /BEFORE UPDATE ON public\.community_acquisition_url_state/);
  assert.doesNotMatch(withoutSqlComments, /DELETE\s+FROM/i);
  assert.doesNotMatch(withoutSqlComments, /TRUNCATE\s+/i);
  assert.doesNotMatch(withoutSqlComments, /UPDATE\s+public\.community_acquisition_url_state\s+SET/i);
  assert.doesNotMatch(withoutSqlComments, /INSERT\s+INTO\s+public\.community_acquisition_url_state/i);
});

test('the ledger derivation is pure and never reads the database', () => {
  assert.doesNotMatch(
    ledgerModule,
    /from\s+['"]\.\/db(?:['"/])|import\(\s*['"]\.\/db(?:['"/])|require\(\s*['"]\.\/db(?:['"/])/,
  );
  assert.doesNotMatch(ledgerModule, /\bgetDb\b|\bPool\b|\.query\(/);
  assert.match(ledgerModule, /COMMUNITY_ACQUISITION_WORK_SURFACES/);
});

test('the Phase 0 report is read-only and reconciles the two bounds', () => {
  assert.doesNotMatch(reportBuilder, /INSERT\s+INTO\s+(?:public\.)?community_acquisition_url_state/i);
  assert.doesNotMatch(reportBuilder, /UPDATE\s+(?:public\.)?community_acquisition_url_state/i);
  assert.doesNotMatch(reportBuilder, /DELETE\s+FROM\s+(?:public\.)?community_acquisition_url_state/i);
  assert.match(reportBuilder, /reconcileCommunityWorkProjection/);
  assert.match(reportBuilder, /never_browser_executed_rows/);
  assert.match(reportBuilder, /ledger_empty_phase0_expected/);
  assert.match(reportBuilder, /retryableWithinFivePercent/);
  assert.match(reportBuilder, /no_retryable_work_measured/);
  assert.match(ledgerModule, /projectionRetryableNeverBrowserExecutedRows/);
  assert.match(reportBuilder, /bool_or\(browser_executed\)/);
  assert.match(reportBuilder, /o\.final_url/);
  assert.match(reportBuilder, /l\.source_url/);
  assert.doesNotMatch(reportBuilder, /canonical_url|site_inspections/);
  assert.match(reportBuilder, /\^\[0-9\]\{1,18\}\$/);
  assert.match(reportBuilder, /::numeric <= 2147483647/);
  assert.ok(
    reportBuilder.includes('THEN (${jsonExpression})::int ELSE 0 END'),
    'JSONB text casts must be parenthesized so ::int does not bind to the key literal',
  );
  assert.match(reportScript, /buildPhase0UrlWorkLedgerReport/);
  assert.match(reportScript, /createReadOnlyDbPool/);
  assert.doesNotMatch(reportScript, /\bgetDb\b/);
  assert.match(reportScript, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.doesNotMatch(reportScript, /process\.exit\(/);
  assert.doesNotMatch(reportScript, /INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i);
});

test('Phase 0 wires no worker to the ledger', () => {
  for (const file of ['dbCore.ts', 'queueManager.ts', 'inspector.ts', 'communityRecovery.ts', 'browserCommunityFallback.ts']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /communityAcquisitionWorkLedger|community_acquisition_url_state/,
      `${file} must not read or write the Phase 0 ledger`,
    );
  }
});
