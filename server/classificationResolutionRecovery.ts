import { getDb } from './db';
import type { ChannelRecord } from '../src/types';
import { enqueueOperationalEnrichmentRecoveryJob } from './queueManager';
import { OPERATIONAL_ENRICHMENT_MAX_RECOVERY_CYCLES } from './operationalEnrichmentRecovery';
import { materializeExhaustedReview } from './reviewEligibility/exhaustedReview';

export const CLASSIFICATION_RESOLUTION_RECOVERY_POLICY_VERSION = 'classification-resolution-recovery-v1';
export const CLASSIFICATION_RESOLUTION_RECOVERY_CYCLE_LIMIT = OPERATIONAL_ENRICHMENT_MAX_RECOVERY_CYCLES;
export const CLASSIFICATION_RESOLUTION_RECOVERY_COOLDOWN_MS = 24 * 60 * 60_000;
const CUTOFF_EVENT_KEY = 'classification-resolution-recovery:cutoff';
const CYCLE_PREFIX = 'operational-enrichment:';
const FAILURE_PREFIX = 'classification-resolution-failure:';

export type ResolutionRecoveryAction =
  | 'SKIP_TERMINAL'
  | 'SKIP_ACTIVE'
  | 'SKIP_LEGACY'
  | 'SKIP_COOLDOWN'
  | 'ENQUEUE_RECOVERY'
  | 'EXHAUSTED_REVIEW'
  | 'PROJECT_PERMANENT_FAILURE';

export interface ResolutionRecoveryDecisionInput {
  tradingStatus: string;
  scanStatus: string;
  hasActiveJob: boolean;
  latestJobStatus: string | null;
  terminalFailureClass: string | null;
  recoveryCycles: number;
  lastChecked: string | null;
  createdAt?: string | null;
  lastRecoveryAt?: string | null;
  terminalRecoveryMarker?: boolean;
  cutoff: string;
  now?: number;
  includeLegacy?: boolean;
}

export interface ResolutionRecoveryDecision {
  action: ResolutionRecoveryAction;
  reasonCodes: string[];
}

export function resolveResolutionRecoveryAction(input: ResolutionRecoveryDecisionInput): ResolutionRecoveryDecision {
  if (input.tradingStatus !== 'UNCERTAIN') return { action: 'SKIP_TERMINAL', reasonCodes: ['NOT_UNCERTAIN'] };
  if (input.hasActiveJob) return { action: 'SKIP_ACTIVE', reasonCodes: ['ACTIVE_JOB_OWNS_CHANNEL'] };
  const observedAt = input.lastChecked || input.createdAt || null;
  if (!input.includeLegacy && (!observedAt || new Date(observedAt).getTime() < new Date(input.cutoff).getTime())) {
    return { action: 'SKIP_LEGACY', reasonCodes: ['BEFORE_RECOVERY_CUTOFF'] };
  }
  const lastActivity = input.lastRecoveryAt || input.lastChecked;
  if (lastActivity) {
    const age = (input.now ?? Date.now()) - new Date(lastActivity).getTime();
    if (age < CLASSIFICATION_RESOLUTION_RECOVERY_COOLDOWN_MS) return { action: 'SKIP_COOLDOWN', reasonCodes: ['RECOVERY_COOLDOWN_ACTIVE'] };
  }
  if (input.terminalRecoveryMarker) return { action: 'EXHAUSTED_REVIEW', reasonCodes: ['RECOVERY_BUDGET_TERMINAL_MARKER'] };
  if (input.terminalFailureClass === 'PERMANENT_INPUT' || input.terminalFailureClass === 'POLICY_TERMINAL') {
    return { action: 'PROJECT_PERMANENT_FAILURE', reasonCodes: ['PERMANENT_TERMINAL_FAILURE'] };
  }
  if (input.terminalFailureClass === 'UNKNOWN') {
    return { action: 'EXHAUSTED_REVIEW', reasonCodes: ['UNKNOWN_TERMINAL_FAILURE_REQUIRES_REVIEW'] };
  }
  if (input.recoveryCycles >= CLASSIFICATION_RESOLUTION_RECOVERY_CYCLE_LIMIT) {
    return { action: 'EXHAUSTED_REVIEW', reasonCodes: ['RECOVERY_ATTEMPTS_EXHAUSTED'] };
  }
  if (input.scanStatus === 'ENRICHMENT_PENDING' && !input.latestJobStatus) {
    return { action: 'ENQUEUE_RECOVERY', reasonCodes: ['ORPHAN_ENRICHMENT_PENDING'] };
  }
  if (input.latestJobStatus === 'COMPLETED') {
    return { action: 'EXHAUSTED_REVIEW', reasonCodes: ['COMPLETED_UNCERTAIN_WITHOUT_REVIEW'] };
  }
  return { action: 'ENQUEUE_RECOVERY', reasonCodes: ['GENERIC_TERMINAL_ENRICHMENT_FAILURE'] };
}

