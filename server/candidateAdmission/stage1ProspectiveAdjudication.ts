import { getDb } from '../db';
import {
  CREATOR_TYPES,
  recordEvaluationGroundTruth,
  type CreatorType
} from '../decisionEvaluation';
import { CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION } from '../evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from '../evidenceEngine/coverage';

const POLICY_KEY = 'stage1-prospective-census';
export const STAGE1_PROSPECTIVE_ADJUDICATION_CONFIRMATION = 'COMMIT_STAGE1_PROSPECTIVE_ADJUDICATION';

export type Stage1AdjudicationLabel = 'TRADING_CONFIRMED' | 'NON_TRADING';
export type Stage1AdjudicationReadiness =
  | 'READY_FOR_INDEPENDENT_ADJUDICATION'
  | 'PROSPECTIVE_ASSIGNMENT_MISSING'
  | 'DIAGNOSTIC_MISSING_AFTER_ASSIGNMENT'
  | 'CREATOR_FOCUS_SNAPSHOT_MISSING'
  | 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING'
  | 'INDEPENDENT_LABEL_ALREADY_EXISTS';

export interface Stage1ProspectiveAdjudicationCandidate {
  channel_id: string;
  channel_name: string;
  youtube_url: string | null;
  country: string | null;
  trading_status: string | null;
  scan_status: string | null;
  assignment_id: string | null;
  assigned_at: string | Date | null;
  inclusion_basis_points: number | null;
  diagnostic_id: string | null;
  diagnostic_at: string | Date | null;
  focus_snapshot_id: string | null;
  coverage_snapshot_id: string | null;
  existing_label_id: string | null;
  existing_label: string | null;
  existing_provenance: string | null;
  readiness: Stage1AdjudicationReadiness;
}

export function stage1ProspectiveAdjudicationReadiness(row: Omit<Stage1ProspectiveAdjudicationCandidate, 'readiness'>): Stage1AdjudicationReadiness {
  if (row.existing_label_id) return 'INDEPENDENT_LABEL_ALREADY_EXISTS';
  if (!row.assignment_id || !(Number(row.inclusion_basis_points) > 0)) return 'PROSPECTIVE_ASSIGNMENT_MISSING';
  if (!row.diagnostic_id) return 'DIAGNOSTIC_MISSING_AFTER_ASSIGNMENT';
  if (!row.focus_snapshot_id) return 'CREATOR_FOCUS_SNAPSHOT_MISSING';
  if (!row.coverage_snapshot_id) return 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING';
  return 'READY_FOR_INDEPENDENT_ADJUDICATION';
}

export async function inspectStage1ProspectiveAdjudicationCandidate(selector: string): Promise<Stage1ProspectiveAdjudicationCandidate> {
  const value = selector.trim();
  if (!value) throw new Error('CHANNEL_SELECTOR_REQUIRED');
  const db = await getDb();
  const result = await db.query(`
    WITH selected_channel AS (
      SELECT channel_id,channel_name,youtube_url,country,trading_status,scan_status
      FROM channels
      WHERE channel_id=$1 OR lower(btrim(channel_name))=lower(btrim($1))
      ORDER BY channel_id
      LIMIT 2
    )
    SELECT c.channel_id,c.channel_name,c.youtube_url,c.country,c.trading_status,c.scan_status,
           a.id assignment_id,a.assigned_at,a.inclusion_basis_points,
           d.id diagnostic_id,d.created_at diagnostic_at,
           f.id focus_snapshot_id,e.id coverage_snapshot_id,
           l.id existing_label_id,l.label existing_label,l.provenance existing_provenance
    FROM selected_channel c
    LEFT JOIN LATERAL (
      SELECT x.* FROM evaluation_cohort_assignments x
      WHERE x.channel_id=c.channel_id
        AND x.policy_key=$2
        AND x.cohort<>'NOT_SELECTED'
        AND x.inclusion_basis_points>0
      ORDER BY x.assigned_at DESC,x.id DESC LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT x.id,x.created_at FROM production_classification_diagnostics x
      WHERE x.channel_id=c.channel_id
        AND a.id IS NOT NULL
        AND x.created_at>=a.assigned_at
      ORDER BY x.created_at DESC,x.id DESC LIMIT 1
    ) d ON true
    LEFT JOIN LATERAL (
      SELECT x.id FROM creator_focus_classification_snapshots x
      WHERE x.classification_diagnostic_id=d.id
        AND x.classifier_version=$3
        AND x.policy_version=$4
      ORDER BY x.observed_at DESC,x.id DESC LIMIT 1
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT x.id FROM evidence_coverage_snapshots x
      WHERE x.classification_diagnostic_id=d.id
        AND x.policy_version=$5
      ORDER BY x.observed_at DESC,x.id DESC LIMIT 1
    ) e ON true
    LEFT JOIN LATERAL (
      SELECT x.id,x.label,x.provenance FROM evaluation_ground_truth_labels x
      WHERE x.channel_id=c.channel_id
        AND x.provenance IN ('HUMAN_REVIEW','ADJUDICATION')
      ORDER BY x.labeled_at DESC,x.id DESC LIMIT 1
    ) l ON true
  `, [value, POLICY_KEY, CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION, EVIDENCE_COVERAGE_POLICY_VERSION]);
  if (!result.rowCount) throw new Error('CHANNEL_NOT_FOUND');
  if (result.rowCount !== 1) throw new Error('CHANNEL_SELECTOR_AMBIGUOUS');
  const raw = result.rows[0] as Omit<Stage1ProspectiveAdjudicationCandidate, 'readiness'>;
  return { ...raw, readiness: stage1ProspectiveAdjudicationReadiness(raw) };
}

