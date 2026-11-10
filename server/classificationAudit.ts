import { createHash } from 'node:crypto';
import { getDb } from './db';

export const CLASSIFICATION_AUDIT_VERSION = 'classification-audit-v1';
export const CLASSIFICATION_AUDIT_LABEL_POLICY = 'independent-classification-audit-v1';

export type ClassificationAuditLabel = 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN';
export type ClassificationAuditStatus = 'PENDING' | 'LABELED' | 'DISPUTED' | 'SKIPPED';

export interface ClassificationAuditEvidence {
  channel: {
    channelId: string;
    channelName: string;
    youtubeUrl?: string;
    country?: string | null;
    sourceCohort?: string;
  };
  input: Record<string, unknown>;
  classifier?: {
    status?: string;
    confidence?: number;
    recognitionState?: string | null;
    semanticPolicy?: string | null;
    route?: string | null;
    fastTrack?: boolean;
    reasonCodes?: string[];
    policyVersion?: string;
  };
  diagnosticId?: string | null;
}

export interface ClassificationAuditItem {
  id: string;
  cohortKey: string;
  channelId: string;
  status: ClassificationAuditStatus;
  evidence: ClassificationAuditEvidence;
  evidenceHash: string;
  proposedLabel: ClassificationAuditLabel | null;
  proposedConfidence: number | null;
  proposedReasonCodes: string[];
  channelName?: string;
  youtubeUrl?: string | null;
  country?: string | null;
  latestLabel?: string | null;
  latestProvenance?: string | null;
  latestLabeledAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

function auditCacheKey(evidence: ClassificationAuditEvidence): string {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function mapItem(row: any): ClassificationAuditItem {
  const evidence = typeof row.evidence_snapshot === 'string'
    ? JSON.parse(row.evidence_snapshot)
    : row.evidence_snapshot;
  return {
    id: String(row.id),
    cohortKey: String(row.cohort_key),
    channelId: String(row.channel_id),
    status: row.status as ClassificationAuditStatus,
    evidence,
    evidenceHash: String(row.evidence_hash),
    proposedLabel: row.proposed_label || null,
    proposedConfidence: row.proposed_confidence == null ? null : Number(row.proposed_confidence),
    proposedReasonCodes: Array.isArray(row.proposed_reason_codes) ? row.proposed_reason_codes.map(String) : [],
    channelName: row.channel_name || evidence?.channel?.channelName,
    youtubeUrl: row.youtube_url || evidence?.channel?.youtubeUrl || null,
    country: row.country ?? evidence?.channel?.country ?? null,
    latestLabel: row.latest_label || null,
    latestProvenance: row.latest_provenance || null,
    latestLabeledAt: row.latest_labeled_at ? new Date(row.latest_labeled_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function createClassificationAuditItem(input: {
  cohortKey: string;
  channelId: string;
  evidence: ClassificationAuditEvidence;
  proposedLabel?: ClassificationAuditLabel | null;
  proposedConfidence?: number | null;
  proposedReasonCodes?: string[];
}): Promise<{ id: string; inserted: boolean }> {
  const db = await getDb();
  const hash = auditCacheKey(input.evidence);
  const result = await db.query(
    `INSERT INTO classification_audit_items(cohort_key,channel_id,evidence_snapshot,evidence_hash,proposed_label,proposed_confidence,proposed_reason_codes)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(cohort_key,channel_id) DO NOTHING
     RETURNING id`,
    [input.cohortKey, input.channelId, JSON.stringify(input.evidence), hash, input.proposedLabel || null, input.proposedConfidence ?? null, input.proposedReasonCodes || []],
  );
  if (result.rows[0]) return { id: String(result.rows[0].id), inserted: true };
  const existing = await db.query(
    `SELECT id FROM classification_audit_items WHERE cohort_key=$1 AND channel_id=$2 LIMIT 1`,
    [input.cohortKey, input.channelId],
  );
  if (!existing.rows[0]) throw new Error('CLASSIFICATION_AUDIT_ITEM_NOT_FOUND_AFTER_INSERT');
  return { id: String(existing.rows[0].id), inserted: false };
}

export async function listClassificationAuditItems(filters: {
  status?: ClassificationAuditStatus | 'ALL';
  cohortKey?: string;
  country?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ items: ClassificationAuditItem[]; total: number }> {
  const db = await getDb();
  const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
  const offset = Math.max(0, filters.offset ?? 0);
  const params = [
    filters.status && filters.status !== 'ALL' ? filters.status : null,
    filters.cohortKey || null,
    filters.country || null,
    limit,
    offset,
  ];
  const result = await db.query(
    `SELECT a.*,c.channel_name,c.youtube_url,c.country,
            l.label AS latest_label,l.provenance AS latest_provenance,l.labeled_at AS latest_labeled_at,
            COUNT(*) OVER() AS total_count
       FROM classification_audit_items a
       JOIN channels c ON c.channel_id=a.channel_id
       LEFT JOIN LATERAL (
         SELECT x.label,x.provenance,x.labeled_at
           FROM evaluation_ground_truth_labels x
          WHERE x.channel_id=a.channel_id
            AND x.evidence_snapshot->>'auditItemId'=a.id::text
          ORDER BY x.labeled_at DESC,x.id DESC
          LIMIT 1
       ) l ON true
      WHERE ($1::text IS NULL OR a.status=$1)
        AND ($2::text IS NULL OR a.cohort_key=$2)
        AND ($3::text IS NULL OR c.country=$3)
      ORDER BY a.created_at,a.id
      LIMIT $4 OFFSET $5`,
    params,
  );
  return {
    items: result.rows.map(mapItem),
    total: Number(result.rows[0]?.total_count || 0),
  };
}

export async function getClassificationAuditItem(id: string): Promise<ClassificationAuditItem | null> {
  const db = await getDb();
  const result = await db.query(
    `SELECT a.*,c.channel_name,c.youtube_url,c.country,
            l.label AS latest_label,l.provenance AS latest_provenance,l.labeled_at AS latest_labeled_at
       FROM classification_audit_items a
       JOIN channels c ON c.channel_id=a.channel_id
       LEFT JOIN LATERAL (
         SELECT x.label,x.provenance,x.labeled_at
           FROM evaluation_ground_truth_labels x
          WHERE x.channel_id=a.channel_id
            AND x.evidence_snapshot->>'auditItemId'=a.id::text
          ORDER BY x.labeled_at DESC,x.id DESC
          LIMIT 1
       ) l ON true
      WHERE a.id=$1
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ? mapItem(result.rows[0]) : null;
}

export async function labelClassificationAuditItem(input: {
  auditItemId: string;
  label: ClassificationAuditLabel;
  reviewer: string;
  notes?: string;
  reasonCodes?: string[];
  provenance?: 'HUMAN_REVIEW' | 'AI_ASSISTED_AUDIT' | 'ADJUDICATION';
  idempotencyKey?: string;
}): Promise<{ item: ClassificationAuditItem; labelId: string; idempotent: boolean }> {
  if (!['TRADING_CONFIRMED', 'NON_TRADING', 'UNCERTAIN'].includes(input.label)) {
    throw new Error('INVALID_AUDIT_LABEL');
  }
  if (!input.reviewer.trim()) throw new Error('REVIEWER_REQUIRED');
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const itemResult = await client.query(`SELECT * FROM classification_audit_items WHERE id=$1 FOR UPDATE`, [input.auditItemId]);
    if (!itemResult.rowCount) throw new Error('CLASSIFICATION_AUDIT_ITEM_NOT_FOUND');
    const item = itemResult.rows[0];
    const provenance = input.provenance || 'HUMAN_REVIEW';
    const existing = await client.query(
      `SELECT id,label,provenance FROM evaluation_ground_truth_labels
        WHERE channel_id=$1 AND evidence_snapshot->>'auditItemId'=$2
        ORDER BY labeled_at DESC,id DESC LIMIT 1`,
      [item.channel_id, input.auditItemId],
    );
    if (existing.rowCount && existing.rows[0].label === input.label
      && existing.rows[0].provenance === provenance
      && item.status === 'LABELED') {
      await client.query('COMMIT');
      return { item: mapItem({ ...item, latest_label: existing.rows[0].label, latest_provenance: existing.rows[0].provenance, latest_labeled_at: new Date().toISOString() }), labelId: String(existing.rows[0].id), idempotent: true };
    }
    const version = Number(existing.rowCount || 0) + 1;
    const labelKey = `classification-audit:${item.cohort_key}:${item.channel_id}:v${version}`;
    const evidenceSnapshot = {
      ...(typeof item.evidence_snapshot === 'string' ? JSON.parse(item.evidence_snapshot) : item.evidence_snapshot),
      auditItemId: input.auditItemId,
      reviewer: input.reviewer.trim(),
      notes: input.notes?.trim() || null,
      reasonCodes: input.reasonCodes || [],
      provenance,
      labelPolicyVersion: CLASSIFICATION_AUDIT_LABEL_POLICY,
      labeledAt: new Date().toISOString(),
    };
    const labelResult = await client.query(
      `INSERT INTO evaluation_ground_truth_labels(label_key,channel_id,review_decision_id,label,provenance,reviewer_count,disagreement,label_policy_version,evidence_snapshot)
       VALUES($1,$2,NULL,$3,$4,1,false,$5,$6)
       RETURNING id`,
      [labelKey, item.channel_id, input.label, provenance, CLASSIFICATION_AUDIT_LABEL_POLICY, JSON.stringify(evidenceSnapshot)],
    );
    await client.query(`UPDATE classification_audit_items SET status='LABELED',updated_at=now() WHERE id=$1`, [input.auditItemId]);
    const updated = await client.query(
      `SELECT a.*,c.channel_name,c.youtube_url,c.country
         FROM classification_audit_items a JOIN channels c ON c.channel_id=a.channel_id
        WHERE a.id=$1`,
      [input.auditItemId],
    );
    await client.query('COMMIT');
    return {
      item: mapItem({ ...updated.rows[0], latest_label: input.label, latest_provenance: provenance, latest_labeled_at: new Date().toISOString() }),
      labelId: String(labelResult.rows[0].id),
      idempotent: false,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function exportClassificationAuditLabels(filters: { cohortKey?: string; limit?: number } = {}) {
  const db = await getDb();
  const limit = Math.min(1000, Math.max(1, filters.limit ?? 500));
  const result = await db.query(
    `SELECT l.id,l.channel_id,l.label,l.provenance,l.reviewer_count,l.disagreement,
            l.label_policy_version,l.evidence_snapshot,l.labeled_at,c.channel_name,c.country
       FROM evaluation_ground_truth_labels l
       JOIN channels c ON c.channel_id=l.channel_id
      WHERE l.evidence_snapshot->>'auditItemId' IS NOT NULL
        AND ($1::text IS NULL OR l.evidence_snapshot->>'cohortKey'=$1)
      ORDER BY l.labeled_at DESC,l.id DESC
      LIMIT $2`,
    [filters.cohortKey || null, limit],
  );
  return result.rows;
}
