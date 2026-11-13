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
  assert.match(sql, /CREATE TABLE IF NOT EXISTS query_candidate_memory/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS query_generation_batches/);
  assert.match(sql, /UNIQUE\(country, language, normalized_query\)/);
  assert.match(sql, /UNIQUE|PRIMARY KEY \(batch_key\)/);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+query_library/i);
  assert.doesNotMatch(sql, /TRUNCATE\s+query_library/i);
});
