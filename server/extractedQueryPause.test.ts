import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { EXTRACTED_QUERY_DISCOVERY_ENABLED_KEY, filterPausedExtractedQueryRows, isExtractedQueryDiscoveryEnabled, isExtractedStandaloneQueryRow } from './queryIntelligence';

test('extracted query discovery is fail-closed unless explicitly enabled', () => {
  assert.equal(EXTRACTED_QUERY_DISCOVERY_ENABLED_KEY, 'extracted_query_discovery_enabled');
  assert.equal(isExtractedQueryDiscoveryEnabled(undefined), false);
  assert.equal(isExtractedQueryDiscoveryEnabled(null), false);
  assert.equal(isExtractedQueryDiscoveryEnabled(''), false);
  assert.equal(isExtractedQueryDiscoveryEnabled('false'), false);
  assert.equal(isExtractedQueryDiscoveryEnabled('1'), false);
  assert.equal(isExtractedQueryDiscoveryEnabled(' true '), true);
  assert.equal(isExtractedQueryDiscoveryEnabled('TRUE'), true);
});

test('paused extracted rows are filtered from every selection path', () => {
  const extracted = { generation_metadata: { queryTemplate: 'EXTRACTED_STANDALONE' } };
  const quarantined = { generation_metadata: { queryTemplate: 'SINGLE_ATOM', extractedQueryPaused: true } };
  const other = { generation_metadata: { queryTemplate: 'ANCHOR_LEARNED' } };
  assert.equal(isExtractedStandaloneQueryRow(extracted), true);
  assert.equal(isExtractedStandaloneQueryRow(quarantined), true);
  assert.equal(isExtractedStandaloneQueryRow(other), false);
  assert.deepEqual(filterPausedExtractedQueryRows([extracted, quarantined, other], false), [other]);
  assert.deepEqual(filterPausedExtractedQueryRows([extracted, quarantined, other], true), [extracted, quarantined, other]);
});

test('pause migration quarantines only extracted queries and clears only the candidate ledger', () => {
  const sql = readFileSync(new URL('./db/migrations/181_pause_extracted_query_discovery.sql', import.meta.url), 'utf8');
  assert.match(sql, /'extracted_query_discovery_enabled', 'false'/);
  assert.match(sql, /SET\s+collection\s*=\s*'REJECTED'/i);
  assert.match(sql, /extractedQueryPaused/);
  assert.match(sql, /generation_metadata->>'queryTemplate' = 'EXTRACTED_STANDALONE'/);
  assert.match(sql, /DELETE FROM extracted_query_candidates/);
  // The user-facing query library must not be deleted or truncated.
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+query_library/i);
  assert.doesNotMatch(sql, /TRUNCATE(?:\s+TABLE)?\s+query_library/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+query_runs/i);
  assert.doesNotMatch(sql, /TRUNCATE(?:\s+TABLE)?\s+query_runs/i);
});
