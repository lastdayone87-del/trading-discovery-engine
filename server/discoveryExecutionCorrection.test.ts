import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');

test('batch diversity is scoped by country, not global intent/term', () => {
  const autonomous = source('autonomousDiscovery.ts');
  assert.match(autonomous, /const diversityCountry = String\(selected\.queryRecord\.country/);
  assert.match(autonomous, /const intentKey = `\$\{diversityCountry\}::\$\{intent\}`/);
  assert.match(autonomous, /usedIntents\.add\(intentKey\)/);
  assert.match(autonomous, /usedPrimaryTerms\.add\(primaryTermKey\)/);
});

test('targeted selection tries governed fallback when matches exist but none are selectable', () => {
  const queryIntelligence = source('queryIntelligence.ts');
  assert.match(queryIntelligence, /Matches can exist while every candidate is cooling down/);
  const fallbackAt = queryIntelligence.indexOf('const generated = await generateCandidateQueriesForCountry(country, 1');
  const matchesAt = queryIntelligence.indexOf('if (matches.length > 0)');
  assert.ok(matchesAt > 0);
  assert.ok(fallbackAt > matchesAt);
});

test('frontier quota caps use provider official units, not total free+official spend', () => {
  const allocator = source('discoveryFrontierAllocator.ts');
  const dbCore = source('dbCore.ts');
  assert.match(allocator, /daily_official_quota_used/);
  assert.match(allocator, /GREATEST\(provider_reserved_amount, provider_consumed_amount\)/);
  assert.match(dbCore, /daily_official_quota_used/);
});
