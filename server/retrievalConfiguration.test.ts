import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRetrievalConfiguration,
  createRetrievalConfigKey,
  normalizeRetrievalConfiguration,
  CURRENT_RETRIEVAL_POLICY_VERSION
} from './retrievalConfiguration';

test('buildRetrievalConfiguration creates deterministic canonical configuration', () => {
  const config1 = buildRetrievalConfiguration({
    searchOrdering: 'RELEVANCE',
    retrievalLane: 'VIDEO',
    requestedPageDepth: 2,
    continuationMode: 'STANDARD',
    freshnessMode: 'STANDARD'
  });

  const config2 = buildRetrievalConfiguration({
    searchOrdering: 'RELEVANCE',
    retrievalLane: 'VIDEO',
    requestedPageDepth: 2,
    continuationMode: 'STANDARD',
    freshnessMode: 'STANDARD'
  });

  assert.equal(config1.configKey, config2.configKey);
  assert.equal(config1.searchOrdering, 'RELEVANCE');
  assert.equal(config1.retrievalLane, 'VIDEO');
  assert.equal(config1.requestedPageDepth, 2);
  assert.equal(config1.policyVersion, CURRENT_RETRIEVAL_POLICY_VERSION);
});

test('normalizeRetrievalConfiguration clamps requestedPageDepth to 1..3 and sets defaults', () => {
  const shallow = buildRetrievalConfiguration({ requestedPageDepth: 0 });
  assert.equal(shallow.requestedPageDepth, 1);
  assert.equal(shallow.continuationMode, 'SHALLOW');

  const deep = buildRetrievalConfiguration({ requestedPageDepth: 5 });
  assert.equal(deep.requestedPageDepth, 3);
  assert.equal(deep.continuationMode, 'BOUNDED_DEEP');

  const dateConfig = buildRetrievalConfiguration({ searchOrdering: 'DATE' });
  assert.equal(dateConfig.freshnessMode, 'FRESH_PROBE');
});

test('createRetrievalConfigKey changes when dimensions differ', () => {
  const key1 = createRetrievalConfigKey({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 1 });
  const key2 = createRetrievalConfigKey({ searchOrdering: 'DATE', retrievalLane: 'VIDEO', requestedPageDepth: 1 });
  const key3 = createRetrievalConfigKey({ searchOrdering: 'RELEVANCE', retrievalLane: 'CHANNEL', requestedPageDepth: 1 });
  const key4 = createRetrievalConfigKey({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 2 });

  assert.notEqual(key1, key2);
  assert.notEqual(key1, key3);
  assert.notEqual(key1, key4);
});
