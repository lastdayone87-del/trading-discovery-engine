import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('post-fix Stage 2 evaluation is anchored to sealed ground truth and non-serving', () => {
  const source = readFileSync(new URL('./stage2PostFixShadowEvaluation.ts', import.meta.url), 'utf8');
  assert.match(source, /status\) !== 'SEALED'/);
  assert.match(source, /groundTruthAnchor: 'SEALED_STAGE1_DATASET'/);
  assert.match(source, /servingAuthority: false/);
  assert.match(source, /automaticPromotion: false/);
  assert.match(source, /mutatesOperationalState: false/);
});

test('post-fix Stage 2 evaluation creates only durable observational diagnostics', () => {
  const source = readFileSync(new URL('./stage2PostFixShadowEvaluation.ts', import.meta.url), 'utf8');
  assert.match(source, /recordProductionClassification/);
  assert.match(source, /observationKey/);
  assert.doesNotMatch(source, /processDiscoveredChannel|triggerManualRecheck|decideReview|UPDATE\s+channels|INSERT\s+INTO\s+channel_reviews/i);
});

test('post-fix Stage 2 evaluation reports decisive outcomes and both safety metrics', () => {
  const source = readFileSync(new URL('./stage2PostFixShadowEvaluation.ts', import.meta.url), 'utf8');
  assert.match(source, /decisiveDecisionRate/);
  assert.match(source, /falsePositiveWithhold/);
  assert.match(source, /genuineCreatorRecall/);
  assert.match(source, /providerDegradation/);
});
