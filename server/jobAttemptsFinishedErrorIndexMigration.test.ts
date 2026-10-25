/**
 * Migration 160 indexes the cap monitor's rolling attempt window.
 *
 * The index must stay additive-only, use the exact partial predicate the
 * monitor query needs, and never hold a write-blocking build on a populated
 * job_attempts table. A failed concurrent build must never leave an invalid
 * index recorded as an applied migration.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('./db/migrations/', import.meta.url));
const migrationName = '160_job_attempts_finished_error_index.sql';
const migration = readFileSync(`${migrationsDir}${migrationName}`, 'utf8');
const withoutSqlComments = migration
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');
const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');

test('migration 160 is present and sorts after migration 159', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes(migrationName));
  assert.ok(files.indexOf(migrationName) > files.indexOf('159_youtube_key_cap_monitor_stops.sql'));
});

test('migration 160 adopts the exact monitor index without rebuilding it', () => {
  assert.match(migration, /SET LOCAL lock_timeout = '10s';/);
  assert.match(migration, /SELECT c\.oid, i\.indisvalid, i\.indisready/);
  assert.match(migration, /WHERE c\.oid = to_regclass\('public\.idx_job_attempts_finished_error'\)/);
  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS idx_job_attempts_finished_error\s+ON public\.job_attempts \(finished_at\)\s+WHERE error IS NOT NULL;/,
  );
  assert.match(migration, /catalog no-op/);
  assert.match(migration, /fails closed instead of holding a write-blocking lock/);
  assert.match(migration, /pre-migration helper builds that index with\s+--\s+CREATE INDEX CONCURRENTLY/);
  assert.doesNotMatch(
    withoutSqlComments,
    /CREATE\s+INDEX\s+CONCURRENTLY/i,
    'the migration runner wraps files in a transaction, so the SQL itself must not request a concurrent build',
  );
});

test('migration 160 fails closed instead of building on a populated table', () => {
  assert.match(migration, /IF EXISTS \(SELECT 1 FROM public\.job_attempts LIMIT 1\) THEN/);
  assert.match(migration, /RAISE EXCEPTION 'job_attempts is populated and idx_job_attempts_finished_error is absent/);
  assert.match(migration, /create it CONCURRENTLY out-of-band before applying migration 160/);
});

test('migration 160 rejects an invalid or not-ready index instead of recording it', () => {
  assert.match(migration, /IF index_oid IS NOT NULL AND \(NOT index_valid OR NOT index_ready\) THEN/);
  assert.match(migration, /RAISE EXCEPTION 'idx_job_attempts_finished_error exists but is not valid\/ready/);
  assert.match(migration, /rebuild it CONCURRENTLY out-of-band before applying migration 160/);
});

test('migration 160 does not require index ownership for a comment', () => {
  assert.doesNotMatch(withoutSqlComments, /COMMENT ON INDEX/i);
});

test('the migration runner builds a missing index concurrently before migration 160', () => {
  assert.match(
    dbCore,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_attempts_finished_error ON public\.job_attempts \(finished_at\) WHERE error IS NOT NULL/,
  );
  assert.match(dbCore, /const migration160 = await client\.query\('SELECT 1 FROM schema_migrations WHERE version=160'\);/);
  assert.match(dbCore, /if \(!migration160\.rowCount\) await ensureJobAttemptsFinishedErrorIndex\(client\);/);
  assert.match(
    dbCore,
    /const populated = await client\.query\(`SELECT EXISTS\(SELECT 1 FROM public\.job_attempts LIMIT 1\) AS populated`\);/,
  );
  assert.match(dbCore, /if \(!populated\.rows\[0\]\?\.populated\) return;/);
  assert.ok(
    dbCore.indexOf('await ensureJobAttemptsFinishedErrorIndex(client)') < dbCore.indexOf('const files = fs.readdirSync(MIGRATIONS_DIR)'),
    'the concurrent ensure step must run before the transactional migration loop',
  );
});

test('the runner repairs an invalid concurrent-build remnant before adopting the index', () => {
  assert.match(dbCore, /SELECT c\.oid, i\.indisvalid, i\.indisready/);
  assert.match(dbCore, /if \(existing\?\.indisvalid && existing\?\.indisready\) return;/);
  assert.match(dbCore, /if \(existing\?\.oid\) \{/);
  assert.match(dbCore, /DROP INDEX CONCURRENTLY IF EXISTS public\.idx_job_attempts_finished_error/);
  assert.ok(
    dbCore.indexOf('DROP INDEX CONCURRENTLY IF EXISTS public.idx_job_attempts_finished_error') < dbCore.indexOf('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_attempts_finished_error'),
    'the invalid remnant must be dropped before the concurrent rebuild',
  );
});

test('migration 160 is additive-only', () => {
  assert.doesNotMatch(withoutSqlComments, /\b(?:DROP|DELETE|TRUNCATE|UPDATE)\b/i);
});
