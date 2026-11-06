import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('./db/migrations/', import.meta.url));
const migrationName = '162_job_clock_and_capacity_lease.sql';
const migration = readFileSync(`${migrationsDir}${migrationName}`, 'utf8');
const withoutSqlComments = migration
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');
const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');

test('migration 162 is present and sorts after migration 161', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes('161_country_discovery_loop.sql'));
  assert.ok(files.includes(migrationName));
  assert.ok(files.indexOf(migrationName) > files.indexOf('161_country_discovery_loop.sql'));
});

test('migration 162 adds separate queue, capacity-lease, and reopen clocks additively', () => {
  for (const column of [
    'first_enqueued_at TIMESTAMPTZ',
    'last_enqueued_at TIMESTAMPTZ',
    'capacity_lease_started_at TIMESTAMPTZ',
    'capacity_lease_expires_at TIMESTAMPTZ',
    'capacity_lease_renewed_at TIMESTAMPTZ',
    'capacity_lease_renewals INTEGER NOT NULL DEFAULT 0',
    'reopen_generation INTEGER NOT NULL DEFAULT 0',
    'last_reopened_at TIMESTAMPTZ',
  ]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.doesNotMatch(withoutSqlComments, /\b(?:DROP|DELETE|TRUNCATE)\b/i);
  assert.equal(
    (migration.match(/ADD COLUMN IF NOT EXISTS first_transient_failure_at/g) || []).length,
    0,
    'the existing failure-budget anchor must not be duplicated by this migration',
  );
});

test('migration 162 performs only metadata-only DDL and defers the backfill', () => {
  assert.doesNotMatch(withoutSqlComments, /DO\s+\$\$/);
  assert.doesNotMatch(withoutSqlComments, /UPDATE\s+public\.jobs/i);
  assert.doesNotMatch(withoutSqlComments, /SET\s+NOT\s+NULL/i);
  assert.match(migration, /ALTER COLUMN first_enqueued_at SET DEFAULT now\(\)/);
  assert.match(migration, /ALTER COLUMN last_enqueued_at SET DEFAULT now\(\)/);
  assert.ok(
    migration.indexOf('SET DEFAULT now()') > migration.indexOf('ADD COLUMN IF NOT EXISTS'),
    'defaults are applied after the columns exist and never rewrite existing rows',
  );
});

test('the runner backfills queue clocks in bounded idempotent batches', () => {
  assert.match(dbCore, /export async function backfillPhase0JobClocks/);
  assert.match(dbCore, /WHERE \(first_enqueued_at IS NULL OR last_enqueued_at IS NULL\)/);
  assert.match(dbCore, /AND id > \$1::uuid/);
  assert.match(dbCore, /LIMIT \$2/);
  assert.match(dbCore, /SELECT job_id, MIN\(started_at\) AS started_at/);
  assert.match(dbCore, /phase0PayloadEpochMs\(row\.payload\)/);
  assert.match(dbCore, /function phase0PayloadEpochMs\(payload: unknown\)/);
  assert.match(dbCore, /retryObservedAt/);
  assert.match(dbCore, /COALESCE\(j\.first_enqueued_at,v\.first_enqueued_at\)/);
  assert.match(dbCore, /COALESCE\(j\.last_enqueued_at,v\.last_enqueued_at\)/);
  assert.ok(
    dbCore.indexOf('await backfillPhase0JobClocks(client)') > dbCore.indexOf('for (const file of files)'),
    'the backfill must run outside the transactional migration loop',
  );
  assert.ok(
    dbCore.indexOf('await backfillPhase0JobClocks(client)') < dbCore.indexOf('await ensurePhase0JobClockIndexes(client)'),
    'queue clocks must be backfilled before the queue-age index is built',
  );
});

test('migration 162 never rewrites the genuine transient-failure anchor', () => {
  assert.doesNotMatch(withoutSqlComments, /first_transient_failure_at\s*=/i);
  assert.doesNotMatch(withoutSqlComments, /created_at\s*=\s*now\(\)/i);
});

test('migration 162 defers populated-table indexes to the concurrent runner', () => {
  assert.doesNotMatch(withoutSqlComments, /CREATE\s+INDEX/i);
  assert.match(dbCore, /async function ensurePhase0JobClockIndexes/);
  assert.match(
    dbCore,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_pending_queue_age ON public\.jobs \(priority DESC, first_enqueued_at ASC\) WHERE status='PENDING'/,
  );
  assert.match(
    dbCore,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_capacity_lease_pending ON public\.jobs \(capacity_lease_expires_at\) WHERE status='PENDING' AND capacity_lease_expires_at IS NOT NULL/,
  );
  assert.match(dbCore, /const phase0ClockMigration = await client\.query\('SELECT 1 FROM schema_migrations WHERE version=162'\);/);
  assert.match(dbCore, /if \(phase0ClockMigration\.rowCount\) \{/);
  assert.ok(
    dbCore.indexOf('await ensurePhase0JobClockIndexes(client)') > dbCore.indexOf('for (const file of files)'),
    'the index helper must run after migration 162 commits its columns',
  );
});

test('the concurrent index helper repairs invalid remnants before rebuilding', () => {
  assert.match(dbCore, /if \(row\?\.indisvalid && row\?\.indisready\) continue;/);
  assert.match(dbCore, /if \(row\?\.oid\) \{\s*await client\.query\(`DROP INDEX CONCURRENTLY IF EXISTS public\.\$\{index\.name\}`\);/s);
  assert.ok(
    dbCore.indexOf('DROP INDEX CONCURRENTLY IF EXISTS public.${index.name}') < dbCore.indexOf('await client.query(index.create)'),
    'an invalid concurrent-build remnant must be dropped before the rebuild',
  );
});
