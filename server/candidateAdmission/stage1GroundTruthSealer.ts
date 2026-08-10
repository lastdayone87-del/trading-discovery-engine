import { getDb } from '../db';
import { evaluationChecksum } from '../decisionEvaluation';
import { CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION } from '../evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from '../evidenceEngine/coverage';

export const STAGE1_GROUND_TRUTH_DATASET_SCHEMA_VERSION = 'stage1-ground-truth-dataset-v1';
export const STAGE1_INDEPENDENT_PROVENANCES = ['HUMAN_REVIEW', 'ADJUDICATION'] as const;

export interface Stage1GroundTruthSealDefinition {
  datasetKey: string;
  cutoffAt: string;
  minimumPerClass?: number;
}

type CandidateRow = {
  channel_id: string;
  label_id: string;
  label: 'TRADING_CONFIRMED' | 'NON_TRADING';
  provenance: string;
  labeled_at: string | Date;
  diagnostic_id: string | null;
  diagnostic_created_at: string | Date | null;
  decision: any;
  normalized_input: any;
  assignment_id: string | null;
  inclusion_basis_points: number | null;
  stratum: any;
  focus_snapshot_id: string | null;
  coverage_snapshot_id: string | null;
};

export type Stage1GroundTruthExclusionReason =
  | 'DIAGNOSTIC_MISSING'
  | 'RETRIEVAL_ASSIGNMENT_MISSING'
  | 'CREATOR_FOCUS_SNAPSHOT_MISSING'
  | 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING';

