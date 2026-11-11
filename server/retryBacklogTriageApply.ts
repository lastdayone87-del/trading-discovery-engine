/**
 * Phase 2 Unit 4 — bounded retry-backlog triage apply.
 *
 * Operator-gated companion to `retryBacklogTriage.ts`:
 *
 *   * TERMINAL rows close the PENDING job with append-only closure evidence
 *     (`RETRY_TRIAGE_TERMINAL`, actor, timestamp);
 *   * QUARANTINE rows stay PENDING but record the original priority/run_after
 *     in `retry_backlog_triage` and defer `run_after` by 30 days. No payload,
 *     attempt, channel, or observation is rewritten or deleted;
 *   * RECOVERABLE rows are never touched.
 *
 * Dry-run (the default) classifies and returns the plan without writes. Apply
 * requires an explicit `--apply` plus actor, locks at most `maxScan` PENDING
 * jobs with `FOR UPDATE SKIP LOCKED`, and writes at most `maxActions` rows in
 * one transaction.
 */

import {
  RETRY_BACKLOG_QUARANTINE_DAYS,
  RETRY_BACKLOG_TRIAGE_JOB_TYPE,
  classifyRetryBacklogJob,
  decodeRetryBacklogTriageCursor,
  encodeRetryBacklogTriageCursor,
  retryBacklogTriageCandidateSql,
  retryBacklogTriageEvidenceFromRawRow,
  type RetryBacklogBucket,
  type RetryBacklogReason,
  type RetryBacklogTriageCursor,
  type RetryBacklogTriageDb,
  type RetryBacklogTriageEvidence,
} from './retryBacklogTriage';

export const RETRY_BACKLOG_APPLY_DEFAULT_MAX_SCAN = 500;
export const RETRY_BACKLOG_APPLY_MAX_SCAN = 5_000;
export const RETRY_BACKLOG_APPLY_DEFAULT_MAX_ACTIONS = 100;
export const RETRY_BACKLOG_APPLY_MAX_ACTIONS = 500;
export const RETRY_BACKLOG_APPLY_MAX_ACTOR_LENGTH = 200;
export const RETRY_BACKLOG_APPLY_DAY_MS = 24 * 60 * 60 * 1000;

export type RetryBacklogApplyBucket = Extract<RetryBacklogBucket, 'TERMINAL' | 'QUARANTINE'>;

export interface RetryBacklogTriageApplyOptions {
  /** When false (default), only classify and plan. */
  apply?: boolean;
  /** Required when apply=true; recorded in jobs.closed_by / triage.applied_by. */
  actor?: string | null;
  maxScan?: number;
  maxActions?: number;
  buckets?: readonly RetryBacklogApplyBucket[];
  /** Optional reviewed batch / test isolation. */
  jobIds?: readonly string[];
  /** Continue after the last examined row from a prior bounded run. */
  cursor?: RetryBacklogTriageCursor | null;
  includeRows?: boolean;
  now?: () => Date;
}

export interface RetryBacklogTriageApplyAction {
  jobId: string;
  channelId: string;
  bucket: RetryBacklogApplyBucket;
  reason: RetryBacklogReason;
  applied: boolean;
  skippedReason?: string;
  closedAt?: string;
  deferredUntil?: string;
  originalPriority?: number;
  originalRunAfter?: string | null;
  evidence: Record<string, unknown>;
}

export interface RetryBacklogTriageApplyReport {
  generatedAt: string;
  dryRun: boolean;
  actor: string | null;
  maxScan: number;
  maxActions: number;
  buckets: RetryBacklogApplyBucket[];
  restricted: boolean;
  schema: { triageTablePresent: boolean };
  population: { pendingRetries: number; examined: number; truncated: boolean };
  scan: { cursor: string | null; nextCursor: string | null };
  summary: {
    terminal: number;
    quarantine: number;
    recoverable: number;
    skipped: number;
    actionSkipped: number;
    applied: number;
    byBucket: Record<string, number>;
    byReason: Record<string, number>;
  };
  actions?: RetryBacklogTriageApplyAction[];
  warnings: string[];
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function normalizeActor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > RETRY_BACKLOG_APPLY_MAX_ACTOR_LENGTH) {
    throw new Error(`actor must be at most ${RETRY_BACKLOG_APPLY_MAX_ACTOR_LENGTH} characters`);
  }
  return trimmed;
}

