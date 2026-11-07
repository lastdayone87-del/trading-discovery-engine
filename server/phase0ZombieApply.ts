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
 *   * the batch is bounded by both `maxScan` and `maxClosures`, and `offset`
 *     lets an operator advance past a window dominated by permanent skips;
 *   * report-only mode (no `--apply`) issues no writes;
 *   * the closure UPDATE re-checks the ownership prefilter and active ledger
 *     state at statement time, so evidence committed after the evidence query
 *     still blocks the write;
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
export const PHASE0_ZOMBIE_APPLY_MAX_OFFSET = 1_000_000;
export const PHASE0_ZOMBIE_APPLY_MAX_ACTOR_LENGTH = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Phase0ZombieApplyOptions {
  /** When false (the default), classify and report without writing. */
  apply?: boolean;
  /** Required when apply=true; recorded verbatim in `jobs.closed_by`. */
  actor?: string | null;
  /** Bound on locked candidate jobs. */
  maxScan?: number;
  /** Bound on applied closures from one scan. */
  maxClosures?: number;
  /** Advance the bounded candidate window past permanent skips. */
  offset?: number;
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
  scan: { locked: number; offset: number; nextOffset: number | null };
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

export interface Phase0ZombieApplyArgs {
  apply: boolean;
  actor: string | null;
  maxScan: number;
  maxClosures: number;
  offset: number;
  includeRows: boolean;
  check: boolean;
  out: string | null;
  help: boolean;
}

export const PHASE0_ZOMBIE_APPLY_USAGE =
  'Usage: npx tsx scripts/phase0ZombieApply.ts --apply --actor=<operator> '
  + '[--max-scan=500] [--max-closures=100] [--offset=0] [--include-rows] [--check] [--out=path]';

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
    offset: 0,
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
    } else if (raw.startsWith('--offset=')) {
      args.offset = parseBoundedInteger(
        raw.slice('--offset='.length),
        '--offset',
        0,
        PHASE0_ZOMBIE_APPLY_MAX_OFFSET,
      );
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
  const offset = boundedInteger(options.offset, 0, 0, PHASE0_ZOMBIE_APPLY_MAX_OFFSET);
  const jobIds = normalizeJobIds(options.jobIds);
  const restricted = jobIds !== null;
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

  const candidates = await db.query(
    zombieCandidateJobIdsSql({
      statuses: ['PENDING'],
      excludeClosed: true,
      lock: true,
      restricted,
      paged: true,
    }),
    restricted ? [maxScan, jobIds, offset] : [maxScan, offset],
  );
  const lockedIds = candidates.rows
    .map(row => String(row.job_id || ''))
    .filter(Boolean);

  let rows: Phase0ZombieReconciliationRow[] = [];
  if (lockedIds.length > 0) {
    const evidence = await db.query(
      zombieEvidenceSqlForJobIds(true),
      [lockedIds],
    );
    const newerObservations = await db.query(
      zombieNewerObservationSqlByJobIds(),
      [lockedIds, ZOMBIE_COMMUNITY_SURFACES],
    );
    rows = buildZombieReconciliationRows(evidence.rows, newerObservations.rows);
  }

  const proposals = rows.filter(row => row.decision === 'PROPOSE_CLOSE');
  const skippedRows = rows.filter(row => row.decision === 'SKIP');
  const selected = proposals.slice(0, maxClosures);
  const warnings: string[] = [];
  const closures: Phase0ZombieApplyClosure[] = [];

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
            AND ${zombieClosureEvidenceGuardSql('$6')}
          RETURNING id`,
        [
          row.jobId,
          row.reason,
          JSON.stringify(evidence),
          actor,
          closedAt,
          ZOMBIE_COMMUNITY_SURFACES,
        ],
      );
      if (!updated.rows || updated.rows.length === 0) {
        warnings.push(`closure_update_skipped:${row.jobId}`);
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
  if (proposals.length > selected.length) {
    warnings.push('closure_limit_reached');
  }
  const remainingAfterScan = Math.max(0, scannable - offset - lockedIds.length);
  const scanLimitReached = !restricted
    && lockedIds.length === maxScan
    && remainingAfterScan > 0;
  if (scanLimitReached) {
    warnings.push('scan_limit_reached');
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
      locked: lockedIds.length,
      offset,
      nextOffset: scanLimitReached ? offset + lockedIds.length : null,
    },
    summary: {
      examined: rows.length,
      proposedClosures: proposals.length,
      appliedClosures: closures.filter(closure => closure.applied).length,
      skipped: skippedRows.length,
      closureLimitReached: proposals.length > selected.length,
      scanLimitReached,
      byReason,
    },
    closures,
    warnings,
  };
  if (includeRows) report.skippedRows = skippedRows;
  return report;
}
