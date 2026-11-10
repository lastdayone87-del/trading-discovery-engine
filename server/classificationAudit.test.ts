import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { findIdempotentAuditLabel, labelClassificationAuditItem } from './classificationAudit';

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
  const migration = readFileSync(new URL('./db/migrations/176_classification_audit.sql', import.meta.url), 'utf8');
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
  assert.match(source, /findIdempotentAuditLabel/);
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

test('a re-import returns the original label without replacing a later operator correction', () => {
  const rows = [
    { id: 'corrected', label: 'NON_TRADING', provenance: 'OPERATOR_AUDIT', idempotency_key: 'operator-key', labeled_at: '2026-01-02' },
    { id: 'original', label: 'TRADING_CONFIRMED', provenance: 'AI_ASSISTED_AUDIT', idempotency_key: 'import-key', labeled_at: '2026-01-01' },
  ];
  const match = findIdempotentAuditLabel(rows, {
    label: 'TRADING_CONFIRMED',
    provenance: 'AI_ASSISTED_AUDIT',
    idempotencyKey: 'import-key',
  });
  assert.equal(match?.id, 'original');
  assert.equal(findIdempotentAuditLabel(rows, {
    label: 'TRADING_CONFIRMED',
    provenance: 'AI_ASSISTED_AUDIT',
    idempotencyKey: 'new-key',
  }), null);
});

test('audit filter changes clear stale queue state and reload through the current filter', () => {
  const ui = readFileSync(new URL('../src/components/ClassificationAudit.tsx', import.meta.url), 'utf8');
  assert.match(ui, /setItems\(\[\]\)/);
  assert.match(ui, /setTotal\(0\)/);
  assert.match(ui, /setReloadToken\(value => value \+ 1\)/);
  assert.match(ui, /\[status, offset, reloadToken\]/);
  assert.match(ui, /disabled=\{submitting\}/);
});

test('the importer validates the whole file before the first write', () => {
  const source = readFileSync(new URL('../scripts/importClassificationAuditLabels.ts', import.meta.url), 'utf8');
  const validation = source.indexOf('validateAuditLabelRows(labels');
  const firstWrite = source.indexOf('const createdItem = await createClassificationAuditItem');
  assert.ok(validation >= 0);
  assert.ok(firstWrite >= 0);
  assert.ok(validation < firstWrite);
});
