import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION } from '../server/evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from '../server/evidenceEngine/coverage';
import {
  selectBalancedAdjudicationQueue,
  selectBalancedProspectiveCandidates,
  type ProspectiveReviewCandidate,
} from '../server/stage1/balancedProspectiveCandidateSelector';

const POLICY_KEY = 'stage1-prospective-census';
const requestedQueuePerClass = Math.max(1, Math.min(50, Number.parseInt(process.env.STAGE1_ADJUDICATION_QUEUE_PER_CLASS || '10', 10) || 10));

const formatProbability = (value: unknown): string => {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : 'n/a';
};

const queueMarkdown = (
  likelyTrading: ProspectiveReviewCandidate[],
  likelyNonTrading: ProspectiveReviewCandidate[],
): string => {
  const lines = [
    '# Stage 1 independent adjudication worklist',
    '',
    '> Human review required. Lane placement is a triage hint only and is not ground truth.',
    '> Independently inspect every creator before choosing TRADING_CONFIRMED or NON_TRADING.',
    '',
    '## Likely trading lane',
    '',
    '| Channel | Creator Focus | Probability | Lower bound | YouTube |',
    '|---|---:|---:|---:|---|',
  ];

  if (!likelyTrading.length) lines.push('| _none_ | | | | |');
  for (const row of likelyTrading) {
    const url = String(row.youtube_url || '').trim();
    const link = url ? `[open](${url})` : '';
    lines.push(`| ${String(row.channel_name || row.channel_id)} | ${String(row.creator_focus_proposed_status || 'UNKNOWN')} | ${formatProbability(row.creator_focus_probability)} | ${formatProbability(row.creator_focus_lower_confidence_bound)} | ${link} |`);
  }

  lines.push('', '## Likely non-trading lane', '', '| Channel | Creator Focus | Probability | Lower bound | YouTube |', '|---|---:|---:|---:|---|');
  if (!likelyNonTrading.length) lines.push('| _none_ | | | | |');
  for (const row of likelyNonTrading) {
    const url = String(row.youtube_url || '').trim();
    const link = url ? `[open](${url})` : '';
    lines.push(`| ${String(row.channel_name || row.channel_id)} | ${String(row.creator_focus_proposed_status || 'UNKNOWN')} | ${formatProbability(row.creator_focus_probability)} | ${formatProbability(row.creator_focus_lower_confidence_bound)} | ${link} |`);
  }

  lines.push('', 'These lanes never write labels, mutate operational state, or create serving authority.', '');
  return lines.join('\n');
};

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const result = await db.query(`
      WITH prospective AS (
        SELECT DISTINCT ON (a.channel_id)
               a.id AS assignment_id,a.channel_id,a.assigned_at,a.inclusion_basis_points,
               a.stratum,a.discovery_context
          FROM evaluation_cohort_assignments a
         WHERE a.policy_key=$1
           AND a.cohort<>'NOT_SELECTED'
           AND a.inclusion_basis_points>0
         ORDER BY a.channel_id,a.assigned_at DESC,a.id DESC
      ), latest_diag AS (
        SELECT p.*,
               d.id AS diagnostic_id,d.created_at AS diagnostic_at
          FROM prospective p
          LEFT JOIN LATERAL (
            SELECT x.id,x.created_at
              FROM production_classification_diagnostics x
             WHERE x.channel_id=p.channel_id
               AND x.created_at>=p.assigned_at
             ORDER BY x.created_at DESC,x.id DESC
             LIMIT 1
          ) d ON true
      )
      SELECT c.channel_id,c.channel_name,c.youtube_url,c.country,c.trading_status,c.scan_status,
             r.state AS review_state,r.review_version,r.pending_since,
             d.assignment_id,d.assigned_at,d.inclusion_basis_points,d.stratum,d.discovery_context,
             d.diagnostic_id,d.diagnostic_at,
             f.id AS focus_snapshot_id,
             f.proposed_status AS creator_focus_proposed_status,
             f.probability AS creator_focus_probability,
             f.lower_confidence_bound AS creator_focus_lower_confidence_bound,
             e.id AS coverage_snapshot_id,
             l.id AS independent_label_id,l.label AS independent_label,l.provenance AS independent_label_provenance,
             CASE
               WHEN r.state<>'PENDING' THEN 'NOT_PENDING_REVIEW'
               WHEN d.diagnostic_id IS NULL THEN 'DIAGNOSTIC_MISSING_AFTER_ASSIGNMENT'
               WHEN f.id IS NULL THEN 'CREATOR_FOCUS_SNAPSHOT_MISSING'
               WHEN e.id IS NULL THEN 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING'
               ELSE 'READY_FOR_PROSPECTIVE_HUMAN_REVIEW'
             END AS readiness,
             CASE
               WHEN l.id IS NOT NULL THEN 'INDEPENDENT_LABEL_ALREADY_EXISTS'
               WHEN d.diagnostic_id IS NULL THEN 'DIAGNOSTIC_MISSING_AFTER_ASSIGNMENT'
               WHEN f.id IS NULL THEN 'CREATOR_FOCUS_SNAPSHOT_MISSING'
               WHEN e.id IS NULL THEN 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING'
               ELSE 'READY_FOR_INDEPENDENT_ADJUDICATION'
             END AS adjudication_readiness
        FROM latest_diag d
        JOIN channels c ON c.channel_id=d.channel_id
        LEFT JOIN channel_reviews r ON r.channel_id=d.channel_id
        LEFT JOIN LATERAL (
          SELECT x.id,x.proposed_status,x.probability,x.lower_confidence_bound
            FROM creator_focus_classification_snapshots x
           WHERE x.classification_diagnostic_id=d.diagnostic_id
             AND x.classifier_version=$2
             AND x.policy_version=$3
           ORDER BY x.observed_at DESC,x.id DESC LIMIT 1
        ) f ON true
        LEFT JOIN LATERAL (
          SELECT x.id
            FROM evidence_coverage_snapshots x
           WHERE x.classification_diagnostic_id=d.diagnostic_id
             AND x.policy_version=$4
           ORDER BY x.observed_at DESC,x.id DESC LIMIT 1
        ) e ON true
        LEFT JOIN LATERAL (
          SELECT x.id,x.label,x.provenance
            FROM evaluation_ground_truth_labels x
           WHERE x.channel_id=d.channel_id
             AND x.provenance IN ('HUMAN_REVIEW','ADJUDICATION')
           ORDER BY x.labeled_at DESC,x.id DESC LIMIT 1
        ) l ON true
       ORDER BY CASE
                  WHEN l.id IS NULL AND d.diagnostic_id IS NOT NULL AND f.id IS NOT NULL AND e.id IS NOT NULL THEN 0
                  WHEN r.state='PENDING' AND d.diagnostic_id IS NOT NULL AND f.id IS NOT NULL AND e.id IS NOT NULL THEN 1
                  ELSE 2
                END,
                d.assigned_at DESC,c.channel_id
       LIMIT 250`, [POLICY_KEY, CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION, EVIDENCE_COVERAGE_POLICY_VERSION]);

    const rows = result.rows as ProspectiveReviewCandidate[];
    const ready = rows.filter(row => row.readiness === 'READY_FOR_PROSPECTIVE_HUMAN_REVIEW');
    const adjudicationReady = rows.filter(row => row.adjudication_readiness === 'READY_FOR_INDEPENDENT_ADJUDICATION');
    const balancedRecommendations = selectBalancedProspectiveCandidates(ready);
    const adjudicationQueue = selectBalancedAdjudicationQueue(adjudicationReady, requestedQueuePerClass);
    const adjudicationRecommendations = {
      operationalTradingConfirmed: adjudicationReady.find(row => row.trading_status === 'TRADING_CONFIRMED') || null,
      operationalUncertain: adjudicationReady.find(row => row.trading_status === 'UNCERTAIN' || row.trading_status === 'NEEDS_REVIEW') || null,
      operationalNonTrading: adjudicationReady.find(row => row.trading_status === 'NON_TRADING' || row.trading_status === 'HUMAN_REJECTED') || null,
      note: 'Operational trading_status is a triage hint only. Independent human adjudication remains the ground-truth decision.'
    };
    const report = {
      reportType: 'STAGE1_PROSPECTIVE_REVIEW_CANDIDATE_AUDIT',
      readOnly: true,
      servingAuthority: false,
      policyKey: POLICY_KEY,
      totals: {
        prospectiveAssignments: rows.length,
        readyPendingReview: ready.length,
        readyIndependentAdjudication: adjudicationReady.length,
        independentLabelsAlreadyPresent: rows.filter(row => row.adjudication_readiness === 'INDEPENDENT_LABEL_ALREADY_EXISTS').length,
        missingPostAssignmentDiagnostic: rows.filter(row => row.adjudication_readiness === 'DIAGNOSTIC_MISSING_AFTER_ASSIGNMENT').length
      },
      recommendedCandidate: ready[0] || null,
      balancedRecommendations,
      adjudicationRecommendations,
      adjudicationQueue,
      safety: {
        humanDecisionRequired: true,
        candidateHintsAreNotGroundTruth: true,
        operationalStatusIsNotGroundTruth: true,
        candidateSelectionDoesNotChangeCohortAssignment: true,
        noLabelWrite: true
      },
      rows
    };
    await db.query('ROLLBACK');
    await mkdir('stage1-output', { recursive: true });
    await writeFile('stage1-output/stage1-prospective-review-candidate-audit.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(
      'stage1-output/stage1-independent-adjudication-worklist.md',
      queueMarkdown(adjudicationQueue.likelyTrading, adjudicationQueue.likelyNonTrading),
      'utf8',
    );
    console.log(JSON.stringify({
      ...report,
      rows: `[${rows.length} rows omitted from console; full rows retained in JSON artifact]`,
    }, null, 2));
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
