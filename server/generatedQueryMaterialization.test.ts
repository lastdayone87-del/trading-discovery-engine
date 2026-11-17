import test from 'node:test';
import assert from 'node:assert/strict';
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

function makeDb(rows: any[], options: { claimRowCount?: number; finalRowCount?: number } = {}) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM frontier_discovery_proposals')) return { rows };
      updates.push({ sql, params });
      if (sql.includes('RETURNING proposal_id')) return { rowCount: options.claimRowCount ?? 1, rows: [] };
      return { rowCount: options.finalRowCount ?? 1, rows: [] };
    },
  };
  return { db, updates };
}

test('materializes an authorized generated proposal as a normal candidate and forwards lineage', async () => {
  const { db, updates } = makeDb([{ ...proposal }]);
  let authorizeArgs: any = null;
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    readSetting: async () => 'true',
    scopePromotionBasis: 'DIRECT_TARGET',
    authorize: (async (args: any) => {
      authorizeArgs = args;
      return { status: 'AUTHORIZED', code: 'AUTHORIZED', queryRecord: { id: 42 } };
    }) as any,
  });
  assert.equal(result.enabled, true);
  assert.equal(result.attempted, 1);
  assert.equal(result.materialized, 1);
  assert.deepEqual(result.queryIds, [42]);
  assert.deepEqual(authorizeArgs.targetNeighborhoodDimensions, dimensions);
  assert.equal(authorizeArgs.materialized, true);
  assert.equal(authorizeArgs.preserveExistingLibraryRow, true);
  assert.equal(authorizeArgs.scopePromotionBasis, 'DIRECT_TARGET');
  assert.equal(authorizeArgs.proposalEvidenceSnapshot.supportingEvidence.nativeTerm, 'market structure');
  const final = updates.find(update => update.sql.includes("trial_status='TRIED'"));
  assert.ok(final);
  assert.equal(final.params[0], 'p-1');
  assert.equal(typeof final.params[1], 'string');
  assert.equal(String(final.params[1]).length, 36);
  assert.equal(final.params[2], 42);
});

test('rejected admission disables the proposal instead of blindly admitting it', async () => {
  const { db, updates } = makeDb([{ ...proposal }]);
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
  const final = updates.find(update => update.sql.includes("trial_status='DISABLED'"));
  assert.ok(final);
  assert.equal(final.params[0], 'p-1');
  assert.equal(typeof final.params[1], 'string');
  assert.equal(final.params[2], 'QUERY_ADMISSION_REJECTED');
});

test('system errors defer the proposal without consuming it', async () => {
  const { db, updates } = makeDb([{ ...proposal }]);
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    readSetting: async () => 'true',
    authorize: (async () => ({
      status: 'SYSTEM_ERROR',
      code: 'AUTHORIZATION_SYSTEM_ERROR',
      queryRecord: null,
    })) as any,
  });
  assert.equal(result.deferred, 1);
  assert.equal(result.materialized, 0);
  assert.equal(result.rejected, 0);
  assert.ok(updates.some(update => update.sql.includes('materializationDeferredAt')));
  assert.equal(updates.some(update => update.sql.includes("trial_status='TRIED'")), false);
  assert.equal(updates.some(update => update.sql.includes("trial_status='DISABLED'")), false);
});

test('a concurrent claim prevents duplicate authorization', async () => {
  const { db } = makeDb([{ ...proposal }], { claimRowCount: 0 });
  let authorized = false;
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    readSetting: async () => 'true',
    authorize: (async () => {
      authorized = true;
      return { status: 'AUTHORIZED', code: 'AUTHORIZED', queryRecord: { id: 42 } };
    }) as any,
  });
  assert.equal(result.deferred, 1);
  assert.equal(result.materialized, 0);
  assert.equal(authorized, false);
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


test('materialized generated queries use lineage-bound dimensions only when materialized', async () => {
  const { lineageBoundDimensions } = await import('./frontierLineage');
  assert.deepEqual(
    lineageBoundDimensions('LEGACY', { materialized: true, targetNeighborhoodKey: proposal.target_neighborhood_key }, dimensions),
    dimensions,
  );
  assert.equal(
    lineageBoundDimensions('LEGACY', { targetNeighborhoodKey: proposal.target_neighborhood_key }, dimensions),
    undefined,
  );
  assert.deepEqual(
    lineageBoundDimensions('FRONTIER_CANARY', { targetNeighborhoodKey: proposal.target_neighborhood_key }, dimensions),
    dimensions,
  );
  assert.equal(lineageBoundDimensions('LEGACY', { materialized: true }, dimensions), undefined);
});


test('a final TRIED update race is reported as deferred, not materialized', async () => {
  const { db } = makeDb([{ ...proposal }], { finalRowCount: 0 });
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    readSetting: async () => 'true',
    authorize: (async () => ({ status: 'AUTHORIZED', code: 'AUTHORIZED', queryRecord: { id: 42 } })) as any,
  });
  assert.equal(result.deferred, 1);
  assert.equal(result.materialized, 0);
  assert.deepEqual(result.queryIds, []);
});

