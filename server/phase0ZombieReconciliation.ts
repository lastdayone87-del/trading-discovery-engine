/**
 * Phase 0 zombie retry reconciliation — dry-run (read-only).
 *
 * A pending `RETRY_COMMUNITY_ACQUISITION` job is a zombie only when evidence
 * proves the channel's community work is already resolved or externally
 * terminal. Age alone never closes a job. The closure criteria are the ones
 * recorded in the approved Phase 0 plan (P0.4):
 *
 *   1. the channel is terminally resolved
 *      (`discord_validation_status IN ('SUCCEEDED','COMPLETED')` or
 *      `discord_status='FOUND'`), or every URL work ledger row is terminal
 *      (`RESOLVED` / `PARKED_EXTERNAL` / `EXHAUSTED`);
 *   2. the channel has no active URL work row
 *      (`PENDING` / `RUNNING` / `PARKED_INFRA`);
 *   3. no observation newer than the job's `retryObservedAt` owns retry on a
 *      community surface (shared `observationOwnsRetry` predicate).
 *
 * This module never writes. It returns proposals for operator review; the
 * bounded apply is a separate, operator-gated capability. The CLI wrapper is
 * `scripts/phase0ZombieReconciliationDryRun.ts`, and the builder is kept here
 * so the PostgreSQL regression exercises the same SQL operators run.
 *
 * Phase 0 runs before the URL work ledger is populated (dual-write starts in
 * Phase 1), so the ledger branch is usually unavailable. The report says so
 * explicitly and falls back to channel-terminal evidence only; it never
 * silently treats an empty ledger as proof that every URL resolved.
 */

import {
  COMMUNITY_ACQUISITION_WORK_SURFACES,
  observationOwnsRetry,
  type CommunityWorkObservation,
} from './communityAcquisitionWorkLedger';

export const ZOMBIE_RETRY_JOB_TYPE = 'RETRY_COMMUNITY_ACQUISITION';

export const ZOMBIE_TERMINAL_LEDGER_STATES = ['RESOLVED', 'PARKED_EXTERNAL', 'EXHAUSTED'] as const;
export const ZOMBIE_ACTIVE_LEDGER_STATES = ['PENDING', 'RUNNING', 'PARKED_INFRA'] as const;

function sqlStateList(states: readonly string[]): string {
  return states.map(state => `'${state}'`).join(',');
}

/** Community surfaces whose observation can own a channel retry. */
export const ZOMBIE_COMMUNITY_SURFACES: readonly string[] = [...COMMUNITY_ACQUISITION_WORK_SURFACES];

export type ZombieClosureReason = 'CHANNEL_TERMINAL' | 'LEDGER_ALL_TERMINAL';

export type ZombieClosureSkipReason =
  | 'PROCESSING_ACTIVE'
  | 'MISSING_RETRY_OBSERVED_AT'
  | 'CHANNEL_NOT_FOUND'
  | 'CHANNEL_NOT_TERMINAL'
  | 'LEDGER_NOT_TERMINAL'
  | 'LEDGER_ACTIVE_WORK'
  | 'NEWER_RETRY_OWNING_OBSERVATION';

export interface ZombieRetryEvidence {
  jobStatus: string;
  channelPresent: boolean;
  discordValidationStatus: string | null;
  discordStatus: string | null;
  retryObservedAt: string | null;
  ledgerRows: number;
  ledgerActiveRows: number;
  ledgerTerminalRows: number;
  newerRetryOwningObservations: number;
}

export interface ZombieRetryDecision {
  decision: 'PROPOSE_CLOSE' | 'SKIP';
  reason: ZombieClosureReason | ZombieClosureSkipReason;
}

/**
 * Pure closure classifier. Order matters:
 *
 *   * an active lease is never closed;
 *   * without a valid retry epoch the newer-evidence test is inconclusive, so
 *     the job is skipped rather than closed;
 *   * a terminal channel row and a fully terminal ledger are independent
 *     sufficient forms of criterion 1, but criterion 2 applies to both;
 *   * fresh retry-owning evidence always wins over terminal history.
 */
