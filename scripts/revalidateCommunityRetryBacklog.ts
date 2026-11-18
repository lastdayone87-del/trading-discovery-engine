/**
 * Revalidate the retry backlog against the URL work ledger.
 *
 * This is deliberately not the old blanket quarantine script. For each job:
 *   * lock the pending batch owner before examining it;
 *   * materialize missing URL work from durable observations;
 *   * if every URL is RESOLVED/EXHAUSTED (no active or parked work), close the
 *     batch owner with append-only closure evidence;
 *   * if any URL is still relevant, leave the job PENDING and let the normal
 *     fair scheduler process it;
 *   * never create a 30-day quarantine merely because a job is old.
 *
 * Usage:
 *   npx tsx scripts/revalidateCommunityRetryBacklog.ts --dry-run --limit=5000
 *   npx tsx scripts/revalidateCommunityRetryBacklog.ts --apply --limit=5000
 *   npx tsx scripts/revalidateCommunityRetryBacklog.ts --apply --triage-only --limit=600
 */
import { getDb } from '../server/db';
import {
  communityWorkSummary,
  materializeCommunityWorkForChannel,
} from '../server/communityAcquisitionWorkStore';

type Args = {
  apply: boolean;
  triageOnly: boolean;
  limit: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, triageOnly: false, limit: 5000 };
  for (const raw of argv) {
    if (raw === '--apply') args.apply = true;
    else if (raw === '--dry-run') args.apply = false;
    else if (raw === '--triage-only') args.triageOnly = true;
    else if (raw.startsWith('--limit=')) {
      const n = Number(raw.slice('--limit='.length));
      if (!Number.isSafeInteger(n) || n < 1 || n > 10_000) throw new Error('--limit must be 1..10000');
      args.limit = n;
    } else if (raw === '--help' || raw === '-h') {
      console.log('Usage: revalidateCommunityRetryBacklog.ts [--dry-run|--apply] [--triage-only] [--limit=N]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${raw}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = await getDb();
  const triageJoin = args.triageOnly
    ? `JOIN retry_backlog_triage t ON t.job_id=j.id AND t.bucket='QUARANTINE' AND t.undone_at IS NULL`
    : '';
  const jobs = await db.query(
    `SELECT j.id,j.payload->>'channelId' AS channel_id,j.attempts,j.first_enqueued_at,
            j.last_error
       FROM jobs j
       ${triageJoin}
      WHERE j.type='RETRY_COMMUNITY_ACQUISITION'
        AND j.status='PENDING'
        AND j.closed_at IS NULL
      ORDER BY j.first_enqueued_at ASC, j.id ASC
      LIMIT $1`,
    [args.limit],
  );

  const summary = {
    examined: 0,
    closedResolved: 0,
    leftActive: 0,
    leftParked: 0,
    skippedClaimed: 0,
    noLedgerRows: 0,
    dryRun: !args.apply,
  };

  for (const job of jobs.rows) {
    const jobId = String(job.id);
    const channelId = String(job.channel_id || '');
    if (!channelId) continue;
    summary.examined++;
    if (!args.apply) {
      // Dry-run uses the same projection materializer in a rolled-back
      // transaction so it reports exactly what apply would see without writing.
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await materializeCommunityWorkForChannel(channelId, { db: client });
        const work = await communityWorkSummary(channelId, client);
        if (work.total === 0) summary.noLedgerRows++;
        else if (work.active === 0 && work.parkedInfra + work.parkedExternal === 0) summary.closedResolved++;
        else if (work.active > 0) summary.leftActive++;
        else summary.leftParked++;
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      continue;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Lock the batch owner. If a worker claimed it after the initial scan,
      // skip it entirely; never touch its attempt. The job lock is sufficient
      // to serialize this channel because workers cannot claim a locked job.
      const locked = await client.query(
        `SELECT 1 FROM jobs
          WHERE id=$1 AND status='PENDING' AND closed_at IS NULL
          FOR UPDATE SKIP LOCKED`,
        [jobId],
      );
      if (!locked.rowCount) {
        await client.query('ROLLBACK');
        summary.skippedClaimed++;
        continue;
      }

      await materializeCommunityWorkForChannel(channelId, { db: client });
      const work = await communityWorkSummary(channelId, client);
      if (work.total === 0) {
        summary.noLedgerRows++;
        await client.query('ROLLBACK');
        continue;
      }
      if (work.active === 0 && work.parkedInfra + work.parkedExternal === 0) {
        const closed = await client.query(
          `UPDATE jobs
              SET status='COMPLETED',completed_at=now(),locked_by=NULL,locked_at=NULL,
                  terminal_failure_class=NULL,last_error=$2,updated_at=now(),
                  capacity_deferrals=0,capacity_wait_started_at=NULL,
                  parked_reason=NULL,parked_at=NULL,last_progress_at=now(),
                  closed_reason='LEDGER_ALL_TERMINAL',
                  closed_by='revalidateCommunityRetryBacklog',
                  closed_at=now(),
                  closed_evidence=$3::jsonb
            WHERE id=$1 AND status='PENDING' AND closed_at IS NULL
            RETURNING id`,
          [
            jobId,
            'Revalidated: all URL work resolved or exhausted',
            JSON.stringify({
              source: 'revalidateCommunityRetryBacklog',
              ledger: {
                total: work.total,
                pending: work.pending,
                running: work.running,
                parkedInfra: work.parkedInfra,
                parkedExternal: work.parkedExternal,
                resolved: work.resolved,
                exhausted: work.exhausted,
              },
            }),
          ],
        );
        if (!closed.rowCount) {
          await client.query('ROLLBACK');
          summary.skippedClaimed++;
          continue;
        }
        await client.query(
          `UPDATE job_attempts SET status='COMPLETED',finished_at=now()
            WHERE job_id=$1 AND finished_at IS NULL`,
          [jobId],
        );
        await client.query(
          `UPDATE retry_backlog_triage
              SET undone_at=now(),undone_by='revalidateCommunityRetryBacklog'
            WHERE job_id=$1 AND bucket='QUARANTINE' AND undone_at IS NULL`,
          [jobId],
        );
        await client.query('COMMIT');
        summary.closedResolved++;
      } else {
        // Revalidation found real work. Do not leave it behind the old
        // 30-day quarantine: both new and old work must keep progressing.
        if (work.active > 0 || work.parkedInfra + work.parkedExternal > 0) {
          await client.query(
            `UPDATE jobs SET run_after=now(),updated_at=now()
              WHERE id=$1 AND status='PENDING'`,
            [jobId],
          );
          await client.query(
            `UPDATE retry_backlog_triage
                SET undone_at=now(),undone_by='revalidateCommunityRetryBacklog'
              WHERE job_id=$1 AND bucket='QUARANTINE' AND undone_at IS NULL`,
            [jobId],
          );
        }
        await client.query('COMMIT');
        if (work.active > 0) summary.leftActive++;
        else summary.leftParked++;
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (typeof (db as any).end === 'function') await (db as any).end();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