test('authorization exceptions after a claim are deferred and remain retryable', async () => {
  const { db, updates } = makeDb([{ ...proposal }]);
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    readSetting: async () => 'true',
    authorize: (async () => { throw new Error('transient'); }) as any,
  });
  assert.equal(result.deferred, 1);
  assert.equal(result.materialized, 0);
  assert.ok(updates.some(update => update.sql.includes('materializationDeferredAt')));
  assert.equal(updates.some(update => update.sql.includes("trial_status='TRIED'")), false);
});

test('materialized lineage and existing-row protection are wired into scheduler and authorizer', async () => {
  const { readFileSync } = await import('node:fs');
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const autonomous = readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  const queryIntelligence = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.match(dbCore, /lineageBoundDimensions\(/);
  assert.match(dbCore, /nativeLineage/);
  assert.match(autonomous, /materializedGeneratedTargetDimensions\(selected\.queryRecord\.generation_metadata\)/);
  assert.match(autonomous, /scopePromotionBasis: promotionBasis === 'DIRECT_TARGET' \? undefined : promotionBasis/);
  assert.match(queryIntelligence, /preserveExistingRow: args\.preserveExistingLibraryRow === true/);
  assert.match(queryIntelligence, /EXISTING_QUERY_PROTECTED/);
});


test('persistent-selection materialization rechecks live scope before authorizing', async () => {
  const { db } = makeDb([{ ...proposal }]);
  let authorized = false;
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    scopePromotionBasis: 'PERSISTENT_SCOPE_SELECTION',
    readSetting: async (key, fallback) => {
      if (key === 'query_intelligence_discovery_scope') return 'SELECTED_COUNTRIES';
      if (key === 'query_intelligence_selected_countries') return '["France"]';
      return fallback;
    },
    authorize: (async () => {
      authorized = true;
      return { status: 'AUTHORIZED', code: 'AUTHORIZED', queryRecord: { id: 42 } };
    }) as any,
  });
  assert.equal(result.deferred, 1);
  assert.equal(authorized, false);
});

test('persistent promotion is stale when the live scope is GLOBAL', async () => {
  const { db } = makeDb([{ ...proposal }]);
  let authorized = false;
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    scopePromotionBasis: 'PERSISTENT_SCOPE_SELECTION',
    readSetting: async (key, fallback) => {
      if (key === 'query_intelligence_discovery_scope') return 'GLOBAL';
      return fallback;
    },
    authorize: (async () => {
      authorized = true;
      return { status: 'AUTHORIZED', code: 'AUTHORIZED', queryRecord: { id: 42 } };
    }) as any,
  });
  assert.equal(result.deferred, 1);
  assert.equal(authorized, false);
});

test('persistent promotion fails closed on a malformed selected-country array', async () => {
  const { db } = makeDb([{ ...proposal }]);
  let authorized = false;
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    scopePromotionBasis: 'PERSISTENT_SCOPE_SELECTION',
    readSetting: async (key, fallback) => {
      if (key === 'query_intelligence_discovery_scope') return 'SELECTED_COUNTRIES';
      if (key === 'query_intelligence_selected_countries') return '["Canada", 7]';
      return fallback;
    },
    authorize: (async () => {
      authorized = true;
      return { status: 'AUTHORIZED', code: 'AUTHORIZED', queryRecord: { id: 42 } };
    }) as any,
  });
  assert.equal(result.deferred, 1);
  assert.equal(authorized, false);
});


test('a stale persistent-scope result is deferred, not permanently disabled', async () => {
  const { db, updates } = makeDb([{ ...proposal }]);
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    readSetting: async () => 'true',
    authorize: (async () => ({
      status: 'REJECTED',
      code: 'SCOPE_PROMOTION_STALE',
      queryRecord: null,
    })) as any,
  });
  assert.equal(result.deferred, 1);
  assert.equal(result.rejected, 0);
  assert.ok(updates.some(update => update.sql.includes('materializationDeferredAt')));
  assert.equal(updates.some(update => update.sql.includes("trial_status='DISABLED'")), false);
});


test('an unrunnable preserved lineage outcome is deferred, not consumed', async () => {
  const { db, updates } = makeDb([{ ...proposal }]);
  const result = await materializeAdmittedGeneratedQueriesForCountry('Canada', {
    db,
    limit: 5,
    readSetting: async () => 'true',
    authorize: (async () => ({
      status: 'DEFERRED',
      code: 'EXISTING_QUERY_LINEAGE_UNRUNNABLE',
      queryRecord: null,
    })) as any,
  });
  assert.equal(result.deferred, 1);
  assert.equal(result.materialized, 0);
  assert.ok(updates.some(update => update.sql.includes('materializationDeferredAt')));
  assert.equal(updates.some(update => update.sql.includes("trial_status='TRIED'")), false);
});