export function classifyZombieRetryClosure(evidence: ZombieRetryEvidence): ZombieRetryDecision {
  if (evidence.jobStatus !== 'PENDING') {
    return { decision: 'SKIP', reason: 'PROCESSING_ACTIVE' };
  }
  if (!evidence.retryObservedAt || !Number.isFinite(Date.parse(evidence.retryObservedAt))) {
    return { decision: 'SKIP', reason: 'MISSING_RETRY_OBSERVED_AT' };
  }
  if (!evidence.channelPresent) {
    return { decision: 'SKIP', reason: 'CHANNEL_NOT_FOUND' };
  }

  const channelTerminal = evidence.discordValidationStatus === 'SUCCEEDED'
    || evidence.discordValidationStatus === 'COMPLETED'
    || evidence.discordStatus === 'FOUND';
  const ledgerAllTerminal = evidence.ledgerRows > 0
    && evidence.ledgerTerminalRows === evidence.ledgerRows;

  if (!channelTerminal && !ledgerAllTerminal) {
    return {
      decision: 'SKIP',
      reason: evidence.ledgerRows > 0 ? 'LEDGER_NOT_TERMINAL' : 'CHANNEL_NOT_TERMINAL',
    };
  }
  if (evidence.ledgerActiveRows > 0) {
    return { decision: 'SKIP', reason: 'LEDGER_ACTIVE_WORK' };
  }
  if (evidence.newerRetryOwningObservations > 0) {
    return { decision: 'SKIP', reason: 'NEWER_RETRY_OWNING_OBSERVATION' };
  }
  return {
    decision: 'PROPOSE_CLOSE',
    reason: channelTerminal ? 'CHANNEL_TERMINAL' : 'LEDGER_ALL_TERMINAL',
  };
}

export interface Phase0ZombieReconciliationOptions {
  /** Upper bound on examined jobs. The dry-run is small, but the bound keeps an
   * unexpected backlog from turning an operator report into an unbounded scan. */
  maxJobs?: number;
  includeRows?: boolean;
}

export interface Phase0ZombieReconciliationRow {
  jobId: string;
  channelId: string;
  jobStatus: string;
  channelPresent: boolean;
  discordValidationStatus: string | null;
  discordStatus: string | null;
  retryObservedAt: string | null;
  firstEnqueuedAt: string | null;
  jobAgeHours: number | null;
  reopenGeneration: number;
  ledgerRows: number;
  ledgerActiveRows: number;
  ledgerTerminalRows: number;
  newerRetryOwningObservations: number;
  decision: 'PROPOSE_CLOSE' | 'SKIP';
  reason: ZombieRetryDecision['reason'];
  evidence: string[];
}

export interface Phase0ZombieReconciliationReport {
  generatedAt: string;
  dryRun: true;
  maxJobs: number;
  schema: { ledgerTablePresent: boolean; closureColumnsPresent: boolean };
  population: {
    pendingRetries: number;
    processingRetries: number;
    scannable: number;
    examined: number;
  };
  ledger: { rows: number };
  summary: {
    proposedClosures: number;
    skipped: number;
    byReason: Record<string, number>;
  };
  proposals: Phase0ZombieReconciliationRow[];
  skippedRows?: Phase0ZombieReconciliationRow[];
  warnings: string[];
}

export interface Phase0ZombieReconciliationDb {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
}

/**
 * `--check` gate. A truncated candidate window is a hard failure: the report
 * examined only part of the backlog, so silence would understate zombies.
 */
export function phase0ZombieReconciliationCheckFailures(
  report: Phase0ZombieReconciliationReport,
): string[] {
  const failures: string[] = [];
  if (!report.schema.ledgerTablePresent) failures.push('ledger_table_missing');
  if (report.warnings.includes('candidate_limit_reached')) {
    failures.push('candidate_limit_reached');
  }
  if (report.population.examined > 0
      && report.summary.proposedClosures + report.summary.skipped
         !== report.population.examined) {
    failures.push('decision_partition_mismatch');
  }
  return failures;
}

export interface Phase0ZombieReconciliationArgs {
  maxJobs: number;
  includeRows: boolean;
  check: boolean;
  out: string | null;
  help: boolean;
}

export const PHASE0_ZOMBIE_RECONCILIATION_USAGE =
  'Usage: npx tsx scripts/phase0ZombieReconciliationDryRun.ts '
  + '[--max-jobs=5000] [--include-rows] [--check] [--out=path]';

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

