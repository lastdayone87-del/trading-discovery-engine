import { getDb } from './db';
import type { ChannelRecord } from '../src/types';
import { enqueueOperationalEnrichmentRecoveryJob } from './queueManager';
import { materializeExhaustedReview } from './reviewEligibility/exhaustedReview';

export const CLASSIFICATION_RESOLUTION_RECOVERY_POLICY_VERSION = 'classification-resolution-recovery-v1';
export const CLASSIFICATION_RESOLUTION_RECOVERY_CYCLE_LIMIT = 3;
const CUTOFF_EVENT_KEY = 'classification-resolution-recovery:cutoff';
const CYCLE_PREFIX = 'classification-resolution-recovery:cycle:';

export type ResolutionRecoveryAction =
  | 'SKIP_TERMINAL'
  | 'SKIP_ACTIVE'
  | 'SKIP_LEGACY'
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
  cutoff: string;
  includeLegacy?: boolean;
}

export interface ResolutionRecoveryDecision {
  action: ResolutionRecoveryAction;
  reasonCodes: string[];
}

export function resolveResolutionRecoveryAction(input: ResolutionRecoveryDecisionInput): ResolutionRecoveryDecision {
  if (input.tradingStatus !== 'UNCERTAIN') return { action: 'SKIP_TERMINAL', reasonCodes: ['NOT_UNCERTAIN'] };
  if (input.hasActiveJob) return { action: 'SKIP_ACTIVE', reasonCodes: ['ACTIVE_JOB_OWNS_CHANNEL'] };
  if (!input.includeLegacy && input.lastChecked && new Date(input.lastChecked).getTime() < new Date(input.cutoff).getTime()) {
    return { action: 'SKIP_LEGACY', reasonCodes: ['BEFORE_RECOVERY_CUTOFF'] };
  }
  if (input.terminalFailureClass === 'PERMANENT_INPUT' || input.terminalFailureClass === 'POLICY_TERMINAL') {
    return { action: 'PROJECT_PERMANENT_FAILURE', reasonCodes: ['PERMANENT_TERMINAL_FAILURE'] };
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
  const cutoff = options.cutoff || await ensureClassificationResolutionCutoff();
  const limit = Math.min(200, Math.max(1, options.limit || 50));
  const dryRun = options.dryRun !== false;
  const result = await db.query(
    `SELECT c.channel_id,c.channel_name,c.trading_status,c.scan_status,c.last_checked,
            latest.id AS latest_job_id,latest.status AS latest_job_status,
            latest.terminal_failure_class,
            (SELECT count(*)::int FROM operational_enrichment_recovery_events e
              WHERE e.channel_id=c.channel_id
                AND e.event_key LIKE '${CYCLE_PREFIX}%') AS recovery_cycles,
            EXISTS(
              SELECT 1 FROM jobs active
               WHERE active.payload->>'channelId'=c.channel_id
                 AND active.type IN('ENRICH_CHANNEL','CLASSIFY_DISCOVERED_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','RETRY_COMMUNITY_ACQUISITION')
                 AND active.status IN('PENDING','PROCESSING')
            ) AS has_active_job
       FROM channels c
       LEFT JOIN LATERAL (
         SELECT job.id,job.status,job.terminal_failure_class
           FROM jobs job
          WHERE job.type IN('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN')
            AND job.payload->>'channelId'=c.channel_id
          ORDER BY job.updated_at DESC NULLS LAST,job.created_at DESC NULLS LAST,job.id DESC
          LIMIT 1
       ) latest ON true
      WHERE c.trading_status='UNCERTAIN'
        AND c.scan_status IN('ENRICHMENT_PENDING','FAILED')
        AND ($1::boolean OR COALESCE(c.last_checked,c.created_at) >= $2::timestamptz)
      ORDER BY c.last_checked ASC NULLS FIRST,c.channel_id
      LIMIT $3`,
    [Boolean(options.includeLegacy), cutoff, limit],
  );
  const items: ClassificationResolutionRecoveryItem[] = [];
  let enqueued = 0, exhaustedReviews = 0, permanentFailures = 0, skipped = 0;
  for (const row of result.rows) {
    const decision = resolveResolutionRecoveryAction({
      tradingStatus: String(row.trading_status),
      scanStatus: String(row.scan_status),
      hasActiveJob: row.has_active_job === true,
      latestJobStatus: row.latest_job_status ? String(row.latest_job_status) : null,
      terminalFailureClass: row.terminal_failure_class ? String(row.terminal_failure_class) : null,
      recoveryCycles: Number(row.recovery_cycles) || 0,
      lastChecked: row.last_checked ? new Date(row.last_checked).toISOString() : null,
      cutoff,
      includeLegacy: options.includeLegacy === true,
    });
    const item: ClassificationResolutionRecoveryItem = {
      channelId: String(row.channel_id),
      channelName: String(row.channel_name),
      scanStatus: String(row.scan_status),
      tradingStatus: String(row.trading_status),
      latestJobStatus: row.latest_job_status ? String(row.latest_job_status) : null,
      latestJobId: row.latest_job_id ? String(row.latest_job_id) : null,
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
    if (decision.action === 'SKIP_TERMINAL' || decision.action === 'SKIP_ACTIVE' || decision.action === 'SKIP_LEGACY') {
      skipped += 1;
      continue;
    }
    if (decision.action === 'PROJECT_PERMANENT_FAILURE') {
      await db.query(`UPDATE channels SET scan_status='FAILED_PERMANENT',updated_at=now() WHERE channel_id=$1 AND trading_status='UNCERTAIN'`, [item.channelId]);
      permanentFailures += 1;
      continue;
    }
    if (decision.action === 'EXHAUSTED_REVIEW') {
      await materializeExhaustedReview({
        channelId: item.channelId,
        reasonCode: decision.reasonCodes[0] || 'ENRICHMENT_EXHAUSTED',
        reasonCodes: ['MACHINE_EXHAUSTED_UNCERTAIN', ...decision.reasonCodes],
        evidenceSummary: { latestJobStatus: item.latestJobStatus, recoveryCycles: item.recoveryCycles, policyVersion: CLASSIFICATION_RESOLUTION_RECOVERY_POLICY_VERSION },
      });
      exhaustedReviews += 1;
      continue;
    }
    const channel = await channelRowToRecord(db, item.channelId);
    if (!channel) { skipped += 1; continue; }
    const accepted = await enqueueOperationalEnrichmentRecoveryJob(channel, decision.reasonCodes);
    if (!accepted) {
      await materializeExhaustedReview({
        channelId: item.channelId,
        reasonCode: 'RECOVERY_ENQUEUE_BLOCKED',
        reasonCodes: ['MACHINE_EXHAUSTED_UNCERTAIN', ...decision.reasonCodes],
        evidenceSummary: { latestJobStatus: item.latestJobStatus, recoveryCycles: item.recoveryCycles },
      });
      exhaustedReviews += 1;
      continue;
    }
    const cycle = item.recoveryCycles + 1;
    await db.query(
      `INSERT INTO operational_enrichment_recovery_events(event_key,channel_id,job_id,prior_scan_status,reason_codes,policy_version)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key) DO NOTHING`,
      [
        `${CYCLE_PREFIX}${item.channelId}:${item.latestJobId || 'none'}:${cycle}`,
        item.channelId,
        item.latestJobId || 'none',
        item.scanStatus,
        JSON.stringify(decision.reasonCodes),
        CLASSIFICATION_RESOLUTION_RECOVERY_POLICY_VERSION,
      ],
    );
    enqueued += 1;
  }
  return { dryRun, cutoff, scanned: items.length, enqueued, exhaustedReviews, permanentFailures, skipped, items };
}
