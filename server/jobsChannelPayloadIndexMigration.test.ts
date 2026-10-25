/**
 * Migration 157 persists the channel-payload index in the migration lineage.
 *
 * The index existed in production before this migration, so the contract is
 * adoption rather than rebuild: it must be IF NOT EXISTS, target the exact
 * expression the runtime queries use, and stay additive-only.
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

test('migration 157 is present and sorts after migration 156', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes(migrationName));
  assert.ok(files.indexOf(migrationName) > files.indexOf('156_adaptive_discovery_pilot.sql'));
});

test('migration 157 adopts the exact channel-payload index without rebuilding it', () => {
  assert.match(migration, /SET LOCAL lock_timeout = '10s';/);
  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS idx_jobs_channel_payload\s+ON public\.jobs USING btree \(\(\(payload ->> 'channelId'::text\)\)\);/,
  );
  assert.match(migration, /COMMENT ON INDEX public\.idx_jobs_channel_payload/);
  assert.match(migration, /catalog no-op/);
  assert.match(migration, /write-blocking lock/);
  assert.match(migration, /lock_timeout bounds the wait/);
  assert.doesNotMatch(
    withoutSqlComments,
    /CONCURRENTLY/i,
    'the migration runner wraps files in a transaction, so the SQL itself must not request a concurrent build',
  );
});

test('migration 157 is additive-only', () => {
  assert.doesNotMatch(withoutSqlComments, /\b(?:DROP|DELETE|TRUNCATE|UPDATE)\b/i);
});
