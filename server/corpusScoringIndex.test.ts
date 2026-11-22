import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('./db/migrations/206_corpus_occurrence_normalized_index.sql', import.meta.url), 'utf8');
const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');

test('corpus scoring has a concurrent normalized-span index migration', () => {
  assert.match(migration, /idx_corpus_occurrences_normalized/);
  assert.match(migration, /corpus_candidate_occurrences\(normalized_span, document_id, start_offset\)/);
  assert.match(migration, /indisvalid/);
  assert.match(migration, /is not valid\/ready/);
});

test('the migration runner builds the corpus scoring index concurrently before the transactional loop', () => {
  assert.match(dbCore, /ensureCorpusOccurrenceIndexes/);
  assert.match(dbCore, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_corpus_occurrences_normalized/);
  assert.match(dbCore, /version=206/);
});
