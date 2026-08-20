import type { ChannelRecord } from '../src/types';
import type { DiscoveredChannelRaw } from './youtube';

export interface CommunityRecoveryReactivationReason {
  reactivate: boolean;
  reasonCodes: string[];
}

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

  // FAILED is the canonical operational state. Legacy FAILED_PERMANENT is
  // recoverable only when it carries operational/unknown validation evidence;
  // an explicitly completed semantic terminal decision is not resurrected.
  if(channel.scan_status==='FAILED_PERMANENT'&&channel.discord_validation_status==='COMPLETED'){
    return {reactivate:false,reasonCodes:['SEMANTIC_TERMINAL_EVIDENCE_PRESERVED']};
  }

  const reasons: string[] = [];

  if (isManualRecheck) {
    reasons.push('OPERATOR_NOMINATED_RECHECK');
  }

  if (candidate?.channelLinks && candidate.channelLinks.length > 0) {
    reasons.push('NEWLY_OBSERVED_EXTERNAL_LINKS');
  }

  if (channel.activity_band === 'VERY_ACTIVE' || channel.activity_band === 'ACTIVE') {
    reasons.push('HIGH_CREATOR_ACTIVITY');
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

export async function reconcileCommunityAcquisitionRecovery(
  getDb: () => Promise<any>,
  getChannelById: (id: string) => Promise<ChannelRecord | null>,
  upsertChannel: (channel: ChannelRecord) => Promise<void>,
  limit = 20,
  now = Date.now()
): Promise<number> {
  if (now - lastCommunityRecoveryReconciliationAt < 60_000) return 0;
  lastCommunityRecoveryReconciliationAt = now;

  const db = await getDb();
  const rows = await db.query(
    `SELECT c.channel_id FROM channels c WHERE c.scan_status IN('FAILED','FAILED_PERMANENT') AND c.discord_validation_status <> 'COMPLETED' AND (c.last_checked IS NULL OR c.last_checked < now() - interval '30 days') ORDER BY c.last_checked ASC LIMIT $1`,
    [Math.min(100, Math.max(1, limit))]
  );

  let reactivatedCount = 0;
  for (const row of rows.rows) {
    const channelRecord = await getChannelById(row.channel_id);
    if (!channelRecord) continue;
    const triggerCheck = shouldReactivateCommunityRecovery(channelRecord, undefined, false, now);
    if (triggerCheck.reactivate) {
      const updated = reactivateCommunityRecovery(channelRecord, triggerCheck.reasonCodes, new Date(now).toISOString());
      await upsertChannel(updated);
      reactivatedCount++;
    }
  }
  return reactivatedCount;
}
