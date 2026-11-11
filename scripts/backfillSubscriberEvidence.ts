/**
 * Subscriber-evidence backfill for channels left NULL by the Phase-3
 * decoupling regression. Default is a read-only dry run, including real
 * provider attempts, so the failed-fetch volume is measured rather than
 * guessed. Use --apply to write evidence and audience outcomes.
 *
 * Usage:
 *   node --import tsx scripts/backfillSubscriberEvidence.ts [--apply]
 *     [--from-jobs-only] [--limit=N] [--offset=N] [--concurrency=N] [--public-concurrency=N]
 */
import { Pool } from 'pg';
import {
  getDb,
  rowToChannel,
  updateChannelSubscriberEvidence,
} from '../server/db';
import type { ChannelRecord } from '../src/types';
import {
  ensureSubscriberEvidence,
  applyChannelSubscriberEvidenceToCandidate,
  subscriberEvidenceCheckedAtFromChannel,
} from '../server/subscriberEvidence';
import { evaluateLowAudienceGate, parseSubscriberCountNumber, sanitizeSubscriberCountText } from '../server/lowAudienceGate';
import { fetchLiveYouTubeChannelData } from '../server/youtubePublicAbout';

type JobEvidenceRow = {
  channel_id: string;
  subscriber_count: string | null;
  subscriber_count_hidden: boolean;
  job_subscriber_count: string | null;
  job_subscriber_hidden: boolean | null;
};

type Outcome = 'KNOWN' | 'HIDDEN' | 'FAILED';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const fromJobsOnly = args.has('--from-jobs-only');
const limitArg = [...args].find(a => a.startsWith('--limit='));
const offsetArg = [...args].find(a => a.startsWith('--offset='));
const concurrencyArg = [...args].find(a => a.startsWith('--concurrency='));
const publicConcurrencyArg = [...args].find(a => a.startsWith('--public-concurrency='));
const limit = limitArg ? Math.max(1, Number(limitArg.slice('--limit='.length)) || 0) : 0;
const offset = offsetArg ? Math.max(0, Number(offsetArg.slice('--offset='.length)) || 0) : 0;
const concurrency = Math.min(32, Math.max(1, Number(concurrencyArg?.slice('--concurrency='.length) || 4)));
const publicConcurrency = Math.min(12, Math.max(1, Number(publicConcurrencyArg?.slice('--public-concurrency='.length) || 6)));

function makeLimiter(width: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= width) await new Promise<void>(resolve => queue.push(resolve));
    active += 1;
    try { return await task(); }
    finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}
const publicLimit = makeLimiter(publicConcurrency);
// Dry-run must not initialize the schema. Use a dedicated read-only pool so a
// measurement cannot auto-apply a migration as a side effect.
const scriptPool = apply ? null : new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? {rejectUnauthorized:false} : undefined,
  max: concurrency,
  application_name: 'subscriber-evidence-backfill-dry-run',
  options: '-c default_transaction_read_only=on',
});
async function scriptDb() { return scriptPool || await getDb(); }
async function loadChannel(channelId: string): Promise<ChannelRecord | null> {
  const db = await scriptDb();
  const res = await db.query('SELECT * FROM channels WHERE channel_id=$1', [channelId]);
  return res.rows[0] ? rowToChannel(res.rows[0]) : null;
}

const failedSamples: Array<{channelId: string; channelName: string; youtubeUrl: string}> = [];
const counters = {
  totalMissing: 0,
  recoveredFromJobs: 0,
  jobKnown: 0,
  jobHidden: 0,
  fetchedKnown: 0,
  fetchedHidden: 0,
  fetchFailed: 0,
  knownUnder30: 0,
  markedLow: 0,
  failedTerminalized: 0,
  skippedTerminal: 0,
};

function log(event: string, payload: Record<string, unknown> = {}) {
  console.log(JSON.stringify({event, ...payload}));
}

async function lowAudienceEligible(channel: ChannelRecord, count: string, hidden: boolean): Promise<boolean> {
  if (hidden || channel.subscriber_count_hidden === true) return false;
  if (channel.country_status === 'REJECTED') return false;
  if (channel.trading_status === 'NON_TRADING') return false;
  if (channel.trading_status === 'TRADING_CONFIRMED') return false;
  return evaluateLowAudienceGate(count, 30, false).shouldSkipDeepEnrichment;
}

