import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const pipeline = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
const materializer = readFileSync(new URL('./reviewEligibility/exhaustedReview.ts', import.meta.url), 'utf8');
const eligibilityStore = readFileSync(new URL('./reviewEligibility/store.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('./db/migrations/180_classification_resolution_safety.sql', import.meta.url), 'utf8');
const reviewUi = readFileSync(new URL('../src/components/ResultsTable.tsx', import.meta.url), 'utf8');

test('post-enrichment no-hypothesis path uses the single exhaustion reviewer', () => {
  const start = pipeline.indexOf('if (currentStage > 0 && !independentHypothesis)');
  const end = pipeline.indexOf('const legacyAction', start);
  const block = pipeline.slice(start, end);
  assert.match(block, /materializeExhaustedReview\(/);
  assert.match(block, /NO_INDEPENDENT_HYPOTHESIS_AFTER_ENRICHMENT/);
  assert.doesNotMatch(block, /recordReviewEligibilityShadow\(/);
  assert.doesNotMatch(block, /trading_status='NEEDS_REVIEW'/);
});

test('stage exhaustion and blocked completed reopens create review instead of COMPLETED/UNCERTAIN', () => {
  assert.match(pipeline, /reasonCode:'ENRICHMENT_STAGE_EXHAUSTED'/);
  assert.match(pipeline, /reasonCode:'ENRICHMENT_REOPEN_BLOCKED_COMPLETED'/);
  assert.match(pipeline, /reasonCodes:\['MACHINE_EXHAUSTED_UNCERTAIN'\]/);
});

test('the exhaustion materializer is review-only and keeps the existing serving lineage', () => {
  assert.match(materializer, /EVIDENCE_EXHAUSTED/);
  assert.match(materializer, /REVIEW_ELIGIBILITY_POLICY_VERSION/);
  assert.match(materializer, /materializeEligibleReviewInTransaction/);
  assert.match(materializer, /evidenceRequirementsUnchanged: true/);
  assert.doesNotMatch(materializer, /status:\s*'TRADING_CONFIRMED'/);
  assert.doesNotMatch(materializer, /status:\s*'NON_TRADING'/);
});

test('normal eligibility reconciliation cannot retire an exhausted review', () => {
  assert.match(eligibilityStore, /if\(pending\.rows\[0\]\?\.evidence_snapshot\?\.reasonFamily==='EVIDENCE_EXHAUSTED'\)return;/);
});

test('the migration and reviewer surface expose the request-rescan path', () => {
  assert.match(migration, /REQUEST_RESCAN/);
  assert.match(migration, /terminal_failure_class/);
  assert.match(reviewUi, /request-rescan/);
  assert.match(reviewUi, /Request more evidence/);
});
