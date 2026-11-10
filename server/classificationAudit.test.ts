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

test('audit label persistence is transactional and isolated from sealed evaluation ground truth', () => {
  const source = readFileSync(new URL('./classificationAudit.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('./db/migrations/175_classification_audit.sql', import.meta.url), 'utf8');
  assert.match(source, /BEGIN/);
  assert.match(source, /COMMIT/);
  assert.match(source, /ROLLBACK/);
  assert.match(source, /INSERT INTO classification_audit_labels/);
  assert.match(source, /classification-audit:/);
  assert.match(source, /AI_ASSISTED_AUDIT/);
  // Audit labels must never write into the sealed evaluation dataset.
  assert.doesNotMatch(source, /evaluation_ground_truth_labels/);
  assert.doesNotMatch(migration, /ALTER TABLE evaluation_ground_truth_labels/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS classification_audit_labels/);
  assert.match(migration, /audit_item_id UUID NOT NULL REFERENCES classification_audit_items/);
});

test('audit queue joins the latest label for an item and never uses production status as a label', () => {
  const source = readFileSync(new URL('./classificationAudit.ts', import.meta.url), 'utf8');
  assert.match(source, /x\.audit_item_id=a\.id/);
  assert.match(source, /ORDER BY x\.labeled_at DESC,x\.id DESC/);
  assert.doesNotMatch(source, /label\s*=\s*c\.trading_status/i);
});

test('audit label corrections version correctly and export filters by the audit cohort',()=>{
  const source = readFileSync(new URL('./classificationAudit.ts', import.meta.url), 'utf8');
  assert.match(source, /existing\.rowCount \|\| 0/);
  assert.match(source, /latest\.idempotency_key === input\.idempotencyKey/);
  assert.match(source, /cohortKey: item\.cohort_key/);
  assert.match(source, /JOIN classification_audit_items a ON a\.id=l\.audit_item_id/);
  assert.match(source, /a\.cohort_key=\$1/);
});

test('audit label history is an append-only read model', () => {
  const source = readFileSync(new URL('./classificationAudit.ts', import.meta.url), 'utf8');
  assert.match(source, /export async function listClassificationAuditLabelHistory/);
  assert.match(source, /FROM classification_audit_labels l/);
  assert.match(source, /ORDER BY l\.labeled_at DESC,l\.id DESC/);
});
