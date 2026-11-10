import { getDb } from './db';
import { listEvidenceAssertions } from './evidenceEngine/assertionStore';
import { listEvidenceCoverage } from './evidenceEngine/coverageStore';
import { listEvidenceDocuments } from './evidenceEngine/documentStore';
import { getReviewDetails } from './reviewStore';

export const REVIEW_EVIDENCE_VERSION = 'review-evidence-v1';

export interface ReviewEvidenceBundle {
  version: string;
  review: Awaited<ReturnType<typeof getReviewDetails>>;
  eligibility: {
    decisionId: string;
    status: string;
    reasonCodes: unknown[];
    reasonFamily: string | null;
    policyVersion: string;
    inputChecksum: string;
    inputSnapshot: Record<string, unknown>;
    servingAuthority: boolean;
    decidedAt: string;
    projection: {
      status: string;
      version: number;
      evidenceChecksum: string;
      policyVersion: string;
      updatedAt: string;
    } | null;
  } | null;
  diagnostic: {
    id: string;
    channelId: string;
    createdAt: string;
    enrichmentStage: number;
    jobId: string | null;
    queryRunId: string | null;
    nominationId: string | null;
    normalizedInput: Record<string, unknown>;
    providerExecution: unknown[];
    evidenceItems: unknown[];
    stagedReport: Record<string, unknown>;
    decision: Record<string, unknown>;
    policyVersions: Record<string, unknown>;
    catalogVersions: unknown[];
  } | null;
  evidenceDocuments: unknown[];
  evidenceAssertions: unknown[];
  evidenceCoverage: unknown[];
  creatorFocusSnapshot: Record<string, unknown> | null;
  warnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // ignore malformed legacy payloads; the warning is added by the caller
    }
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
  }
  return [];
}

export function mapReviewEvidenceRows(input: {
  review: Awaited<ReturnType<typeof getReviewDetails>>;
  eligibilityRow: any | null;
  diagnosticRow: any | null;
  evidenceDocuments?: unknown[];
  evidenceAssertions?: unknown[];
  evidenceCoverage?: unknown[];
  creatorFocusRow?: any | null;
}): ReviewEvidenceBundle {
  const warnings: string[] = [];
  const eligibility = input.eligibilityRow ? {
    decisionId: String(input.eligibilityRow.id),
    status: String(input.eligibilityRow.status),
    reasonCodes: asArray(input.eligibilityRow.reason_codes),
    reasonFamily: input.eligibilityRow.input_snapshot?.reasonFamily
      ? String(input.eligibilityRow.input_snapshot.reasonFamily)
      : null,
    policyVersion: String(input.eligibilityRow.policy_version),
    inputChecksum: String(input.eligibilityRow.input_checksum),
    inputSnapshot: asRecord(input.eligibilityRow.input_snapshot),
    servingAuthority: input.eligibilityRow.serving_authority === true,
    decidedAt: new Date(input.eligibilityRow.decided_at).toISOString(),
    projection: input.eligibilityRow.projection_status ? {
      status: String(input.eligibilityRow.projection_status),
      version: Number(input.eligibilityRow.projection_version || 0),
      evidenceChecksum: String(input.eligibilityRow.projection_evidence_checksum || ''),
      policyVersion: String(input.eligibilityRow.projection_policy_version || ''),
      updatedAt: input.eligibilityRow.projection_updated_at
        ? new Date(input.eligibilityRow.projection_updated_at).toISOString()
        : '',
    } : null,
  } : null;
  if (!eligibility) warnings.push('ELIGIBILITY_DECISION_MISSING');

  const diagnostic = input.diagnosticRow ? {
    id: String(input.diagnosticRow.id),
    channelId: String(input.diagnosticRow.channel_id),
    createdAt: new Date(input.diagnosticRow.created_at).toISOString(),
    enrichmentStage: Number(input.diagnosticRow.enrichment_stage || 0),
    jobId: input.diagnosticRow.job_id || null,
    queryRunId: input.diagnosticRow.query_run_id || null,
    nominationId: input.diagnosticRow.nomination_id || null,
    normalizedInput: asRecord(input.diagnosticRow.normalized_input),
    providerExecution: asArray(input.diagnosticRow.provider_execution),
    evidenceItems: asArray(input.diagnosticRow.evidence_items),
    stagedReport: asRecord(input.diagnosticRow.staged_report),
    decision: asRecord(input.diagnosticRow.decision),
    policyVersions: asRecord(input.diagnosticRow.policy_versions),
    catalogVersions: asArray(input.diagnosticRow.catalog_versions),
  } : null;
  if (!diagnostic) warnings.push('CLASSIFICATION_DIAGNOSTIC_MISSING');

  return {
    version: REVIEW_EVIDENCE_VERSION,
    review: input.review,
    eligibility,
    diagnostic,
    evidenceDocuments: input.evidenceDocuments || [],
    evidenceAssertions: input.evidenceAssertions || [],
    evidenceCoverage: input.evidenceCoverage || [],
    creatorFocusSnapshot: input.creatorFocusRow ? asRecord(input.creatorFocusRow) : null,
    warnings,
  };
}

