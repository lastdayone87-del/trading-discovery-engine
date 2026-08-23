import type { ChannelRecord } from '../src/types';
import type { DiscoveredChannelRaw } from './youtube';

export interface CommunityRecoveryReactivationReason {
  reactivate: boolean;
  reasonCodes: string[];
}

export type EnqueueCommunityRecoveryJob = (channelId: string) => Promise<void>;

// High-activity recovery is intentionally more frequent than the 30-day
// freshness trigger, but it must not reopen a terminal retry window on every
// worker tick after an attempt-free or exhausted failure. The channel's
// last_checked timestamp is advanced by the failure projection, so this
// cooldown is durable without adding a schema field.
export const COMMUNITY_ACTIVE_RECOVERY_COOLDOWN_MS = 24 * 60 * 60_000;

// The generic job failure policy has a six-hour transient-age ceiling based on
// jobs.created_at. Capacity deferrals are intentionally attempt-free, so they
// must not age into a terminal result merely because provider capacity stayed
// unavailable. Renew the retry epoch before that generic ceiling while
// preserving normal run_after backoff and durable execution history.
export const COMMUNITY_CAPACITY_RETRY_LEASE_MS = 5 * 60 * 60_000;
const COMMUNITY_CAPACITY_DEFERRED_PREFIX = 'Community acquisition deferred:';
const COMMUNITY_CAPACITY_TERMINAL_PREFIX = 'OPERATIONALLY_BLOCKED_RETRY_REQUIRED: Community acquisition deferred:';
const ENRICHMENT_CAPACITY_ERROR_FRAGMENT = 'ENRICHMENT YouTube quota allocation is exhausted';

/**
 * FAILED_PERMANENT records operational retry exhaustion history for a specific
 * historical attempt. It is never a permanent claim that a creator will never
 * have a Discord or community link. Fresh evidence or activity safely reactivates
 * community acquisition.
 */
export function shouldReactivateCommunityRecovery(
  channel: ChannelRecord,
  candidate?: DiscoveredChannelRaw,
  isManualRecheck = false,
  now = Date.now()
): CommunityRecoveryReactivationReason {
  if (channel.scan_status !== 'FAILED_PERMANENT' && channel.scan_status !== 'FAILED') {
    return { reactivate: false, reasonCodes: ['SCAN_STATUS_NOT_RECOVERABLE_FAILURE'] };
  }

  if (channel.country_status === 'REJECTED' || channel.trading_status === 'NON_TRADING' || channel.trading_status === 'HUMAN_REJECTED') {
    return { reactivate: false, reasonCodes: ['SEMANTIC_TERMINAL_STATE_PRESERVED'] };
  }

  if (channel.scan_status === 'FAILED_PERMANENT' && channel.discord_validation_status === 'COMPLETED') {
    return { reactivate: false, reasonCodes: ['SEMANTIC_TERMINAL_EVIDENCE_PRESERVED'] };
  }

  const reasons: string[] = [];

  if (isManualRecheck) reasons.push('OPERATOR_NOMINATED_RECHECK');
  if (candidate?.channelLinks && candidate.channelLinks.length > 0) reasons.push('NEWLY_OBSERVED_EXTERNAL_LINKS');

  if (channel.activity_band === 'VERY_ACTIVE' || channel.activity_band === 'ACTIVE') {
    const ageSinceLastCheckedMs = channel.last_checked ? now - Date.parse(channel.last_checked) : Number.POSITIVE_INFINITY;
    if (ageSinceLastCheckedMs >= COMMUNITY_ACTIVE_RECOVERY_COOLDOWN_MS) reasons.push('HIGH_CREATOR_ACTIVITY');
  }

  if (channel.last_checked) {
    const ageDays = (now - Date.parse(channel.last_checked)) / 86_400_000;
    if (ageDays >= 30) reasons.push('COMMUNITY_FRESHNESS_INTERVAL_EXPIRED');
  } else {
    reasons.push('NO_PRIOR_CHECK_TIMESTAMP');
  }

  return {
    reactivate: reasons.length > 0,
    reasonCodes: reasons.length > 0 ? reasons : ['NO_REACTIVATION_TRIGGER_MATCHED']
  };
}

export function reactivateCommunityRecovery(
  channel: ChannelRecord,
  reasonCodes: string[],
  now = new Date().toISOString()
): ChannelRecord {
  return {
    ...channel,
    scan_status: 'ENRICHMENT_PENDING',
    discord_status: 'UNCERTAIN',
    discord_validation_status: 'RETRY_PENDING',
    last_checked: now,
    inspection_trail: [
      ...(channel.inspection_trail || []),
      {
        step: 'BIO',
        title: 'Community Acquisition Reactivated',
        status: 'FOUND',
        details: `Reactivated from recoverable operational failure: ${reasonCodes.join(', ')}`,
        timestamp: now
      }
    ]
  };
}

let lastCommunityRecoveryReconciliationAt = 0;

/**
 * Reactivates operational community failures and reopens exactly one durable
 * retry window for each selected channel. It also repairs the adjacent generic
 * enrichment-capacity case: ENRICH_CHANNEL quota deferrals are attempt-free,
 * so the generic six-hour job-age ceiling must not turn them into channel
 * failures. This reconciliation renews active capacity-only retry epochs and
 * reopens only terminal enrichment jobs whose persisted error proves quota
 * capacity was the cause.
 */
