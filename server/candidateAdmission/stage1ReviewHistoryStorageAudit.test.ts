import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('review history storage-origin audit is read-only and inspects all durable review clues', () => {
  const source = readFileSync(new URL('./stage1ReviewHistoryStorageAudit.ts', import.meta.url), 'utf8');
  assert.match(source, /BEGIN TRANSACTION READ ONLY/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
  assert.match(source, /channel_review_decisions/);
  assert.match(source, /channel_reviews/);
  assert.match(source, /evaluation_ground_truth_labels/);
  assert.match(source, /outcome_events/);
  assert.match(source, /POST_APPROVAL_ENRICH/);
  assert.match(source, /FORCE_REVIEW_RESCAN/);
});

test('audit explicitly refuses to treat status-only evidence as recoverable human ground truth', () => {
  const source = readFileSync(new URL('./stage1ReviewHistoryStorageAudit.ts', import.meta.url), 'utf8');
  assert.match(source, /statusOnlyEvidenceIsRecoverableGroundTruth:\s*false/);
  assert.match(source, /current channel status alone is not human ground truth/);
});
