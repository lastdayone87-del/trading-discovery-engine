import fs from 'node:fs';
import path from 'node:path';
import { createClassificationAuditItem, labelClassificationAuditItem, type ClassificationAuditEvidence } from '../server/classificationAudit';
import { buildAuditEvidenceInput } from '../server/classificationAuditWorklist';

const dataDir = process.env.CLASSIFICATION_AUDIT_DIR || '/tmp/opencode/classification-audit-data';
const cohortKey = process.env.CLASSIFICATION_AUDIT_COHORT || 'audit-2026-11-10-v1';
const labelsFile = process.env.CLASSIFICATION_AUDIT_LABELS || path.join(dataDir, 'audit-labels.jsonl');
const work = new Map<string, any>(fs.readFileSync(path.join(dataDir, 'worklist.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => { const row = JSON.parse(line); return [row.itemId, row]; }));
const manifest = new Map<string, any>(fs.readFileSync(path.join(dataDir, 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => { const row = JSON.parse(line); return [row.itemId, row]; }));
const labels = fs.readFileSync(labelsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
let imported = 0, created = 0;
for (const label of labels) {
  const item = work.get(label.itemId);
  if (!item) continue;
  const source = manifest.get(label.itemId) || {};
  const evidence: ClassificationAuditEvidence = {
    channel: { channelId: item.channelId, channelName: item.channelName, country: item.country || null, sourceCohort: source.sourceCohort },
    input: buildAuditEvidenceInput(item),
  };
  const createdItem = await createClassificationAuditItem({ cohortKey, channelId: item.channelId, evidence });
  if (createdItem.inserted) created += 1;
  await labelClassificationAuditItem({
    auditItemId: createdItem.id,
    label: label.label,
    reviewer: 'independent-audit-agent',
    notes: [label.notes, ...(Array.isArray(label.evidence) ? label.evidence.map((entry: any) => `${entry.field}: ${entry.quote}`) : [])].filter(Boolean).join(' | '),
    reasonCodes: ['INDEPENDENT_EVIDENCE_AUDIT'],
    provenance: 'AI_ASSISTED_AUDIT',
    idempotencyKey: `${cohortKey}:${label.itemId}:${label.label}`,
  });
  imported += 1;
}
console.log(JSON.stringify({ cohortKey, labels: labels.length, imported, createdItems: created }, null, 2));