async function markLow(channel: ChannelRecord, count: string) {
  const db = await scriptDb();
  const now = new Date().toISOString();
  await db.query(
    `UPDATE channels
        SET scan_status='SKIPPED_LOW_AUDIENCE',
            subscriber_count=$2,
            subscriber_count_hidden=false,
            last_checked=$3,
            updated_at=now(),
            inspection_trail=inspection_trail || $4::jsonb
      WHERE channel_id=$1`,
    [channel.channel_id, count, now, JSON.stringify([{
      step: 'BIO',
      title: 'Low-Audience Budget Gate',
      status: 'SKIPPED',
      details: `Subscribers: ${count} (< 30). Stored and skipped deep enrichment (backfill).`,
      timestamp: now,
    }])],
  );
}

async function markFailed(channel: ChannelRecord, attempts: number) {
  const db = await scriptDb();
  const now = new Date().toISOString();
  await db.query(
    `UPDATE channels
        SET scan_status='FAILED_PERMANENT',
            last_checked=$2,
            updated_at=now(),
            inspection_trail=inspection_trail || $3::jsonb
      WHERE channel_id=$1`,
    [channel.channel_id, now, JSON.stringify([{
      step: 'BIO',
      title: 'Audience evidence unavailable',
      status: 'ERROR',
      details: `Subscriber count could not be fetched after ${attempts} attempt(s); channel held out of normal processing (backfill).`,
      timestamp: now,
    }])],
  );
}

async function applyEvidence(channel: ChannelRecord, count: string | undefined, hidden: boolean, attempts: number): Promise<Outcome> {
  if (hidden) {
    if (apply) await updateChannelSubscriberEvidence(channel.channel_id, { hidden: true });
    counters.fetchedHidden += 1;
    return 'HIDDEN';
  }
  const safe = sanitizeSubscriberCountText(count);
  if (safe !== undefined) {
    if (apply) {
      await updateChannelSubscriberEvidence(channel.channel_id, { subscriberCount: safe });
      if (await lowAudienceEligible(channel, safe, false)) {
        await markLow(channel, safe);
        counters.markedLow += 1;
      }
    }
    if (parseSubscriberCountNumber(safe)! < 30) counters.knownUnder30 += 1;
    counters.fetchedKnown += 1;
    return 'KNOWN';
  }
  counters.fetchFailed += 1;
  if (failedSamples.length < 50) {
    failedSamples.push({channelId: channel.channel_id, channelName: channel.channel_name, youtubeUrl: channel.youtube_url});
  }
  if (apply) {
    const terminal = channel.trading_status === 'TRADING_CONFIRMED'
      || channel.scan_status === 'COMPLETED'
      || channel.scan_status === 'SKIPPED_LOW_AUDIENCE'
      || channel.country_status === 'REJECTED';
    if (terminal) {
      counters.skippedTerminal += 1;
      const db = await scriptDb();
      const now = new Date().toISOString();
      await db.query(
        `UPDATE channels SET updated_at=now(), inspection_trail=inspection_trail || $2::jsonb WHERE channel_id=$1`,
        [channel.channel_id, JSON.stringify([{
          step: 'BIO',
          title: 'Audience evidence unavailable',
          status: 'ERROR',
          details: `Subscriber count could not be fetched after ${attempts} attempt(s); terminal decision preserved (backfill).`,
          timestamp: now,
        }])],
      );
    } else {
      await markFailed(channel, attempts);
      counters.failedTerminalized += 1;
    }
  }
  return 'FAILED';
}

