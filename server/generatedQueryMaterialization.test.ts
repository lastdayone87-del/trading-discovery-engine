import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  materializeAdmittedGeneratedQueriesForCountry,
  materializedGeneratedTargetDimensions,
} from './generatedQueryMaterialization';

const dimensions = {
  country: 'Canada',
  language: 'en',
  queryIntent: 'strategy',
  primaryTermFamily: 'market structure',
  retrievalLane: 'VIDEO',
  searchOrdering: 'RELEVANCE',
  instrumentOrTheme: null,
  sourceFamily: 'automated_query',
};

const proposal = {
  proposal_id: 'p-1',
  proposal_family: 'COUNTRY_NATIVE',
  country: 'Canada',
  language: 'en',
  concept: 'market structure',
  target_neighborhood_key: 'canada|en|strategy|market structure|video|relevance|none|automated_query',
  target_dimensions: dimensions,
  source_provenance: 'youtube_autocomplete:market structure:abc',
  supporting_evidence: {
    nativeTerm: 'market structure',
    evidenceChecksum: 'checksum',
    sourceProvenanceFamily: 'YOUTUBE_AUTOCOMPLETE',
  },
  confidence: 0.7,
};

test('materialized target dimensions require the explicit materialization marker', () => {
  assert.equal(materializedGeneratedTargetDimensions({ countryNativeAllocation: { targetNeighborhoodDimensions: dimensions } }), undefined);
  assert.deepEqual(
    materializedGeneratedTargetDimensions({
      countryNativeAllocation: { materialized: true, targetNeighborhoodDimensions: dimensions },
    }),
    dimensions,
  );
});

test('materializes an authorized generated proposal as a normal candidate', async () => {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM frontier_discovery_proposals')) return { rows: [{ ...proposal }] };
      updates.push({ sql, params });
      return { rows: [] };
    },
  };
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    readSetting: async () => 'true',
    authorize: (async () => ({
      status: 'AUTHORIZED',
      code: 'AUTHORIZED',
      queryRecord: { id: 42 },
    })) as any,
  });
  assert.equal(result.enabled, true);
  assert.equal(result.attempted, 1);
  assert.equal(result.materialized, 1);
  assert.deepEqual(result.queryIds, [42]);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /trial_status='TRIED'/);
  assert.deepEqual(updates[0].params, ['p-1', 42]);
});

test('rejected admission disables the proposal instead of blindly admitting it', async () => {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM frontier_discovery_proposals')) return { rows: [{ ...proposal }] };
      updates.push({ sql, params });
      return { rows: [] };
    },
  };
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    readSetting: async () => 'true',
    authorize: (async () => ({
      status: 'REJECTED',
      code: 'QUERY_ADMISSION_REJECTED',
      queryRecord: null,
    })) as any,
  });
  assert.equal(result.rejected, 1);
  assert.equal(result.materialized, 0);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /trial_status='DISABLED'/);
  assert.deepEqual(updates[0].params, ['p-1', 'QUERY_ADMISSION_REJECTED']);
});

test('system errors defer the proposal without consuming it', async () => {
  let updates = 0;
  const db = {
    query: async (sql: string) => {
      if (sql.includes('FROM frontier_discovery_proposals')) return { rows: [{ ...proposal }] };
      updates++;
      return { rows: [] };
    },
  };
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    readSetting: async () => 'true',
    authorize: (async () => {
      throw new Error('transient');
    }) as any,
  });
  assert.equal(result.deferred, 1);
  assert.equal(result.materialized, 0);
  assert.equal(updates, 0);
});

test('materialization can be disabled without changing proposals', async () => {
  let queried = false;
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    readSetting: async () => 'false',
    db: { query: async () => { queried = true; return { rows: [] }; } },
  });
  assert.equal(result.enabled, false);
  assert.equal(queried, false);
});


test('materialized generated queries use normal scheduler lineage and target dimensions', () => {
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const autonomous = readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  assert.match(dbCore, /nativeLineage\.materialized === true/);
  assert.match(dbCore, /lineageBoundAllocation/);
  assert.match(autonomous, /materializedGeneratedTargetDimensions\(selected\.queryRecord\.generation_metadata\)/);
  assert.doesNotMatch(autonomous, /GENERATED_QUERY_LANE|generatedQueryLane|generated_share/i);
});