export async function commitStage1ProspectiveAdjudication(input: {
  channel: string;
  label: Stage1AdjudicationLabel;
  creatorType: CreatorType;
  reasonCodes: string[];
  reviewer: string;
  notes?: string;
  confirmation: string;
}) {
  if (input.confirmation !== STAGE1_PROSPECTIVE_ADJUDICATION_CONFIRMATION) throw new Error('EXPLICIT_CONFIRMATION_REQUIRED');
  if (input.label !== 'TRADING_CONFIRMED' && input.label !== 'NON_TRADING') throw new Error('INVALID_ADJUDICATION_LABEL');
  if (!CREATOR_TYPES.includes(input.creatorType)) throw new Error('INVALID_CREATOR_TYPE');
  const reasonCodes = [...new Set(input.reasonCodes.map(code => code.trim()).filter(Boolean))];
  if (!reasonCodes.length) throw new Error('REASON_CODES_REQUIRED');
  if (!input.reviewer.trim()) throw new Error('REVIEWER_REQUIRED');

  const candidate = await inspectStage1ProspectiveAdjudicationCandidate(input.channel);
  if (candidate.readiness !== 'READY_FOR_INDEPENDENT_ADJUDICATION') {
    throw new Error(`STAGE1_ADJUDICATION_NOT_READY:${candidate.readiness}`);
  }

  const evidenceSnapshot = {
    stage: 'STAGE1_PROSPECTIVE_INDEPENDENT_ADJUDICATION',
    servingAuthority: false,
    operationalStateMutation: false,
    reviewer: input.reviewer.trim(),
    notes: input.notes?.trim() || null,
    lineage: {
      policyKey: POLICY_KEY,
      assignmentId: candidate.assignment_id,
      assignedAt: candidate.assigned_at,
      inclusionBasisPoints: candidate.inclusion_basis_points,
      diagnosticId: candidate.diagnostic_id,
      diagnosticAt: candidate.diagnostic_at,
      creatorFocusSnapshotId: candidate.focus_snapshot_id,
      evidenceCoverageSnapshotId: candidate.coverage_snapshot_id
    }
  };

  const label = await recordEvaluationGroundTruth({
    channelId: candidate.channel_id,
    label: input.label,
    provenance: 'ADJUDICATION',
    reviewerCount: 1,
    disagreement: false,
    evidenceSnapshot,
    creatorType: input.creatorType,
    reasonCodes
  });

  return {
    reportType: 'STAGE1_PROSPECTIVE_INDEPENDENT_ADJUDICATION',
    servingAuthority: false,
    operationalStateMutation: false,
    channelId: candidate.channel_id,
    channelName: candidate.channel_name,
    label: input.label,
    creatorType: input.creatorType,
    reasonCodes,
    groundTruthLabelId: label.id,
    provenance: label.provenance,
    lineage: evidenceSnapshot.lineage
  };
}