function normalizeBuckets(value: readonly RetryBacklogApplyBucket[] | undefined): RetryBacklogApplyBucket[] {
  const allowed: RetryBacklogApplyBucket[] = ['TERMINAL', 'QUARANTINE'];
  if (!value || value.length === 0) return allowed;
  const unique = [...new Set(value)];
  return unique.filter((bucket): bucket is RetryBacklogApplyBucket => allowed.includes(bucket));
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function plannedEvidence(
  evidence: RetryBacklogTriageEvidence,
  bucket: RetryBacklogApplyBucket,
  reason: RetryBacklogReason,
  extra: Record<string, unknown>,
  nowIso: string,
): Record<string, unknown> {
  return {
    source: 'phase2-retry-backlog-triage',
    bucket,
    reason,
    channelId: evidence.channelId,
    classifiedAt: nowIso,
    ...evidence,
    ...extra,
  };
}

interface CandidateLoad {
  rows: Array<{
    evidence: RetryBacklogTriageEvidence;
    bucket: RetryBacklogApplyBucket;
    reason: RetryBacklogReason;
  }>;
  triageTablePresent: boolean;
  pendingRetries: number;
  examined: number;
  truncated: boolean;
}

export async function runRetryBacklogTriageApply(
  db: RetryBacklogTriageDb,
  options: RetryBacklogTriageApplyOptions = {},
): Promise<RetryBacklogTriageApplyReport> {
  const apply = options.apply === true;
  const actor = normalizeActor(options.actor);
  if (apply && !actor) throw new Error('retry backlog apply requires a non-empty actor');
  const now = options.now ? options.now() : new Date();
  const maxScan = boundedInteger(
    options.maxScan,
    RETRY_BACKLOG_APPLY_DEFAULT_MAX_SCAN,
    1,
    RETRY_BACKLOG_APPLY_MAX_SCAN,
  );
  const maxActions = boundedInteger(
    options.maxActions,
    RETRY_BACKLOG_APPLY_DEFAULT_MAX_ACTIONS,
    1,
    RETRY_BACKLOG_APPLY_MAX_ACTIONS,
  );
  const buckets = normalizeBuckets(options.buckets);
  const restricted = Array.isArray(options.jobIds) && options.jobIds.length > 0;
  if (restricted) {
    for (const id of options.jobIds!) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error(`invalid job id: ${id}`);
      }
    }
  }

  const schema = await db.query(
    `SELECT to_regclass('public.retry_backlog_triage') IS NOT NULL AS present,
            (SELECT count(*)::int FROM jobs
              WHERE type='${RETRY_BACKLOG_TRIAGE_JOB_TYPE}' AND status='PENDING') AS pending_retries`,
  );
  const triageTablePresent = schema.rows[0]?.present === true;
  const pendingRetries = count(schema.rows[0]?.pending_retries);
  if (apply && !triageTablePresent) {
    throw new Error('retry_backlog_triage table is missing; apply migration 177 first');
  }

  const sql = retryBacklogTriageCandidateSql(triageTablePresent, {
    lock: apply,
    excludeApplied: apply,
  });
  const cursor = options.cursor || null;
  // Dry-run may fetch one extra (unlocked) row to detect a next page; apply
  // must not lock beyond maxScan, so it uses a separate probe below.
  const scanLimit = apply ? maxScan : maxScan + 1;
  const result = await db.query(sql, [
    scanLimit,
    restricted ? options.jobIds : null,
    cursor?.firstEnqueuedAt ?? null,
    cursor?.jobId ?? null,
  ]);
  const rawRows = Array.isArray(result.rows) ? result.rows : [];
  let truncated = apply ? rawRows.length >= maxScan : rawRows.length > maxScan;
  const limited = rawRows.slice(0, maxScan);
  if (apply && truncated && limited.length > 0) {
    const lastExamined = limited[limited.length - 1];
    const probe = await db.query(
      retryBacklogTriageCandidateSql(triageTablePresent, { excludeApplied: true }),
      [
        1,
        restricted ? options.jobIds : null,
        lastExamined.first_enqueued_at_cursor ?? lastExamined.first_enqueued_at,
        lastExamined.id,
      ],
    );
    truncated = Array.isArray(probe.rows) && probe.rows.length > 0;
  }

  const candidates: CandidateLoad['rows'] = [];
  const byReason: Record<string, number> = {};
  let terminal = 0;
  let quarantine = 0;
  let recoverable = 0;
  let skipped = 0;

  for (const raw of limited) {
    const evidence = retryBacklogTriageEvidenceFromRawRow(raw);
    const decision = classifyRetryBacklogJob(evidence, now.getTime());
    byReason[decision.reason] = (byReason[decision.reason] || 0) + 1;
    if (decision.bucket === 'TERMINAL') terminal++;
    else if (decision.bucket === 'QUARANTINE') quarantine++;
    else if (decision.bucket === 'RECOVERABLE') recoverable++;
    else skipped++;
    if (decision.bucket === 'TERMINAL' || decision.bucket === 'QUARANTINE') {
      if (buckets.includes(decision.bucket)) {
        candidates.push({
          evidence,
          bucket: decision.bucket,
          reason: decision.reason as RetryBacklogReason,
        });
      }
    }
  }

  const selected = candidates.slice(0, maxActions);
  const actions: RetryBacklogTriageApplyAction[] = [];
  let applied = 0;
  let actionSkipped = 0;

  if (!apply) {
    for (const candidate of selected) {
      const extra = candidate.bucket === 'QUARANTINE'
        ? {
          originalPriority: candidate.evidence.priority,
          originalRunAfter: candidate.evidence.runAfter,
          deferredUntil: new Date(
            now.getTime() + RETRY_BACKLOG_QUARANTINE_DAYS * RETRY_BACKLOG_APPLY_DAY_MS,
          ).toISOString(),
        }
        : {};
      actions.push({
        jobId: candidate.evidence.jobId,
        channelId: candidate.evidence.channelId,
        bucket: candidate.bucket,
        reason: candidate.reason,
        applied: false,
        ...(candidate.bucket === 'TERMINAL' ? {} : { deferredUntil: String(extra.deferredUntil) }),
        evidence: plannedEvidence(candidate.evidence, candidate.bucket, candidate.reason, extra, now.toISOString()),
      });
    }
  } else {
    for (const candidate of selected) {
      const evidence = candidate.evidence;
      if (candidate.bucket === 'TERMINAL') {
        const closedAt = new Date(now.getTime()).toISOString();
        const closureEvidence = plannedEvidence(evidence, 'TERMINAL', candidate.reason, {
          closedAt,
          actor,
        }, closedAt);
        // Lock the channel evidence row so it cannot change between the
        // statement-time guard and commit.
        if (evidence.channelId) {
          await db.query(
            'SELECT 1 FROM channels WHERE channel_id=$1 FOR UPDATE',
            [evidence.channelId],
          );
        }
        // Re-check the reason-specific channel/job evidence at statement time;
        // the job row is locked, but a channel policy update is not.
        const evidenceGuard = candidate.reason === 'OUT_OF_SCOPE'
          ? `AND EXISTS (
               SELECT 1 FROM channels c
                WHERE c.channel_id=j.payload->>'channelId'
                  AND c.scope_eligibility='OUT_OF_SCOPE'
             )`
          : candidate.reason === 'LOW_AUDIENCE_STOP'
            ? `AND EXISTS (
                 SELECT 1 FROM channels c
                  WHERE c.channel_id=j.payload->>'channelId'
                    AND c.scan_status='SKIPPED_LOW_AUDIENCE'
               )`
            : candidate.reason === 'ATTEMPTS_EXHAUSTED'
              ? 'AND j.max_attempts > 0 AND j.attempts >= j.max_attempts'
              : candidate.reason === 'CHANNEL_TERMINAL'
                ? `AND EXISTS (
                     SELECT 1 FROM channels c
                      WHERE c.channel_id=j.payload->>'channelId'
                        AND (c.country_status='REJECTED'
                             OR c.trading_status IN('NON_TRADING','HUMAN_REJECTED'))
                   )`
                : 'AND FALSE';
        const updated = await db.query(
          `UPDATE jobs j
              SET status='COMPLETED',
                  completed_at=COALESCE(completed_at,$4::timestamptz),
                  locked_by=NULL,
                  locked_at=NULL,
                  closed_reason='RETRY_TRIAGE_TERMINAL',
                  closed_evidence=$2::jsonb,
                  closed_by=$3,
                  closed_at=$4::timestamptz,
                  updated_at=now()
            WHERE j.id=$1
              AND j.status='PENDING'
              AND j.closed_at IS NULL
              ${evidenceGuard}
            RETURNING j.id`,
          [evidence.jobId, JSON.stringify(closureEvidence), actor, closedAt],
        );
        if (!updated.rows?.length) {
          actionSkipped++;
          continue;
        }
        await db.query(
          `INSERT INTO retry_backlog_triage(
             job_id,bucket,reason,evidence,applied_at,applied_by
           ) VALUES($1,'TERMINAL',$2,$3::jsonb,$4::timestamptz,$5)
           ON CONFLICT(job_id) DO NOTHING`,
          [evidence.jobId, candidate.reason, JSON.stringify(closureEvidence), closedAt, actor],
        );
        actions.push({
          jobId: evidence.jobId,
          channelId: evidence.channelId,
          bucket: 'TERMINAL',
          reason: candidate.reason,
          applied: true,
          closedAt,
          evidence: closureEvidence,
        });
        applied++;
        continue;
      }

      // Human-review quarantine is only valid while the channel is still in
      // that route. Lock and re-check the channel row before deferring.
      if (candidate.reason === 'HUMAN_REVIEW' && evidence.channelId) {
        const channel = await db.query(
          `SELECT scan_status,trading_status FROM channels WHERE channel_id=$1 FOR UPDATE`,
          [evidence.channelId],
        );
        const current = channel.rows?.[0];
        const stillReview = String(current?.scan_status || '').toUpperCase() === 'NEEDS_REVIEW'
          || String(current?.trading_status || '').toUpperCase() === 'NEEDS_REVIEW';
        if (!stillReview) {
          actionSkipped++;
          continue;
        }
      } else if (evidence.channelId) {
        await db.query(
          'SELECT 1 FROM channels WHERE channel_id=$1 FOR UPDATE',
          [evidence.channelId],
        );
      }

      const deferredUntil = new Date(
        now.getTime() + RETRY_BACKLOG_QUARANTINE_DAYS * RETRY_BACKLOG_APPLY_DAY_MS,
      ).toISOString();
      const originalPriority = evidence.priority;
      const originalRunAfter = evidence.runAfter;
      const update = await db.query(
        `UPDATE jobs
            SET run_after=$2::timestamptz,
                updated_at=now()
          WHERE id=$1
            AND status='PENDING'
            AND closed_at IS NULL
          RETURNING id`,
        [evidence.jobId, deferredUntil],
      );
      if (!update.rows?.length) {
        actionSkipped++;
        continue;
      }
      const quarantineEvidence = plannedEvidence(evidence, 'QUARANTINE', candidate.reason, {
        originalPriority,
        originalRunAfter,
        deferredUntil,
        actor,
      }, now.toISOString());
      await db.query(
        `INSERT INTO retry_backlog_triage(
           job_id,bucket,reason,evidence,original_priority,original_run_after,
           deferred_until,applied_at,applied_by
         ) VALUES($1,'QUARANTINE',$2,$3::jsonb,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,$8)
         ON CONFLICT(job_id) DO NOTHING`,
        [
          evidence.jobId,
          candidate.reason,
          JSON.stringify(quarantineEvidence),
          originalPriority,
          originalRunAfter,
          deferredUntil,
          now.toISOString(),
          actor,
        ],
      );
      actions.push({
        jobId: evidence.jobId,
        channelId: evidence.channelId,
        bucket: 'QUARANTINE',
        reason: candidate.reason,
        applied: true,
        deferredUntil,
        originalPriority,
        originalRunAfter,
        evidence: quarantineEvidence,
      });
      applied++;
    }
  }

  const warnings: string[] = [];
  if (truncated) warnings.push('candidate_scan_limit_reached');
  if (candidates.length > selected.length) warnings.push('action_limit_reached');
  // Never advance the cursor while an eligible row in the examined window was
  // left un-applied. Re-running without a cursor re-examines those rows; a
  // cursor here would silently skip them.
  const pendingActions = candidates.length > selected.length || actionSkipped > 0;
  if (pendingActions && truncated) warnings.push('cursor_not_advanced_pending_actions');
  const nextCursor = truncated && limited.length > 0 && !pendingActions
    ? encodeRetryBacklogTriageCursor({
      firstEnqueuedAt: limited[limited.length - 1].first_enqueued_at_cursor
        ?? limited[limited.length - 1].first_enqueued_at,
      jobId: limited[limited.length - 1].id,
    })
    : null;
  if (!triageTablePresent) warnings.push('triage_table_missing_report_only');

  return {
    generatedAt: now.toISOString(),
    dryRun: !apply,
    actor,
    maxScan,
    maxActions,
    buckets,
    restricted,
    schema: { triageTablePresent },
    population: { pendingRetries, examined: limited.length, truncated },
    scan: {
      cursor: cursor ? encodeRetryBacklogTriageCursor(cursor) : null,
      nextCursor,
    },
    summary: {
      terminal,
      quarantine,
      recoverable,
      skipped,
      actionSkipped,
      applied,
      byBucket: {
        TERMINAL: terminal,
        QUARANTINE: quarantine,
        RECOVERABLE: recoverable,
      },
      byReason,
    },
    ...(options.includeRows ? { actions } : {}),
    warnings,
  };
}

