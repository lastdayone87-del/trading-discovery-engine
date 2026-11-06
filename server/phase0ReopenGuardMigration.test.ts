import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('./db/migrations/', import.meta.url));
const migrationName = '165_job_reopen_generation_guard.sql';
const migration = readFileSync(`${migrationsDir}${migrationName}`, 'utf8');
const withoutSqlComments = migration
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');
const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');

test('migration 165 is present and sorts after the classification migration', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes('163_job_attempt_failure_classification.sql'));
  assert.ok(files.includes(migrationName));
  assert.ok(files.indexOf(migrationName) > files.indexOf('163_job_attempt_failure_classification.sql'));
});

test('migration 165 adds reopen identity and generation-scoped attempt history additively', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS reopened_from_status TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.job_reopen_events/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.job_reopen_guard_config/);
  assert.match(migration, /outcome TEXT NOT NULL CHECK \(outcome IN \('REOPENED', 'BLOCKED'\)\)/);
  assert.match(migration, /prior_status TEXT NOT NULL/);
  assert.match(migration, /prior_generation INTEGER NOT NULL/);
  assert.match(migration, /next_generation INTEGER/);
});

test('the reopen guard is default-off and shadow-first', () => {
  assert.match(migration, /enabled BOOLEAN NOT NULL DEFAULT false/);
  assert.match(migration, /max_reopens_per_30d INTEGER NOT NULL DEFAULT 6/);
  assert.match(migration, /VALUES \(true, false, 6\)/);
  assert.match(migration, /IF guard_enabled AND guarded_type AND channel_key IS NOT NULL AND NOT override_enabled THEN/);
  assert.match(migration, /guard_enabled := COALESCE\(guard_enabled, false\)/);
});

test('the guard only caps terminal-to-pending acquisition reopens', () => {
  assert.match(migration, /NEW\.status IS DISTINCT FROM 'PENDING'/);
  assert.match(migration, /OLD\.status NOT IN \('COMPLETED', 'FAILED'\)/);
  assert.match(migration, /OLD\.type IN \('RETRY_COMMUNITY_ACQUISITION', 'ENRICH_CHANNEL'\)/);
  assert.match(migration, /interval '30 days'/);
  assert.match(migration, /current_setting\('acquisition\.reopen_guard_override', true\)/);
  assert.match(migration, /RETURN NULL/);
});

test('the guard preserves the old generation when it blocks a reopen', () => {
  assert.match(migration, /NEW\.reopen_generation <= OLD\.reopen_generation/);
  assert.match(migration, /NEW\.reopen_generation := COALESCE\(OLD\.reopen_generation, 0\) \+ 1/);
  assert.match(migration, /NEW\.last_reopened_at IS NOT DISTINCT FROM OLD\.last_reopened_at/);
  assert.match(migration, /NEW\.last_reopened_at := now\(\)/);
});

test('migration 165 is additive and rewrites no existing job or observation', () => {
  assert.doesNotMatch(withoutSqlComments, /DROP\s+(TABLE|COLUMN)/i);
  assert.doesNotMatch(withoutSqlComments, /DELETE\s+FROM/i);
  assert.doesNotMatch(withoutSqlComments, /TRUNCATE\s+/i);
  assert.doesNotMatch(withoutSqlComments, /UPDATE\s+public\.jobs/i);
});

test('claims and reopen bookkeeping carry the generation through the writer', () => {
  assert.match(
    dbCore,
    /INSERT INTO job_attempts\(job_id,attempt_number,generation,status\) VALUES\(\$1,\$2,\$3,'PROCESSING'\)/,
  );
  assert.match(dbCore, /Number\(upd\.rows\[0\]\.reopen_generation\|\|0\)/);
  assert.match(dbCore, /event:'job_reopen_guard_blocked'/);
  assert.match(dbCore, /throw new Error\('JOB_ENQUEUE_LOST_ROW'\)/);
  assert.ok(
    dbCore.indexOf(`if(res.rows[0])return rowToJob(res.rows[0]);`) < dbCore.indexOf(`event:'job_reopen_guard_blocked'`),
    'the blocked-reopen fallback must only run when the upsert returned no row',
  );
});
