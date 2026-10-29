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
  const planned = planDiverseQueries({
    country: 'Nigeria',
    count: 1,
    learnedVocabulary: [],
    existingQueries: [],
    freeSignalCandidates: [{
      surface: 'Chartanalyse', signalType: 'METHOD', country: 'Nigeria', language: 'en',
      provider: 'WIKIPEDIA', sourceIds: ['wikipedia:1'],
    }],
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].metadata.queryTemplate, 'FREE_SIGNAL_STANDALONE');

  const base: QueryRecord = {
    id: 1, query: planned[0].query, country: 'Nigeria', collection: 'EXPERIMENTAL',
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

test('free-signal standalone planning excludes ambiguous market/entity surfaces', () => {
  const planned = planDiverseQueries({
    country: 'Nigeria',
    count: 1,
    learnedVocabulary: [],
    existingQueries: [],
    freeSignalCandidates: [{
      surface: 'Lagos Stock Exchange', signalType: 'EXCHANGE', country: 'Nigeria', language: 'en',
      provider: 'WIKIPEDIA', sourceIds: ['wikipedia:2'],
    }],
  });
  assert.equal(planned.length, 0);
});

test('queueManager enforces execution-time query authority revalidation and handles missing provenance', () => {
  const queueSource = read('server/queueManager.ts');
  assert.match(queueSource, /evaluateAutonomousQueryAuthority/);
  assert.match(queueSource, /Withheld automated search job/);
  assert.match(queueSource, /QUERY_PROVENANCE_RECORD_MISSING/);
  assert.match(queueSource, /source !== 'manual_search'/);
});