export interface RetryBacklogTriageUndoOptions {
  actor: string;
  maxActions?: number;
  jobIds?: readonly string[];
  includeRows?: boolean;
  now?: () => Date;
}

export interface RetryBacklogTriageUndoAction {
  jobId: string;
  restored: boolean;
  skippedReason?: string;
  restoredRunAfter?: string | null;
}

export interface RetryBacklogTriageUndoReport {
  generatedAt: string;
  dryRun: false;
  actor: string;
  maxActions: number;
  scanned: number;
  restored: number;
  skipped: number;
  actions?: RetryBacklogTriageUndoAction[];
  warnings: string[];
}

/**
 * Restore quarantined jobs only while the job still carries the exact
 * `run_after` written by apply (`deferred_until`). A newer scheduling change
 * is never overwritten. The triage row records the one-way undo actor/time.
 */
export async function runRetryBacklogTriageUndo(
  db: RetryBacklogTriageDb,
  options: RetryBacklogTriageUndoOptions,
): Promise<RetryBacklogTriageUndoReport> {
  const actor = normalizeActor(options.actor);
  if (!actor) throw new Error('retry backlog undo requires a non-empty actor');
  const now = options.now ? options.now() : new Date();
  const maxActions = boundedInteger(
    options.maxActions,
    RETRY_BACKLOG_APPLY_DEFAULT_MAX_ACTIONS,
    1,
    RETRY_BACKLOG_APPLY_MAX_ACTIONS,
  );
  const restricted = Array.isArray(options.jobIds) && options.jobIds.length > 0;
  if (restricted) {
    for (const id of options.jobIds!) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error(`invalid job id: ${id}`);
      }
    }
  }

  const result = await db.query(
    `SELECT t.job_id,
            t.original_run_after,
            t.deferred_until,
            j.status AS job_status,
            j.run_after AS job_run_after
       FROM retry_backlog_triage t
       JOIN jobs j ON j.id=t.job_id
      WHERE t.bucket='QUARANTINE'
        AND t.undone_at IS NULL
        AND ($1::uuid[] IS NULL OR t.job_id=ANY($1))
      ORDER BY t.applied_at, t.job_id
      LIMIT $2
      FOR UPDATE OF t, j SKIP LOCKED`,
    [restricted ? options.jobIds : null, maxActions],
  );
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const actions: RetryBacklogTriageUndoAction[] = [];
  let restored = 0;
  let skipped = 0;

  for (const row of rows) {
    const jobId = String(row.job_id);
    const originalRunAfter = row.original_run_after ? new Date(row.original_run_after).toISOString() : null;
    const deferredUntil = row.deferred_until ? new Date(row.deferred_until).toISOString() : null;
    const jobRunAfter = row.job_run_after ? new Date(row.job_run_after).toISOString() : null;
    if (String(row.job_status) !== 'PENDING'
        || !originalRunAfter
        || !deferredUntil
        || jobRunAfter !== deferredUntil) {
      skipped++;
      actions.push({
        jobId,
        restored: false,
        skippedReason: 'QUEUE_STATE_CHANGED',
      });
      continue;
    }
    const update = await db.query(
      `UPDATE jobs
          SET run_after=$2::timestamptz, updated_at=now()
        WHERE id=$1
          AND status='PENDING'
          AND run_after=$3::timestamptz
        RETURNING id`,
      [jobId, originalRunAfter, deferredUntil],
    );
    if (!update.rows?.length) {
      skipped++;
      actions.push({ jobId, restored: false, skippedReason: 'QUEUE_STATE_CHANGED' });
      continue;
    }
    await db.query(
      `UPDATE retry_backlog_triage
          SET undone_at=$2::timestamptz, undone_by=$3
        WHERE job_id=$1 AND undone_at IS NULL`,
      [jobId, now.toISOString(), actor],
    );
    restored++;
    actions.push({
      jobId,
      restored: true,
      restoredRunAfter: originalRunAfter,
    });
  }

  return {
    generatedAt: now.toISOString(),
    dryRun: false,
    actor,
    maxActions,
    scanned: rows.length,
    restored,
    skipped,
    ...(options.includeRows ? { actions } : {}),
    warnings: rows.length >= maxActions ? ['undo_action_limit_reached'] : [],
  };
}

