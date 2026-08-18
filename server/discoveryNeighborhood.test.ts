import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNeighborhoodKey,
  createNeighborhoodChecksum,
  mapQueryRunToNeighborhood,
  type DiscoveryNeighborhoodDimensions
} from './discoveryNeighborhood';
import type { QueryIntent } from '../src/types';

test('Discovery Neighborhood Key is deterministic and normalizes whitespace/casing', () => {
  const dim1: DiscoveryNeighborhoodDimensions = {
    country: 'Germany',
    language: 'de',
    queryIntent: 'futures',
    primaryTermFamily: 'DAX',
    retrievalLane: 'VIDEO',
    searchOrdering: 'DATE',
    instrumentOrTheme: 'FDAX',
    sourceFamily: 'automated_query'
  };

  const dim2: DiscoveryNeighborhoodDimensions = {
    country: '  germany  ',
    language: 'DE',
    queryIntent: 'futures',
    primaryTermFamily: 'dax ',
    retrievalLane: 'video',
    searchOrdering: 'date',
    instrumentOrTheme: ' fdax ',
    sourceFamily: 'AUTOMATED_QUERY'
  };

  const key1 = createNeighborhoodKey(dim1);
  const key2 = createNeighborhoodKey(dim2);

  assert.equal(key1, key2, 'Normalized keys must be strictly identical');
  assert.equal(key1, 'germany|de|futures|dax|video|date|fdax|automated_query');
});

test('Discovery Neighborhood SHA-256 checksum is consistent', () => {
  const key = 'germany|de|futures|dax|video|date|fdax|automated_query';
  const checksum1 = createNeighborhoodChecksum(key);
  const checksum2 = createNeighborhoodChecksum(key);

  assert.equal(checksum1, checksum2);
  assert.equal(checksum1.length, 64, 'SHA-256 hex string must be 64 characters long');
});

test('Multiple distinct query strings map to the same discovery neighborhood territory', () => {
  const run1 = { runId: 'run-uuid-1', country: 'Brazil', retrievalLane: 'VIDEO', searchOrdering: 'RELEVANCE', source: 'automated_query' };
  const query1 = { id: 101, query: 'mini indice fracionario', intent: 'strategy' as QueryIntent, primary_term: 'mini indice', country: 'Brazil' };

  const run2 = { runId: 'run-uuid-2', country: 'Brazil', retrievalLane: 'VIDEO', searchOrdering: 'RELEVANCE', source: 'automated_query' };
  const query2 = { id: 102, query: 'mini indice day trade ao vivo', intent: 'strategy' as QueryIntent, primary_term: 'mini indice', country: 'Brazil' };

  const mapped1 = mapQueryRunToNeighborhood(run1, query1, { language: 'pt' });
  const mapped2 = mapQueryRunToNeighborhood(run2, query2, { language: 'pt' });

  assert.equal(
    mapped1.neighborhood.neighborhoodKey,
    mapped2.neighborhood.neighborhoodKey,
    'Distinct queries with same intent and primary term family must map to the same neighborhood'
  );
  assert.notEqual(mapped1.lineage.queryRunId, mapped2.lineage.queryRunId, 'Query runs remain distinct');
  assert.notEqual(mapped1.lineage.retrievalActionKey, mapped2.lineage.retrievalActionKey, 'Retrieval action keys remain distinct');
});

test('Lineage structure accurately tracks query run -> retrieval action -> neighborhood', () => {
  const run = { runId: 'run-abc-123', queryId: 50, country: 'Japan', retrievalLane: 'VIDEO', searchOrdering: 'DATE', source: 'automated_query' };
  const query = { id: 50, query: '日経225 先物', intent: 'stocks' as QueryIntent, primary_term: '日経225', country: 'Japan' };

  const { neighborhood, lineage } = mapQueryRunToNeighborhood(run, query, { language: 'ja' });

  assert.equal(lineage.queryRunId, 'run-abc-123');
  assert.equal(lineage.queryId, 50);
  assert.equal(lineage.neighborhoodKey, neighborhood.neighborhoodKey);
  assert.equal(lineage.retrievalActionKey, `retrieval_action:run-abc-123:${neighborhood.neighborhoodKey}`);
  assert.ok(lineage.observedAt, 'Lineage must record observation timestamp');
});
