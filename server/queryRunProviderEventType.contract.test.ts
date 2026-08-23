import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = readFileSync(fileURLToPath(new URL('./db.ts', import.meta.url)), 'utf8');

test('query-run provider-event aggregates cast UUID run ids to the provider-event text type', () => {
  const providerRunComparisons = source.match(/e\.run_id=\$1::text/g) || [];
  assert.ok(providerRunComparisons.length >= 10, 'completion and failure projections must cast every provider-event run comparison');
  assert.match(source, /WHERE id=\$1 AND status NOT IN \('COMPLETED','FAILED'\) RETURNING query_id/);
  assert.doesNotMatch(source, /e\.run_id=\$1(?!::text)/);
});
