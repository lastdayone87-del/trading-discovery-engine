import type { ChannelRecord } from '../src/types';
import { evaluateLowAudienceGate } from './lowAudienceGate';
import { bumpOperationalEnrichmentRecoveryDuplicateEvent, bumpOperationalEnrichmentRecoveryEnqueued, bumpOperationalEnrichmentRecoveryExhausted } from './operationsTelemetry';

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
  if (channel.scan_status !== 'FAILED' && channel.scan_status !== 'FAILED_PERMANENT' && channel.scan_status !== 'PROVIDER_DEFERRED') {
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

// Start timestamp of the previous reconciliation. This is a start-to-start
// throttle, not a completion-to-start delay: a scan that itself lasts longer
// than 60 seconds already satisfies the interval.
let lastOperationalEnrichmentReconciliationAt = 0;
// Process-local single-flight guard. Production runs one app replica, and all
// worker loops share this module, so a boolean stops the 15 loops from piling
// overlapping scans onto the same pool. If the app is ever scaled to multiple
// replicas or processes this must become a database advisory lock/lease: a
// module boolean cannot coordinate across processes.
let operationalEnrichmentReconciliationInFlight = false;

/** Start-to-start interval for the provider-deferred projection. */
export const PROVIDER_DEFERRED_PROJECTION_INTERVAL_MS = 60_000;
// The projection rewrites channel rows one at a time and is not claim-critical.
// A start-to-start throttle plus single-flight prevents the worker fan-out from
// repeating the same bounded scan on every tick.
let lastProviderDeferredProjectionAt = 0;
let providerDeferredProjectionInFlight = false;

/** Project only machine-owned, provider-blocked terminal rows for truthful dashboard state. */
export async function projectProviderDeferredEnrichment(
  getDb: () => Promise<any>,
  getChannelById: (id: string) => Promise<ChannelRecord | null>,
  upsertChannel: (channel: ChannelRecord) => Promise<void>,
  limit = 100,
  now = Date.now()
): Promise<number> {
  // Check the in-flight guard before the throttle: a concurrent call must not
  // start a second scan, and a skipped call must not extend the window.
  if (providerDeferredProjectionInFlight) return 0;
  if (now - lastProviderDeferredProjectionAt < PROVIDER_DEFERRED_PROJECTION_INTERVAL_MS) return 0;
  lastProviderDeferredProjectionAt = now;
  providerDeferredProjectionInFlight = true;
  try {
    return await runProviderDeferredProjection(getDb, getChannelById, upsertChannel, limit);
  } finally {
    // Always release, including on query failure, so one transient error
    // cannot permanently disable the projection for this process.
    providerDeferredProjectionInFlight = false;
  }
}

async function runProviderDeferredProjection(
  getDb: () => Promise<any>,
  getChannelById: (id: string) => Promise<ChannelRecord | null>,
  upsertChannel: (channel: ChannelRecord) => Promise<void>,
  limit: number
): Promise<number> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT c.channel_id
       FROM channels c
      WHERE c.scan_status IN('FAILED','FAILED_PERMANENT')
        AND c.trading_status IS DISTINCT FROM 'NON_TRADING'
        AND c.trading_status IS DISTINCT FROM 'HUMAN_REJECTED'
        AND c.discord_validation_status IS DISTINCT FROM 'COMPLETED'
        AND c.country_status IS DISTINCT FROM 'REJECTED'
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
  let projected = 0;
  for (const row of rows.rows) {
    const channel = await getChannelById(row.channel_id);
    if (!channel || channel.scan_status === 'PROVIDER_DEFERRED') continue;
    await upsertChannel({ ...channel, scan_status: 'PROVIDER_DEFERRED' });
    projected++;
  }
  return projected;
}

export type EnqueueOperationalEnrichmentRecovery = (
  channel: ChannelRecord,
  reasonCodes: string[],
  client?: any
) => Promise<void>;

export const OPERATIONAL_ENRICHMENT_RECOVERY_POLICY_VERSION = 'operational-enrichment-recovery-v2';

/**
 * Explicit ceiling on recovery cycles per channel. Each recorded cycle is one
 * durable recovery enqueue after the 24h cooldown, and enqueueJob reopens a
 * FAILED row on its channel-scoped idempotency key, so without a ceiling a
 * provider-blocked channel could be resurrected every cooldown forever. At the
 * ceiling the reconciliation writes an idempotent terminal event and never
 * re-enqueues; the terminal event is also excluded from the selection gate.
 */
export const OPERATIONAL_ENRICHMENT_MAX_RECOVERY_CYCLES = 3;

const OPERATIONAL_ENRICHMENT_CYCLE_EVENT_PREFIX = 'operational-enrichment:';
const OPERATIONAL_ENRICHMENT_TERMINAL_EVENT_PREFIX = 'operational-enrichment-terminal:';

