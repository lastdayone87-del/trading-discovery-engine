/**
 * Phase 0 zombie retry reconciliation — operator-gated bounded apply.
 *
 * The dry-run report (`phase0ZombieReconciliation.ts`) proposes closures; this
 * module performs at most a bounded batch of them after an operator explicitly
 * passes `--apply` and an actor identity. It reuses the dry-run's evidence
 * queries and classifier, so a proposal and an applied closure can never be
 * produced by different rules.
 *
 * Safety properties:
 *
 *   * only `PENDING` jobs are candidates, and candidate rows are locked with
 *     `FOR UPDATE SKIP LOCKED` so a worker can never claim one mid-audit;
 *   * `closed_at IS NULL` excludes jobs that already carry closure evidence
 *     from an earlier batch or retry epoch; the record is append-only, so a
 *     reopened generation is not re-closed by Phase 0;
 *   * every closure writes append-only `closed_reason`, `closed_evidence`,
 *     `closed_by`, and `closed_at` in the same transaction;
 *   * the batch is bounded by both `maxScan` and `maxClosures`; keyset cursors
 *     advance past a window dominated by permanent skips without skipping
 *     survivors when closures leave the window;
 *   * report-only mode (no `--apply`) issues no writes;
 *   * the closure UPDATE re-checks the ownership prefilter and active ledger
 *     state at statement time, excluding observations the batch classifier
 *     already examined, so only evidence that appeared after the batch
 *     snapshot can block the write;
 *   * the CLI runs the batch in one `READ COMMITTED` transaction. Full
 *     synchronization with evidence writers lands with Phase 1's atomic
 *     claim/lease/recovery; Phase 0 relies on the reviewed dry-run, the actor
 *     gate, the bounded batch, and 100% audit of the first 100 closures.
 */

import {
  ZOMBIE_COMMUNITY_SURFACES,
  ZOMBIE_RETRY_JOB_TYPE,
  buildZombieReconciliationRows,
  zombieCandidateJobIdsSql,
  zombieClosureEvidenceGuardSql,
  zombieEvidenceSqlForJobIds,
  zombieNewerObservationSqlByJobIds,
  zombieReconciliationSchemaSql,
  type Phase0ZombieReconciliationDb,
  type Phase0ZombieReconciliationRow,
  type ZombieClosureReason,
} from './phase0ZombieReconciliation';

export const PHASE0_ZOMBIE_APPLY_CLASSIFIER_VERSION = 'phase0-zombie-apply-v1';
export const PHASE0_ZOMBIE_APPLY_DEFAULT_MAX_SCAN = 500;
export const PHASE0_ZOMBIE_APPLY_DEFAULT_MAX_CLOSURES = 100;
export const PHASE0_ZOMBIE_APPLY_MAX_SCAN = 5_000;
export const PHASE0_ZOMBIE_APPLY_MAX_CLOSURES = 500;
export const PHASE0_ZOMBIE_APPLY_MAX_CURSOR_LENGTH = 256;
export const PHASE0_ZOMBIE_APPLY_MAX_ACTOR_LENGTH = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP_KEY_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/;

function isValidTimestampKey(value: string): boolean {
  const match = TIMESTAMP_KEY_PATTERN.exec(value);
  if (!match) return false;
  const millis = (match[2] || '').padEnd(3, '0').slice(0, 3);
  return Number.isFinite(Date.parse(`${match[1]}.${millis}Z`));
}