export async function reconcileCommunityAcquisitionRecovery(
  getDb: () => Promise<any>,
  getChannelById: (id: string) => Promise<ChannelRecord | null>,
  upsertChannel: (channel: ChannelRecord) => Promise<void>,
  limit = 20,
  now = Date.now(),
  enqueueRecoveryJob?: EnqueueCommunityRecoveryJob
): Promise<number> {
  if (now - lastCommunityRecoveryReconciliationAt < 60_000) return 0;
  lastCommunityRecoveryReconciliationAt = now;

  const db = await getDb();

  // Keep active community capacity deferrals younger than the generic transient
  // age ceiling. This does not change run_after, attempts, or attempt history.
  await db.query(
    `UPDATE jobs
        SET created_at=now(), updated_at=now()
      WHERE type='RETRY_COMMUNITY_ACQUISITION'
        AND status IN('PENDING','PROCESSING')
        AND last_error LIKE $1
        AND created_at < now() - ($2 || ' milliseconds')::interval`,
    [`${COMMUNITY_CAPACITY_DEFERRED_PREFIX}%`, String(COMMUNITY_CAPACITY_RETRY_LEASE_MS)]
  );

  // ENRICH_CHANNEL uses the same attempt-free quota signal. Prevent an old
  // pending enrichment job from becoming terminal merely because it waited for
  // the next quota window longer than the generic six-hour age ceiling.
  await db.query(
    `UPDATE jobs
        SET created_at=now(), updated_at=now()
      WHERE type='ENRICH_CHANNEL'
        AND status IN('PENDING','PROCESSING')
        AND last_error LIKE $1
        AND created_at < now() - ($2 || ' milliseconds')::interval`,
    [`%${ENRICHMENT_CAPACITY_ERROR_FRAGMENT}%`, String(COMMUNITY_CAPACITY_RETRY_LEASE_MS)]
  );

  // Repair historical/current enrichment rows already terminalized solely by
  // quota capacity. The job remains the same durable owner; its retry epoch is
  // renewed, the claim increment is undone because the failure was attempt-free,
  // and the channel projection returns to ENRICHMENT_PENDING. Semantic terminal
  // channels are deliberately excluded.
  await db.query(
    `WITH recovered AS (
       UPDATE jobs j
          SET status='PENDING',
              attempts=GREATEST(0,j.attempts-1),
              created_at=now(),
              updated_at=now(),
              locked_by=NULL,
              locked_at=NULL,
              completed_at=NULL
        WHERE j.type='ENRICH_CHANNEL'
          AND j.status='FAILED'
          AND j.last_error LIKE $1
        RETURNING j.payload->>'channelId' AS channel_id
     )
     UPDATE channels c
        SET scan_status='ENRICHMENT_PENDING',updated_at=now()
       FROM recovered r
      WHERE c.channel_id=r.channel_id
        AND c.scan_status='FAILED'
        AND c.country_status <> 'REJECTED'
        AND c.trading_status NOT IN('NON_TRADING','HUMAN_REJECTED')`,
    [`OPERATIONALLY_BLOCKED_RETRY_REQUIRED:%${ENRICHMENT_CAPACITY_ERROR_FRAGMENT}%`]
  );

  const rows = await db.query(
    `SELECT c.channel_id,
            retry_job.id AS capacity_retry_job_id,
            COALESCE(
              retry_job.status='FAILED'
              AND retry_job.last_error LIKE $2,
              false
            ) AS capacity_terminal
       FROM channels c
       LEFT JOIN LATERAL (
         SELECT j.id,j.status,j.last_error
           FROM jobs j
          WHERE j.type='RETRY_COMMUNITY_ACQUISITION'
            AND j.payload->>'channelId'=c.channel_id
          ORDER BY j.created_at DESC
          LIMIT 1
       ) retry_job ON true
      WHERE c.scan_status IN('FAILED','FAILED_PERMANENT')
        AND c.discord_validation_status <> 'COMPLETED'
        AND c.trading_status NOT IN('NON_TRADING','HUMAN_REJECTED')
        AND c.country_status <> 'REJECTED'
        AND (
          c.last_checked IS NULL
          OR c.last_checked < now() - interval '30 days'
          OR (
            c.activity_band IN('ACTIVE','VERY_ACTIVE')
            AND c.last_checked < now() - interval '24 hours'
          )
          OR (
            retry_job.status='FAILED'
            AND retry_job.last_error LIKE $2
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.type='RETRY_COMMUNITY_ACQUISITION'
             AND j.payload->>'channelId'=c.channel_id
             AND j.status IN('PENDING','PROCESSING')
        )
      ORDER BY (retry_job.status='FAILED' AND retry_job.last_error LIKE $2) DESC,
               c.last_checked ASC NULLS FIRST
      LIMIT $1`,
    [Math.min(100, Math.max(1, limit)), `${COMMUNITY_CAPACITY_TERMINAL_PREFIX}%`]
  );

  let reactivatedCount = 0;
  for (const row of rows.rows) {
    const channelRecord = await getChannelById(row.channel_id);
    if (!channelRecord) continue;
    const capacityTerminal = row.capacity_terminal === true;
    const triggerCheck = capacityTerminal
      ? { reactivate: true, reasonCodes: ['ATTEMPT_FREE_CAPACITY_RETRY_REOPENED'] }
      : shouldReactivateCommunityRecovery(channelRecord, undefined, false, now);
    if (!triggerCheck.reactivate) continue;

    const updated = reactivateCommunityRecovery(channelRecord, triggerCheck.reasonCodes, new Date(now).toISOString());
    await upsertChannel(updated);
    try {
      if (capacityTerminal && row.capacity_retry_job_id) {
        await db.query(
          `UPDATE jobs SET created_at=now(),updated_at=now() WHERE id=$1 AND status='FAILED'`,
          [row.capacity_retry_job_id]
        );
      }
      if (enqueueRecoveryJob) await enqueueRecoveryJob(channelRecord.channel_id);
    } catch (error) {
      await upsertChannel(channelRecord);
      throw error;
    }
    reactivatedCount++;
  }
  return reactivatedCount;
}
