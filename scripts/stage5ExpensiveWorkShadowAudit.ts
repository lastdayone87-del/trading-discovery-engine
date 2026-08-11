import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';

const DEFERRABLE_STATES = [
  'WITHHELD_NO_PLAUSIBLE_HYPOTHESIS',
  'WITHHELD_TERMINAL_NON_TRADING'
];

const EXPENSIVE_JOB_TYPES = [
  'ENRICH_CHANNEL',
  'RETRY_COMMUNITY_ACQUISITION',
  'POST_APPROVAL_ENRICH',
  'FORCE_REVIEW_RESCAN',
  'INSPECT_PLAYLIST',
  'INSPECT_FEATURED_CHANNELS'
];

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

    const admission = await db.query(`
      SELECT state, count(*)::int AS channels
      FROM channel_admission_projection
      GROUP BY state
      ORDER BY state
    `);

    const jobs = await db.query(`
      WITH projected AS (
        SELECT channel_id,state
        FROM channel_admission_projection
      ), expensive AS (
        SELECT id,type,status,created_at,
               COALESCE(payload->>'channelId', payload->>'channel_id') AS channel_id
        FROM jobs
        WHERE type = ANY($1::text[])
      )
      SELECT e.type,e.status,p.state AS admission_state,count(*)::int AS jobs
      FROM expensive e
      LEFT JOIN projected p ON p.channel_id=e.channel_id
      GROUP BY e.type,e.status,p.state
      ORDER BY e.type,e.status,p.state NULLS LAST
    `, [EXPENSIVE_JOB_TYPES]);

    const recent = await db.query(`
      WITH projected AS (
        SELECT channel_id,state
        FROM channel_admission_projection
      )
      SELECT j.id,j.type,j.status,j.created_at,
             COALESCE(j.payload->>'channelId', j.payload->>'channel_id') AS channel_id,
             p.state AS admission_state
      FROM jobs j
      LEFT JOIN projected p ON p.channel_id=COALESCE(j.payload->>'channelId', j.payload->>'channel_id')
      WHERE j.type = ANY($1::text[])
      ORDER BY j.created_at DESC
      LIMIT 250
    `, [EXPENSIVE_JOB_TYPES]);

    const rows = recent.rows;
    const deferrable = rows.filter(row => DEFERRABLE_STATES.includes(String(row.admission_state)));
    const pendingOrProcessing = deferrable.filter(row => ['PENDING','PROCESSING','RETRY'].includes(String(row.status)));
    const completed = deferrable.filter(row => String(row.status) === 'COMPLETED');

    const report = {
      reportType: 'STAGE5_EXPENSIVE_WORK_SHADOW_AUDIT',
      readOnly: true,
      servingAuthority: false,
      automaticDeferral: false,
      deferrableAdmissionStates: DEFERRABLE_STATES,
      expensiveJobTypes: EXPENSIVE_JOB_TYPES,
      admissionStateCounts: admission.rows,
      expensiveJobBreakdown: jobs.rows,
      recentWindow: {
        inspectedJobs: rows.length,
        hypotheticallyDeferrableJobs: deferrable.length,
        currentlyPendingOrProcessingDeferrableJobs: pendingOrProcessing.length,
        alreadyCompletedDeferrableJobs: completed.length,
        projectedWorkReductionRate: rows.length ? deferrable.length / rows.length : 0
      },
      safety: {
        dashboardBehaviorChanged: false,
        reviewBehaviorChanged: false,
        discordBehaviorChanged: false,
        enrichmentBehaviorChanged: false,
        discoveryBehaviorChanged: false
      },
      nextGate: 'MEASURE_FALSE_DEFER_RISK_BEFORE_ANY_STAGE5_CANARY',
      recentRows: rows
    };

    await db.query('ROLLBACK');
    await mkdir('stage5-output', { recursive: true });
    await writeFile('stage5-output/stage5-expensive-work-shadow-audit.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
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
