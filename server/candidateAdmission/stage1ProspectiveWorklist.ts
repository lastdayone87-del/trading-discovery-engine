import { getDb } from '../db';
import { CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION } from '../evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from '../evidenceEngine/coverage';

const POLICY_KEY = 'stage1-prospective-census';

export type Stage1ProspectiveWorklistItem = {
  channel_id: string;
  channel_name: string;
  youtube_url: string | null;
  country: string | null;
  assigned_at: string | Date;
  diagnostic_at: string | Date;
};

/**
 * Read-only, prediction-blind worklist for independent Stage 1 adjudication.
 *
 * Deliberately excludes production trading status, classifier scores, focus
 * distributions and other model outputs so the human reviewer is not primed by
 * the system being evaluated. Every returned channel already has complete
 * prospective assignment + diagnostic + focus + coverage lineage and has no
 * prior independent HUMAN_REVIEW/ADJUDICATION label.
 */
export async function loadStage1ProspectiveWorklist(limit = 100): Promise<Stage1ProspectiveWorklistItem[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('WORKLIST_LIMIT_OUT_OF_RANGE');
  const db = await getDb();
  const result = await db.query(`
    SELECT c.channel_id,c.channel_name,c.youtube_url,c.country,
           a.assigned_at,d.created_at AS diagnostic_at
      FROM channels c
      JOIN LATERAL (
        SELECT x.id,x.assigned_at,x.inclusion_basis_points
          FROM evaluation_cohort_assignments x
         WHERE x.channel_id=c.channel_id
           AND x.policy_key=$1
           AND x.cohort<>'NOT_SELECTED'
           AND x.inclusion_basis_points>0
         ORDER BY x.assigned_at DESC,x.id DESC
         LIMIT 1
      ) a ON true
      JOIN LATERAL (
        SELECT x.id,x.created_at
          FROM production_classification_diagnostics x
         WHERE x.channel_id=c.channel_id
           AND x.created_at>=a.assigned_at
         ORDER BY x.created_at DESC,x.id DESC
         LIMIT 1
      ) d ON true
      JOIN LATERAL (
        SELECT x.id
          FROM creator_focus_classification_snapshots x
         WHERE x.classification_diagnostic_id=d.id
           AND x.classifier_version=$2
           AND x.policy_version=$3
         ORDER BY x.observed_at DESC,x.id DESC
         LIMIT 1
      ) f ON true
      JOIN LATERAL (
        SELECT x.id
          FROM evidence_coverage_snapshots x
         WHERE x.classification_diagnostic_id=d.id
           AND x.policy_version=$4
         ORDER BY x.observed_at DESC,x.id DESC
         LIMIT 1
      ) e ON true
     WHERE NOT EXISTS (
       SELECT 1
         FROM evaluation_ground_truth_labels l
        WHERE l.channel_id=c.channel_id
          AND l.provenance IN ('HUMAN_REVIEW','ADJUDICATION')
     )
     ORDER BY a.assigned_at,c.channel_id
     LIMIT $5
  `, [POLICY_KEY, CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION, EVIDENCE_COVERAGE_POLICY_VERSION, limit]);
  return result.rows as Stage1ProspectiveWorklistItem[];
}

export function toStage1HumanReviewSheet(items: Stage1ProspectiveWorklistItem[]) {
  return items.map(item => ({
    channel: item.channel_name,
    channel_id: item.channel_id,
    youtube_url: item.youtube_url,
    country: item.country,
    human_label: '',
    creator_type: '',
    reason_codes: [] as string[]
  }));
}
