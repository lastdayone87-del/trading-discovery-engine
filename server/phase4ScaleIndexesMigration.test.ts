/**
 * Migration 170 indexes the enrichment throughput window and semantic cache
 * retention sweep.
 *
 * The jobs indexes must never take a write-blocking build on the populated
 * queue table. The runner prebuilds them CONCURRENTLY; the transactional
 * migration only adopts a valid index or verifies an empty table. A failed
 * concurrent build must never leave an invalid index recorded as applied.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('./db/migrations/', import.meta.url));
const migrationName = '170_phase4_scale_indexes.sql';
const migration = readFileSync(`${migrationsDir}${migrationName}`, 'utf8');
const withoutSqlComments = migration
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');
const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');

const indexes = [
  'idx_jobs_enrich_created_at',
  'idx_jobs_enrich_completed_at',
  'idx_semantic_cache_retention',
];

test('migration 170 is present and sorts after migration 169', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes(migrationName));
  assert.ok(files.indexOf(migrationName) > files.indexOf('169_semantic_classification_cache.sql'));
});

test('migration 170 adopts every index without rebuilding it transactionally', () => {
  assert.match(migration, /SET LOCAL lock_timeout = '10s';/);
  for (const name of indexes) {
    assert.match(migration, new RegExp(`WHERE c\\.oid = to_regclass\\('public\\.${name}'\\)`), `${name} must be adopted by catalog name`);
    assert.match(migration, new RegExp(`RAISE EXCEPTION '${name} exists but is not valid/ready`), `${name} must reject an invalid build`);
  }
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_jobs_enrich_created_at\s+ON public\.jobs \(created_at\)\s+WHERE type='ENRICH_CHANNEL';/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_jobs_enrich_completed_at\s+ON public\.jobs \(completed_at\)\s+WHERE type='ENRICH_CHANNEL' AND completed_at IS NOT NULL;/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_semantic_cache_retention\s+ON public\.semantic_classification_cache \(\(COALESCE\(last_hit_at, created_at\)\)\);/);
  assert.doesNotMatch(
    withoutSqlComments,
    /CREATE\s+INDEX\s+CONCURRENTLY/i,
    'the migration runner wraps files in a transaction, so the SQL itself must not request a concurrent build',
  );
});

test('migration 170 fails closed instead of building on populated tables', () => {
  assert.match(migration, /IF EXISTS \(SELECT 1 FROM public\.jobs LIMIT 1\) THEN\s+RAISE EXCEPTION 'jobs is populated and idx_jobs_enrich_created_at is absent/);
  assert.match(migration, /IF EXISTS \(SELECT 1 FROM public\.jobs WHERE completed_at IS NOT NULL LIMIT 1\) THEN\s+RAISE EXCEPTION 'jobs has completed rows and idx_jobs_enrich_completed_at is absent/);
  assert.match(migration, /IF EXISTS \(SELECT 1 FROM public\.semantic_classification_cache LIMIT 1\) THEN\s+RAISE EXCEPTION 'semantic_classification_cache is populated and idx_semantic_cache_retention is absent/);
  assert.match(migration, /create it CONCURRENTLY out-of-band before applying migration 170/);
});

test('the migration runner builds every missing index concurrently before migration 170', () => {
  for (const name of indexes) {
    assert.match(
      dbCore,
      new RegExp(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}`),
      `${name} must be built concurrently by the runner`,
    );
  }
  assert.match(dbCore, /const migration170 = await client\.query\('SELECT 1 FROM schema_migrations WHERE version=170'\);/);
  assert.match(dbCore, /if \(!migration170\.rowCount\) await ensurePhase4ScaleIndexes\(client\);/);
  assert.ok(
    dbCore.indexOf('await ensurePhase4ScaleIndexes(client)') < dbCore.indexOf('const files = fs.readdirSync(MIGRATIONS_DIR)'),
    'the concurrent ensure step must run before the transactional migration loop',
  );
});

test('the runner repairs invalid remnants and drops the superseded cache index', () => {
  assert.match(dbCore, /SELECT c\.oid, i\.indisvalid, i\.indisready/);
  assert.match(dbCore, /if \(existing\?\.indisvalid && existing\?\.indisready\) return;/);
  assert.match(dbCore, /if \(existing\?\.oid\) \{/);
  for (const name of indexes) {
    assert.match(dbCore, new RegExp(`DROP INDEX CONCURRENTLY IF EXISTS public\\.\\$\\{name\\}`));
  }
  assert.match(dbCore, /DROP INDEX CONCURRENTLY IF EXISTS public\.idx_semantic_cache_created_at/);
  assert.ok(
    dbCore.indexOf('DROP INDEX CONCURRENTLY IF EXISTS public.idx_semantic_cache_created_at') < dbCore.indexOf('const files = fs.readdirSync(MIGRATIONS_DIR)'),
    'the superseded index must be dropped outside the migration transaction',
  );
});

test('migration 170 only drops the known superseded index', () => {
  assert.doesNotMatch(withoutSqlComments, /\b(?:DELETE|TRUNCATE|UPDATE)\b/i);
  const drops = [...withoutSqlComments.matchAll(/DROP INDEX (?:CONCURRENTLY )?IF EXISTS (\w+)/g)].map(match => match[1]);
  assert.deepEqual(drops, ['idx_semantic_cache_created_at']);
});
