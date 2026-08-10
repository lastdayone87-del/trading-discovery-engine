import pg from 'pg';

export const STAGE1_REVIEW_HISTORY_STORAGE_AUDIT_VERSION = 'stage1-review-history-storage-audit-v1';

function rowsToCounts(rows: any[], key: string, value = 'count') {
  return Object.fromEntries(rows.map(row => [String(row[key]), Number(row[value])]));
}

export async function inspectStage1ReviewHistoryStorageAudit() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');

    // Keep all statements on this single transaction strictly sequential.
    // pg deprecates overlapping client.query() calls and removes support in pg@9.
    const decisionCount = await client.query(`SELECT COUNT(*)::int AS count FROM channel_review_decisions`);
    const reviewStates = await client.query(`SELECT state::text AS state, COUNT(*)::int AS count FROM channel_reviews GROUP BY state ORDER BY state`);
    const reviewSources = await client.query(`SELECT COALESCE(evidence_snapshot->>'source','UNKNOWN') AS source, COUNT(*)::int AS count FROM channel_reviews GROUP BY 1 ORDER BY 1`);
    const terminalReviewOrphans = await client.query(`
      SELECT r.state::text AS state, COUNT(*)::int AS count
        FROM channel_reviews r
        LEFT JOIN channel_review_decisions d ON d.channel_id=r.channel_id
       WHERE r.state IN ('APPROVED','REJECTED','SUPERSEDED')
         AND d.id IS NULL
       GROUP BY r.state
       ORDER BY r.state`);
    const channelTradingStatuses = await client.query(`SELECT trading_status::text AS status, COUNT(*)::int AS count FROM channels GROUP BY trading_status ORDER BY trading_status`);
    const channelScanStatuses = await client.query(`SELECT scan_status::text AS status, COUNT(*)::int AS count FROM channels GROUP BY scan_status ORDER BY scan_status`);
    const groundTruth = await client.query(`
      SELECT provenance::text AS provenance, label::text AS label, COUNT(*)::int AS count
        FROM evaluation_ground_truth_labels
       GROUP BY provenance,label
       ORDER BY provenance,label`);
    const reviewOutcomeEvents = await client.query(`
      SELECT event_type::text AS event_type, COUNT(*)::int AS count
        FROM outcome_events
       WHERE event_type IN ('REVIEW_VERIFIED','REVIEW_CORRECTED')
       GROUP BY event_type
       ORDER BY event_type`);
    const reviewJobs = await client.query(`
      SELECT type::text AS type, COUNT(*)::int AS count
        FROM jobs
       WHERE type IN ('POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN')
       GROUP BY type
       ORDER BY type`);

    await client.query('ROLLBACK');

    const reviewDecisionRows = Number(decisionCount.rows[0]?.count || 0);
    const terminalOrphans = rowsToCounts(terminalReviewOrphans.rows, 'state');
    const groundTruthCounts = groundTruth.rows.map((row:any) => ({
      provenance: String(row.provenance),
      label: String(row.label),
      count: Number(row.count)
    }));

    return {
      reportType: 'STAGE1_REVIEW_HISTORY_STORAGE_ORIGIN_AUDIT',
      version: STAGE1_REVIEW_HISTORY_STORAGE_AUDIT_VERSION,
      readOnly: true,
      servingAuthority: false,
      automaticPromotion: false,
      authoritativeHumanHistoryRule: 'Only immutable review decisions or independently provenance-bound ground-truth labels qualify; current channel status alone is not human ground truth.',
      summary: {
        reviewDecisionRows,
        reviewStates: rowsToCounts(reviewStates.rows, 'state'),
        reviewEvidenceSources: rowsToCounts(reviewSources.rows, 'source'),
        terminalReviewRowsWithoutDecision: terminalOrphans,
        channelTradingStatuses: rowsToCounts(channelTradingStatuses.rows, 'status'),
        channelScanStatuses: rowsToCounts(channelScanStatuses.rows, 'status'),
        groundTruthLabels: groundTruthCounts,
        reviewOutcomeEvents: rowsToCounts(reviewOutcomeEvents.rows, 'event_type'),
        reviewLifecycleJobs: rowsToCounts(reviewJobs.rows, 'type')
      },
      interpretation: {
        hasImmutableReviewHistory: reviewDecisionRows > 0,
        hasOrphanTerminalReviewState: Object.values(terminalOrphans).some(count => Number(count) > 0),
        statusOnlyEvidenceIsRecoverableGroundTruth: false
      }
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