export interface Phase0ZombieApplyOptions {
  /** When false (the default), classify and report without writing. */
  apply?: boolean;
  /** Required when apply=true; recorded verbatim in `jobs.closed_by`. */
  actor?: string | null;
  /** Bound on locked candidate jobs. */
  maxScan?: number;
  /** Bound on applied closures from one scan. */
  maxClosures?: number;
  /** Opaque keyset cursor from a previous report: resume after that row. */
  cursor?: string | null;
  /** Optional explicit job ids (operator audit batch or test isolation). */
  jobIds?: readonly string[];
  includeRows?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface Phase0ZombieApplyClosure {
  jobId: string;
  channelId: string;
  reason: ZombieClosureReason;
  applied: boolean;
  closedAt: string | null;
  actor: string | null;
  evidence: Record<string, unknown>;
}

export interface Phase0ZombieApplyReport {
  generatedAt: string;
  dryRun: boolean;
  actor: string | null;
  maxScan: number;
  maxClosures: number;
  restricted: boolean;
  schema: { ledgerTablePresent: boolean; closureColumnsPresent: boolean };
  population: { pendingRetries: number; processingRetries: number; scannable: number };
  ledger: { rows: number };
  scan: {
    /** Rows returned by the keyset window before locking. */
    window: number;
    locked: number;
    /** Input cursor, if this run resumed a prior page. */
    cursor: string | null;
    /**
     * Cursor for the next batch. It never advances past a row this run did not
     * classify, and it repeats the current page when `maxClosures` left
     * proposals unapplied.
     */
    nextCursor: string | null;
  };
  summary: {
    examined: number;
    proposedClosures: number;
    appliedClosures: number;
    skipped: number;
    closureLimitReached: boolean;
    scanLimitReached: boolean;
    byReason: Record<string, number>;
  };
  closures: Phase0ZombieApplyClosure[];
  skippedRows?: Phase0ZombieReconciliationRow[];
  warnings: string[];
}

export type Phase0ZombieApplyTransaction = 'COMMITTED' | 'ROLLED_BACK';

export interface Phase0ZombieApplyArgs {
  apply: boolean;
  actor: string | null;
  maxScan: number;
  maxClosures: number;
  cursor: string | null;
  includeRows: boolean;
  check: boolean;
  out: string | null;
  help: boolean;
}

export const PHASE0_ZOMBIE_APPLY_USAGE =
  'Usage: npx tsx scripts/phase0ZombieApply.ts --apply --actor=<operator> '
  + '[--max-scan=500] [--max-closures=100] [--cursor=<token>] [--include-rows] [--check] [--out=path]';

/** Immutable ordering key for the apply's keyset paging. */
export interface Phase0ZombieApplyCursor {
  at: string | null;
  id: string;
}

/**
 * Encode the last classified row as an opaque cursor. The queue clock is
 * nullable for historical rows, so `at: null` is a valid key inside the
 * NULLS FIRST band.
 *
 * The key preserves PostgreSQL's microsecond precision: `Date.toISOString()`
 * truncates to milliseconds, which can make a cursor re-include its own row
 * forever when `maxScan` is 1. The SQL returns `first_enqueued_at_key` in an
 * explicit UTC ISO form for that reason. The key is immutable, which is what
 * makes resuming safe even when closures remove earlier rows from the window.
 */
export function encodePhase0ZombieApplyCursor(row: {
  job_id?: unknown;
  first_enqueued_at?: unknown;
  first_enqueued_at_key?: unknown;
}): string | null {
  const id = String(row.job_id || '').trim();
  if (!UUID_PATTERN.test(id)) return null;
  let at: string | null = null;
  const rawKey = row.first_enqueued_at_key;
  if (typeof rawKey === 'string' && isValidTimestampKey(rawKey.trim())) {
    at = rawKey.trim();
  } else {
    const rawAt = row.first_enqueued_at;
    if (rawAt instanceof Date) {
      if (Number.isFinite(rawAt.getTime())) at = rawAt.toISOString();
    } else if (typeof rawAt === 'string' && isValidTimestampKey(rawAt.trim())) {
      at = rawAt.trim();
    }
  }
  return Buffer.from(JSON.stringify({ v: 1, at, id }), 'utf8').toString('base64url');
}

/** Strict cursor parsing: malformed input must fail before any query runs. */
export function parsePhase0ZombieApplyCursor(raw: unknown): Phase0ZombieApplyCursor {
  const token = String(raw ?? '').trim();
  if (!token
      || token.length > PHASE0_ZOMBIE_APPLY_MAX_CURSOR_LENGTH
      || !BASE64URL_PATTERN.test(token)) {
    throw new Error('--cursor is invalid');
  }
  let decoded: any;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new Error('--cursor is invalid');
  }
  if (!decoded || typeof decoded !== 'object' || decoded.v !== 1) {
    throw new Error('--cursor is invalid');
  }
  const id = typeof decoded.id === 'string' ? decoded.id : '';
  if (!UUID_PATTERN.test(id)) throw new Error('--cursor is invalid');
  const at = decoded.at === null
    ? null
    : (typeof decoded.at === 'string' ? decoded.at : undefined);
  if (at === undefined || (at !== null && !isValidTimestampKey(at))) {
    throw new Error('--cursor is invalid');
  }
  return { at, id };
}