export async function readClassificationResolutionCutoff(): Promise<string | null> {
  const db = await getDb();
  const existing = await db.query('SELECT created_at FROM operational_enrichment_recovery_events WHERE event_key=$1', [CUTOFF_EVENT_KEY]);
  return existing.rowCount ? new Date(existing.rows[0].created_at).toISOString() : null;
}

export async function ensureClassificationResolutionCutoff(): Promise<string> {
  const db = await getDb();
  const existing = await db.query('SELECT created_at FROM operational_enrichment_recovery_events WHERE event_key=$1', [CUTOFF_EVENT_KEY]);
  if (existing.rowCount) return new Date(existing.rows[0].created_at).toISOString();
  await db.query(
    `INSERT INTO operational_enrichment_recovery_events(event_key,channel_id,job_id,prior_scan_status,reason_codes,policy_version)
     VALUES($1,'__SYSTEM__','__CUTOFF__','SYSTEM',$2,$3) ON CONFLICT(event_key) DO NOTHING`,
    [CUTOFF_EVENT_KEY, JSON.stringify(['CLASSIFICATION_RESOLUTION_RECOVERY_CUTOFF']), CLASSIFICATION_RESOLUTION_RECOVERY_POLICY_VERSION],
  );
  const inserted = await db.query('SELECT created_at FROM operational_enrichment_recovery_events WHERE event_key=$1', [CUTOFF_EVENT_KEY]);
  return new Date(inserted.rows[0].created_at).toISOString();
}

export interface ClassificationResolutionRecoveryOptions {
  dryRun?: boolean;
  includeLegacy?: boolean;
  limit?: number;
  cutoff?: string;
  now?: number;
}

export interface ClassificationResolutionRecoveryItem {
  channelId: string;
  channelName: string;
  scanStatus: string;
  tradingStatus: string;
  latestJobStatus: string | null;
  latestJobId: string | null;
  latestJobAttempts: number;
  terminalFailureClass: string | null;
  recoveryCycles: number;
  lastChecked: string | null;
  action: ResolutionRecoveryAction;
  reasonCodes: string[];
}

export interface ClassificationResolutionRecoveryResult {
  dryRun: boolean;
  cutoff: string;
  scanned: number;
  enqueued: number;
  exhaustedReviews: number;
  permanentFailures: number;
  skipped: number;
  failures: number;
  items: ClassificationResolutionRecoveryItem[];
}

async function channelRowToRecord(db: any, channelId: string): Promise<ChannelRecord | null> {
  const result = await db.query('SELECT * FROM channels WHERE channel_id=$1', [channelId]);
  if (!result.rowCount) return null;
  return result.rows[0] as ChannelRecord;
}

/**
 * Bounded maintenance sweep for machine-owned unresolved channels.
 *
 * Forward-only by default: a system ledger row records the first run time and
 * legacy rows before that time are reported but not mutated. The dry-run mode
 * is the default entry point for the operator script. Reuses the existing
 * operational recovery ledger, 24-hour style cycle ceiling and idempotent
 * ENRICH_CHANNEL enqueue.
 */
