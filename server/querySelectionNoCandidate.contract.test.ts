import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const queryIntelligence = readFileSync(fileURLToPath(new URL('./queryIntelligence.ts', import.meta.url)), 'utf8');
const autonomousDiscovery = readFileSync(fileURLToPath(new URL('./autonomousDiscovery.ts', import.meta.url)), 'utf8');

test('query selection returns null when cold-start or exploration generation yields no candidate', () => {
  assert.match(queryIntelligence, /reason: string;\n\} \| null> \{/);
  assert.match(queryIntelligence, /const selected = generated\[0\];\n    if \(!selected\) return null;/g);
  assert.match(queryIntelligence, /if \(!selected\) return null;\n  return \{ queryRecord: selected/);
});

test('autonomous discovery records no-eligible-query and does not enter authority or scheduling paths', () => {
  assert.match(autonomousDiscovery, /reasonCode: 'QUERY_INTELLIGENCE_NO_ELIGIBLE_QUERY'/g);
  assert.match(autonomousDiscovery, /const fallbackSelection = await selectNextQueryForCountry\(legacyCountry\);\n          if \(!fallbackSelection\)/);
  assert.match(autonomousDiscovery, /const legacySelection = await selectNextQueryForCountry\(country\);\n        if \(!legacySelection\)/);
  assert.match(autonomousDiscovery, /if \(!legacySelection\)[\s\S]*?continue;[\s\S]*?evaluateAutonomousQueryAuthority\(selected\.queryRecord\)/);
});