/** Unique per channel/job/attempt/cycle recovery event key for the durable ledger. */
export function operationalEnrichmentCycleEventKey(channelId: string, jobId: string, attempts: unknown, cycle: number): string {
  return `${OPERATIONAL_ENRICHMENT_CYCLE_EVENT_PREFIX}${channelId}:${jobId}:attempt:${String(attempts)}:cycle:${Math.max(1, Math.floor(cycle))}`;
}

/** Idempotent per-channel terminal marker: recovery budget exhausted. */
export function operationalEnrichmentTerminalEventKey(channelId: string): string {
  return `${OPERATIONAL_ENRICHMENT_TERMINAL_EVENT_PREFIX}${channelId}`;
}

async function insertOperationalEnrichmentRecoveryEvent(
  db: any,
  eventKey: string,
  channelId: string,
  failedJobId: string,
  priorScanStatus: string,
  reasonCodes: string[]
): Promise<boolean> {
  const inserted = await db.query(
    `INSERT INTO operational_enrichment_recovery_events(event_key,channel_id,job_id,prior_scan_status,reason_codes,policy_version)
     VALUES($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT(event_key) DO NOTHING`,
    [eventKey, channelId, failedJobId, priorScanStatus, JSON.stringify(reasonCodes), OPERATIONAL_ENRICHMENT_RECOVERY_POLICY_VERSION]
  );
  return (Number(inserted?.rowCount) || 0) > 0;
}

async function withRecoveryTransaction<T>(db: any, fn: (queryable: any) => Promise<T>): Promise<T> {
  if (typeof db.connect !== 'function' || typeof db.totalCount !== 'number') {
    return fn(db);
  }
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    const result = await fn(connection);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    connection.release?.();
  }
}

export async function reconcileOperationalEnrichmentRecovery(
  getDb: () => Promise<any>,
  getChannelById: (id: string) => Promise<ChannelRecord | null>,
  upsertChannel: (channel: ChannelRecord) => Promise<void>,
  enqueueRecoveryJob: EnqueueOperationalEnrichmentRecovery,
  limit = 20,
  now = Date.now()
): Promise<number> {
  // Check the in-flight guard before the throttle: a concurrent worker with a
  // slightly later clock must not start a second scan, and a skipped call must
  // not extend the throttle window.
  if (operationalEnrichmentReconciliationInFlight) return 0;
  if (now - lastOperationalEnrichmentReconciliationAt < 60_000) return 0;
  // Stamp the start, preserving the existing start-to-start contract. If a scan
  // outlives the window, the next scan may start as soon as this one finishes;
  // the single-flight guard still prevents overlap, and the two starts remain
  // at least the scan duration apart.
  lastOperationalEnrichmentReconciliationAt = now;
  operationalEnrichmentReconciliationInFlight = true;
  try {
    return await runOperationalEnrichmentReconciliation(
      getDb,
      getChannelById,
      upsertChannel,
      enqueueRecoveryJob,
      limit,
      now
    );
  } finally {
    // Always release, including on query/transaction failure, so one transient
    // error cannot permanently disable recovery for this process.
    operationalEnrichmentReconciliationInFlight = false;
  }
}