export interface RetryBacklogApplyArgs {
  apply: boolean;
  undo: boolean;
  actor: string | null;
  maxScan: number;
  maxActions: number;
  buckets: RetryBacklogApplyBucket[];
  jobIds: string[] | null;
  cursor: RetryBacklogTriageCursor | null;
  includeRows: boolean;
  out: string | null;
  help: boolean;
}

export const RETRY_BACKLOG_APPLY_USAGE =
  'Usage: npx tsx scripts/phase2RetryBacklogApply.ts '
  + '[--apply --actor=name | --undo --actor=name] [--max-scan=500] [--max-actions=100] '
  + '[--buckets=TERMINAL,QUARANTINE] [--job-ids=id1,id2] [--cursor=cursor] '
  + '[--include-rows] [--out=path]';

function parsePositiveInt(rawValue: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}: "${rawValue}"`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}: "${rawValue}"`);
  }
  return value;
}

export function parseRetryBacklogApplyArgs(argv: readonly string[]): RetryBacklogApplyArgs {
  const args: RetryBacklogApplyArgs = {
    apply: false,
    undo: false,
    actor: null,
    maxScan: RETRY_BACKLOG_APPLY_DEFAULT_MAX_SCAN,
    maxActions: RETRY_BACKLOG_APPLY_DEFAULT_MAX_ACTIONS,
    buckets: ['TERMINAL', 'QUARANTINE'],
    jobIds: null,
    cursor: null,
    includeRows: false,
    out: null,
    help: false,
  };
  for (const raw of argv) {
    if (raw === '--apply') args.apply = true;
    else if (raw === '--undo') args.undo = true;
    else if (raw === '--include-rows') args.includeRows = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--actor=')) args.actor = raw.slice('--actor='.length);
    else if (raw.startsWith('--max-scan=')) {
      args.maxScan = parsePositiveInt(raw.slice('--max-scan='.length), '--max-scan', 1, RETRY_BACKLOG_APPLY_MAX_SCAN);
    } else if (raw.startsWith('--max-actions=')) {
      args.maxActions = parsePositiveInt(raw.slice('--max-actions='.length), '--max-actions', 1, RETRY_BACKLOG_APPLY_MAX_ACTIONS);
    } else if (raw.startsWith('--buckets=')) {
      const buckets = raw.slice('--buckets='.length).split(',').map(value => value.trim().toUpperCase());
      if (!buckets.length || buckets.some(bucket => bucket !== 'TERMINAL' && bucket !== 'QUARANTINE')) {
        throw new Error('--buckets must be a comma-separated subset of TERMINAL,QUARANTINE');
      }
      args.buckets = [...new Set(buckets)] as RetryBacklogApplyBucket[];
    } else if (raw.startsWith('--job-ids=')) {
      const ids = raw.slice('--job-ids='.length).split(',').map(value => value.trim()).filter(Boolean);
      if (!ids.length) throw new Error('--job-ids must contain at least one id');
      args.jobIds = ids;
    } else if (raw.startsWith('--cursor=')) {
      const cursor = decodeRetryBacklogTriageCursor(raw.slice('--cursor='.length));
      if (!cursor) throw new Error('--cursor is not a valid triage cursor');
      args.cursor = cursor;
    } else if (raw.startsWith('--out=')) {
      const out = raw.slice('--out='.length);
      if (!out.trim()) throw new Error('--out must name a non-empty file path');
      args.out = out;
    } else {
      throw new Error(`unknown argument: "${raw}". ${RETRY_BACKLOG_APPLY_USAGE}`);
    }
  }
  if (args.apply && args.undo) {
    throw new Error('--apply and --undo are mutually exclusive');
  }
  if (args.apply && !normalizeActor(args.actor)) {
    throw new Error('--apply requires a non-empty --actor');
  }
  if (args.undo && !normalizeActor(args.actor)) {
    throw new Error('--undo requires a non-empty --actor');
  }
  return args;
}
