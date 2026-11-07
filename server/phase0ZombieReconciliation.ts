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

const ZOMBIE_SURFACES = [...COMMUNITY_ACQUISITION_WORK_SURFACES];

function sqlStateList(states: readonly string[]): string {
  return states.map(state => `'${state}'`).join(',');
}

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
  schema: { ledgerTablePresent: boolean };
  population: { pendingRetries: number; processingRetries: number; examined: number };
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

/**
 * The ledger CTE is conditional because Phase 0 can run against a database
 * where migration 166 has not been applied yet. A missing table is reported as
 * an explicit warning, never as "zero active rows, therefore resolved".
 */
function zombieCandidateSql(ledgerTablePresent: boolean): string {
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
    WITH candidates AS (
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
             END AS retry_observed_at
        FROM jobs j
       WHERE j.type='${ZOMBIE_RETRY_JOB_TYPE}'
         AND j.status IN ('PENDING','PROCESSING')
       ORDER BY j.first_enqueued_at ASC NULLS FIRST, j.id ASC
       LIMIT $1
    ),
    candidate_channels AS (
      SELECT DISTINCT channel_id FROM candidates WHERE channel_id <> ''
    ),
    ${ledgerCte}
    SELECT c.job_id,
           c.channel_id,
           c.job_status,
           c.created_at,
           c.first_enqueued_at,
           c.reopen_generation,
           c.retry_observed_at,
           ch.channel_id IS NOT NULL AS channel_present,
           ch.discord_validation_status,
           ch.discord_status,
           COALESCE(l.ledger_rows,0) AS ledger_rows,
           COALESCE(l.ledger_active_rows,0) AS ledger_active_rows,
           COALESCE(l.ledger_terminal_rows,0) AS ledger_terminal_rows
      FROM candidates c
      LEFT JOIN channels ch ON ch.channel_id = c.channel_id
      LEFT JOIN ledger l ON l.channel_id = c.channel_id
     ORDER BY c.first_enqueued_at ASC NULLS FIRST, c.job_id ASC
  `;
}

/**
 * Observations newer than each candidate job's retry epoch. Retry ownership is
 * decided in the builder by the shared `observationOwnsRetry` predicate, never
 * by a SQL approximation of `required && retryable`. The candidate ordering and
 * limit must match `zombieCandidateSql` so both queries describe the same jobs.
 * The raw `provenance` object is returned unprojected so optional
 * `STATIC_BUDGET_GAP` owners and demoted/auxiliary observations are classified
 * exactly as the production worker classifies them.
 *
 * The SQL prefilter is a deliberately coarse superset of retry owners: ledger
 * work (required rows or the static-gap exception) that is stored retryable.
 * Every row it removes would be rejected by `observationOwnsRetry` anyway, so
 * final ownership still lives in one shared predicate.
 */
function zombieNewerObservationSql(): string {
  return `
    WITH candidates AS (
      SELECT j.id AS job_id,
             COALESCE(j.payload->>'channelId','') AS channel_id,
             CASE
               WHEN pg_input_is_valid(
                 btrim(COALESCE(j.payload->>'retryObservedAt','')),
                 'timestamptz'
               )
               THEN btrim(j.payload->>'retryObservedAt')::timestamptz
             END AS retry_observed_at
        FROM jobs j
       WHERE j.type='${ZOMBIE_RETRY_JOB_TYPE}'
         AND j.status IN ('PENDING','PROCESSING')
       ORDER BY j.first_enqueued_at ASC NULLS FIRST, j.id ASC
       LIMIT $1
    )
    SELECT c.job_id,
           o.requested_url,
           o.outcome,
           o.retryable,
           o.failure_class,
           o.observed_at,
           o.id,
           o.provenance
      FROM candidates c
      JOIN external_acquisition_observations o
        ON o.channel_id = c.channel_id
       AND c.retry_observed_at IS NOT NULL
       AND o.observed_at > c.retry_observed_at
       AND o.provenance->>'surface' = ANY($2::text[])
       AND o.retryable = true
       AND (
         o.provenance->'required' = 'true'::jsonb
         OR (
           o.outcome = 'PARTIALLY_INSPECTED'
           AND o.failure_class = 'STATIC_BUDGET_GAP'
         )
       )
     ORDER BY c.job_id, o.observed_at, o.id
  `;
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

  const schema = await db.query(
    `SELECT to_regclass('public.community_acquisition_url_state') IS NOT NULL
            AS ledger_table_present`,
  );
  const ledgerTablePresent = schema.rows[0]?.ledger_table_present === true;

  const populationResult = await db.query(
    `SELECT count(*) FILTER (WHERE status='PENDING')::int AS pending_retries,
            count(*) FILTER (WHERE status='PROCESSING')::int AS processing_retries
       FROM jobs
      WHERE type='${ZOMBIE_RETRY_JOB_TYPE}'
        AND status IN ('PENDING','PROCESSING')`,
  );
  const pendingRetries = Number(populationResult.rows[0]?.pending_retries || 0);
  const processingRetries = Number(populationResult.rows[0]?.processing_retries || 0);

  const ledgerResult = ledgerTablePresent
    ? await db.query(`SELECT count(*)::int AS rows FROM community_acquisition_url_state`)
    : { rows: [{ rows: 0 }] };
  const ledgerRows = Number(ledgerResult.rows[0]?.rows || 0);

  const candidates = await db.query(
    zombieCandidateSql(ledgerTablePresent),
    [maxJobs],
  );

  const newerRetryOwningByJob = new Map<string, number>();
  if (candidates.rows.length > 0) {
    const newerObservations = await db.query(
      zombieNewerObservationSql(),
      [maxJobs, ZOMBIE_SURFACES],
    );
    for (const raw of newerObservations.rows) {
      const observation: CommunityWorkObservation = {
        channelId: '',
        requestedUrl: String(raw.requested_url || ''),
        outcome: String(raw.outcome || ''),
        retryable: raw.retryable === true,
        failureClass: raw.failure_class ? String(raw.failure_class) : null,
        observedAt: nullableIso(raw.observed_at) || '',
        id: raw.id ? String(raw.id) : undefined,
        provenance: raw.provenance,
      };
      if (!observationOwnsRetry(observation)) continue;
      const jobId = String(raw.job_id || '');
      newerRetryOwningByJob.set(jobId, (newerRetryOwningByJob.get(jobId) || 0) + 1);
    }
  }

  const rows: Phase0ZombieReconciliationRow[] = [];
  const proposals: Phase0ZombieReconciliationRow[] = [];
  const skippedRows: Phase0ZombieReconciliationRow[] = [];
  const byReason: Record<string, number> = {};
  const nowMs = Date.now();

  for (const raw of candidates.rows) {
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
    const row: Phase0ZombieReconciliationRow = {
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
    };
    rows.push(row);
    byReason[row.reason] = (byReason[row.reason] || 0) + 1;
    if (outcome.decision === 'PROPOSE_CLOSE') proposals.push(row);
    else skippedRows.push(row);
  }

  const warnings: string[] = [];
  if (!ledgerTablePresent) {
    warnings.push('ledger_table_missing_channel_evidence_only');
  } else if (ledgerRows === 0) {
    warnings.push('phase0_ledger_empty_channel_evidence_only');
  }
  if (rows.length < pendingRetries + processingRetries) {
    warnings.push('candidate_limit_reached');
  }

  const report: Phase0ZombieReconciliationReport = {
    generatedAt,
    dryRun: true,
    maxJobs,
    schema: { ledgerTablePresent },
    population: {
      pendingRetries,
      processingRetries,
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