export function parsePhase0ZombieReconciliationArgs(
  argv: readonly string[],
): Phase0ZombieReconciliationArgs {
  const args: Phase0ZombieReconciliationArgs = {
    maxJobs: 5_000,
    includeRows: false,
    check: false,
    out: null,
    help: false,
  };
  for (const raw of argv) {
    if (raw === '--include-rows') args.includeRows = true;
    else if (raw === '--check') args.check = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--max-jobs=')) {
      args.maxJobs = parseBoundedInteger(raw.slice('--max-jobs='.length), '--max-jobs', 1, 5_000);
    } else if (raw.startsWith('--out=')) {
      const out = raw.slice('--out='.length);
      if (!out.trim()) throw new Error('--out must name a non-empty file path');
      args.out = out;
    } else {
      throw new Error(`unknown argument: "${raw}". ${PHASE0_ZOMBIE_RECONCILIATION_USAGE}`);
    }
  }
  return args;
}

function nullableIso(value: unknown): string | null {
  if (!value) return null;
  const parsed = new Date(value as string | number | Date);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function evidenceLines(evidence: ZombieRetryEvidence, reason: ZombieRetryDecision['reason']): string[] {
  const lines = [
    `channel=${evidence.discordValidationStatus || 'UNKNOWN'}:${evidence.discordStatus || 'UNKNOWN'}`,
    `retry_observed_at=${evidence.retryObservedAt}`,
    `ledger_rows=${evidence.ledgerRows}`,
    `ledger_active_rows=${evidence.ledgerActiveRows}`,
    `ledger_terminal_rows=${evidence.ledgerTerminalRows}`,
    `newer_retry_owning_observations=${evidence.newerRetryOwningObservations}`,
  ];
  if (reason === 'CHANNEL_TERMINAL') lines.push('criterion=channel_terminal');
  if (reason === 'LEDGER_ALL_TERMINAL') lines.push('criterion=ledger_all_terminal');
  return lines;
}

export interface ZombieCandidateSqlOptions {
  /** Statuses eligible for the candidate window. Defaults to pending+processing. */
  statuses?: readonly ('PENDING' | 'PROCESSING')[];
  /** Exclude an epoch that already carries append-only closure evidence. */
  excludeClosed?: boolean;
  /** Lock candidates for the operator apply. */
  lock?: boolean;
  /** Restrict to explicit job ids in `$2`. */
  restricted?: boolean;
  /** Resume strictly after the immutable `(first_enqueued_at, id)` cursor. */
  after?: boolean;
  /** Include the queue clock and a microsecond-precision cursor key. */
  includeKey?: boolean;
}

/**
 * Shared bounded candidate identity query. Keeping identity separate from
 * evidence lets the apply path lock exactly these rows with
 * `FOR UPDATE SKIP LOCKED` and then reuse the same evidence assembly as the
 * dry-run, so the two paths cannot drift. Ordering is the immutable queue
 * clock, never age-of-lease.
 *
 * Paging is a keyset cursor on that ordering key, never a row-count `OFFSET`:
 * closures leave the candidate window, so an offset computed before a batch
 * would skip surviving candidates on the next page. `NULL` queue clocks sort
 * first, and the cursor comparison preserves that ordering.
 *
 * A closed epoch is excluded when closure columns exist: the closure record is
 * append-only and a later reopen is a new generation, so Phase 0 never rewrites
 * earlier evidence.
 */
export function zombieCandidateJobIdsSql(options: ZombieCandidateSqlOptions = {}): string {
  const statuses = options.statuses ?? ['PENDING', 'PROCESSING'];
  const predicates = [
    `j.type='${ZOMBIE_RETRY_JOB_TYPE}'`,
    `j.status IN (${statuses.map(status => `'${status}'`).join(',')})`,
  ];
  let nextParam = 2;
  if (options.excludeClosed) {
    predicates.push('j.closed_at IS NULL');
    // A reopened epoch (reopen_generation > 0) is the planned Phase 1
    // re-close gap, not a new Phase 0 zombie. Phase 0 must not re-close it.
    predicates.push('COALESCE(j.reopen_generation,0) = 0');
  }
  if (options.restricted) {
    predicates.push(`j.id = ANY($${nextParam++}::uuid[])`);
  }
  if (options.after) {
    const atParam = `$${nextParam++}`;
    const idParam = `$${nextParam++}`;
    predicates.push(`(
      CASE
        WHEN ${atParam}::timestamptz IS NULL THEN
          j.first_enqueued_at IS NOT NULL
          OR (j.first_enqueued_at IS NULL AND j.id > ${idParam}::uuid)
        ELSE
          j.first_enqueued_at > ${atParam}::timestamptz
          OR (j.first_enqueued_at = ${atParam}::timestamptz AND j.id > ${idParam}::uuid)
      END
    )`);
  }
  return `
    SELECT j.id AS job_id${options.includeKey
      ? `,
           j.first_enqueued_at AS first_enqueued_at,
           to_char(
             j.first_enqueued_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) AS first_enqueued_at_key`
      : ''}
      FROM jobs j
     WHERE ${predicates.join('\n       AND ')}
     ORDER BY j.first_enqueued_at ASC NULLS FIRST, j.id ASC
     LIMIT $1
     ${options.lock ? 'FOR UPDATE SKIP LOCKED' : ''}
  `;
}

/**
 * Schema probe shared by the dry-run and apply. The closure columns arrive in
 * migration 167, after the dry-run shipped, so the report must tolerate their
 * absence and say so rather than crash or silently assume they exist.
 */
export function zombieReconciliationSchemaSql(): string {
  return `
    SELECT to_regclass('public.community_acquisition_url_state') IS NOT NULL
             AS ledger_table_present,
           (
             SELECT count(*) = 4
               FROM information_schema.columns
              WHERE table_schema='public'
                AND table_name='jobs'
                AND column_name IN (
                  'closed_reason','closed_evidence','closed_by','closed_at'
                )
           ) AS closure_columns_present
  `;
}

/**
 * Shared SQL prefilter for observations that may own retry: ledger work that
 * is stored retryable. It is a deliberate superset of `observationOwnsRetry`
 * (which also rejects auxiliary/shared evidence), so SQL can narrow the scan
 * without deciding ownership. The final decision always stays in TypeScript.
 *
 * `CASE` protects the `timestamptz` cast: `pg_input_is_valid` and the cast in
 * the same `AND` chain have no guaranteed evaluation order, and a malformed
 * `retryObservedAt` must skip the job, never abort the whole report.
 */
function zombieObservationOwnershipPrefilterSql(args: {
  observationAlias: string;
  channelExpression: string;
  retryObservedAtExpression: string;
  surfacesParam: string;
}): string {
  const o = args.observationAlias;
  return `${o}.channel_id = ${args.channelExpression}
       AND CASE
             WHEN pg_input_is_valid(
               btrim(COALESCE(${args.retryObservedAtExpression},'')),
               'timestamptz'
             )
             THEN ${o}.observed_at > btrim(${args.retryObservedAtExpression})::timestamptz
             ELSE false
           END
       AND ${o}.provenance->>'surface' = ANY(${args.surfacesParam}::text[])
       AND ${o}.retryable = true
       AND (
         ${o}.provenance->'required' = 'true'::jsonb
         OR (
           ${o}.outcome = 'PARTIALLY_INSPECTED'
           AND ${o}.failure_class = 'STATIC_BUDGET_GAP'
         )
       )`;
}

/**
 * Statement-time closure guard for the apply UPDATE. It re-checks the same
 * coarse ownership prefilter under the UPDATE's own snapshot, so evidence
 * committed after the evidence query but before the write still blocks the
 * closure.
 *
 * Observations already returned by the batch evidence query are excluded by
 * id: `observationOwnsRetry` has already decided whether they own a retry, and
 * encoding that rule a second time in SQL would drift (for example, a
 * `DEMOTE` or auxiliary row must not block a valid closure). The guard
 * therefore blocks only coarse-owning evidence that appeared after the batch
 * snapshot. A brand-new non-owning row can conservatively block one attempt;
 * the next reviewed run classifies it and proceeds.
 *
 * Full synchronization with evidence writers is a Phase 1 concern (atomic
 * claim/lease/recovery); this guard removes the avoidable window without
 * duplicating the ownership policy.
 */
export function zombieClosureEvidenceGuardSql(
  surfacesParam: string,
  knownObservationIdsParam: string,
): string {
  return `
    NOT EXISTS (
      SELECT 1
        FROM external_acquisition_observations o
       WHERE ${zombieObservationOwnershipPrefilterSql({
         observationAlias: 'o',
         channelExpression: "COALESCE(jobs.payload->>'channelId','')",
         retryObservedAtExpression: "jobs.payload->>'retryObservedAt'",
         surfacesParam,
       })}
         AND o.id <> ALL(${knownObservationIdsParam}::uuid[])
    )
    AND NOT EXISTS (
      SELECT 1
        FROM community_acquisition_url_state l
       WHERE l.channel_id = COALESCE(jobs.payload->>'channelId','')
         AND l.state IN (${sqlStateList(ZOMBIE_ACTIVE_LEDGER_STATES)})
    )
  `;
}

/**
 * Evidence for a bounded set of retry job ids. The ledger CTE is conditional
 * because Phase 0 can run against a database where migration 166 has not been
 * applied yet. A missing table is reported as an explicit warning, never as
 * "zero active rows, therefore resolved".
 */
export function zombieEvidenceSqlForJobIds(ledgerTablePresent: boolean): string {
  const ledgerCte = ledgerTablePresent
    ? `ledger AS (
         SELECT l.channel_id,
                count(*)::int AS ledger_rows,
                count(*) FILTER (
                  WHERE l.state IN (${sqlStateList(ZOMBIE_ACTIVE_LEDGER_STATES)})
                )::int AS ledger_active_rows,
                count(*) FILTER (
                  WHERE l.state IN (${sqlStateList(ZOMBIE_TERMINAL_LEDGER_STATES)})
                )::int AS ledger_terminal_rows
           FROM community_acquisition_url_state l
          WHERE l.channel_id IN (SELECT channel_id FROM candidate_channels)
          GROUP BY l.channel_id
       )`
    : `ledger AS (
         SELECT NULL::text AS channel_id,
                0::int AS ledger_rows,
                0::int AS ledger_active_rows,
                0::int AS ledger_terminal_rows
          WHERE false
       )`;

  return `
    WITH candidate_channels AS (
      SELECT DISTINCT COALESCE(j.payload->>'channelId','') AS channel_id
        FROM jobs j
       WHERE j.id = ANY($1::uuid[])
         AND COALESCE(j.payload->>'channelId','') <> ''
    ),
    ${ledgerCte}
    SELECT j.id AS job_id,
           COALESCE(j.payload->>'channelId','') AS channel_id,
           j.status AS job_status,
           j.created_at,
           j.first_enqueued_at,
           COALESCE(j.reopen_generation,0) AS reopen_generation,
           CASE
             WHEN pg_input_is_valid(
               btrim(COALESCE(j.payload->>'retryObservedAt','')),
               'timestamptz'
             )
             THEN btrim(j.payload->>'retryObservedAt')::timestamptz
           END AS retry_observed_at,
           ch.channel_id IS NOT NULL AS channel_present,
           ch.discord_validation_status,
           ch.discord_status,
           COALESCE(l.ledger_rows,0) AS ledger_rows,
           COALESCE(l.ledger_active_rows,0) AS ledger_active_rows,
           COALESCE(l.ledger_terminal_rows,0) AS ledger_terminal_rows
      FROM jobs j
      LEFT JOIN channels ch ON ch.channel_id = COALESCE(j.payload->>'channelId','')
      LEFT JOIN ledger l ON l.channel_id = COALESCE(j.payload->>'channelId','')
     WHERE j.id = ANY($1::uuid[])
       AND j.type='${ZOMBIE_RETRY_JOB_TYPE}'
     ORDER BY j.first_enqueued_at ASC NULLS FIRST, j.id ASC
  `;
}

/**
 * Observations newer than each selected job's retry epoch. Retry ownership is
 * decided in the builder by the shared `observationOwnsRetry` predicate, never
 * by a SQL approximation of `required && retryable`. The raw `provenance`
 * object is returned unprojected so optional `STATIC_BUDGET_GAP` owners and
 * demoted/auxiliary observations are classified exactly as the production
 * worker classifies them.
 *
 * The SQL prefilter is a deliberately coarse superset of retry owners: ledger
 * work (required rows or the static-gap exception) that is stored retryable.
 * Every row it removes would be rejected by `observationOwnsRetry` anyway, so
 * final ownership still lives in one shared predicate. The query is bounded by
 * the selected job ids, never by the whole observation history.
 */
export function zombieNewerObservationSqlByJobIds(): string {
  return `
    SELECT j.id AS job_id,
           o.requested_url,
           o.outcome,
           o.retryable,
           o.failure_class,
           o.observed_at,
           o.id,
           o.provenance
      FROM jobs j
      JOIN external_acquisition_observations o
        ON ${zombieObservationOwnershipPrefilterSql({
          observationAlias: 'o',
          channelExpression: "COALESCE(j.payload->>'channelId','')",
          retryObservedAtExpression: "j.payload->>'retryObservedAt'",
          surfacesParam: '$2',
        })}
     WHERE j.id = ANY($1::uuid[])
       AND j.type='${ZOMBIE_RETRY_JOB_TYPE}'
     ORDER BY j.id, o.observed_at, o.id
  `;
}

export interface ZombieMappedObservation {
  jobId: string;
  observation: CommunityWorkObservation;
}

/** Map a raw observation row; shared by the dry-run report and the apply path. */
export function mapZombieNewerObservation(raw: any): ZombieMappedObservation {
  return {
    jobId: String(raw.job_id || ''),
    observation: {
      channelId: '',
      requestedUrl: String(raw.requested_url || ''),
      outcome: String(raw.outcome || ''),
      retryable: raw.retryable === true,
      failureClass: raw.failure_class ? String(raw.failure_class) : null,
      observedAt: nullableIso(raw.observed_at) || '',
      id: raw.id ? String(raw.id) : undefined,
      provenance: raw.provenance,
    },
  };
}

/**
 * Build classified rows from evidence rows and the bounded newer-observation
 * rows. Both the dry-run and the operator apply call this function, so a
 * closure decision is produced by exactly one code path.
 */
export function buildZombieReconciliationRows(
  candidateRows: any[],
  newerObservationRows: any[],
  nowMs = Date.now(),
): Phase0ZombieReconciliationRow[] {
  const newerRetryOwningByJob = new Map<string, number>();
  for (const raw of newerObservationRows) {
    const { jobId, observation } = mapZombieNewerObservation(raw);
    if (!observationOwnsRetry(observation)) continue;
    newerRetryOwningByJob.set(jobId, (newerRetryOwningByJob.get(jobId) || 0) + 1);
  }

  const rows: Phase0ZombieReconciliationRow[] = [];
  for (const raw of candidateRows) {
    const retryObservedAt = nullableIso(raw.retry_observed_at);
    const firstEnqueuedAt = nullableIso(raw.first_enqueued_at);
    const evidence: ZombieRetryEvidence = {
      jobStatus: String(raw.job_status || ''),
      channelPresent: raw.channel_present === true,
      discordValidationStatus: raw.discord_validation_status
        ? String(raw.discord_validation_status)
        : null,
      discordStatus: raw.discord_status ? String(raw.discord_status) : null,
      retryObservedAt,
      ledgerRows: Number(raw.ledger_rows || 0),
      ledgerActiveRows: Number(raw.ledger_active_rows || 0),
      ledgerTerminalRows: Number(raw.ledger_terminal_rows || 0),
      newerRetryOwningObservations: newerRetryOwningByJob.get(String(raw.job_id || '')) || 0,
    };
    const outcome = classifyZombieRetryClosure(evidence);
    rows.push({
      jobId: String(raw.job_id || ''),
      channelId: String(raw.channel_id || ''),
      jobStatus: evidence.jobStatus,
      channelPresent: evidence.channelPresent,
      discordValidationStatus: evidence.discordValidationStatus,
      discordStatus: evidence.discordStatus,
      retryObservedAt,
      firstEnqueuedAt,
      jobAgeHours: firstEnqueuedAt
        ? Math.round(((nowMs - Date.parse(firstEnqueuedAt)) / 3_600_000) * 10) / 10
        : null,
      reopenGeneration: Number(raw.reopen_generation || 0),
      ledgerRows: evidence.ledgerRows,
      ledgerActiveRows: evidence.ledgerActiveRows,
      ledgerTerminalRows: evidence.ledgerTerminalRows,
      newerRetryOwningObservations: evidence.newerRetryOwningObservations,
      decision: outcome.decision,
      reason: outcome.reason,
      evidence: evidenceLines(evidence, outcome.reason),
    });
  }
  return rows;
}

export async function buildPhase0ZombieReconciliationReport(
  db: Phase0ZombieReconciliationDb,
  options: Phase0ZombieReconciliationOptions = {},
): Promise<Phase0ZombieReconciliationReport> {
  const requestedMaxJobs = options.maxJobs ?? 5_000;
  // `NaN`, zero, negative, and infinite bounds fall back to the default so a
  // bad caller can never produce `LIMIT NaN` or an unbounded scan.
  const maxJobs = Number.isFinite(requestedMaxJobs) && requestedMaxJobs >= 1
    ? Math.min(Math.floor(requestedMaxJobs), 5_000)
    : 5_000;
  const includeRows = options.includeRows === true;
  const generatedAt = new Date().toISOString();

  const schema = await db.query(zombieReconciliationSchemaSql());
  const ledgerTablePresent = schema.rows[0]?.ledger_table_present === true;
  const closureColumnsPresent = schema.rows[0]?.closure_columns_present === true;

  const populationResult = await db.query(
    `SELECT count(*) FILTER (WHERE status='PENDING')::int AS pending_retries,
            count(*) FILTER (WHERE status='PROCESSING')::int AS processing_retries,
            count(*) FILTER (
              WHERE status='PENDING'
              ${closureColumnsPresent ? 'AND closed_at IS NULL AND COALESCE(reopen_generation,0) = 0' : ''}
            )::int AS scannable_pending,
            count(*) FILTER (
              WHERE status='PROCESSING'
              ${closureColumnsPresent ? 'AND closed_at IS NULL AND COALESCE(reopen_generation,0) = 0' : ''}
            )::int AS scannable_processing
       FROM jobs
      WHERE type='${ZOMBIE_RETRY_JOB_TYPE}'
        AND status IN ('PENDING','PROCESSING')`,
  );
  const pendingRetries = Number(populationResult.rows[0]?.pending_retries || 0);
  const processingRetries = Number(populationResult.rows[0]?.processing_retries || 0);
  // Candidate eligibility, not raw status counts: a previously closed epoch
  // can reopen into PENDING or PROCESSING but is deliberately excluded from
  // this Phase 0 window, so counting it again would make a complete report
  // look truncated forever.
  const scannable = Number(
    populationResult.rows[0]?.scannable_pending ?? pendingRetries,
  ) + Number(
    populationResult.rows[0]?.scannable_processing ?? processingRetries,
  );

  const ledgerResult = ledgerTablePresent
    ? await db.query(`SELECT count(*)::int AS rows FROM community_acquisition_url_state`)
    : { rows: [{ rows: 0 }] };
  const ledgerRows = Number(ledgerResult.rows[0]?.rows || 0);

  const candidateIds = await db.query(
    zombieCandidateJobIdsSql({ excludeClosed: closureColumnsPresent }),
    [maxJobs],
  );
  const jobIds = candidateIds.rows
    .map(row => String(row.job_id || ''))
    .filter(Boolean);

  let rows: Phase0ZombieReconciliationRow[] = [];
  if (jobIds.length > 0) {
    const evidence = await db.query(
      zombieEvidenceSqlForJobIds(ledgerTablePresent),
      [jobIds],
    );
    const newerObservations = await db.query(
      zombieNewerObservationSqlByJobIds(),
      [jobIds, ZOMBIE_COMMUNITY_SURFACES],
    );
    rows = buildZombieReconciliationRows(evidence.rows, newerObservations.rows);
  }

  const proposals = rows.filter(row => row.decision === 'PROPOSE_CLOSE');
  const skippedRows = rows.filter(row => row.decision === 'SKIP');
  const byReason: Record<string, number> = {};
  for (const row of rows) byReason[row.reason] = (byReason[row.reason] || 0) + 1;

  const warnings: string[] = [];
  if (!ledgerTablePresent) {
    warnings.push('ledger_table_missing_channel_evidence_only');
  } else if (ledgerRows === 0) {
    warnings.push('phase0_ledger_empty_channel_evidence_only');
  }
  if (!closureColumnsPresent) {
    warnings.push('closure_columns_missing_historical_epochs_not_filtered');
  }
  if (rows.length < scannable) {
    warnings.push('candidate_limit_reached');
  }

  const report: Phase0ZombieReconciliationReport = {
    generatedAt,
    dryRun: true,
    maxJobs,
    schema: { ledgerTablePresent, closureColumnsPresent },
    population: {
      pendingRetries,
      processingRetries,
      scannable,
      examined: rows.length,
    },
    ledger: { rows: ledgerRows },
    summary: {
      proposedClosures: proposals.length,
      skipped: skippedRows.length,
      byReason,
    },
    proposals,
    warnings,
  };
  if (includeRows) report.skippedRows = skippedRows;
  return report;
}
