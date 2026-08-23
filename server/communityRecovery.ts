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

  // FAILED is the canonical operational state. Legacy FAILED_PERMANENT is
  // recoverable only when it carries operational/unknown validation evidence;
  // an explicitly completed semantic terminal decision is not resurrected.
  if (channel.scan_status === 'FAILED_PERMANENT' && channel.discord_validation_status === 'COMPLETED') {
    return { reactivate: false, reasonCodes: ['SEMANTIC_TERMINAL_EVIDENCE_PRESERVED'] };
  }

  const reasons: string[] = [];

  if (isManualRecheck) {
    reasons.push('OPERATOR_NOMINATED_RECHECK');
  }

  if (candidate?.channelLinks && candidate.channelLinks.length > 0) {
    reasons.push('NEWLY_OBSERVED_EXTERNAL_LINKS');
  }

  if (channel.activity_band === 'VERY_ACTIVE' || channel.activity_band === 'ACTIVE') {
    const ageSinceLastCheckedMs = channel.last_checked ? now - Date.parse(channel.last_checked) : Number.POSITIVE_INFINITY;
    if (ageSinceLastCheckedMs >= COMMUNITY_ACTIVE_RECOVERY_COOLDOWN_MS) {
      reasons.push('HIGH_CREATOR_ACTIVITY');
    }
  }

  if (channel.last_checked) {
    const ageDays = (now - Date.parse(channel.last_checked)) / 86_400_000;
    if (ageDays >= 30) {
      reasons.push('COMMUNITY_FRESHNESS_INTERVAL_EXPIRED');
    }
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
 * retry window for each selected channel. The existing job idempotency key is
 * deliberately reused: enqueueJob reopens only a terminal job, resets that
 * job's current attempt window, and cannot duplicate an active PENDING or
 * PROCESSING owner. Semantic terminal channels are excluded in SQL and again
 * by shouldReactivateCommunityRecovery.
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
  const rows = await db.query(
    `SELECT c.channel_id FROM channels c
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
        )
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.type='RETRY_COMMUNITY_ACQUISITION'
             AND j.payload->>'channelId'=c.channel_id
             AND j.status IN('PENDING','PROCESSING')
        )
      ORDER BY c.last_checked ASC NULLS FIRST
      LIMIT $1`,
    [Math.min(100, Math.max(1, limit))]
  );

  let reactivatedCount = 0;
  for (const row of rows.rows) {
    const channelRecord = await getChannelById(row.channel_id);
    if (!channelRecord) continue;
    const triggerCheck = shouldReactivateCommunityRecovery(channelRecord, undefined, false, now);
    if (!triggerCheck.reactivate) continue;

    const updated = reactivateCommunityRecovery(channelRecord, triggerCheck.reasonCodes, new Date(now).toISOString());
    await upsertChannel(updated);
    try {
      // Persist the operational projection before reopening work so a worker
      // cannot complete the new job and then be overwritten by this function.
      // If enqueue fails, restore the prior failure projection and let the next
      // reconciliation tick retry the complete recovery operation.
      if (enqueueRecoveryJob) await enqueueRecoveryJob(channelRecord.channel_id);
    } catch (error) {
      await upsertChannel(channelRecord);
      throw error;
    }
    reactivatedCount++;
  }
  return reactivatedCount;
}
