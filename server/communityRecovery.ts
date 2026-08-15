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
  if (channel.scan_status !== 'FAILED_PERMANENT') {
    return { reactivate: false, reasonCodes: ['SCAN_STATUS_NOT_FAILED_PERMANENT'] };
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
        details: `Reactivated from FAILED_PERMANENT: ${reasonCodes.join(', ')}`,
        timestamp: now
      }
    ]
  };
}
