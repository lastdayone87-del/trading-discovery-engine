import type { ChannelRecord } from '../src/types';
import type { DiscoveredChannelRaw } from './youtube';

export interface CommunityRecoveryReactivationReason {
  reactivate: boolean;
  reasonCodes: string[];
}

export type EnqueueCommunityRecoveryJob = (channelId: string, retryReason?: string) => Promise<void>;

const COMMUNITY_RETRY_SURFACES = new Set([
  'CHANNEL_LINKS', 'CHANNEL_EXTERNAL_LINKS', 'EXTERNAL_LINKS', 'LINKED_WEBSITES', 'CUSTOM_DOMAINS',
  'SOCIAL_PROFILES', 'SOCIAL_BIO'
]);

export type LegacyCommunityRetryDisposition =
  | 'ACTIVE_COMMUNITY_RETRY'
  | 'COMPLETED_NEGATIVE';

export interface LegacyCommunityRetryDispositionInput {
  payload?: Record<string, unknown>;
  inspectionTrail?: Array<{ step?: string; status?: string }>;
  hasCurrentCommunityRetryableFailure: boolean;
  hasCurrentUpstreamRetryableFailure: boolean;
}

export interface LegacyCommunityRetryDispositionResult {
  disposition: LegacyCommunityRetryDisposition;
  retryReason: 'NO_SURFACE' | 'BROWSER_RUNTIME_UNAVAILABLE' | 'UPSTREAM_REQUIRED_ACQUISITION_FAILURE' | 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE';
  reconciliationReason?: string;
}
export function classifyLegacyCommunityRetryDisposition(input: LegacyCommunityRetryDispositionInput): LegacyCommunityRetryDispositionResult {
  const trail = input.inspectionTrail || [];
  if (input.hasCurrentCommunityRetryableFailure) {
    return {
      disposition: 'ACTIVE_COMMUNITY_RETRY',
      retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE'
    };
  }
  // The historical contract is negative once the Discord/community surfaces
  // have completed without a match. Upstream YouTube failures must not outrank
  // that result or create Discord ownership.
  const hasInspectedCommunitySurface = trail.some(step =>
    COMMUNITY_RETRY_SURFACES.has(String(step.step || '')) &&
    ['FOUND', 'NOT_FOUND', 'SKIPPED', 'COMPLETED'].includes(String(step.status || ''))
  );
  if (!hasInspectedCommunitySurface && String(input.payload?.retryReason || '') === 'BROWSER_RUNTIME_UNAVAILABLE') {
    return {
      disposition: 'ACTIVE_COMMUNITY_RETRY',
      retryReason: 'BROWSER_RUNTIME_UNAVAILABLE',
      reconciliationReason: 'Browser runtime remains unavailable; preserve the bounded attempt-free operational retry.'
    };
  }
  return {
    disposition: 'COMPLETED_NEGATIVE',
    retryReason: 'NO_SURFACE',
    reconciliationReason: hasInspectedCommunitySurface
      ? 'Latest inspection completed without a Discord/community match or current retryable acquisition failure.'
      : 'No current Discord/community retryable acquisition failure was found; restore the historical completed negative.'
  };
}

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