export async function getReviewEvidence(
  channelId: string,
  options: { documentLimit?: number; assertionLimit?: number; coverageLimit?: number; cutoff?: string } = {},
): Promise<ReviewEvidenceBundle> {
  const review = await getReviewDetails(channelId);
  const snapshot = asRecord(review.evidenceSnapshot);
  const eligibilityDecisionId = typeof snapshot.eligibilityDecisionId === 'string' ? snapshot.eligibilityDecisionId : '';
  const db = await getDb();

  let eligibilityRow: any = null;
  let eligibilityWarning: string | null = null;
  if (eligibilityDecisionId) {
    const result = await db.query(
      `SELECT d.*,p.status AS projection_status,p.version AS projection_version,
              p.evidence_checksum AS projection_evidence_checksum,
              p.policy_version AS projection_policy_version,p.updated_at AS projection_updated_at
         FROM review_eligibility_decisions d
         LEFT JOIN review_eligibility_projection p
           ON p.decision_id=d.id AND p.channel_id=d.channel_id
        WHERE d.id=$1 AND d.channel_id=$2
        LIMIT 1`,
      [eligibilityDecisionId, channelId],
    );
    eligibilityRow = result.rows[0] || null;
    if (!eligibilityRow) eligibilityWarning = 'ELIGIBILITY_DECISION_NOT_FOUND';
  }
  if (!eligibilityRow) {
    const result = await db.query(
      `SELECT d.*,p.status AS projection_status,p.version AS projection_version,
              p.evidence_checksum AS projection_evidence_checksum,
              p.policy_version AS projection_policy_version,p.updated_at AS projection_updated_at
         FROM review_eligibility_projection p
         JOIN review_eligibility_decisions d ON d.id=p.decision_id AND d.channel_id=p.channel_id
        WHERE p.channel_id=$1
        ORDER BY p.updated_at DESC,p.version DESC
        LIMIT 1`,
      [channelId],
    );
    eligibilityRow = result.rows[0] || null;
  }

  let diagnosticRow: any = null;
  let diagnosticWarning: string | null = null;
  const diagnosticId = eligibilityRow?.classification_diagnostic_id;
  if (diagnosticId) {
    const result = await db.query(
      `SELECT id,channel_id,job_id,query_run_id,enrichment_stage,normalized_input,
              provider_execution,evidence_items,staged_report,decision,policy_versions,
              catalog_versions,created_at,nomination_id
         FROM production_classification_diagnostics
        WHERE id=$1 AND channel_id=$2
        LIMIT 1`,
      [diagnosticId, channelId],
    );
    diagnosticRow = result.rows[0] || null;
    if (!diagnosticRow) diagnosticWarning = 'CLASSIFICATION_DIAGNOSTIC_NOT_FOUND';
  }
  if (!diagnosticRow) {
    const result = await db.query(
      `SELECT id,channel_id,job_id,query_run_id,enrichment_stage,normalized_input,
              provider_execution,evidence_items,staged_report,decision,policy_versions,
              catalog_versions,created_at,nomination_id
         FROM production_classification_diagnostics
        WHERE channel_id=$1
        ORDER BY created_at DESC,id DESC
        LIMIT 1`,
      [channelId],
    );
    diagnosticRow = result.rows[0] || null;
    if (!diagnosticWarning && !diagnosticId) diagnosticWarning = 'CLASSIFICATION_DIAGNOSTIC_ID_MISSING';
  }

  const cutoff = options.cutoff || (diagnosticRow ? new Date(diagnosticRow.created_at).toISOString() : undefined);
  let documentsUnavailable = false;
  let assertionsUnavailable = false;
  let coverageUnavailable = false;
  let creatorFocusUnavailable = false;
  const [evidenceDocuments, evidenceAssertions, evidenceCoverage, creatorFocus] = await Promise.all([
    listEvidenceDocuments({ channelId, limit: Math.min(100, Math.max(1, options.documentLimit || 50)), cutoff }).catch(() => { documentsUnavailable = true; return []; }),
    listEvidenceAssertions({ channelId, limit: Math.min(200, Math.max(1, options.assertionLimit || 100)), cutoff }).catch(() => { assertionsUnavailable = true; return []; }),
    listEvidenceCoverage({ channelId, limit: Math.min(50, Math.max(1, options.coverageLimit || 20)), cutoff }).catch(() => { coverageUnavailable = true; return []; }),
    diagnosticRow ? db.query(
      `SELECT id,classification_diagnostic_id,classifier_version,policy_version,observed_at,
              document_count,independent_families,trading_mass,alternative_mass,lower_confidence_bound
         FROM creator_focus_classification_snapshots
        WHERE classification_diagnostic_id=$1
        ORDER BY observed_at DESC,id DESC
        LIMIT 1`,
      [diagnosticRow.id],
    ).then(result => result.rows[0] || null).catch(() => { creatorFocusUnavailable = true; return null; }) : Promise.resolve(null),
  ]);

  const bundle = mapReviewEvidenceRows({
    review,
    eligibilityRow,
    diagnosticRow,
    evidenceDocuments,
    evidenceAssertions,
    evidenceCoverage,
    creatorFocusRow: creatorFocus,
  });
  if (eligibilityWarning) bundle.warnings.push(eligibilityWarning);
  if (diagnosticWarning) bundle.warnings.push(diagnosticWarning);
  if (documentsUnavailable) bundle.warnings.push('EVIDENCE_DOCUMENTS_UNAVAILABLE');
  if (assertionsUnavailable) bundle.warnings.push('EVIDENCE_ASSERTIONS_UNAVAILABLE');
  if (coverageUnavailable) bundle.warnings.push('EVIDENCE_COVERAGE_UNAVAILABLE');
  if (creatorFocusUnavailable) bundle.warnings.push('CREATOR_FOCUS_UNAVAILABLE');
  return bundle;
}
