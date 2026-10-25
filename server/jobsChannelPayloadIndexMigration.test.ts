/**
 * Migration 157 persists the channel-payload index in the migration lineage.
 *
 * The index existed in production before this migration, so the contract is
 * adoption rather than rebuild: it must target the exact expression the
 * runtime queries use, stay additive-only, and never hold a write-blocking
 * build on a populated jobs table. A failed concurrent build must never leave
 * an invalid index recorded as an applied migration.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('./db/migrations/', import.meta.url));
const migrationName = '157_jobs_channel_payload_index.sql';
const migration = readFileSync(`${migrationsDir}${migrationName}`, 'utf8');
const withoutSqlComments = migration
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');
const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');

test('migration 157 is present and sorts after migration 156', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes(migrationName));
  assert.ok(files.indexOf(migrationName) > files.indexOf('156_adaptive_discovery_pilot.sql'));
});

test('migration 157 adopts the exact channel-payload index without rebuilding it', () => {
  assert.match(migration, /SET LOCAL lock_timeout = '10s';/);
  assert.match(migration, /SELECT c\.oid, i\.indisvalid, i\.indisready/);
  assert.match(migration, /WHERE c\.oid = to_regclass\('public\.idx_jobs_channel_payload'\)/);
  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS idx_jobs_channel_payload\s+ON public\.jobs USING btree \(\(\(payload ->> 'channelId'::text\)\)\);/,
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

test('migration 157 fails closed instead of building on a populated table', () => {
  assert.match(migration, /IF EXISTS \(SELECT 1 FROM public\.jobs LIMIT 1\) THEN/);
  assert.match(migration, /RAISE EXCEPTION 'jobs is populated and idx_jobs_channel_payload is absent/);
  assert.match(migration, /create it CONCURRENTLY out-of-band before applying migration 157/);
});

test('migration 157 rejects an invalid or not-ready index instead of recording it', () => {
  assert.match(migration, /IF index_oid IS NOT NULL AND \(NOT index_valid OR NOT index_ready\) THEN/);
  assert.match(migration, /RAISE EXCEPTION 'idx_jobs_channel_payload exists but is not valid\/ready/);
  assert.match(migration, /rebuild it CONCURRENTLY out-of-band before applying migration 157/);
});

test('migration 157 does not require index ownership for a comment', () => {
  assert.doesNotMatch(withoutSqlComments, /COMMENT ON INDEX/i);
});

test('the migration runner builds a missing index concurrently before migration 157', () => {
  assert.match(
    dbCore,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_channel_payload ON public\.jobs USING btree \(\(\(payload ->> 'channelId'::text\)\)\)/,
  );
  assert.match(dbCore, /const migration157 = await client\.query\('SELECT 1 FROM schema_migrations WHERE version=157'\);/);
  assert.match(dbCore, /if \(!migration157\.rowCount\) await ensureJobsChannelPayloadIndex\(client\);/);
  assert.match(
    dbCore,
    /const populated = await client\.query\(`SELECT EXISTS\(SELECT 1 FROM public\.jobs LIMIT 1\) AS populated`\);/,
  );
  assert.match(dbCore, /if \(!populated\.rows\[0\]\?\.populated\) return;/);
  assert.ok(
    dbCore.indexOf('await ensureJobsChannelPayloadIndex(client)') < dbCore.indexOf('const files = fs.readdirSync(MIGRATIONS_DIR)'),
    'the concurrent ensure step must run before the transactional migration loop',
  );
});

test('the runner repairs an invalid concurrent-build remnant before adopting the index', () => {
  assert.match(dbCore, /SELECT c\.oid, i\.indisvalid, i\.indisready/);
  assert.match(dbCore, /if \(existing\?\.indisvalid && existing\?\.indisready\) return;/);
  assert.match(dbCore, /if \(existing\?\.oid\) \{/);
  assert.match(dbCore, /DROP INDEX CONCURRENTLY IF EXISTS public\.idx_jobs_channel_payload/);
  assert.ok(
    dbCore.indexOf('DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_channel_payload') < dbCore.indexOf('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_channel_payload'),
    'the invalid remnant must be dropped before the concurrent rebuild',
  );
});

test('migration 157 is additive-only', () => {
  assert.doesNotMatch(withoutSqlComments, /\b(?:DROP|DELETE|TRUNCATE|UPDATE)\b/i);
});