async function loadJobEvidence(): Promise<JobEvidenceRow[]> {
  const db = await scriptDb();
  // Dry-run is allowed before migration 181 is applied to production.
  const hiddenColumn = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='channels' AND column_name='subscriber_count_hidden'`,
  );
  const hiddenExpr = hiddenColumn.rowCount ? 'c.subscriber_count_hidden' : 'false';
  const res = await db.query(`
    SELECT c.channel_id,c.subscriber_count,${hiddenExpr} AS subscriber_count_hidden,
      e.job_subscriber_count,e.job_subscriber_hidden
    FROM channels c
    LEFT JOIN LATERAL (
      SELECT
        j.payload->'candidate'->>'subscriberCount' AS job_subscriber_count,
        CASE
          WHEN lower(coalesce(j.payload->'candidate'->>'subscriberCountHidden','')) = 'true' THEN true
          WHEN lower(coalesce(j.payload->'candidate'->>'subscriberCountHidden','')) = 'false' THEN false
          ELSE NULL
        END AS job_subscriber_hidden
      FROM jobs j
      WHERE j.payload->>'channelId'=c.channel_id
        AND (j.payload->'candidate' ? 'subscriberCount' OR j.payload->'candidate' ? 'subscriberCountHidden')
      ORDER BY (j.payload->'candidate'->>'subscriberCount') IS NOT NULL DESC, j.created_at DESC
      LIMIT 1
    ) e ON true
    WHERE c.subscriber_count IS NULL OR btrim(c.subscriber_count)=''
    ORDER BY c.first_seen, c.channel_id
    ${limit ? 'LIMIT ' + limit : ''}
  `);
  return res.rows;
}

async function runPool<T>(items: T[], width: number, worker: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const runners = Array.from({length: Math.min(width, items.length || 1)}, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const rows = await loadJobEvidence();
  counters.totalMissing = rows.length;
  log('backfill_start', {
    mode: apply ? 'APPLY' : 'DRY_RUN',
    missing: rows.length,
    concurrency,
    publicConcurrency,
    fromJobsOnly,
  });

  let remaining: JobEvidenceRow[] = [];
  for (const row of rows) {
    const jobCount = sanitizeSubscriberCountText(row.job_subscriber_count);
    if (row.subscriber_count_hidden === true || row.job_subscriber_hidden === true) {
      counters.recoveredFromJobs += 1;
      counters.jobHidden += 1;
      if (apply) await updateChannelSubscriberEvidence(row.channel_id, { hidden: true });
      continue;
    }
    if (jobCount !== undefined) {
      counters.recoveredFromJobs += 1;
      counters.jobKnown += 1;
      if (parseSubscriberCountNumber(jobCount)! < 30) counters.knownUnder30 += 1;
      if (apply) {
        const channel = await loadChannel(row.channel_id);
        if (channel) {
          await updateChannelSubscriberEvidence(row.channel_id, { subscriberCount: jobCount });
          if (await lowAudienceEligible(channel, jobCount, false)) {
            await markLow(channel, jobCount);
            counters.markedLow += 1;
          }
        }
      }
      continue;
    }
    remaining.push(row);
  }

  log('job_payload_phase_complete', {
    recoveredFromJobs: counters.recoveredFromJobs,
    known: counters.jobKnown,
    hidden: counters.jobHidden,
    remaining: remaining.length,
    knownUnder30: counters.knownUnder30,
  });

  if (offset > 0) {
    const skipped = Math.min(offset, remaining.length);
    remaining = remaining.slice(skipped);
    log('resume_offset', {offset, skipped, remaining: remaining.length});
  }

  if (fromJobsOnly) {
    log('backfill_summary', {...counters, mode: apply ? 'APPLY' : 'DRY_RUN'});
    if (scriptPool) await scriptPool.end();
    return;
  }

  let processed = 0;
  await runPool(remaining, concurrency, async (row) => {
    const channel = await loadChannel(row.channel_id);
    if (!channel) return;
    const candidate = applyChannelSubscriberEvidenceToCandidate({
      channelId: channel.channel_id,
      channelName: channel.channel_name,
      youtubeUrl: channel.youtube_url,
      description: '',
      videoTitles: [],
      channelLinks: [],
      subscriberCount: channel.subscriber_count,
      subscriberCountHidden: channel.subscriber_count_hidden === true,
      subscriberCountCheckedAt: subscriberEvidenceCheckedAtFromChannel(channel),
      countryMetadataStatus: channel.country_metadata_status,
      countryMetadataCheckedAt: channel.country_metadata_checked_at || undefined,
    }, channel);
    const resolved = await ensureSubscriberEvidence(candidate, {
      allowPublicFallback: true,
      fetchPublic: (url) => publicLimit(() => fetchLiveYouTubeChannelData(url)),
    });
    await applyEvidence(channel, resolved.candidate.subscriberCount, resolved.candidate.subscriberCountHidden === true, resolved.attempts);
    processed += 1;
    if (processed % 25 === 0) log('progress', {processed, remaining: remaining.length, ...counters});
  });

  log('backfill_summary', {...counters, failedSamples, mode: apply ? 'APPLY' : 'DRY_RUN'});
  if (scriptPool) await scriptPool.end();
}

main().catch(async error => {
  console.error(error);
  if (scriptPool) await scriptPool.end().catch(() => undefined);
  process.exitCode = 1;
});
