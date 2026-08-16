import { getDb } from './db';
import { getYouTubeQuotaDay, getYouTubeQuotaDayStartAt, minutesSinceYouTubeQuotaDayStart } from './youtubeQuotaDay';

export interface AutonomousQuotaSchedulingSnapshot {
  queueDepth: number;
  autonomousUnitsUsed: number;
  autonomousUnitsReserved: number;
  minutesSinceQuotaDayStart: number;
  awakenedQuotaDeferredJobs: number;
  quotaDay: string;
}

const QUOTA_DEFERRED_JOB_TYPES = ['SEARCH_YOUTUBE', 'MANUAL_SEARCH_PAGE', 'ENRICH_CHANNEL'];

/**
 * Reconcile the durable queue with the authoritative YouTube Pacific quota day.
 *
 * Previous-day quota deferrals may carry a stale future run_after (historically
 * some allocation errors used UTC midnight). Once a new Pacific quota day has
 * begun, those jobs should be runnable again. Runtime 429/rate-limit deferrals
 * are deliberately excluded and retain their own retry schedule.
 */
export async function reconcileYouTubeQuotaRolloverAndGetAutonomousSnapshot(
  now: Date = new Date()
): Promise<AutonomousQuotaSchedulingSnapshot> {
  const db = await getDb();
  const client = await db.connect();
  const quotaDay = getYouTubeQuotaDay(now);
  const quotaDayStart = new Date(getYouTubeQuotaDayStartAt(now));
  let awakenedQuotaDeferredJobs = 0;

  try {
    await client.query('BEGIN');

    const tracker = await client.query(`SELECT last_reset,daily_limit FROM quota_tracker WHERE id='youtube' FOR UPDATE`);
    if (tracker.rowCount) {
      const previousDay = String(tracker.rows[0].last_reset || '');
      if (previousDay !== quotaDay) {
        await client.query(
          `UPDATE quota_tracker SET units_used=0,last_reset=$1 WHERE id='youtube'`,
          [quotaDay]
        );
      }
    }

    await client.query(`UPDATE quota_reservations SET status='EXPIRED' WHERE status='RESERVED' AND expires_at<=now()`);

    const awakened = await client.query(
      `UPDATE jobs
       SET run_after=now(),updated_at=now()
       WHERE status='PENDING'
         AND type=ANY($1::text[])
         AND run_after>now()
         AND updated_at<$2
         AND (
           last_error ILIKE '%YouTube quota allocation is exhausted%'
           OR last_error ILIKE '%daily quota%'
           OR last_error ILIKE '%dailyLimitExceeded%'
           OR last_error ILIKE '%quotaExceeded%'
         )
         AND last_error !~* 'rate.?limit|429'
       RETURNING id`,
      [QUOTA_DEFERRED_JOB_TYPES, quotaDayStart.toISOString()]
    );
    awakenedQuotaDeferredJobs = awakened.rowCount || 0;

    const [depth, used, reserved] = await Promise.all([
      client.query(
        `SELECT COUNT(*)::int AS count
         FROM jobs
         WHERE type='SEARCH_YOUTUBE'
           AND status IN ('PENDING','PROCESSING')
           AND payload->>'source'='automated_query'`
      ),
      client.query(
        `SELECT COALESCE(SUM(quota_used),0)::int AS units
         FROM query_runs
         WHERE source='automated_query'
           AND COALESCE(completed_at,started_at,scheduled_at)>=$1`,
        [quotaDayStart.toISOString()]
      ),
      client.query(
        `SELECT COALESCE(SUM(quota_reserved),0)::int AS units
         FROM query_runs
         WHERE source='automated_query'
           AND status IN ('SCHEDULED','RUNNING','RETRYING')`
      )
    ]);

    await client.query('COMMIT');
    return {
      queueDepth: Number(depth.rows[0]?.count || 0),
      autonomousUnitsUsed: Number(used.rows[0]?.units || 0),
      autonomousUnitsReserved: Number(reserved.rows[0]?.units || 0),
      minutesSinceQuotaDayStart: minutesSinceYouTubeQuotaDayStart(now),
      awakenedQuotaDeferredJobs,
      quotaDay
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
