import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateAutonomousQueryAuthority } from './autonomousQueryAuthority';
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

test('queueManager enforces execution-time query authority revalidation and handles missing provenance', () => {
  const queueSource = read('server/queueManager.ts');
  assert.match(queueSource, /evaluateAutonomousQueryAuthority/);
  assert.match(queueSource, /withheld before queuing/);
  assert.match(queueSource, /Withheld automated search job/);
  assert.match(queueSource, /QUERY_PROVENANCE_RECORD_MISSING/);
  assert.match(queueSource, /source !== 'manual_search'/);
});
