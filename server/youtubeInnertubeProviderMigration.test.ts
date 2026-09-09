import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const migration130 = readFileSync('server/db/migrations/130_youtube_innertube_provider.sql', 'utf8');
const migration112 = readFileSync('server/db/migrations/112_brave_search_provider_and_staging.sql', 'utf8');

function onConflictClause(sql: string): string {
  const at = sql.indexOf('ON CONFLICT');
  assert.ok(at !== -1, 'migration must be an idempotent upsert');
  return sql.slice(at);
}

test('migration 130 seeds youtube-innertube as ACTIVE on first insert', () => {
  assert.match(migration130, /'youtube-innertube', 'youtube', 'RETRIEVAL'/);
  assert.match(migration130, /'YOUTUBE_INNERTUBE_FREE', 'https:\/\/www\.youtube\.com\/t\/terms',\s*\n?\s*'ACTIVE', 0, 'system:migration-130'/);
});

test('re-running migration 130 never overwrites an operator-controlled mode', () => {
  const clause = onConflictClause(migration130);
  // No mode assignment of any form in the conflict branch: an existing
  // PAUSED/RETIRED (or CANARY/SHADOW) row keeps its mode on re-apply.
  assert.doesNotMatch(clause, /mode\s*=\s*(EXCLUDED\.mode|'\w+'|"mode")/);
  assert.doesNotMatch(clause, /SET[^;]*\bmode\b\s*=/);
});

test('re-running migration 130 still syncs provider definition columns', () => {
  const clause = onConflictClause(migration130);
  assert.match(clause, /capabilities = EXCLUDED\.capabilities/);
  assert.match(clause, /quota_domain = EXCLUDED\.quota_domain/);
  assert.match(clause, /terms_reference = EXCLUDED\.terms_reference/);
});

test('migration 130 matches the state-preserving convention of migration 112', () => {
  // Migration 112 (brave-search) is the established pattern: definition
  // columns sync on conflict, mode is insert-only.
  assert.doesNotMatch(onConflictClause(migration112), /SET[^;]*\bmode\b\s*=/);
  assert.doesNotMatch(onConflictClause(migration130), /SET[^;]*\bmode\b\s*=/);
});
