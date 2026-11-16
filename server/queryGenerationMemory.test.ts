import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { queryGenerationBatchKey } from './queryGenerationMemory';

test('query generation cache keys are deterministic and context-sensitive', () => {
  const base = {
    country: 'France',
    language: 'fr',
    source: 'LLM' as const,
    mode: 'OPEN_WORLD' as const,
    promptVersion: 'native-query-v1',
    contextDigest: 'context-a',
  };
  assert.equal(queryGenerationBatchKey(base), queryGenerationBatchKey({ ...base, country: '  france  ' }));
  assert.notEqual(queryGenerationBatchKey(base), queryGenerationBatchKey({ ...base, language: 'en' }));
  assert.notEqual(queryGenerationBatchKey(base), queryGenerationBatchKey({ ...base, mode: 'GROUNDED' }));
  assert.notEqual(queryGenerationBatchKey(base), queryGenerationBatchKey({ ...base, contextDigest: 'context-b' }));
});

test('generation memory migration is additive and does not touch query_library', () => {
  const sql = readFileSync(new URL('./db/migrations/184_query_generation_memory.sql', import.meta.url), 'utf8');
  // Strip comments before every assertion: the file legitimately explains that
  // it is separate from query_library, and commented-out DDL must not satisfy
  // the required-schema checks.
  const stripped = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(stripped, /CREATE TABLE IF NOT EXISTS query_candidate_memory/);
  assert.match(stripped, /CREATE TABLE IF NOT EXISTS query_generation_batches/);
  assert.match(stripped, /CREATE UNIQUE INDEX[^;]*query_candidate_memory\(LOWER\(country\), language, normalized_query\)/i);

  // Scope the batch-key assertion to its table; a generic UNIQUE elsewhere in
  // the migration must not satisfy it.
  const batchesTable = stripped.match(
    /CREATE TABLE IF NOT EXISTS query_generation_batches\s*\(([\s\S]*?)\);/i,
  )?.[1] || '';
  assert.match(batchesTable, /batch_key TEXT PRIMARY KEY/);

  assert.doesNotMatch(stripped, /\bquery_library\b/i);
  assert.doesNotMatch(stripped, /\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE)\b/i);
  assert.match(stripped, /jsonb_typeof\(reason_codes\)\s*=\s*'array'/i);
  assert.match(stripped, /jsonb_typeof\(metadata\)\s*=\s*'object'/i);
  assert.match(stripped, /jsonb_typeof\(payload\)\s*=\s*'object'/i);
});
