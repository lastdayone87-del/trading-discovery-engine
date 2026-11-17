import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('pending-run resume ranking recomputes creator-only utility instead of trusting legacy community-weighted values', () => {
  const source = readFileSync(new URL('./autonomousPageStore.ts', import.meta.url), 'utf8');
  assert.match(source, /Recompute creator-only utility for resume ranking/);
  assert.match(source, /p\.marginal_quality_creators/);
  assert.match(source, /p\.marginal_confirmed_creators/);
  assert.match(source, /p\.marginal_new_creators/);
  assert.doesNotMatch(source, /SELECT p\.marginal_utility_v2\s+FROM autonomous_query_page_observations/);
});