/** Shared actor validation: trimmed, bounded, and free of control characters. */
export function normalizeZombieApplyActor(raw: unknown): string {
  const actor = String(raw ?? '').trim();
  if (!actor) {
    throw new Error('--actor is required when --apply is set');
  }
  if (actor.length > PHASE0_ZOMBIE_APPLY_MAX_ACTOR_LENGTH) {
    throw new Error(`--actor must be at most ${PHASE0_ZOMBIE_APPLY_MAX_ACTOR_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(actor)) {
    throw new Error('--actor must not contain control characters');
  }
  return actor;
}

function parseBoundedInteger(rawValue: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}: "${rawValue}"`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}: "${rawValue}"`);
  }
  return value;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested < min) return fallback;
  return Math.min(Math.floor(requested), max);
}

function normalizeJobIds(raw: readonly string[] | undefined): string[] | null {
  if (!raw || raw.length === 0) return null;
  const ids = [...new Set(raw.map(value => String(value || '').trim()).filter(Boolean))];
  if (ids.length === 0) return null;
  if (ids.length > PHASE0_ZOMBIE_APPLY_MAX_CLOSURES) {
    throw new Error(`jobIds may contain at most ${PHASE0_ZOMBIE_APPLY_MAX_CLOSURES} entries`);
  }
  for (const id of ids) {
    if (!UUID_PATTERN.test(id)) throw new Error(`jobIds contains a malformed UUID: "${id}"`);
  }
  return ids;
}

export function parsePhase0ZombieApplyArgs(
  argv: readonly string[],
): Phase0ZombieApplyArgs {
  const args: Phase0ZombieApplyArgs = {
    apply: false,
    actor: null,
    maxScan: PHASE0_ZOMBIE_APPLY_DEFAULT_MAX_SCAN,
    maxClosures: PHASE0_ZOMBIE_APPLY_DEFAULT_MAX_CLOSURES,
    cursor: null,
    includeRows: false,
    check: false,
    out: null,
    help: false,
  };
  for (const raw of argv) {
    if (raw === '--apply') args.apply = true;
    else if (raw === '--include-rows') args.includeRows = true;
    else if (raw === '--check') args.check = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--actor=')) {
      args.actor = normalizeZombieApplyActor(raw.slice('--actor='.length));
    } else if (raw.startsWith('--max-scan=')) {
      args.maxScan = parseBoundedInteger(
        raw.slice('--max-scan='.length),
        '--max-scan',
        1,
        PHASE0_ZOMBIE_APPLY_MAX_SCAN,
      );
    } else if (raw.startsWith('--max-closures=')) {
      args.maxClosures = parseBoundedInteger(
        raw.slice('--max-closures='.length),
        '--max-closures',
        1,
        PHASE0_ZOMBIE_APPLY_MAX_CLOSURES,
      );
    } else if (raw.startsWith('--cursor=')) {
      const token = raw.slice('--cursor='.length);
      parsePhase0ZombieApplyCursor(token);
      args.cursor = token;
    } else if (raw.startsWith('--out=')) {
      const out = raw.slice('--out='.length);
      if (!out.trim()) throw new Error('--out must name a non-empty file path');
      args.out = out;
    } else {
      throw new Error(`unknown argument: "${raw}". ${PHASE0_ZOMBIE_APPLY_USAGE}`);
    }
  }
  if (args.apply && !args.actor) {
    throw new Error(`--apply requires --actor. ${PHASE0_ZOMBIE_APPLY_USAGE}`);
  }
  return args;
}

/**
 * Closure evidence is captured at write time from the same classified row the
 * dry-run exposes. It is deliberately self-contained: an auditor can verify a
 * closure without recomputing eligibility against a database that has moved on.
 */
export function buildZombieClosureEvidence(
  row: Phase0ZombieReconciliationRow,
  closedAt: string | null,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    classifier: 'phase0-zombie-retry-closure',
    classifierVersion: PHASE0_ZOMBIE_APPLY_CLASSIFIER_VERSION,
    reason: row.reason,
    criterion: row.reason === 'CHANNEL_TERMINAL' ? 'channel_terminal' : 'ledger_all_terminal',
    job: {
      id: row.jobId,
      type: ZOMBIE_RETRY_JOB_TYPE,
      statusAtClosure: row.jobStatus,
      firstEnqueuedAt: row.firstEnqueuedAt,
      retryObservedAt: row.retryObservedAt,
      reopenGeneration: row.reopenGeneration,
    },
    channel: {
      id: row.channelId,
      present: row.channelPresent,
      discordValidationStatus: row.discordValidationStatus,
      discordStatus: row.discordStatus,
    },
    ledger: {
      rows: row.ledgerRows,
      activeRows: row.ledgerActiveRows,
      terminalRows: row.ledgerTerminalRows,
    },
    newerRetryOwningObservations: row.newerRetryOwningObservations,
    supportingEvidence: [...row.evidence],
    closedAt,
  };
}

/**
 * `--check` gate for an apply run. Bounded truncation is normal and therefore
 * not a failure; a skipped update or a partition mismatch is.
 */
export function phase0ZombieApplyCheckFailures(report: Phase0ZombieApplyReport): string[] {
  const failures: string[] = [];
  if (!report.schema.closureColumnsPresent) failures.push('closure_columns_missing');
  if (!report.schema.ledgerTablePresent) failures.push('ledger_table_missing');
  if (report.summary.examined > 0
      && report.summary.proposedClosures + report.summary.skipped
         !== report.summary.examined) {
    failures.push('decision_partition_mismatch');
  }
  if (report.warnings.some(warning => warning.startsWith('closure_update_skipped'))) {
    failures.push('closure_update_skipped');
  }
  return failures;
}

/**
 * Finalize the report against the transaction outcome. A rolled-back apply
 * wrote nothing, so its audit artifact must not claim that closures, actors,
 * or closure timestamps persisted, and its cursor must not skip the rows it
 * tried to close: those rows are still `PENDING`, so resume at the input page.
 * A report-only scan never attempted writes and keeps its computed
 * `nextCursor` for read-only paging. `proposedClosures` keeps the plan size.
 */
export function finalizePhase0ZombieApplyReport(
  report: Phase0ZombieApplyReport,
  transaction: Phase0ZombieApplyTransaction,
): Phase0ZombieApplyReport & { transaction: Phase0ZombieApplyTransaction } {
  if (transaction === 'COMMITTED') return { ...report, transaction };
  return {
    ...report,
    summary: { ...report.summary, appliedClosures: 0 },
    scan: {
      ...report.scan,
      nextCursor: report.summary.appliedClosures > 0
        ? report.scan.cursor
        : report.scan.nextCursor,
    },
    closures: report.closures.map(closure => ({
      ...closure,
      applied: false,
      closedAt: null,
      actor: null,
    })),
    transaction,
  };
}

function zombieApplyPopulationSql(restricted: boolean): string {
  return `
    SELECT count(*) FILTER (WHERE status='PENDING')::int AS pending_retries,
           count(*) FILTER (WHERE status='PROCESSING')::int AS processing_retries,
           count(*) FILTER (
             WHERE status='PENDING' AND closed_at IS NULL
           )::int AS scannable
      FROM jobs
     WHERE type='${ZOMBIE_RETRY_JOB_TYPE}'
       AND status IN ('PENDING','PROCESSING')
       ${restricted ? 'AND id = ANY($1::uuid[])' : ''}
  `;
}

export async function runPhase0ZombieApply(
  db: Phase0ZombieReconciliationDb,
  options: Phase0ZombieApplyOptions = {},
): Promise<Phase0ZombieApplyReport> {
  const apply = options.apply === true;
  const actor = apply
    ? normalizeZombieApplyActor(options.actor)
    : (options.actor === null || options.actor === undefined
      ? null
      : normalizeZombieApplyActor(options.actor));
  const maxScan = boundedInteger(
    options.maxScan,
    PHASE0_ZOMBIE_APPLY_DEFAULT_MAX_SCAN,
    1,
    PHASE0_ZOMBIE_APPLY_MAX_SCAN,
  );
  const maxClosures = boundedInteger(
    options.maxClosures,
    PHASE0_ZOMBIE_APPLY_DEFAULT_MAX_CLOSURES,
    1,
    PHASE0_ZOMBIE_APPLY_MAX_CLOSURES,
  );
  const jobIds = normalizeJobIds(options.jobIds);
  const restricted = jobIds !== null;
  const cursorToken = options.cursor === null || options.cursor === undefined
    ? null
    : String(options.cursor).trim();
  if (restricted && cursorToken) {
    throw new Error('--cursor cannot be combined with an explicit jobIds batch');
  }
  const cursor = cursorToken ? parsePhase0ZombieApplyCursor(cursorToken) : null;
  const includeRows = options.includeRows === true;
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();

  const schemaResult = await db.query(zombieReconciliationSchemaSql());
  const schema = {
    ledgerTablePresent: schemaResult.rows[0]?.ledger_table_present === true,
    closureColumnsPresent: schemaResult.rows[0]?.closure_columns_present === true,
  };
  if (!schema.closureColumnsPresent) {
    throw new Error(
      'ZOMBIE_APPLY_SCHEMA_MISSING: migration 167 closure columns are not present',
    );
  }
  if (!schema.ledgerTablePresent) {
    throw new Error(
      'ZOMBIE_APPLY_SCHEMA_MISSING: community_acquisition_url_state is not present',
    );
  }

  const populationResult = await db.query(
    zombieApplyPopulationSql(restricted),
    restricted ? [jobIds] : [],
  );
  const pendingRetries = Number(populationResult.rows[0]?.pending_retries || 0);
  const processingRetries = Number(populationResult.rows[0]?.processing_retries || 0);
  const scannable = Number(populationResult.rows[0]?.scannable || 0);

  const ledgerResult = await db.query(
    `SELECT count(*)::int AS rows FROM community_acquisition_url_state`,
  );
  const ledgerRows = Number(ledgerResult.rows[0]?.rows || 0);

  // Page first, then lock exactly that page. `OFFSET` is deliberately absent:
  // closures leave the candidate window, so a row-count offset would skip
  // survivors on the next batch. Fetching one extra row tells us whether a
  // later page exists without a second population query.
  const candidateWindow = await db.query(
    zombieCandidateJobIdsSql({
      statuses: ['PENDING'],
      excludeClosed: true,
      restricted,
      after: cursor !== null,
      includeKey: true,
    }),
    restricted
      ? [maxScan + 1, jobIds]
      : cursor
        ? [maxScan + 1, cursor.at, cursor.id]
        : [maxScan + 1],
  );
  const candidateRows = candidateWindow.rows.filter(row => String(row.job_id || ''));
  const hasMore = candidateRows.length > maxScan;
  const window = candidateRows.slice(0, maxScan);
  const windowIds = window.map(row => String(row.job_id));

  let lockedIds: string[] = [];
  if (windowIds.length > 0) {
    const locked = await db.query(
      zombieCandidateJobIdsSql({
        statuses: ['PENDING'],
        excludeClosed: true,
        restricted: true,
        lock: true,
      }),
      [windowIds.length, windowIds],
    );
    const lockedSet = new Set(
      locked.rows.map(row => String(row.job_id || '')).filter(Boolean),
    );
    // Preserve the immutable queue order for cursor bookkeeping.
    lockedIds = windowIds.filter(id => lockedSet.has(id));
  }
  const lockedSet = new Set(lockedIds);
  const unexaminedIds = windowIds.filter(id => !lockedSet.has(id));

  let rows: Phase0ZombieReconciliationRow[] = [];
  const knownObservationIdsByJob = new Map<string, string[]>();
  if (lockedIds.length > 0) {
    const evidence = await db.query(
      zombieEvidenceSqlForJobIds(true),
      [lockedIds],
    );
    const newerObservations = await db.query(
      zombieNewerObservationSqlByJobIds(),
      [lockedIds, ZOMBIE_COMMUNITY_SURFACES],
    );
    for (const observation of newerObservations.rows) {
      const jobId = String(observation.job_id || '');
      const observationId = String(observation.id || '');
      if (!jobId || !observationId) continue;
      const ids = knownObservationIdsByJob.get(jobId) || [];
      ids.push(observationId);
      knownObservationIdsByJob.set(jobId, ids);
    }
    rows = buildZombieReconciliationRows(evidence.rows, newerObservations.rows);
  }

  const proposals = rows.filter(row => row.decision === 'PROPOSE_CLOSE');
  const skippedRows = rows.filter(row => row.decision === 'SKIP');
  const selected = proposals.slice(0, maxClosures);
  const warnings: string[] = [];
  const closures: Phase0ZombieApplyClosure[] = [];
  const updateSkippedIds: string[] = [];

  if (!apply) {
    for (const row of selected) {
      closures.push({
        jobId: row.jobId,
        channelId: row.channelId,
        reason: row.reason as ZombieClosureReason,
        applied: false,
        closedAt: null,
        actor: null,
        evidence: buildZombieClosureEvidence(row, null),
      });
    }
  } else {
    for (const row of selected) {
      const closedAt = now().toISOString();
      const evidence = buildZombieClosureEvidence(row, closedAt);
      const updated = await db.query(
        `UPDATE jobs
            SET status='COMPLETED',
                completed_at=COALESCE(completed_at,$5::timestamptz),
                locked_by=NULL,
                locked_at=NULL,
                closed_reason=$2,
                closed_evidence=$3::jsonb,
                closed_by=$4,
                closed_at=$5::timestamptz,
                updated_at=now()
          WHERE id=$1
            AND status='PENDING'
            AND closed_at IS NULL
            AND ${zombieClosureEvidenceGuardSql('$6', '$7')}
          RETURNING id`,
        [
          row.jobId,
          row.reason,
          JSON.stringify(evidence),
          actor,
          closedAt,
          ZOMBIE_COMMUNITY_SURFACES,
          knownObservationIdsByJob.get(row.jobId) || [],
        ],
      );
      if (!updated.rows || updated.rows.length === 0) {
        warnings.push(`closure_update_skipped:${row.jobId}`);
        updateSkippedIds.push(row.jobId);
        continue;
      }
      closures.push({
        jobId: row.jobId,
        channelId: row.channelId,
        reason: row.reason as ZombieClosureReason,
        applied: true,
        closedAt,
        actor,
        evidence,
      });
    }

    const appliedIds = closures.filter(closure => closure.applied).map(closure => closure.jobId);
    if (appliedIds.length > 0) {
      await db.query(
        `UPDATE job_attempts
            SET status='COMPLETED',
                finished_at=COALESCE(finished_at,now())
          WHERE job_id=ANY($1::uuid[])
            AND finished_at IS NULL`,
        [appliedIds],
      );
    }
  }

  if (ledgerRows === 0) {
    warnings.push('phase0_ledger_empty_channel_evidence_only');
  }
  const closureLimitReached = proposals.length > selected.length;
  if (closureLimitReached) {
    warnings.push('closure_limit_reached');
  }
  const scanLimitReached = !restricted && hasMore;
  if (scanLimitReached) {
    warnings.push('scan_limit_reached');
  }
  if (unexaminedIds.length > 0) {
    warnings.push('candidate_rows_locked_by_workers');
  }

  // A cursor may only advance past rows this run actually classified. If a
  // worker locked a window row or the statement-time guard skipped an update,
  // resume at the row before the earliest such problem. If `maxClosures`
  // truncated the proposals, repeat the current page (or start over when
  // there was no cursor), because those proposals remain pending.
  const problemIds = new Set([...unexaminedIds, ...updateSkippedIds]);
  const firstProblemIndex = windowIds.findIndex(id => problemIds.has(id));
  let nextCursor: string | null;
  if (firstProblemIndex === 0) {
    nextCursor = cursorToken;
  } else if (firstProblemIndex > 0) {
    nextCursor = encodePhase0ZombieApplyCursor(window[firstProblemIndex - 1]);
  } else if (closureLimitReached) {
    nextCursor = cursorToken;
  } else if (scanLimitReached) {
    nextCursor = encodePhase0ZombieApplyCursor(window[window.length - 1]);
  } else {
    nextCursor = null;
  }

  const byReason: Record<string, number> = {};
  for (const row of rows) byReason[row.reason] = (byReason[row.reason] || 0) + 1;

  const report: Phase0ZombieApplyReport = {
    generatedAt,
    dryRun: !apply,
    actor,
    maxScan,
    maxClosures,
    restricted,
    schema,
    population: {
      pendingRetries,
      processingRetries,
      scannable,
    },
    ledger: { rows: ledgerRows },
    scan: {
      window: windowIds.length,
      locked: lockedIds.length,
      cursor: cursorToken,
      nextCursor,
    },
    summary: {
      examined: rows.length,
      proposedClosures: proposals.length,
      appliedClosures: closures.filter(closure => closure.applied).length,
      skipped: skippedRows.length,
      closureLimitReached,
      scanLimitReached,
      byReason,
    },
    closures,
    warnings,
  };
  if (includeRows) report.skippedRows = skippedRows;
  return report;
}