export function projectTerminalCommunityRetryFailure(
  channel: ChannelRecord,
  attempts: number,
  now = new Date().toISOString()
): ChannelRecord {
  const preservesSemanticCompletion = channel.discord_validation_status === 'COMPLETED' || channel.discord_validation_status === 'SUCCEEDED';
  return {
    ...channel,
    scan_status: channel.scan_status === 'FAILED_PERMANENT' ? 'FAILED_PERMANENT' : 'FAILED',
    discord_validation_status: preservesSemanticCompletion ? channel.discord_validation_status : 'FAILED_OPERATIONAL',
    scan_attempts: Math.max(channel.scan_attempts || 0, attempts),
    last_checked: now
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

export async function reconcileLegacyCommunityRetryOwnership(
  getDb: () => Promise<any>,
  limit = 250,
  now = new Date().toISOString()
): Promise<{ examined: number; completedNegative: number; closedNonCommunity: number; activeCommunity: number }> {
  const db = await getDb();
  const result = await db.query(
    `SELECT j.id,j.status,j.payload,c.channel_id,c.scan_status,c.discord_status,c.discord_validation_status,c.inspection_trail,
            EXISTS(
              SELECT 1 FROM (
                SELECT DISTINCT ON (o.provenance->>'surface',lower(rtrim(COALESCE(o.requested_url,''),'/')))
                       o.provenance->>'surface' AS surface,o.outcome,o.retryable,COALESCE(o.provenance->>'required','false') AS required
                  FROM external_acquisition_observations o
                 WHERE o.channel_id=c.channel_id
                   AND o.observed_at >= COALESCE(c.last_checked,now()) - interval '5 minutes'
                   AND o.observed_at <= COALESCE(c.last_checked,now()) + interval '5 minutes'
                 ORDER BY o.provenance->>'surface',lower(rtrim(COALESCE(o.requested_url,''),'/')),
                          CASE o.outcome WHEN 'FOUND' THEN 3 WHEN 'INSPECTED_NO_MATCH' THEN 2 WHEN 'PARTIALLY_INSPECTED' THEN 1 ELSE 0 END DESC,
                          o.observed_at DESC
              ) effective
             WHERE effective.required='true'
               AND effective.outcome='ACQUISITION_FAILED'
               AND effective.retryable=true
               AND effective.surface IN('CHANNEL_EXTERNAL_LINKS','CREATOR_WEBSITES','SOCIAL_PROFILES','CHANNEL_LINKS','EXTERNAL_LINKS','LINKED_WEBSITES','CUSTOM_DOMAINS','SOCIAL_BIO')
            ) AS has_current_community_retryable_failure,
            EXISTS(
              SELECT 1 FROM (
                SELECT DISTINCT ON (o.provenance->>'surface',lower(rtrim(COALESCE(o.requested_url,''),'/')))
                       o.provenance->>'surface' AS surface,o.outcome,o.retryable,COALESCE(o.provenance->>'required','false') AS required
                  FROM external_acquisition_observations o
                 WHERE o.channel_id=c.channel_id
                   AND o.observed_at >= COALESCE(c.last_checked,now()) - interval '5 minutes'
                   AND o.observed_at <= COALESCE(c.last_checked,now()) + interval '5 minutes'
                 ORDER BY o.provenance->>'surface',lower(rtrim(COALESCE(o.requested_url,''),'/')),
                          CASE o.outcome WHEN 'FOUND' THEN 3 WHEN 'INSPECTED_NO_MATCH' THEN 2 WHEN 'PARTIALLY_INSPECTED' THEN 1 ELSE 0 END DESC,
                          o.observed_at DESC
              ) effective
             WHERE effective.required='true'
               AND effective.outcome='ACQUISITION_FAILED'
               AND effective.retryable=true
               AND effective.surface IN('YOUTUBE_ABOUT','RECENT_VIDEO_DESCRIPTIONS')
            ) AS has_current_upstream_retryable_failure
       FROM jobs j
       JOIN channels c ON c.channel_id=j.payload->>'channelId'
      WHERE j.type='RETRY_COMMUNITY_ACQUISITION'
        AND j.status IN('PENDING','COMPLETED')
        AND CASE
          WHEN btrim(COALESCE(j.payload->>'retryLifecycleVersion','')) ~ '^[0-9]+$'
            THEN btrim(j.payload->>'retryLifecycleVersion')::numeric
          ELSE 0
        END < 2
      ORDER BY j.created_at ASC
      LIMIT $1`,
    [Math.min(250, Math.max(1, limit))]
  );
  const summary = { examined: result.rows?.length || 0, completedNegative: 0, closedNonCommunity: 0, activeCommunity: 0 };
  for (const row of result.rows || []) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : (row.payload || {});
    const trail = typeof row.inspection_trail === 'string' ? JSON.parse(row.inspection_trail || '[]') : (row.inspection_trail || []);
    const decision = classifyLegacyCommunityRetryDisposition({
      payload,
      inspectionTrail: trail,
      hasCurrentCommunityRetryableFailure: row.has_current_community_retryable_failure === true,
      hasCurrentUpstreamRetryableFailure: row.has_current_upstream_retryable_failure === true
    });
    const nextPayload: Record<string, unknown> = {
      ...payload,
      retryReason: decision.retryReason,
      retrySource: payload.retrySource || 'LEGACY',
      // The original audit payload/history remains intact, but no newer stale
      // lifecycle state is projected for a job that is no longer retry-owned.
      reconciliationStatus: 'NONE',
      reconciliationCode: null,
      reconciliationReason: null,
      reconciliationObservedAt: null
    };
    if (decision.disposition === 'ACTIVE_COMMUNITY_RETRY') {
      if (row.status === 'PENDING') {
        await db.query(`UPDATE jobs SET payload=$2::jsonb,updated_at=now() WHERE id=$1 AND status='PENDING'`, [row.id, JSON.stringify(nextPayload)]);
      }
      summary.activeCommunity++;
      continue;
    }
    if (row.status === 'PENDING') {
      await db.query(
        `UPDATE jobs
            SET status='COMPLETED',completed_at=COALESCE(completed_at,now()),locked_by=NULL,locked_at=NULL,payload=$2::jsonb,updated_at=now()
          WHERE id=$1 AND status='PENDING'`,
        [row.id, JSON.stringify(nextPayload)]
      );
      await db.query(
        `UPDATE job_attempts
            SET status='COMPLETED',finished_at=COALESCE(finished_at,now())
          WHERE job_id=$1 AND finished_at IS NULL`,
        [row.id]
      );
    }
    summary.closedNonCommunity++;
    if (decision.disposition === 'COMPLETED_NEGATIVE') {
      await db.query(
        `UPDATE channels
            SET scan_status='COMPLETED',discord_status='NOT_FOUND',discord_validation_status='COMPLETED',discord_resolution_status='NOT_ATTEMPTED',discord_liveness_status='NOT_CHECKED',discord_relevance_status='NOT_CHECKED',discord_discovery_status='NOT_DISCOVERED',updated_at=now()
          WHERE channel_id=$1
            AND COALESCE(discord_candidate_locator,'')=''
            AND (scan_status='FAILED' OR discord_validation_status='RETRY_PENDING' OR discord_validation_status='NOT_STARTED')
            AND discord_status<>'FOUND'`,
        [row.channel_id]
      );
      summary.completedNegative++;
    }
  }
  return summary;
}

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
      if (enqueueRecoveryJob) await enqueueRecoveryJob(channelRecord.channel_id, triggerCheck.reasonCodes.join(','));
    } catch (error) {
      await upsertChannel(channelRecord);
      throw error;
    }
    reactivatedCount++;
  }
  return reactivatedCount;
}
