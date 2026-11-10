/**
 * Phase 2 Unit 4 — retry backlog triage (read-only classifier/report).
 *
 * Classifies every PENDING RETRY_COMMUNITY_ACQUISITION job into:
 *
 *   * TERMINAL    — evidence-backed closure (scope/terminal channel, low-audience
 *                   stop, or exhausted durable attempts);
 *   * QUARANTINE  — ancient job with no proven started work and no recent claim,
 *                   or a human-review route that the crawler cannot advance;
 *   * RECOVERABLE — recent work, recent claim, or affirmative started evidence.
 *
 * Channel-terminal Discord closures remain owned by the existing Phase 0
 * zombie reconciliation (`phase0ZombieReconciliation.ts`), which already
 * checks newer retry-owning observations and the URL work ledger. This module
 * deliberately does not duplicate that evidence path.
 *
 * Age alone never closes a job. Quarantine is reversible and never deletes or
 * rewrites the job payload/history: the apply path records the original
 * priority/run_after in `retry_backlog_triage`, then defers `run_after`.
 *
 * The report is read-only and runs on one REPEATABLE READ snapshot. The apply
 * path is separate and operator-gated.
 */

export const RETRY_BACKLOG_TRIAGE_JOB_TYPE = 'RETRY_COMMUNITY_ACQUISITION';
export const RETRY_BACKLOG_ANCIENT_DAYS = 7;
export const RETRY_BACKLOG_QUARANTINE_DAYS = 30;
export const RETRY_BACKLOG_TRIAGE_DEFAULT_MAX_JOBS = 5_000;
export const RETRY_BACKLOG_TRIAGE_MAX_JOBS = 5_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RetryBacklogBucket = 'TERMINAL' | 'QUARANTINE' | 'RECOVERABLE';

export type RetryBacklogReason =
  | 'CHANNEL_TERMINAL'
  | 'OUT_OF_SCOPE'
  | 'LOW_AUDIENCE_STOP'
  | 'ATTEMPTS_EXHAUSTED'
  | 'HUMAN_REVIEW'
  | 'CHANNEL_MISSING'
  | 'ANCIENT_NO_CLAIMS'
  | 'ANCIENT_STALLED'
  | 'WORK_STARTED'
  | 'RECENT_ACTIVITY'
  | 'RECENT';

export type RetryBacklogSkipReason = 'ALREADY_TRIAGED' | 'NOT_PENDING';

export interface RetryBacklogTriageEvidence {
  jobId: string;
  channelId: string;
  jobStatus: string;
  channelPresent: boolean;
  attempts: number;
  maxAttempts: number;
  priority: number;
  runAfter: string | null;
  firstEnqueuedAt: string | null;
  retryObservedAt: string | null;
  scopeEligibility: string | null;
  scanStatus: string | null;
  discordStatus: string | null;
  discordValidationStatus: string | null;
  countryStatus: string | null;
  tradingStatus: string | null;
  claims: number;
  lastClaimAt: string | null;
  startedClaims: number;
  appliedBucket: string | null;
  appliedAt: string | null;
}

export interface RetryBacklogTriageDecision {
  bucket: RetryBacklogBucket | 'SKIP';
  reason: RetryBacklogReason | RetryBacklogSkipReason;
}

