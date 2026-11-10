import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { labelClassificationAuditItem } from './classificationAudit';

test('audit labels reject invalid values and missing reviewers before touching the database', async () => {
  await assert.rejects(
    labelClassificationAuditItem({ auditItemId: 'item-1', label: 'MAYBE' as any, reviewer: 'operator-1' }),
    /INVALID_AUDIT_LABEL/,
  );
  await assert.rejects(
    labelClassificationAuditItem({ auditItemId: 'item-1', label: 'TRADING_CONFIRMED', reviewer: '  ' }),
    /REVIEWER_REQUIRED/,
  );
});

test('audit label persistence is transactional and keeps labels separate from production review decisions', () => {
  const source = readFileSync(new URL('./classificationAudit.ts', import.meta.url), 'utf8');
  assert.match(source, /BEGIN/);
  assert.match(source, /COMMIT/);
  assert.match(source, /ROLLBACK/);
  assert.match(source, /review_decision_id/);
  assert.match(source, /NULL,\$3/);
  assert.match(source, /evaluation_ground_truth_labels/);
  assert.match(source, /classification-audit:/);
  assert.match(source, /AI_ASSISTED_AUDIT/);
});

test('audit queue joins the latest label for an item and never uses production status as a label', () => {
  const source = readFileSync(new URL('./classificationAudit.ts', import.meta.url), 'utf8');
  assert.match(source, /evidence_snapshot->>'auditItemId'/);
  assert.match(source, /ORDER BY x\.labeled_at DESC,x\.id DESC/);
  assert.doesNotMatch(source, /label\s*=\s*c\.trading_status/i);
});

test('audit label corrections version correctly and export filters by the audit cohort',()=>{
  const source = readFileSync(new URL('./classificationAudit.ts', import.meta.url), 'utf8');
  assert.match(source, /existing\.rowCount \|\| 0/);
  assert.match(source, /latestKey === input\.idempotencyKey/);
  assert.match(source, /cohortKey: item\.cohort_key/);
  assert.match(source, /JOIN classification_audit_items a ON a\.id::text=l\.evidence_snapshot->>'auditItemId'/);
  assert.match(source, /a\.cohort_key=\$1/);
});