export function stage1GroundTruthEligibility(row: CandidateRow): { eligible: boolean; reason: Stage1GroundTruthExclusionReason | null } {
  if (!row.diagnostic_id) return { eligible: false, reason: 'DIAGNOSTIC_MISSING' };
  if (!row.assignment_id || !(Number(row.inclusion_basis_points) > 0)) return { eligible: false, reason: 'RETRIEVAL_ASSIGNMENT_MISSING' };
  if (!row.focus_snapshot_id) return { eligible: false, reason: 'CREATOR_FOCUS_SNAPSHOT_MISSING' };
  if (!row.coverage_snapshot_id) return { eligible: false, reason: 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING' };
  return { eligible: true, reason: null };
}

export function summarizeStage1GroundTruthCandidates(rows: CandidateRow[], minimumPerClass = 30) {
  const counts = {
    independentLabels: rows.length,
    eligible: 0,
    tradingConfirmed: 0,
    nonTrading: 0,
    exclusions: {} as Record<Stage1GroundTruthExclusionReason, number>
  };
  for (const row of rows) {
    const eligibility = stage1GroundTruthEligibility(row);
    if (!eligibility.eligible) {
      counts.exclusions[eligibility.reason!] = (counts.exclusions[eligibility.reason!] || 0) + 1;
      continue;
    }
    counts.eligible++;
    if (row.label === 'TRADING_CONFIRMED') counts.tradingConfirmed++;
    if (row.label === 'NON_TRADING') counts.nonTrading++;
  }
  const ready = counts.tradingConfirmed >= minimumPerClass && counts.nonTrading >= minimumPerClass;
  return {
    ...counts,
    minimumPerClass,
    ready,
    reasonCodes: ready ? [] : [
      ...(counts.tradingConfirmed < minimumPerClass ? ['GENUINE_CREATOR_EFFECTIVE_SAMPLE_SIZE_INSUFFICIENT'] : []),
      ...(counts.nonTrading < minimumPerClass ? ['NON_TRADING_EFFECTIVE_SAMPLE_SIZE_INSUFFICIENT'] : [])
    ]
  };
}

function validateDefinition(definition: Stage1GroundTruthSealDefinition) {
  if (!definition.datasetKey?.trim()) throw new Error('datasetKey is required.');
  const cutoff = new Date(definition.cutoffAt);
  if (!Number.isFinite(cutoff.getTime())) throw new Error('A valid cutoffAt timestamp is required.');
  const minimumPerClass = definition.minimumPerClass ?? 30;
  if (!Number.isInteger(minimumPerClass) || minimumPerClass < 1) throw new Error('minimumPerClass must be a positive integer.');
  return { cutoff, minimumPerClass };
}

async function loadIndependentGroundTruthCandidates(client: any, cutoffAt: string): Promise<CandidateRow[]> {
  const result = await client.query(`
    WITH latest_labels AS (
      SELECT DISTINCT ON (l.channel_id)
             l.id AS label_id, l.channel_id, l.label, l.provenance, l.labeled_at
        FROM evaluation_ground_truth_labels l
       WHERE l.labeled_at <= $1
         AND l.label IN ('TRADING_CONFIRMED','NON_TRADING')
         AND l.provenance IN ('HUMAN_REVIEW','ADJUDICATION')
       ORDER BY l.channel_id, l.labeled_at DESC, l.id DESC
    )
    SELECT l.channel_id, l.label_id, l.label, l.provenance, l.labeled_at,
           d.id AS diagnostic_id, d.created_at AS diagnostic_created_at,
           d.decision, d.normalized_input,
           a.id AS assignment_id, a.inclusion_basis_points, a.stratum,
           f.id AS focus_snapshot_id,
           c.id AS coverage_snapshot_id
      FROM latest_labels l
      LEFT JOIN LATERAL (
        SELECT pd.*
          FROM production_classification_diagnostics pd
         WHERE pd.channel_id = l.channel_id
           AND pd.created_at <= l.labeled_at
         ORDER BY pd.created_at DESC, pd.id DESC
         LIMIT 1
      ) d ON true
      LEFT JOIN LATERAL (
        SELECT ea.*
          FROM evaluation_cohort_assignments ea
         WHERE ea.channel_id = l.channel_id
           AND ea.cohort <> 'NOT_SELECTED'
           AND ea.inclusion_basis_points > 0
           AND ea.assigned_at <= COALESCE(d.created_at, l.labeled_at)
         ORDER BY ea.assigned_at DESC, ea.id DESC
         LIMIT 1
      ) a ON true
      LEFT JOIN LATERAL (
        SELECT cf.id
          FROM creator_focus_classification_snapshots cf
         WHERE cf.classification_diagnostic_id = d.id
           AND cf.observed_at <= $1
           AND cf.classifier_version = $2
           AND cf.policy_version = $3
         ORDER BY cf.observed_at DESC, cf.id DESC
         LIMIT 1
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT ec.id
          FROM evidence_coverage_snapshots ec
         WHERE ec.classification_diagnostic_id = d.id
           AND ec.observed_at <= $1
           AND ec.policy_version = $4
         ORDER BY ec.observed_at DESC, ec.id DESC
         LIMIT 1
      ) c ON true
     ORDER BY l.labeled_at, l.channel_id`, [
       cutoffAt,
       CREATOR_FOCUS_CLASSIFIER_VERSION,
       CREATOR_FOCUS_POLICY_VERSION,
       EVIDENCE_COVERAGE_POLICY_VERSION
     ]);
  return result.rows as CandidateRow[];
}

export async function inspectStage1GroundTruthSeal(definition: Stage1GroundTruthSealDefinition) {
  const { minimumPerClass } = validateDefinition(definition);
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const rows = await loadIndependentGroundTruthCandidates(client, definition.cutoffAt);
    const summary = summarizeStage1GroundTruthCandidates(rows, minimumPerClass);
    await client.query('ROLLBACK');
    return {
      reportType: 'STAGE1_GROUND_TRUTH_SEAL_PREVIEW',
      schemaVersion: STAGE1_GROUND_TRUTH_DATASET_SCHEMA_VERSION,
      readOnly: true,
      servingAuthority: false,
      automaticPromotion: false,
      allowedGroundTruthProvenance: [...STAGE1_INDEPENDENT_PROVENANCES],
      definition,
      summary
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function buildExample(row: CandidateRow) {
  const stratum = row.stratum || {};
  const normalized = row.normalized_input || {};
  const productionStatus = row.decision?.status || 'UNCERTAIN';
  const productionScore = Number(row.decision?.confidenceScore || 0);
  const segment = {
    country: stratum.country || normalized.country || 'GLOBAL',
    language: stratum.language || 'und',
    script: stratum.script || 'UNKNOWN',
    discoveryOrigin: stratum.discoveryOrigin || 'UNKNOWN',
    groundTruthProvenance: row.provenance
  };
  const exampleKey = evaluationChecksum({
    diagnosticId: row.diagnostic_id,
    labelId: row.label_id,
    assignmentId: row.assignment_id,
    schemaVersion: STAGE1_GROUND_TRUTH_DATASET_SCHEMA_VERSION
  });
  return {
    exampleKey,
    channelId: row.channel_id,
    diagnosticId: row.diagnostic_id!,
    assignmentId: row.assignment_id!,
    labelId: row.label_id,
    label: row.label,
    inclusionProbability: Number(row.inclusion_basis_points) / 10000,
    observedAt: new Date(row.diagnostic_created_at!).toISOString(),
    productionStatus,
    productionScore,
    segment
  };
}

export async function sealStage1GroundTruthDataset(input: {
  definition: Stage1GroundTruthSealDefinition;
  actor: string;
  confirmation: string;
}) {
  const { minimumPerClass } = validateDefinition(input.definition);
  if (input.confirmation !== 'SEAL_STAGE1_EVALUATION_DATASET') {
    throw new Error('Explicit confirmation SEAL_STAGE1_EVALUATION_DATASET is required.');
  }
  if (!input.actor?.trim()) throw new Error('actor is required.');

  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const rows = await loadIndependentGroundTruthCandidates(client, input.definition.cutoffAt);
    const summary = summarizeStage1GroundTruthCandidates(rows, minimumPerClass);
    if (!summary.ready) {
      throw new Error(`STAGE1_SEAL_INSUFFICIENT_GROUND_TRUTH:${summary.reasonCodes.join(',')}`);
    }
    const eligible = rows.filter(row => stage1GroundTruthEligibility(row).eligible).map(buildExample);
    const definition = {
      schemaVersion: STAGE1_GROUND_TRUTH_DATASET_SCHEMA_VERSION,
      source: 'INDEPENDENT_OPERATOR_GROUND_TRUTH',
      allowedGroundTruthProvenance: [...STAGE1_INDEPENDENT_PROVENANCES],
      minimumPerClass,
      cutoffAt: input.definition.cutoffAt,
      datasetKey: input.definition.datasetKey,
      split: 'TEST'
    };
    const checksum = evaluationChecksum({
      definition,
      examples: eligible.map(example => [
        example.exampleKey,
        example.label,
        example.inclusionProbability,
        example.diagnosticId,
        example.assignmentId
      ])
    });

    const existing = await client.query(
      'SELECT * FROM decision_evaluation_datasets WHERE dataset_key=$1 AND checksum=$2 ORDER BY version DESC LIMIT 1',
      [input.definition.datasetKey, checksum]
    );
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return { dataset: existing.rows[0], reused: true, summary, checksum };
    }

    const versionResult = await client.query(
      'SELECT COALESCE(MAX(version),0)+1 AS version FROM decision_evaluation_datasets WHERE dataset_key=$1',
      [input.definition.datasetKey]
    );
    const datasetResult = await client.query(`
      INSERT INTO decision_evaluation_datasets(
        dataset_key, version, cutoff_at, definition, checksum, example_count, created_by
      ) VALUES($1,$2,$3,$4,$5,$6,$7)
      RETURNING *`, [
        input.definition.datasetKey,
        Number(versionResult.rows[0].version),
        input.definition.cutoffAt,
        JSON.stringify(definition),
        checksum,
        eligible.length,
        input.actor
      ]);
    const dataset = datasetResult.rows[0];

    for (const example of eligible) {
      await client.query(`
        INSERT INTO decision_evaluation_examples(
          dataset_id, example_key, channel_id, decision_diagnostic_id, assignment_id, label_id,
          split, segment, production_status, production_score, ground_truth_label,
          inclusion_probability, observed_at
        ) VALUES($1,$2,$3,$4,$5,$6,'TEST',$7,$8,$9,$10,$11,$12)`, [
          dataset.id,
          example.exampleKey,
          example.channelId,
          example.diagnosticId,
          example.assignmentId,
          example.labelId,
          JSON.stringify(example.segment),
          example.productionStatus,
          example.productionScore,
          example.label,
          example.inclusionProbability,
          example.observedAt
        ]);
    }
    await client.query('COMMIT');
    return { dataset, reused: false, summary, checksum };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
