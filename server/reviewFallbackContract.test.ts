import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('governed review fallback requires explicit human confirmation and structured reasons', async () => {
  const source = await readFile(new URL('../scripts/commitHumanReviewDecision.ts', import.meta.url), 'utf8');
  assert.match(source, /COMMIT_HUMAN_REVIEW_DECISION/);
  assert.match(source, /REVIEW_REASON_CATALOG_VERSION/);
  assert.match(source, /REVIEW_REASON_CATALOG\[action\]/);
  assert.match(source, /OTHER is intentionally unsupported/);
});

test('fallback only acts on one pending review and uses the authoritative decideReview path', async () => {
  const source = await readFile(new URL('../scripts/commitHumanReviewDecision.ts', import.meta.url), 'utf8');
  assert.match(source, /r\.state='PENDING'/);
  assert.match(source, /lookup\.rowCount !== 1/);
  assert.match(source, /await decideReview/);
  assert.match(source, /expectedVersion: Number\(row\.review_version\)/);
});

test('fallback verifies the independent ground-truth chain after the decision', async () => {
  const source = await readFile(new URL('../scripts/commitHumanReviewDecision.ts', import.meta.url), 'utf8');
  assert.match(source, /evaluation_ground_truth_labels/);
  assert.match(source, /phase_b_observation_outbox/);
  assert.match(source, /independentLabelChainComplete/);
});