export async function reconcileClassificationResolutionGaps(
  options: ClassificationResolutionRecoveryOptions = {},
): Promise<ClassificationResolutionRecoveryResult> {
  const db = await getDb();
  const dryRun = options.dryRun !== false;
  const cutoff = options.cutoff || (dryRun ? (await readClassificationResolutionCutoff()) || new Date().toISOString() : await ensureClassificationResolutionCutoff());
  const limit = Math.min(200, Math.max(1, options.limit || 50));
  const result = await db.query(
    `SELECT c.channel_id,c.channel_name,c.trading_status,c.scan_status,c.last_checked,
            latest.id AS latest_job_id,latest.status AS latest_job_status,
            latest.terminal_failure_class,latest.attempts AS latest_job_attempts,
            latest.updated_at AS latest_job_updated_at,c.created_at AS channel_created_at,
            (SELECT count(*)::int FROM operational_enrichment_recovery_events e
              WHERE e.channel_id=c.channel_id
                AND e.event_key LIKE '${CYCLE_PREFIX}%') AS recovery_cycles,
            (SELECT MAX(e.created_at) FROM operational_enrichment_recovery_events e
              WHERE e.channel_id=c.channel_id
                AND e.event_key LIKE '${CYCLE_PREFIX}%') AS last_recovery_at,
            EXISTS(SELECT 1 FROM operational_enrichment_recovery_events e
              WHERE e.channel_id=c.channel_id
                AND e.event_key LIKE 'operational-enrichment-terminal:%') AS terminal_recovery_marker,
            COALESCE(
              (SELECT MAX(e.created_at) FROM operational_enrichment_recovery_events e
                WHERE e.channel_id=c.channel_id
                  AND e.event_key LIKE '${CYCLE_PREFIX}%'),
              latest.updated_at,
              c.last_checked,
              c.created_at
            ) > now()-interval '24 hours' AS recovery_cooldown_active
       FROM channels c
       LEFT JOIN LATERAL (
         SELECT job.id,job.status,job.terminal_failure_class,job.attempts,job.updated_at
           FROM jobs job
          WHERE job.type IN('ENRICH_CHANNEL','CLASSIFY_DISCOVERED_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN')
            AND job.payload->>'channelId'=c.channel_id
          ORDER BY job.updated_at DESC NULLS LAST,job.created_at DESC NULLS LAST,job.id DESC
          LIMIT 1
       ) latest ON true
      WHERE c.trading_status='UNCERTAIN'
        AND c.scan_status IN('ENRICHMENT_PENDING','FAILED')
        AND ($1::boolean OR COALESCE(c.last_checked,c.created_at) >= $2::timestamptz)
        AND COALESCE(c.country_status,'') <> 'REJECTED'
        AND NOT EXISTS(
          SELECT 1 FROM operational_enrichment_recovery_events recent_failure
           WHERE recent_failure.channel_id=c.channel_id
             AND recent_failure.event_key LIKE '${FAILURE_PREFIX}%'
             AND recent_failure.created_at>=now()-interval '15 minutes'
        )
        AND NOT EXISTS(
          SELECT 1 FROM jobs active
           WHERE active.payload->>'channelId'=c.channel_id
             AND active.type IN('ENRICH_CHANNEL','CLASSIFY_DISCOVERED_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','RETRY_COMMUNITY_ACQUISITION')
             AND active.status IN('PENDING','PROCESSING')
        )
        AND ($3::boolean OR NOT (
          COALESCE(
            (SELECT MAX(e.created_at) FROM operational_enrichment_recovery_events e
              WHERE e.channel_id=c.channel_id
                AND e.event_key LIKE '${CYCLE_PREFIX}%'),
            latest.updated_at,
            c.last_checked,
            c.created_at
          ) > now()-interval '24 hours'
        ))
      ORDER BY recovery_cooldown_active ASC,c.last_checked ASC NULLS FIRST,c.channel_id
      LIMIT $4`,
    [Boolean(options.includeLegacy), cutoff, Boolean(dryRun), limit],
  );
  const items: ClassificationResolutionRecoveryItem[] = [];
  let enqueued = 0, exhaustedReviews = 0, permanentFailures = 0, skipped = 0, failures = 0;
  for (const row of result.rows) {
    const decision = resolveResolutionRecoveryAction({
      tradingStatus: String(row.trading_status),
      scanStatus: String(row.scan_status),
      // The candidate query already excludes every active job type.
      hasActiveJob: false,
      latestJobStatus: row.latest_job_status ? String(row.latest_job_status) : null,
      terminalFailureClass: row.terminal_failure_class ? String(row.terminal_failure_class) : null,
      recoveryCycles: Number(row.recovery_cycles) || 0,
      lastChecked: row.last_checked ? new Date(row.last_checked).toISOString() : null,
      createdAt: row.channel_created_at ? new Date(row.channel_created_at).toISOString() : null,
      lastRecoveryAt: row.last_recovery_at ? new Date(row.last_recovery_at).toISOString() : (row.latest_job_updated_at ? new Date(row.latest_job_updated_at).toISOString() : null),
      terminalRecoveryMarker: row.terminal_recovery_marker === true,
      cutoff,
      includeLegacy: options.includeLegacy === true,
      now: options.now || Date.now(),
    });
    const item: ClassificationResolutionRecoveryItem = {
      channelId: String(row.channel_id),
      channelName: String(row.channel_name),
      scanStatus: String(row.scan_status),
      tradingStatus: String(row.trading_status),
      latestJobStatus: row.latest_job_status ? String(row.latest_job_status) : null,
      latestJobId: row.latest_job_id ? String(row.latest_job_id) : null,
      latestJobAttempts: Number(row.latest_job_attempts) || 0,
      terminalFailureClass: row.terminal_failure_class ? String(row.terminal_failure_class) : null,
      recoveryCycles: Number(row.recovery_cycles) || 0,
      lastChecked: row.last_checked ? new Date(row.last_checked).toISOString() : null,
      action: decision.action,
      reasonCodes: decision.reasonCodes,
    };
    items.push(item);
    if (dryRun) {
      if (decision.action === 'ENQUEUE_RECOVERY') enqueued += 1;
      else if (decision.action === 'EXHAUSTED_REVIEW') exhaustedReviews += 1;
      else if (decision.action === 'PROJECT_PERMANENT_FAILURE') permanentFailures += 1;
      else skipped += 1;
      continue;
    }
    // One poisoned row must not starve the rest of the batch. Rows are ordered
    // by last_checked, so a repeated failure at the head would otherwise block
    // every later channel on every sweep.
    try {
      if (decision.action === 'SKIP_TERMINAL' || decision.action === 'SKIP_ACTIVE' || decision.action === 'SKIP_LEGACY' || decision.action === 'SKIP_COOLDOWN') {
        skipped += 1;
        continue;
      }
      if (decision.action === 'PROJECT_PERMANENT_FAILURE') {
        const projected = await db.query(`UPDATE channels SET scan_status='FAILED_PERMANENT',updated_at=now() WHERE channel_id=$1 AND trading_status='UNCERTAIN' AND scan_status IN('FAILED','ENRICHMENT_PENDING') AND date_trunc('milliseconds', last_checked) IS NOT DISTINCT FROM date_trunc('milliseconds', $2::timestamptz) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.payload->>'channelId'=$1 AND j.type IN('ENRICH_CHANNEL','CLASSIFY_DISCOVERED_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','RETRY_COMMUNITY_ACQUISITION') AND j.status IN('PENDING','PROCESSING'))`, [item.channelId, item.lastChecked]);
        if (projected.rowCount) permanentFailures += 1;
        else skipped += 1;
        continue;
      }
      if (decision.action === 'EXHAUSTED_REVIEW') {
        const review = await materializeExhaustedReview({
          channelId: item.channelId,
          reasonCode: decision.reasonCodes[0] || 'ENRICHMENT_EXHAUSTED',
          reasonCodes: ['MACHINE_EXHAUSTED_UNCERTAIN', ...decision.reasonCodes],
          evidenceSummary: { latestJobStatus: item.latestJobStatus, recoveryCycles: item.recoveryCycles, policyVersion: CLASSIFICATION_RESOLUTION_RECOVERY_POLICY_VERSION },
        });
        if (review.materialized) exhaustedReviews += 1;
        else skipped += 1;
        continue;
      }
      const channel = await channelRowToRecord(db, item.channelId);
      if (!channel) { skipped += 1; continue; }
      const cycle = item.recoveryCycles + 1;
      let accepted = false;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        accepted = await enqueueOperationalEnrichmentRecoveryJob(channel, decision.reasonCodes, client);
        if (accepted) {
          await client.query(
            `INSERT INTO operational_enrichment_recovery_events(event_key,channel_id,job_id,prior_scan_status,reason_codes,policy_version)
             VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key) DO NOTHING`,
            [
              `${CYCLE_PREFIX}${item.channelId}:${item.latestJobId || 'none'}:attempt:${item.latestJobAttempts || 0}:cycle:${cycle}`,
              item.channelId,
              item.latestJobId || 'none',
              item.scanStatus,
              JSON.stringify(decision.reasonCodes),
              CLASSIFICATION_RESOLUTION_RECOVERY_POLICY_VERSION,
            ],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (!accepted) {
        const review = await materializeExhaustedReview({
          channelId: item.channelId,
          reasonCode: 'RECOVERY_ENQUEUE_BLOCKED',
          reasonCodes: ['MACHINE_EXHAUSTED_UNCERTAIN', ...decision.reasonCodes],
          evidenceSummary: { latestJobStatus: item.latestJobStatus, recoveryCycles: item.recoveryCycles },
        });
        if (review.materialized) exhaustedReviews += 1;
        else skipped += 1;
        continue;
      }
      enqueued += 1;
    } catch (error) {
      failures += 1;
      // Keep a deterministic failing head row from starving the rest of the
      // batch on every sweep. The exclusion is short-lived so transient
      // failures are retried after the backoff.
      await db.query(
        `INSERT INTO operational_enrichment_recovery_events(event_key,channel_id,job_id,prior_scan_status,reason_codes,policy_version)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key) DO NOTHING`,
        [
          `${FAILURE_PREFIX}${item.channelId}:${Date.now()}`,
          item.channelId,
          item.latestJobId || 'none',
          item.scanStatus,
          JSON.stringify(['ROW_APPLY_FAILED', 'CLASSIFICATION_RESOLUTION']),
          CLASSIFICATION_RESOLUTION_RECOVERY_POLICY_VERSION,
        ],
      ).catch(ledgerError => console.warn(`[ClassificationResolution] Failure backoff write failed for ${item.channelId}:`, ledgerError instanceof Error ? ledgerError.message : ledgerError));
      console.warn(JSON.stringify({
        event: 'classification_resolution_recovery_item_failed',
        channelId: item.channelId,
        action: item.action,
        reason: String(error instanceof Error ? error.message : error).slice(0, 300),
        timestamp: new Date().toISOString(),
      }));
    }
  }
  return { dryRun, cutoff, scanned: items.length, enqueued, exhaustedReviews, permanentFailures, skipped, failures, items };
}
