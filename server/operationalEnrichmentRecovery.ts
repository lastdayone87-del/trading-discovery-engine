import type { ChannelRecord } from '../src/types';

export const OPERATIONAL_ENRICHMENT_RECOVERY_COOLDOWN_MS = 24 * 60 * 60_000;

type RecoveryChannel = Pick<ChannelRecord,
  'channel_id' | 'scan_status' | 'trading_status' | 'country_status' | 'discord_validation_status' | 'last_checked'
>;

export interface OperationalEnrichmentRecoveryDecision {
  reactivate: boolean;
  reasonCodes: string[];
}

/**
 * ENRICH_CHANNEL operational failures are machine-owned only. Recovery never
 * reopens a negative semantic/human terminal decision and waits for a durable
 * cooldown after the last failed projection. A positive trading decision is
 * preserved while the independent operational enrichment work is recovered.
 */
export function shouldReactivateOperationalEnrichment(
  channel: RecoveryChannel,
  now = Date.now()
): OperationalEnrichmentRecoveryDecision {
  if (channel.scan_status !== 'FAILED' && channel.scan_status !== 'FAILED_PERMANENT') {
    return { reactivate: false, reasonCodes: ['SCAN_STATUS_NOT_RECOVERABLE_FAILURE'] };
  }
  if (
    channel.country_status === 'REJECTED' ||
    channel.trading_status === 'NON_TRADING' ||
    channel.trading_status === 'HUMAN_REJECTED'
  ) {
    return { reactivate: false, reasonCodes: ['SEMANTIC_OR_HUMAN_DECISION_PRESERVED'] };
  }
  if (channel.discord_validation_status === 'COMPLETED') {
    return { reactivate: false, reasonCodes: ['COMPLETED_DISCORD_OUTCOME_PRESERVED'] };
  }
  const ageMs = channel.last_checked ? now - Date.parse(channel.last_checked) : Number.POSITIVE_INFINITY;
  if (ageMs < OPERATIONAL_ENRICHMENT_RECOVERY_COOLDOWN_MS) {
    return { reactivate: false, reasonCodes: ['OPERATIONAL_RECOVERY_COOLDOWN_ACTIVE'] };
  }
  return {
    reactivate: true,
    reasonCodes: ['OPERATIONALLY_BLOCKED_ENRICHMENT_FAILURE', 'OPERATIONAL_RECOVERY_COOLDOWN_EXPIRED']
  };
}

export function reactivateOperationalEnrichment(
  channel: ChannelRecord,
  reasonCodes: string[],
  now = new Date().toISOString()
): ChannelRecord {
  void reasonCodes;
  return {
    ...channel,
    scan_status: 'ENRICHMENT_PENDING',
    last_checked: now
  };
}

let lastOperationalEnrichmentReconciliationAt = 0;

export type EnqueueOperationalEnrichmentRecovery = (channel: ChannelRecord, reasonCodes: string[]) => Promise<void>;

export async function reconcileOperationalEnrichmentRecovery(
  getDb: () => Promise<any>,
  getChannelById: (id: string) => Promise<ChannelRecord | null>,
  upsertChannel: (channel: ChannelRecord) => Promise<void>,
  enqueueRecoveryJob: EnqueueOperationalEnrichmentRecovery,
  limit = 20,
  now = Date.now()
): Promise<number> {
  if (now - lastOperationalEnrichmentReconciliationAt < 60_000) return 0;
  lastOperationalEnrichmentReconciliationAt = now;
  const db = await getDb();
  const rows = await db.query(
    `SELECT c.channel_id
       FROM channels c
      WHERE c.scan_status IN('FAILED','FAILED_PERMANENT')
        AND c.trading_status IS DISTINCT FROM 'NON_TRADING'
        AND c.trading_status IS DISTINCT FROM 'HUMAN_REJECTED'
        AND c.discord_validation_status IS DISTINCT FROM 'COMPLETED'
        AND c.country_status IS DISTINCT FROM 'REJECTED'
        AND (c.last_checked IS NULL OR c.last_checked < now() - interval '24 hours')
        AND EXISTS (
          SELECT 1 FROM jobs failed_job
           WHERE failed_job.type='ENRICH_CHANNEL'
             AND failed_job.status='FAILED'
             AND failed_job.last_error ILIKE 'OPERATIONALLY_BLOCKED_RETRY_REQUIRED:%'
             AND failed_job.payload->>'channelId'=c.channel_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM jobs active_job
           WHERE active_job.type IN('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','RETRY_COMMUNITY_ACQUISITION')
             AND active_job.status IN('PENDING','PROCESSING')
             AND active_job.payload->>'channelId'=c.channel_id
        )
      ORDER BY c.last_checked ASC NULLS FIRST
      LIMIT $1`,
    [Math.min(100, Math.max(1, limit))]
  );
  let reconciled = 0;
  for (const row of rows.rows) {
    const channel = await getChannelById(row.channel_id);
    if (!channel) continue;
    const decision = shouldReactivateOperationalEnrichment(channel, now);
    if (!decision.reactivate) continue;
    const updated = reactivateOperationalEnrichment(channel, decision.reasonCodes, new Date(now).toISOString());
    await upsertChannel(updated);
    try {
      await enqueueRecoveryJob(updated, decision.reasonCodes);
    } catch (error) {
      await upsertChannel(channel);
      throw error;
    }
    reconciled++;
  }
  return reconciled;
}
