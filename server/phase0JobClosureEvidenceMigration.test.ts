import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('./db/migrations/', import.meta.url));
const migrationName = '167_job_closure_evidence.sql';
const migration = readFileSync(`${migrationsDir}${migrationName}`, 'utf8');
const withoutSqlComments = migration
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');

test('migration 167 is present and sorts after the Phase 0 ledger migration', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes('164_job_clock_immutability_guard.sql'));
  assert.ok(files.includes('165_job_reopen_generation_guard.sql'));
  assert.ok(files.includes('166_community_acquisition_url_state.sql'));
  assert.ok(files.includes(migrationName));
  assert.ok(files.indexOf(migrationName) > files.indexOf('166_community_acquisition_url_state.sql'));
});

test('migration 167 adds nullable closure evidence columns additively', () => {
  assert.match(migration, /ALTER TABLE public\.jobs/);
  for (const column of [
    'closed_reason TEXT',
    'closed_evidence JSONB',
    'closed_by TEXT',
    'closed_at TIMESTAMPTZ',
  ]) {
    assert.ok(
      migration.includes(`ADD COLUMN IF NOT EXISTS ${column}`),
      `missing additive column definition: ${column}`,
    );
  }
  assert.doesNotMatch(
    withoutSqlComments,
    /\bADD COLUMN[^,;]*\b(?:NOT\s+NULL|DEFAULT)\b/i,
    'closure columns must stay nullable for historical rows',
  );
});

test('migration 167 requires all-or-none closure evidence without validating history', () => {
  assert.match(migration, /ADD CONSTRAINT jobs_closure_evidence_complete_check/);
  assert.match(migration, /CHECK \(/);
  assert.match(withoutSqlComments, /closed_at IS NULL/);
  assert.match(withoutSqlComments, /closed_reason IS NULL/);
  assert.match(withoutSqlComments, /closed_evidence IS NULL/);
  assert.match(withoutSqlComments, /closed_by IS NULL/);
  assert.match(withoutSqlComments, /closed_at IS NOT NULL/);
  assert.match(withoutSqlComments, /closed_reason IS NOT NULL/);
  assert.match(withoutSqlComments, /btrim\(closed_reason\) <> ''/);
  assert.match(withoutSqlComments, /closed_evidence IS NOT NULL/);
  assert.match(withoutSqlComments, /jsonb_typeof\(closed_evidence\) = 'object'/);
  assert.match(withoutSqlComments, /closed_by IS NOT NULL/);
  assert.match(withoutSqlComments, /btrim\(closed_by\) <> ''/);
  assert.match(migration, /\) NOT VALID;/);
  // The guard is idempotent, so a redeploy cannot fail on an existing constraint.
  assert.match(migration, /IF NOT EXISTS \(/);
  assert.match(migration, /FROM pg_constraint/);
});

test('migration 167 installs a single append-only BEFORE UPDATE guard on jobs', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.guard_job_closure_evidence\(\)/);
  assert.match(migration, /RETURNS trigger/);
  assert.match(migration, /LANGUAGE plpgsql/);
  assert.match(migration, /OLD\.closed_at IS NOT NULL/);
  for (const field of ['closed_at', 'closed_reason', 'closed_evidence', 'closed_by']) {
    assert.match(
      migration,
      new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`),
      `guard must protect ${field}`,
    );
  }
  assert.match(migration, /JOB_CLOSURE_IMMUTABLE: closure evidence cannot be rewritten/);
  assert.match(migration, /DROP TRIGGER IF EXISTS jobs_closure_evidence_guard ON public\.jobs/);
  assert.match(
    migration,
    /CREATE TRIGGER jobs_closure_evidence_guard\s+BEFORE UPDATE ON public\.jobs\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.guard_job_closure_evidence\(\)/s,
  );
  assert.equal((migration.match(/CREATE TRIGGER jobs_closure_evidence_guard/g) || []).length, 1);
});

test('migration 167 is additive and rewrites no historical rows', () => {
  assert.match(migration, /SET LOCAL lock_timeout = '10s'/);
  assert.doesNotMatch(withoutSqlComments, /\b(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(withoutSqlComments, /\bUPDATE\s+(?:public\.)?jobs\b/i);
  assert.doesNotMatch(withoutSqlComments, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(withoutSqlComments, /\bSET\s+closed_(?:reason|evidence|by|at)\s*=/i);
  assert.doesNotMatch(withoutSqlComments, /first_enqueued_at\s*=/i);
  assert.doesNotMatch(withoutSqlComments, /first_transient_failure_at\s*=/i);
  assert.doesNotMatch(withoutSqlComments, /capacity_lease_\w+\s*=/i);
});

test('the closure write is confined to the operator-gated apply path', () => {
  const applyModule = readFileSync(new URL('./phase0ZombieApply.ts', import.meta.url), 'utf8');
  const applyScript = readFileSync(new URL('../scripts/phase0ZombieApply.ts', import.meta.url), 'utf8');

  // The apply writes all four closure fields in one statement, so a crash
  // cannot leave a partially evidenced closure.
  assert.match(applyModule, /closed_reason=\$2/);
  assert.match(applyModule, /closed_evidence=\$3::jsonb/);
  assert.match(applyModule, /closed_by=\$4/);
  assert.match(applyModule, /closed_at=\$5::timestamptz/);
  assert.match(applyModule, /AND status='PENDING'/);
  assert.match(applyModule, /AND closed_at IS NULL/);
  assert.match(applyModule, /FOR UPDATE SKIP LOCKED/);

  // A report-only run (no --apply) must never reach the closure UPDATE.
  assert.match(applyModule, /if \(!apply\) \{/);
  assert.match(applyScript, /args\.apply/);
  assert.match(applyScript, /createOperatorWriteDbPool/);

  // No other production module may write closure evidence outside the apply.
  for (const file of ['communityRecovery.ts', 'dbCore.ts', 'queueManager.ts']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /closed_(?:reason|evidence|by|at)\s*=/,
      `${file} must not write closure evidence outside the operator apply`,
    );
  }
});