function upper(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function ageDays(value: unknown, nowMs: number): number {
  const parsed = timestampMs(value);
  if (parsed === null) return 0;
  return Math.max(0, (nowMs - parsed) / DAY_MS);
}

/**
 * Pure classifier. Terminal evidence wins over quarantine; quarantine wins over
 * recoverable. Missing channels are quarantined (no target to inspect), never
 * closed. Applied rows are skipped so a re-run is idempotent.
 */
export function classifyRetryBacklogJob(
  evidence: RetryBacklogTriageEvidence,
  nowMs: number = Date.now(),
): RetryBacklogTriageDecision {
  if (evidence.appliedAt) return { bucket: 'SKIP', reason: 'ALREADY_TRIAGED' };
  if (upper(evidence.jobStatus) !== 'PENDING') return { bucket: 'SKIP', reason: 'NOT_PENDING' };

  if (!evidence.channelPresent) return { bucket: 'QUARANTINE', reason: 'CHANNEL_MISSING' };

  const scope = upper(evidence.scopeEligibility);
  const scan = upper(evidence.scanStatus);
  const country = upper(evidence.countryStatus);
  const trading = upper(evidence.tradingStatus);

  if (scope === 'OUT_OF_SCOPE') return { bucket: 'TERMINAL', reason: 'OUT_OF_SCOPE' };
  if (scan === 'SKIPPED_LOW_AUDIENCE') return { bucket: 'TERMINAL', reason: 'LOW_AUDIENCE_STOP' };
  if (country === 'REJECTED' || trading === 'NON_TRADING' || trading === 'HUMAN_REJECTED') {
    return { bucket: 'TERMINAL', reason: 'CHANNEL_TERMINAL' };
  }
  if (evidence.attempts >= evidence.maxAttempts) {
    return { bucket: 'TERMINAL', reason: 'ATTEMPTS_EXHAUSTED' };
  }
  if (scan === 'NEEDS_REVIEW') return { bucket: 'QUARANTINE', reason: 'HUMAN_REVIEW' };

  const ancient = ageDays(evidence.firstEnqueuedAt, nowMs) > RETRY_BACKLOG_ANCIENT_DAYS;
  const lastClaimMs = timestampMs(evidence.lastClaimAt);
  const recentClaim = lastClaimMs !== null && nowMs - lastClaimMs <= RETRY_BACKLOG_ANCIENT_DAYS * DAY_MS;
  if (!ancient) return { bucket: 'RECOVERABLE', reason: 'RECENT' };
  if (evidence.startedClaims > 0) return { bucket: 'RECOVERABLE', reason: 'WORK_STARTED' };
  if (recentClaim) return { bucket: 'RECOVERABLE', reason: 'RECENT_ACTIVITY' };
  return {
    bucket: 'QUARANTINE',
    reason: evidence.claims > 0 ? 'ANCIENT_STALLED' : 'ANCIENT_NO_CLAIMS',
  };
}

export interface RetryBacklogTriageRow {
  jobId: string;
  channelId: string;
  bucket: RetryBacklogBucket;
  reason: RetryBacklogReason;
  ageDays: number;
  attempts: number;
  maxAttempts: number;
  claims: number;
  lastClaimAt: string | null;
  startedClaims: number;
  priority: number;
  runAfter: string | null;
  firstEnqueuedAt: string | null;
  retryObservedAt: string | null;
  scopeEligibility: string | null;
  scanStatus: string | null;
  discordStatus: string | null;
  discordValidationStatus: string | null;
  countryStatus: string | null;
  tradingStatus: string | null;
  evidence: Record<string, unknown>;
}

export interface RetryBacklogTriageReport {
  generatedAt: string;
  dryRun: true;
  maxJobs: number;
  schema: { triageTablePresent: boolean };
  population: { pendingRetries: number; examined: number; truncated: boolean };
  summary: {
    terminal: number;
    quarantine: number;
    recoverable: number;
    skipped: number;
    byReason: Record<string, number>;
  };
  rows?: RetryBacklogTriageRow[];
  warnings: string[];
}

export interface RetryBacklogTriageDb {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
}

export interface RetryBacklogTriageReportOptions {
  maxJobs?: number;
  includeRows?: boolean;
  now?: () => Date;
}

export interface RetryBacklogTriageArgs {
  maxJobs: number;
  includeRows: boolean;
  check: boolean;
  out: string | null;
  help: boolean;
}

export const RETRY_BACKLOG_TRIAGE_USAGE =
  'Usage: npx tsx scripts/phase2RetryBacklogTriage.ts '
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

export function parseRetryBacklogTriageArgs(
  argv: readonly string[],
): RetryBacklogTriageArgs {
  const args: RetryBacklogTriageArgs = {
    maxJobs: RETRY_BACKLOG_TRIAGE_DEFAULT_MAX_JOBS,
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
      args.maxJobs = parseBoundedInteger(
        raw.slice('--max-jobs='.length),
        '--max-jobs',
        1,
        RETRY_BACKLOG_TRIAGE_MAX_JOBS,
      );
    } else if (raw.startsWith('--out=')) {
      const out = raw.slice('--out='.length);
      if (!out.trim()) throw new Error('--out must name a non-empty file path');
      args.out = out;
    } else {
      throw new Error(`unknown argument: "${raw}". ${RETRY_BACKLOG_TRIAGE_USAGE}`);
    }
  }
  return args;
}