async function runOperationalEnrichmentReconciliation(
  getDb: () => Promise<any>,
  getChannelById: (id: string) => Promise<ChannelRecord | null>,
  upsertChannel: (channel: ChannelRecord) => Promise<void>,
  enqueueRecoveryJob: EnqueueOperationalEnrichmentRecovery,
  limit: number,
  now: number
): Promise<number> {
  const db = await getDb();
  // The failed-job predicate admits both marked terminal failures and the raw
  // bounded provider-cooling terminal messages persisted before the marker was
  // added (historical rows). Select the latest enrichment job regardless of its
  // terminal error: a newer enrichment attempt (including an exhausted recovery
  // job) supersedes an older failure. Community acquisition is a separate lane,
  // so its failures cannot hide an older enrichment failure. The qualifying
  // failed/error predicates are applied after the LATERAL. The cycle count comes
  // from durable state so enqueue idempotency and the ceiling never use process
  // memory.
  const rows = await db.query(
    `SELECT c.channel_id,
            failed_job.id AS failed_job_id,
            failed_job.attempts AS failed_job_attempts,
            (SELECT count(*)::int
               FROM operational_enrichment_recovery_events cycle_event
              WHERE cycle_event.channel_id=c.channel_id
                AND cycle_event.event_key LIKE 'operational-enrichment:%') AS recovery_cycles
       FROM channels c
       JOIN LATERAL (
         SELECT latest_job.id, latest_job.attempts, latest_job.status, latest_job.last_error
           FROM jobs latest_job
          WHERE latest_job.type IN('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN')
            AND latest_job.payload->>'channelId'=c.channel_id
          ORDER BY latest_job.updated_at DESC NULLS LAST, latest_job.created_at DESC NULLS LAST, latest_job.id DESC
          LIMIT 1
       ) failed_job ON true
      WHERE c.scan_status IN('FAILED','FAILED_PERMANENT','PROVIDER_DEFERRED')
        AND failed_job.status='FAILED'
        AND (failed_job.last_error ILIKE 'OPERATIONALLY_BLOCKED_RETRY_REQUIRED:%'
             OR failed_job.last_error ILIKE 'Every configured YouTube provider is cooling down%'
             OR failed_job.last_error ILIKE 'YouTube API project pool is quota-exhausted%')
        AND c.trading_status IS DISTINCT FROM 'NON_TRADING'
        AND c.trading_status IS DISTINCT FROM 'HUMAN_REJECTED'
        AND c.discord_validation_status IS DISTINCT FROM 'COMPLETED'
        AND c.country_status IS DISTINCT FROM 'REJECTED'
        AND (c.last_checked IS NULL OR c.last_checked < now() - interval '24 hours')
        AND NOT EXISTS (
          SELECT 1 FROM jobs active_job
           WHERE active_job.type IN('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','RETRY_COMMUNITY_ACQUISITION')
             AND active_job.status IN('PENDING','PROCESSING')
             AND active_job.payload->>'channelId'=c.channel_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM operational_enrichment_recovery_events terminal_event
           WHERE terminal_event.channel_id=c.channel_id
             AND terminal_event.event_key LIKE 'operational-enrichment-terminal:%'
        )
      ORDER BY c.last_checked ASC NULLS FIRST
      LIMIT $1`,
    [Math.min(100, Math.max(1, limit))]
  );
  let reconciled = 0;
  for (const row of rows.rows) {
    const channel = await getChannelById(row.channel_id);
    if (!channel) continue;
    const failedJobId = String(row.failed_job_id || '');
    const recoveryCycles = Number(row.recovery_cycles) || 0;
    if (recoveryCycles >= OPERATIONAL_ENRICHMENT_MAX_RECOVERY_CYCLES) {
      // Budget exhausted: record the idempotent terminal marker once and stop.
      // No channel mutation and no enqueue — the channel stays in its truthful
      // operational-failure projection and can never be reopened by recovery.
      const marked = await insertOperationalEnrichmentRecoveryEvent(
        db,
        operationalEnrichmentTerminalEventKey(channel.channel_id),
        channel.channel_id,
        failedJobId,
        channel.scan_status,
        ['OPERATIONAL_RECOVERY_ATTEMPTS_EXHAUSTED']
      );
      if (marked) {
        bumpOperationalEnrichmentRecoveryExhausted();
        console.warn(JSON.stringify({event:'operational_enrichment_recovery_exhausted',channelId:channel.channel_id,failedJobId,recoveryCycles,maxRecoveryCycles:OPERATIONAL_ENRICHMENT_MAX_RECOVERY_CYCLES,timestamp:new Date(now).toISOString()}));
      }
      continue;
    }
    // A stored known-low count must not re-enter enrichment through recovery:
    // project the low-audience skip instead of re-enqueueing.
    if (evaluateLowAudienceGate(channel.subscriber_count).shouldSkipDeepEnrichment) {
      const skipNow = new Date(now).toISOString();
      await upsertChannel({...channel,subscriber_count:channel.subscriber_count,scan_status:'SKIPPED_LOW_AUDIENCE',last_checked:skipNow,inspection_trail:[...(channel.inspection_trail||[]),{step:'BIO',title:'Low-Audience Budget Gate',status:'SKIPPED',details:`Subscribers: ${channel.subscriber_count} (< 30). Stored and skipped deep enrichment.`,timestamp:skipNow}]});
      reconciled++;
      continue;
    }
    const decision = shouldReactivateOperationalEnrichment(channel, now);
    if (!decision.reactivate) continue;
    const updated = reactivateOperationalEnrichment(channel, decision.reasonCodes, new Date(now).toISOString());
    await upsertChannel(updated);
    let recorded = false;
    try {
      // Enqueue and ledger write share one transaction on the real pool: a
      // failed ledger insert must not leave a reopened job that consumes a
      // recovery cycle without a durable record (or vice versa).
      recorded = await withRecoveryTransaction(db, async queryable => {
        await enqueueRecoveryJob(updated, decision.reasonCodes, queryable);
        return insertOperationalEnrichmentRecoveryEvent(
          queryable,
          operationalEnrichmentCycleEventKey(channel.channel_id, failedJobId, row.failed_job_attempts, recoveryCycles + 1),
          channel.channel_id,
          failedJobId,
          channel.scan_status,
          decision.reasonCodes
        );
      });
    } catch (error) {
      await upsertChannel(channel);
      throw error;
    }
    if (recorded) {
      bumpOperationalEnrichmentRecoveryEnqueued();
      console.info(JSON.stringify({event:'operational_enrichment_recovery_enqueued',channelId:channel.channel_id,failedJobId,cycle:recoveryCycles+1,maxRecoveryCycles:OPERATIONAL_ENRICHMENT_MAX_RECOVERY_CYCLES,reasonCodes:decision.reasonCodes,timestamp:new Date(now).toISOString()}));
    } else {
      bumpOperationalEnrichmentRecoveryDuplicateEvent();
    }
    reconciled++;
  }
  return reconciled;
}
