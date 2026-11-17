import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertQueryRecord } from './dbCore';

test('preserveExistingRow canonicalizes country and carries fresh admission metadata', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const existingRow = {
    id: 9,
    query: 'market structure',
    normalized_query: 'market structure',
    country: 'canada',
    collection: 'EXPERIMENTAL',
    intent: 'strategy',
    generation_metadata: JSON.stringify({ staleMarker: true }),
    knowledge_tiers: [1],
    status: 'ACTIVE',
    created_at: '2026-01-01T00:00:00Z',
  };
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('normalized_query<>$2')) return { rows: [], rowCount: 0 };
      if (sql.includes('LOWER(country)=LOWER($1)')) return { rows: [existingRow], rowCount: 1 };
      throw new Error(`unexpected write: ${sql.slice(0, 80)}`);
    },
  };

  const record = await upsertQueryRecord({
    query: 'Market Structure',
    country: 'canada',
    collection: 'EXPERIMENTAL',
    intent: 'strategy',
    primaryTerm: 'market structure',
    generationMetadata: { countryNativeAllocation: { materialized: true } },
  }, { preserveExistingRow: true, db: db as any });

  assert.equal(record.id, 9);
  assert.equal(record.country, 'Canada');
  assert.equal((record.generation_metadata as any).staleMarker, undefined);
  assert.equal((record.generation_metadata as any).countryNativeAllocation.materialized, true);
  assert.ok((record.generation_metadata as any).queryAdmission);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO query_library')), false);
  assert.equal(calls.find(call => call.sql.includes('LOWER(country)=LOWER($1)'))?.params[0], 'Canada');
});
