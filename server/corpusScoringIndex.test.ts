import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('./db/migrations/206_corpus_occurrence_normalized_index.sql', import.meta.url), 'utf8');
const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');

test('corpus scoring has a concurrent normalized-span index migration', () => {
  assert.match(migration, /idx_corpus_occurrences_normalized/);
  assert.match(migration, /corpus_candidate_occurrences\(normalized_span, document_id, start_offset\)/);
  assert.match(migration, /indisvalid/);
  assert.match(migration, /indisready/);
  assert.match(migration, /pg_get_indexdef/);
  assert.match(migration, /USING btree \(normalized_span, document_id, start_offset\)/);
  assert.match(migration, /octet_length\(normalized_span\)>2704/);
  assert.match(migration, /is not valid\/ready/);
});

test('the migration runner builds the corpus scoring index concurrently before the transactional loop', () => {
  assert.match(dbCore, /ensureCorpusOccurrenceIndexes/);
  assert.ok(dbCore.includes('CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON public.corpus_candidate_occurrences(normalized_span, document_id, start_offset)'));
  assert.match(dbCore, /version=206/);
  assert.match(dbCore, /DROP INDEX CONCURRENTLY IF EXISTS public\.\$\{name\}/);
  const builder = dbCore.indexOf('const migration206');
  const loop = dbCore.indexOf('for (const file of files)');
  assert.ok(builder >= 0 && loop > builder, 'the concurrent index build must run before the transactional migration loop');
});
