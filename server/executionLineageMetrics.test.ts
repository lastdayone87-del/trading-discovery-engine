import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeExecutionLineageWindowHours } from './executionLineageMetrics';
import { routePolicyInventory } from './operatorAuth';

test('execution-lineage window is bounded and fail-safe', () => {
  assert.equal(normalizeExecutionLineageWindowHours(undefined), 168);
  assert.equal(normalizeExecutionLineageWindowHours('bad'), 168);
  assert.equal(normalizeExecutionLineageWindowHours(0), 1);
  assert.equal(normalizeExecutionLineageWindowHours(9999), 720);
  assert.equal(normalizeExecutionLineageWindowHours(12.9), 12);
});

test('execution-lineage route is explicitly operator protected', () => {
  const route = routePolicyInventory.find(item => item.pattern.includes('diagnostics\\/execution-lineage'));
  assert.ok(route);
  assert.equal(route?.method, 'GET');
  assert.equal(route?.policy, 'operator');
  assert.equal(route?.action, 'diagnostics.execution-lineage.read');
});

test('execution-lineage implementation is aggregate-only and reuses durable records', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./executionLineageMetrics.ts', import.meta.url), 'utf8'));
  assert.match(source, /FROM query_runs/);
  assert.match(source, /FROM autonomous_query_page_observations/);
  assert.match(source, /FROM channel_sightings/);
  assert.match(source, /FROM discovery_nominations/);
  assert.match(source, /FROM channel_admission_decisions/);
  assert.doesNotMatch(source, /INSERT INTO|UPDATE |DELETE FROM|TRUNCATE /i);
  assert.doesNotMatch(source, /SELECT\s+[^`\n]*\bquery\b\s*,/i);
});
