import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateAutonomousQueryAuthority } from './autonomousQueryAuthority';
import { planDiverseQueries } from './queryPlanner';
import type { QueryRecord } from '../src/types';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('evaluateAutonomousQueryAuthority requires valid retrieval specificity provenance', () => {
  const queryRecord: QueryRecord = {
    id: 1,
    query: 'Order Flow',
    country: 'DE',
    collection: 'EXPERIMENTAL',
    intent: 'strategy',
    times_executed: 1,
    total_channels_found: 0,
    unique_channels_found: 0,
    quality_channels_found: 0,
    community_channels_found: 0,
    avg_quality_score: 0,
    performance_score: 0,
    created_at: new Date().toISOString(),
    status: 'ACTIVE',
    knowledge_tiers: [2],
    generation_mode: 'EXPLORATION',
    generation_reason: 'test',
    discovery_objective: 'test',
    primary_term: 'Order Flow',
    generation_metadata: {}
  };

  const decision = evaluateAutonomousQueryAuthority(queryRecord);
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasonCodes.includes('CURRENT_RETRIEVAL_PROVENANCE_MISSING'));
});

test('free-signal standalone bootstrap carries a narrow execution-time authority path', () => {
  // Planner-shape fixture only: Nigeria has no curated anchors, which is the
  // exact no-anchor path that can emit FREE_SIGNAL_STANDALONE. Execution
  // authority is asserted below against a supported production market so this
  // test never endorses admission for an excluded/unregistered country.
  const planned = planDiverseQueries({
    country: 'Nigeria',
    count: 1,
    learnedVocabulary: [],
    existingQueries: [],
    freeSignalCandidates: [{
      surface: 'Chartanalyse', signalType: 'METHOD', country: 'Nigeria', language: 'de',
      provider: 'WIKIPEDIA', sourceIds: ['wikipedia:1'],
    }],
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].metadata.queryTemplate, 'FREE_SIGNAL_STANDALONE');

  // The surface is German because execution revalidates admission against the
  // supported market's language profile, not the no-anchor planner fixture.
  const base: QueryRecord = {
    id: 1, query: planned[0].query, country: 'Germany', collection: 'EXPERIMENTAL',
    intent: planned[0].intent, times_executed: 0, total_channels_found: 0,
    unique_channels_found: 0, quality_channels_found: 0, community_channels_found: 0,
    avg_quality_score: 0, performance_score: 0, created_at: new Date().toISOString(),
    status: 'ACTIVE', knowledge_tiers: planned[0].knowledgeTiers,
    generation_mode: planned[0].generationMode, generation_reason: planned[0].generationReason,
    discovery_objective: planned[0].discoveryObjective, primary_term: planned[0].primaryTerm,
    generation_metadata: planned[0].metadata,
  };
  assert.equal(evaluateAutonomousQueryAuthority(base).eligible, true);

  // Only the exact free-signal-only shape is authorized. A marker copied onto
  // a mixed/source-less candidate must not unlock standalone retrieval.
  const mixed = { ...base, generation_metadata: { ...planned[0].metadata, source: 'MIXED' } };
  assert.equal(evaluateAutonomousQueryAuthority(mixed).eligible, false);
  const foreignAtom = {
    ...base,
    generation_metadata: {
      ...planned[0].metadata,
      atoms: [{ ...(planned[0].metadata.atoms as any[])[0], origin: 'CURATED' }],
    },
  };
  assert.equal(evaluateAutonomousQueryAuthority(foreignAtom).eligible, false);
});

test('demand-signal standalone bootstrap carries a narrow execution-time authority path', () => {
  // Demand-only candidates consume the documented 30% cap, so a four-query
  // portfolio is the smallest one that can emit one.
  const planned = planDiverseQueries({
    country: 'Nigeria',
    count: 4,
    learnedVocabulary: [],
    existingQueries: [],
    demandSignalCandidates: [{
      surface: 'Chartanalyse', language: 'de', demandScore: 55, sourceIds: ['trends:1'],
    }],
  });
  const demand = planned.find(query => query.metadata.queryTemplate === 'DEMAND_SIGNAL_STANDALONE');
  assert.ok(demand, 'a no-anchor country can emit one standalone demand surface');

  const base: QueryRecord = {
    id: 2, query: demand.query, country: 'Germany', collection: 'EXPERIMENTAL',
    intent: demand.intent, times_executed: 0, total_channels_found: 0,
    unique_channels_found: 0, quality_channels_found: 0, community_channels_found: 0,
    avg_quality_score: 0, performance_score: 0, created_at: new Date().toISOString(),
    status: 'ACTIVE', knowledge_tiers: demand.knowledgeTiers,
    generation_mode: demand.generationMode, generation_reason: demand.generationReason,
    discovery_objective: demand.discoveryObjective, primary_term: demand.primaryTerm,
    generation_metadata: demand.metadata,
  };
  assert.equal(evaluateAutonomousQueryAuthority(base).eligible, true);

  // The exception is exact-shape: a copied marker on a mixed source or a
  // non-demand atom must not unlock standalone retrieval.
  const mixed = { ...base, generation_metadata: { ...demand.metadata, source: 'MIXED' } };
  assert.equal(evaluateAutonomousQueryAuthority(mixed).eligible, false);
  const foreignAtom = {
    ...base,
    generation_metadata: {
      ...demand.metadata,
      atoms: [{ ...(demand.metadata.atoms as any[])[0], origin: 'CURATED' }],
    },
  };
  assert.equal(evaluateAutonomousQueryAuthority(foreignAtom).eligible, false);
});

test('free-signal standalone planning excludes ambiguous market/entity surfaces', () => {
  const planned = planDiverseQueries({
    country: 'Germany',
    count: 4,
    learnedVocabulary: [],
    existingQueries: [],
    freeSignalCandidates: [{
      surface: 'Frankfurt Stock Exchange', signalType: 'EXCHANGE', country: 'Germany', language: 'en',
      provider: 'WIKIPEDIA', sourceIds: ['wikipedia:2'],
    }],
  });
  assert.ok(planned.length > 0, 'a supported country still plans normal seed queries');
  assert.ok(planned.every(query => query.metadata.queryTemplate !== 'FREE_SIGNAL_STANDALONE'));
});

test('queueManager enforces execution-time query authority revalidation and handles missing provenance', () => {
  const queueSource = read('server/queueManager.ts');
  assert.match(queueSource, /evaluateAutonomousQueryAuthority/);
  assert.match(queueSource, /Withheld automated search job/);
  assert.match(queueSource, /QUERY_PROVENANCE_RECORD_MISSING/);
  assert.match(queueSource, /source !== 'manual_search'/);
});
