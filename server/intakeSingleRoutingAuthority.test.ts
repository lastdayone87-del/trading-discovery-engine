import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pipeline = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');

test('normal ingestion has no blocking trading-focus intake gate', () => {
  assert.doesNotMatch(pipeline, /triageAutonomousSearchCandidate\(/);
  assert.doesNotMatch(pipeline, /INTAKE_DEFERRED/);
  assert.doesNotMatch(pipeline, /buildDeferredTradingIntakeChannel/);
  assert.doesNotMatch(pipeline, /DEFER_NO_CONFIDENT_EVIDENCE/);
  assert.doesNotMatch(queue, /scan_status === 'INTAKE_DEFERRED'/);
});

test('country validation remains before normal classification', () => {
  const country = pipeline.indexOf('// Step 1: GATE 1 - Country Validation Hard Gate');
  const classification = pipeline.indexOf('classifyTradingRelevanceDetailed(classifierInput)');
  assert.ok(country >= 0 && classification > country);
  assert.match(pipeline, /validateChannelCountry|validateCountryWithHydration/);
  assert.match(pipeline, /applyTargetCountryBoundary|country_status === 'REJECTED'/);
});

test('observational triage remains available without controlling production routing', () => {
  const triage = readFileSync(new URL('./candidateTriage.ts', import.meta.url), 'utf8');
  assert.match(triage, /export function triageAutonomousSearchCandidate/);
  assert.match(triage, /export function observeKeywordBaseline/);
  assert.doesNotMatch(pipeline, /triageAutonomousSearchCandidate/);
  assert.match(pipeline, /hasIndependentTradingHypothesis/);
});
