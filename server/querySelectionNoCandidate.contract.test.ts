import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const queryIntelligence = readFileSync(fileURLToPath(new URL('./queryIntelligence.ts', import.meta.url)), 'utf8');
const autonomousDiscovery = readFileSync(fileURLToPath(new URL('./autonomousDiscovery.ts', import.meta.url)), 'utf8');

test('query selection returns null when cold-start or exploration generation yields no candidate', () => {
  assert.match(queryIntelligence, /reason: string;\n\} \| null> \{/);
  assert.match(queryIntelligence, /const selected = generated\[0\];\n    if \(!selected\) return null;/g);
  // Bind the null check to the cold-start branch: a wildcard that crosses
  // function/file boundaries would pass on an unrelated check.
  assert.match(queryIntelligence, /const selected = generated\[0\];\n    if \(!selected\) return null;\n    \/\/ Generated rows are reloaded[\s\S]*?return buildSelectionResult\(admitted, pool, 'COLD_START_GENERATION'/);
  // The exploration branch has no separate null check: an empty generation
  // must fall through to the final candidate-pool guard and return null.
  assert.match(queryIntelligence, /const generated = await generateCandidateQueriesForCountry\(country, 4, 'EXPLORATION'[\s\S]*?if \(generated\.length > 0\) \{[\s\S]*?\n  \}\n\n  if \(options\.targetNeighborhoodDimensions\)/);
  assert.match(queryIntelligence, /if \(pool\.candidates\.length === 0\) return null;\n  const decision = selectHierarchicalUcb\(pool\.candidates, pool\.context\);\n  if \(!decision\.queryId\) return null;/);
});

test('autonomous discovery records no-eligible-query and does not enter authority or scheduling paths', () => {
  assert.match(autonomousDiscovery, /reasonCode: 'QUERY_INTELLIGENCE_NO_ELIGIBLE_QUERY'/g);
  assert.match(autonomousDiscovery, /let fallbackSelection[\s\S]*?if \(!fallbackSelection\)/);
  assert.match(autonomousDiscovery, /let legacySelection[\s\S]*?if \(!legacySelection\)/);
  assert.match(autonomousDiscovery, /if \(!legacySelection\)[\s\S]*?continue;[\s\S]*?evaluateAutonomousQueryAuthority\(selected\.queryRecord, \{/);
  assert.doesNotMatch(autonomousDiscovery, /\?\? await selectNextQueryForCountry/);
});