export function retryBacklogTriageCheckFailures(report: RetryBacklogTriageReport): string[] {
  const failures: string[] = [];
  if (report.population.truncated) failures.push('candidate_limit_reached');
  if (report.population.examined
      !== report.summary.terminal + report.summary.quarantine
        + report.summary.recoverable + report.summary.skipped) {
    failures.push('decision_partition_mismatch');
  }
  return failures;
}

function iso(value: unknown): string | null {
  const parsed = timestampMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export interface RetryBacklogTriageCandidateSqlOptions {
  /** Lock candidate job rows for an operator apply. */
  lock?: boolean;
  /** Add `$2::uuid[]` job-id restriction (test isolation or a reviewed batch). */
  restrictJobIds?: boolean;
  /** Exclude rows already carrying applied triage evidence. */
  excludeApplied?: boolean;
}

export function retryBacklogTriageCandidateSql(
  triageTablePresent: boolean,
  options: RetryBacklogTriageCandidateSqlOptions = {},
): string {
  const triageJoin = triageTablePresent
    ? 'LEFT JOIN public.retry_backlog_triage t ON t.job_id=j.id'
    : '';
  const appliedBucket = triageTablePresent ? 't.bucket' : 'NULL::text';
  const appliedAt = triageTablePresent ? 't.applied_at' : 'NULL::timestamptz';
  const restrict = options.restrictJobIds
    ? "AND ($2::uuid[] IS NULL OR j.id=ANY($2))"
    : '';
  const excludeApplied = options.excludeApplied && triageTablePresent
    ? 'AND t.applied_at IS NULL'
    : '';
  const lock = options.lock ? 'FOR UPDATE OF j SKIP LOCKED' : '';
  return `
    WITH claim_stats AS (
      SELECT job_id,
             count(*)::int AS claims,
             max(started_at) AS last_claim_at,
             count(*) FILTER (WHERE failure_work_started_evidence='PROVEN_STARTED')::int AS started_claims
        FROM job_attempts
       GROUP BY job_id
    )
    SELECT j.id,
           j.payload->>'channelId' AS channel_id,
           j.status,
           j.attempts,
           j.max_attempts,
           j.priority,
           j.run_after,
           j.first_enqueued_at,
           j.payload->>'retryObservedAt' AS retry_observed_at,
           c.channel_id IS NOT NULL AS channel_present,
           c.scope_eligibility,
           c.scan_status,
           c.discord_status,
           c.discord_validation_status,
           c.country_status,
           c.trading_status,
           COALESCE(cs.claims,0) AS claims,
           cs.last_claim_at,
           COALESCE(cs.started_claims,0) AS started_claims,
           ${appliedBucket} AS applied_bucket,
           ${appliedAt} AS applied_at
      FROM jobs j
      LEFT JOIN channels c ON c.channel_id=j.payload->>'channelId'
      LEFT JOIN claim_stats cs ON cs.job_id=j.id
      ${triageJoin}
     WHERE j.type='${RETRY_BACKLOG_TRIAGE_JOB_TYPE}'
       AND j.status='PENDING'
       AND j.closed_at IS NULL
       ${restrict}
       ${excludeApplied}
     ORDER BY j.first_enqueued_at, j.id
     LIMIT $1
     ${lock}
  `;
}

export function retryBacklogTriageEvidenceFromRawRow(raw: any): RetryBacklogTriageEvidence {
  return {
    jobId: String(raw.id),
    channelId: String(raw.channel_id || ''),
    jobStatus: String(raw.status || ''),
    channelPresent: raw.channel_present === true,
    attempts: count(raw.attempts),
    maxAttempts: count(raw.max_attempts),
    priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 0,
    runAfter: iso(raw.run_after),
    firstEnqueuedAt: iso(raw.first_enqueued_at),
    retryObservedAt: iso(raw.retry_observed_at),
    scopeEligibility: raw.scope_eligibility ? String(raw.scope_eligibility) : null,
    scanStatus: raw.scan_status ? String(raw.scan_status) : null,
    discordStatus: raw.discord_status ? String(raw.discord_status) : null,
    discordValidationStatus: raw.discord_validation_status
      ? String(raw.discord_validation_status)
      : null,
    countryStatus: raw.country_status ? String(raw.country_status) : null,
    tradingStatus: raw.trading_status ? String(raw.trading_status) : null,
    claims: count(raw.claims),
    lastClaimAt: iso(raw.last_claim_at),
    startedClaims: count(raw.started_claims),
    appliedBucket: raw.applied_bucket ? String(raw.applied_bucket) : null,
    appliedAt: iso(raw.applied_at),
  };
}

export async function buildRetryBacklogTriageReport(
  db: RetryBacklogTriageDb,
  options: RetryBacklogTriageReportOptions = {},
): Promise<RetryBacklogTriageReport> {
  const now = options.now ? options.now() : new Date();
  const nowMs = now.getTime();
  const maxJobs = Math.min(
    RETRY_BACKLOG_TRIAGE_MAX_JOBS,
    Math.max(1, Math.floor(Number(options.maxJobs) || RETRY_BACKLOG_TRIAGE_DEFAULT_MAX_JOBS)),
  );

  const schema = await db.query(
    `SELECT to_regclass('public.retry_backlog_triage') IS NOT NULL AS present,
            (SELECT count(*)::int FROM jobs
              WHERE type='${RETRY_BACKLOG_TRIAGE_JOB_TYPE}' AND status='PENDING') AS pending_retries`,
  );
  const schemaRow = schema.rows[0] || {};
  const triageTablePresent = schemaRow.present === true;
  const pendingRetries = count(schemaRow.pending_retries);

  const result = await db.query(retryBacklogTriageCandidateSql(triageTablePresent), [maxJobs + 1]);
  const rawRows = Array.isArray(result.rows) ? result.rows : [];
  const truncated = rawRows.length > maxJobs;
  const limited = truncated ? rawRows.slice(0, maxJobs) : rawRows;

  const rows: RetryBacklogTriageRow[] = [];
  const byReason: Record<string, number> = {};
  let terminal = 0;
  let quarantine = 0;
  let recoverable = 0;
  let skipped = 0;

  for (const raw of limited) {
    const evidence = retryBacklogTriageEvidenceFromRawRow(raw);
    const decision = classifyRetryBacklogJob(evidence, nowMs);
    byReason[decision.reason] = (byReason[decision.reason] || 0) + 1;
    if (decision.bucket === 'TERMINAL') terminal++;
    else if (decision.bucket === 'QUARANTINE') quarantine++;
    else if (decision.bucket === 'RECOVERABLE') recoverable++;
    else skipped++;

    if (decision.bucket !== 'SKIP') {
      rows.push({
        jobId: evidence.jobId,
        channelId: evidence.channelId,
        bucket: decision.bucket,
        reason: decision.reason as RetryBacklogReason,
        ageDays: Math.round(ageDays(evidence.firstEnqueuedAt, nowMs) * 10) / 10,
        attempts: evidence.attempts,
        maxAttempts: evidence.maxAttempts,
        claims: evidence.claims,
        lastClaimAt: evidence.lastClaimAt,
        startedClaims: evidence.startedClaims,
        priority: evidence.priority,
        runAfter: evidence.runAfter,
        firstEnqueuedAt: evidence.firstEnqueuedAt,
        retryObservedAt: evidence.retryObservedAt,
        scopeEligibility: evidence.scopeEligibility,
        scanStatus: evidence.scanStatus,
        discordStatus: evidence.discordStatus,
        discordValidationStatus: evidence.discordValidationStatus,
        countryStatus: evidence.countryStatus,
        tradingStatus: evidence.tradingStatus,
        evidence: {
          jobId: evidence.jobId,
          channelId: evidence.channelId,
          channelPresent: evidence.channelPresent,
          attempts: evidence.attempts,
          maxAttempts: evidence.maxAttempts,
          claims: evidence.claims,
          startedClaims: evidence.startedClaims,
          lastClaimAt: evidence.lastClaimAt,
          firstEnqueuedAt: evidence.firstEnqueuedAt,
          retryObservedAt: evidence.retryObservedAt,
          scopeEligibility: evidence.scopeEligibility,
          scanStatus: evidence.scanStatus,
          discordStatus: evidence.discordStatus,
          discordValidationStatus: evidence.discordValidationStatus,
          countryStatus: evidence.countryStatus,
          tradingStatus: evidence.tradingStatus,
        },
      });
    }
  }

  const warnings: string[] = [];
  if (truncated) warnings.push('candidate_limit_reached');
  if (!triageTablePresent) warnings.push('triage_table_missing_report_only');

  return {
    generatedAt: now.toISOString(),
    dryRun: true,
    maxJobs,
    schema: { triageTablePresent },
    population: { pendingRetries, examined: limited.length, truncated },
    summary: { terminal, quarantine, recoverable, skipped, byReason },
    ...(options.includeRows ? { rows } : {}),
    warnings,
  };
}
