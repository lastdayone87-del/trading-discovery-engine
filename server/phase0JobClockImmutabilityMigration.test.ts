import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('./db/migrations/', import.meta.url));
const migrationName = '164_job_clock_immutability_guard.sql';
const migration = readFileSync(`${migrationsDir}${migrationName}`, 'utf8');
const withoutSqlComments = migration
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');

test('migration 164 is present and sorts after the Phase 0 schema migrations', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes('162_job_clock_and_capacity_lease.sql'));
  assert.ok(files.includes('163_job_attempt_failure_classification.sql'));
  assert.ok(files.includes(migrationName));
  assert.ok(files.indexOf(migrationName) > files.indexOf('163_job_attempt_failure_classification.sql'));
});

test('migration 164 installs a single BEFORE UPDATE guard on jobs', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.guard_job_clock_immutability\(\)/);
  assert.match(migration, /RETURNS trigger/);
  assert.match(migration, /LANGUAGE plpgsql/);
  assert.match(migration, /DROP TRIGGER IF EXISTS jobs_clock_immutability_guard ON public\.jobs/);
  assert.match(migration, /CREATE TRIGGER jobs_clock_immutability_guard\s+BEFORE UPDATE ON public\.jobs\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.guard_job_clock_immutability\(\)/s);
  assert.equal((migration.match(/CREATE TRIGGER jobs_clock_immutability_guard/g) || []).length, 1);
});

test('migration 164 makes the queue clock immutable once populated', () => {
  assert.match(migration, /OLD\.first_enqueued_at IS NOT NULL/);
  assert.match(migration, /NEW\.first_enqueued_at IS DISTINCT FROM OLD\.first_enqueued_at/);
  assert.match(migration, /JOB_CLOCK_IMMUTABLE: first_enqueued_at/);
});

test('migration 164 prevents moving a genuine failure anchor', () => {
  assert.match(migration, /OLD\.first_transient_failure_at IS NOT NULL/);
  assert.match(migration, /NEW\.first_transient_failure_at IS NOT NULL/);
  assert.match(migration, /NEW\.first_transient_failure_at IS DISTINCT FROM OLD\.first_transient_failure_at/);
  assert.match(migration, /JOB_CLOCK_IMMUTABLE: first_transient_failure_at/);
});

test('migration 164 forbids lease bookkeeping from rewriting queue or failure age', () => {
  for (const field of [
    'capacity_lease_started_at',
    'capacity_lease_expires_at',
    'capacity_lease_renewed_at',
    'capacity_lease_renewals',
  ]) {
    assert.match(migration, new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`));
  }
  assert.match(migration, /NEW\.created_at IS DISTINCT FROM OLD\.created_at/);
  assert.match(migration, /NEW\.first_transient_failure_at IS DISTINCT FROM OLD\.first_transient_failure_at/);
  assert.match(migration, /JOB_CLOCK_IMMUTABLE: capacity lease renewal/);
});

test('migration 164 is additive and rewrites no historical rows', () => {
  assert.match(migration, /SET LOCAL lock_timeout = '10s'/);
  assert.doesNotMatch(withoutSqlComments, /\b(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(withoutSqlComments, /\bUPDATE\s+(?:public\.)?jobs\b/i);
  assert.doesNotMatch(withoutSqlComments, /\bALTER\s+TABLE\b/i);
  assert.doesNotMatch(withoutSqlComments, /first_enqueued_at\s*=/i);
  assert.doesNotMatch(withoutSqlComments, /first_transient_failure_at\s*=/i);
});
