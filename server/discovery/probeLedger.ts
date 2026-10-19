/**
 * Evidence-first discovery Phase 2 — bounded probe ledger.
 *
 * Authority boundary: this module owns probe admission only. It never reads or
 * writes `search_eligible`, never mutates the canonical catalog, never advances
 * the 3-creator / 2-community / 5-evidence promotion gate, and never touches
 * serving/planner paths. Probes are inert until the operator sets
 * `discovery_probe_enabled='true'` and an approved caller invokes
 * runApprovedProbe (see probeExecutor.ts).
 *
 * Ledger decision (recon over migrations 002/027/043/048; psql unavailable):
 * `terminology_trial_assignments` is NOT repurposed. Its row shape cannot carry
 * a probe lifecycle without destructive changes: it is append-only by trigger
 * (BEFORE UPDATE OR DELETE raises), hypothesis_id/action_id are NOT NULL FKs
 * into the persistent-research program graph, `arm` is constrained to
 * TERMINOLOGY/BASELINE_CONTROL, and it has no candidate/term/country/route/
 * units/attempt/outcome/results/idempotency columns. `terminology_trial_controls`
 * is a singleton kill switch, `discovery_actions` is a program-scoped planner
 * row, `discovery_provider_registry` is a provider catalog, and `jobs` is a
 * queue. Additive migration 146 therefore creates `discovery_probe_ledger`.
 *
 * Enforcement is both in code (all caps/termination/idempotency decisions) and
 * in SQL (transaction + advisory lock per candidate, UNIQUE(candidate_key,
 * attempt_no), UNIQUE(idempotency_key), ON CONFLICT DO NOTHING). Any settings
 * or DB error fails closed: no reservation is granted.
 */

import { getAppSetting, getDb } from '../dbCore';
import { canonicalCountry } from '../countryInference';

export const PROBE_POLICY_VERSION = 'bounded-probe-v1';

export const DISCOVERY_PROBE_FLAG_KEY = 'discovery_probe_enabled';
export const DISCOVERY_PROBE_KILL_SWITCH_KEY = 'discovery_probe_kill_switch';
export const DISCOVERY_PROBE_ALLOW_OFFICIAL_KEY = 'discovery_probe_allow_official';

/** All caps are read from app_settings; settings may only tighten these. */
export const PROBE_SETTING_KEYS = {
  maxPerCandidate: 'discovery_probe_max_per_candidate',
  minIntervalHours: 'discovery_probe_min_interval_hours',
  maxPerDay: 'discovery_probe_max_per_day',
  maxPerCountryPerDay: 'discovery_probe_max_per_country_per_day',
  allowOfficial: DISCOVERY_PROBE_ALLOW_OFFICIAL_KEY,
  inFlightTtlMinutes: 'discovery_probe_inflight_ttl_minutes',
  maxAgeDays: 'discovery_probe_max_age_days',
} as const;

/**
 * Conservative defaults + hard ceilings. A missing key uses the default; an
 * unparseable/looser value is clamped so a misconfiguration can never enlarge
 * the probe budget beyond the approved bounds.
 */
export const PROBE_DEFAULTS = {
  maxPerCandidate: 3,
  minIntervalHours: 24,
  maxPerDay: 20,
  maxPerCountryPerDay: 10,
  allowOfficial: false,
  inFlightTtlMinutes: 15,
  maxAgeDays: 14,
} as const;

export const PROBE_HARD_LIMITS = {
  maxPerCandidate: 3,
  minIntervalHours: 24,
  maxIntervalHours: 168,
  maxPerDay: 20,
  maxPerCountryPerDay: 10,
  minInFlightTtlMinutes: 1,
  maxInFlightTtlMinutes: 60,
  maxAgeDays: 14,
} as const;

export const PROBE_ROUTES = ['youtube-innertube', 'youtube-data-api'] as const;
export type ProbeRoute = (typeof PROBE_ROUTES)[number];

export type ProbeStatus = 'RESERVED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
export type ProbeOutcome = 'SUCCESS' | 'EMPTY' | 'FAILED' | 'INCONCLUSIVE' | 'EXPIRED';

export type ProbeSettingReader = (key: string, fallback: string) => Promise<string>;

export interface ProbeCaps {
  maxPerCandidate: number;
  minIntervalHours: number;
  maxPerDay: number;
  maxPerCountryPerDay: number;
  allowOfficial: boolean;
  inFlightTtlMinutes: number;
  maxAgeDays: number;
}

export interface ProbeLedgerRow {
  id: string;
  candidateKey: string;
  probeKey: string;
  idempotencyKey: string;
  term: string;
  country: string;
  route: ProbeRoute;
  providerKey: string;
  units: number;
  attemptNo: number;
  status: ProbeStatus;
  outcome: ProbeOutcome | null;
  resultsCount: number;
  newCreators: number;
  reasons: string[];
  details: Record<string, unknown>;
  evidenceVersion: string | null;
  reservedAt: string;
  expiresAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface NewProbeAttempt {
  candidateKey: string;
  probeKey: string;
  idempotencyKey: string;
  term: string;
  country: string;
  route: ProbeRoute;
  providerKey: string;
  units: number;
  attemptNo: number;
  evidenceVersion: string | null;
  reservedAt: string;
  expiresAt: string;
}

export interface ProbeOutcomeUpdate {
  probeId: string;
  outcome: Exclude<ProbeOutcome, 'EXPIRED'>;
  resultsCount: number;
  newCreators: number;
  reasons: string[];
  details: Record<string, unknown>;
  completedAt: string;
}

export interface ProbeLedgerQueryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

export interface ProbeLedgerConnection extends ProbeLedgerQueryable {
  release?: () => void;
}

export interface ProbeLedgerClient extends ProbeLedgerQueryable {
  connect?: () => Promise<ProbeLedgerConnection>;
}

export interface ProbeLedgerTransaction {
  lockCandidate: (candidateKey: string) => Promise<void>;
  getCandidateStats: (candidateKey: string) => Promise<{ attempts: number; firstReservedAt: string | null }>;
  getLastAttempt: (candidateKey: string) => Promise<ProbeLedgerRow | null>;
  getInflight: (candidateKey: string, nowIso: string) => Promise<ProbeLedgerRow | null>;
  countProbesSince: (sinceIso: string, country?: string) => Promise<number>;
  findAttempt: (candidateKey: string, attemptNo: number) => Promise<ProbeLedgerRow | null>;
  insertAttempt: (attempt: NewProbeAttempt) => Promise<ProbeLedgerRow | null>;
}

export interface ProbeLedgerStore {
  transaction: <T>(fn: (tx: ProbeLedgerTransaction) => Promise<T>) => Promise<T>;
  markRunning: (probeId: string, startedAtIso: string) => Promise<ProbeLedgerRow | null>;
  recordOutcome: (update: ProbeOutcomeUpdate) => Promise<ProbeLedgerRow | null>;
  expireStale: (nowIso: string) => Promise<ProbeLedgerRow[]>;
  list: (limit: number) => Promise<ProbeLedgerRow[]>;
}

export interface ProbeLedgerDeps {
  readSetting?: ProbeSettingReader;
  client?: ProbeLedgerClient;
  store?: ProbeLedgerStore;
  now?: () => Date;
}

export interface ReserveProbeInput {
  candidateKey: string;
  term: string;
  country: string;
  route?: string;
  evidenceVersion?: string | null;
  /** Replay identity. When omitted the next sequential attempt is allocated. */
  attemptNo?: number;
}

export interface ProbeReserveResult {
  granted: boolean;
  reason: string;
  duplicate?: boolean;
  probe?: ProbeLedgerRow;
}

export interface SweepExpiredProbesResult {
  expiredCount: number;
  probeIds: string[];
  error?: string;
}

export interface InspectProbeLedgerResult {
  rows: ProbeLedgerRow[];
  error?: string;
}

export const PROBE_REASONS = {
  granted: 'PROBE_GRANTED',
  duplicateInflight: 'DUPLICATE_INFLIGHT',
  duplicateAttempt: 'DUPLICATE_ATTEMPT',
  invalidInput: 'INVALID_INPUT',
  invalidAttemptNo: 'INVALID_ATTEMPT_NO',
  routeNotAllowed: 'ROUTE_NOT_ALLOWED',
  officialRouteDisabled: 'OFFICIAL_ROUTE_DISABLED',
  settingsUnavailable: 'SETTINGS_UNAVAILABLE',
  dbError: 'DB_ERROR',
  noDatabase: 'NO_DATABASE',
  candidateConcluded: 'CANDIDATE_CONCLUDED',
  minInterval: 'MIN_INTERVAL_NOT_ELAPSED',
  globalDailyCap: 'GLOBAL_DAILY_CAP_REACHED',
  countryDailyCap: 'COUNTRY_DAILY_CAP_REACHED',
  inconclusiveNeedsEvidence: 'INCONCLUSIVE_REQUIRES_NEW_EVIDENCE_VERSION',
} as const;

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return new Date(0).toISOString();
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function mapProbeLedgerRow(row: Record<string, unknown>): ProbeLedgerRow {
  return {
    id: String(row.id ?? ''),
    candidateKey: String(row.candidate_key ?? ''),
    probeKey: String(row.probe_key ?? ''),
    idempotencyKey: String(row.idempotency_key ?? ''),
    term: String(row.term ?? ''),
    country: String(row.country ?? ''),
    route: String(row.route ?? 'youtube-innertube') as ProbeRoute,
    providerKey: String(row.provider_key ?? 'youtube-innertube'),
    units: Number(row.units ?? 0),
    attemptNo: Number(row.attempt_no ?? 0),
    status: String(row.status ?? 'RESERVED') as ProbeStatus,
    outcome: row.outcome === null || row.outcome === undefined ? null : (String(row.outcome) as ProbeOutcome),
    resultsCount: Number(row.results_count ?? 0),
    newCreators: Number(row.new_creators ?? 0),
    reasons: toStringArray(row.reasons),
    details: toRecord(row.details),
    evidenceVersion:
      row.evidence_version === null || row.evidence_version === undefined
        ? null
        : String(row.evidence_version),
    reservedAt: toIso(row.reserved_at),
    expiresAt: toIso(row.expires_at),
    startedAt: toIsoOrNull(row.started_at),
    completedAt: toIsoOrNull(row.completed_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function normalizeProbeRoute(value: string | undefined | null): ProbeRoute | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return (PROBE_ROUTES as readonly string[]).includes(normalized) ? (normalized as ProbeRoute) : null;
}

export function resolveProbeCapsFromValues(values: {
  maxPerCandidate: string;
  minIntervalHours: string;
  maxPerDay: string;
  maxPerCountryPerDay: string;
  allowOfficial: string;
  inFlightTtlMinutes: string;
  maxAgeDays: string;
}): ProbeCaps {
  const int = (raw: string, fallback: number, min: number, max: number): number => {
    const trimmed = String(raw ?? '').trim();
    // Absent/blank => conservative default. Unparseable => default as well.
    if (!trimmed) return fallback;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
  };
  return {
    maxPerCandidate: int(
      values.maxPerCandidate,
      PROBE_DEFAULTS.maxPerCandidate,
      1,
      PROBE_HARD_LIMITS.maxPerCandidate
    ),
    // 24h is a floor, not just a default: settings can only lengthen it.
    minIntervalHours: int(
      values.minIntervalHours,
      PROBE_DEFAULTS.minIntervalHours,
      PROBE_HARD_LIMITS.minIntervalHours,
      PROBE_HARD_LIMITS.maxIntervalHours
    ),
    maxPerDay: int(values.maxPerDay, PROBE_DEFAULTS.maxPerDay, 1, PROBE_HARD_LIMITS.maxPerDay),
    maxPerCountryPerDay: int(
      values.maxPerCountryPerDay,
      PROBE_DEFAULTS.maxPerCountryPerDay,
      1,
      PROBE_HARD_LIMITS.maxPerCountryPerDay
    ),
    allowOfficial: String(values.allowOfficial ?? '').trim().toLowerCase() === 'true',
    inFlightTtlMinutes: int(
      values.inFlightTtlMinutes,
      PROBE_DEFAULTS.inFlightTtlMinutes,
      PROBE_HARD_LIMITS.minInFlightTtlMinutes,
      PROBE_HARD_LIMITS.maxInFlightTtlMinutes
    ),
    maxAgeDays: int(values.maxAgeDays, PROBE_DEFAULTS.maxAgeDays, 1, PROBE_HARD_LIMITS.maxAgeDays),
  };
}

/** Reads every cap. Any read failure propagates so reserveProbe fails closed. */
export async function resolveProbeCaps(readSetting: ProbeSettingReader): Promise<ProbeCaps> {
  const [maxPerCandidate, minIntervalHours, maxPerDay, maxPerCountryPerDay, allowOfficial, inFlightTtlMinutes, maxAgeDays] =
    await Promise.all([
      readSetting(PROBE_SETTING_KEYS.maxPerCandidate, String(PROBE_DEFAULTS.maxPerCandidate)),
      readSetting(PROBE_SETTING_KEYS.minIntervalHours, String(PROBE_DEFAULTS.minIntervalHours)),
      readSetting(PROBE_SETTING_KEYS.maxPerDay, String(PROBE_DEFAULTS.maxPerDay)),
      readSetting(PROBE_SETTING_KEYS.maxPerCountryPerDay, String(PROBE_DEFAULTS.maxPerCountryPerDay)),
      readSetting(PROBE_SETTING_KEYS.allowOfficial, PROBE_DEFAULTS.allowOfficial ? 'true' : 'false'),
      readSetting(PROBE_SETTING_KEYS.inFlightTtlMinutes, String(PROBE_DEFAULTS.inFlightTtlMinutes)),
      readSetting(PROBE_SETTING_KEYS.maxAgeDays, String(PROBE_DEFAULTS.maxAgeDays)),
    ]);
  return resolveProbeCapsFromValues({
    maxPerCandidate,
    minIntervalHours,
    maxPerDay,
    maxPerCountryPerDay,
    allowOfficial,
    inFlightTtlMinutes,
    maxAgeDays,
  });
}

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * SQL ledger store. Every reservation runs inside one transaction holding a
 * per-candidate advisory lock; the unique constraints are the final
 * idempotency authority.
 */
export class SqlProbeLedgerStore implements ProbeLedgerStore {
  constructor(private readonly client: ProbeLedgerClient) {}

  private async withTransaction<T>(fn: (queryable: ProbeLedgerQueryable) => Promise<T>): Promise<T> {
    if (typeof this.client.connect === 'function') {
      const connection = await this.client.connect();
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
    await this.client.query('BEGIN');
    try {
      const result = await fn(this.client);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async transaction<T>(fn: (tx: ProbeLedgerTransaction) => Promise<T>): Promise<T> {
    return this.withTransaction(async queryable => {
      const tx: ProbeLedgerTransaction = {
        lockCandidate: async candidateKey => {
          await queryable.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [candidateKey]);
        },
        getCandidateStats: async candidateKey => {
          const result = await queryable.query(
            `SELECT COUNT(*)::int AS attempts, MIN(reserved_at) AS first_reserved_at
               FROM discovery_probe_ledger WHERE candidate_key=$1`,
            [candidateKey]
          );
          const row = result.rows[0] || {};
          return {
            attempts: Number(row.attempts ?? 0),
            firstReservedAt: toIsoOrNull(row.first_reserved_at),
          };
        },
        getLastAttempt: async candidateKey => {
          const result = await queryable.query(
            `SELECT * FROM discovery_probe_ledger
              WHERE candidate_key=$1 ORDER BY attempt_no DESC LIMIT 1`,
            [candidateKey]
          );
          return result.rows[0] ? mapProbeLedgerRow(result.rows[0]) : null;
        },
        getInflight: async (candidateKey, nowIso) => {
          const result = await queryable.query(
            `SELECT * FROM discovery_probe_ledger
              WHERE candidate_key=$1 AND status IN ('RESERVED','RUNNING') AND expires_at > $2
              ORDER BY attempt_no DESC LIMIT 1`,
            [candidateKey, nowIso]
          );
          return result.rows[0] ? mapProbeLedgerRow(result.rows[0]) : null;
        },
        countProbesSince: async (sinceIso, country) => {
          const result = country
            ? await queryable.query(
                `SELECT COUNT(*)::int AS count FROM discovery_probe_ledger
                  WHERE reserved_at >= $1 AND country=$2`,
                [sinceIso, country]
              )
            : await queryable.query(
                `SELECT COUNT(*)::int AS count FROM discovery_probe_ledger WHERE reserved_at >= $1`,
                [sinceIso]
              );
          return Number(result.rows[0]?.count ?? 0);
        },
        findAttempt: async (candidateKey, attemptNo) => {
          const result = await queryable.query(
            `SELECT * FROM discovery_probe_ledger WHERE candidate_key=$1 AND attempt_no=$2 LIMIT 1`,
            [candidateKey, attemptNo]
          );
          return result.rows[0] ? mapProbeLedgerRow(result.rows[0]) : null;
        },
        insertAttempt: async attempt => {
          const result = await queryable.query(
            `INSERT INTO discovery_probe_ledger(
               candidate_key, probe_key, idempotency_key, term, country, route, provider_key,
               units, attempt_no, status, evidence_version, reserved_at, expires_at, updated_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'RESERVED',$10,$11,$12,$11)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [
              attempt.candidateKey,
              attempt.probeKey,
              attempt.idempotencyKey,
              attempt.term,
              attempt.country,
              attempt.route,
              attempt.providerKey,
              attempt.units,
              attempt.attemptNo,
              attempt.evidenceVersion,
              attempt.reservedAt,
              attempt.expiresAt,
            ]
          );
          return result.rows[0] ? mapProbeLedgerRow(result.rows[0]) : null;
        },
      };
      return fn(tx);
    });
  }

  async markRunning(probeId: string, startedAtIso: string): Promise<ProbeLedgerRow | null> {
    const result = await this.client.query(
      `UPDATE discovery_probe_ledger
          SET status='RUNNING', started_at=$2, updated_at=$2
        WHERE id=$1 AND status='RESERVED' AND expires_at > $2
        RETURNING *`,
      [probeId, startedAtIso]
    );
    return result.rows[0] ? mapProbeLedgerRow(result.rows[0]) : null;
  }

  async recordOutcome(update: ProbeOutcomeUpdate): Promise<ProbeLedgerRow | null> {
    const status = update.outcome === 'FAILED' ? 'FAILED' : 'COMPLETED';
    const result = await this.client.query(
      `UPDATE discovery_probe_ledger
          SET status=$2, outcome=$3, results_count=$4, new_creators=$5,
              reasons=$6::jsonb, details=$7::jsonb, completed_at=$8, updated_at=$8
        WHERE id=$1 AND status IN ('RESERVED','RUNNING')
        RETURNING *`,
      [
        update.probeId,
        status,
        update.outcome,
        update.resultsCount,
        update.newCreators,
        JSON.stringify(update.reasons),
        JSON.stringify(update.details),
        update.completedAt,
      ]
    );
    return result.rows[0] ? mapProbeLedgerRow(result.rows[0]) : null;
  }

  async expireStale(nowIso: string): Promise<ProbeLedgerRow[]> {
    const result = await this.client.query(
      `UPDATE discovery_probe_ledger
          SET status='EXPIRED', outcome='EXPIRED',
              reasons = reasons || '["RESERVATION_EXPIRED"]'::jsonb,
              completed_at=$1, updated_at=$1
        WHERE status IN ('RESERVED','RUNNING') AND expires_at <= $1
        RETURNING *`,
      [nowIso]
    );
    return result.rows.map(mapProbeLedgerRow);
  }

  async list(limit: number): Promise<ProbeLedgerRow[]> {
    const result = await this.client.query(
      `SELECT * FROM discovery_probe_ledger ORDER BY reserved_at DESC, attempt_no DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapProbeLedgerRow);
  }
}

async function resolveStore(deps: ProbeLedgerDeps): Promise<ProbeLedgerStore | null> {
  if (deps.store) return deps.store;
  const client =
    deps.client ?? (process.env.DATABASE_URL ? ((await getDb()) as unknown as ProbeLedgerClient) : null);
  return client ? new SqlProbeLedgerStore(client) : null;
}

function defaultReadSetting(key: string, fallback: string): Promise<string> {
  return getAppSetting(key, fallback);
}

function denial(reason: string, probe?: ProbeLedgerRow | null): ProbeReserveResult {
  return probe ? { granted: false, reason, probe } : { granted: false, reason };
}

/**
 * Reserves at most one probe attempt for a candidate. Never throws.
 *
 * Denial order: input/route -> settings (fail closed) -> candidate termination
 * (3 attempts or 14 days) -> INCONCLUSIVE evidence-version rule -> in-flight
 * duplicate -> explicit attempt replay -> 24h interval -> global/day and
 * country/day caps. The candidate is CONCLUDED once either lifetime bound is
 * reached; there is no override parameter.
 */
export async function reserveProbe(
  input: ReserveProbeInput,
  deps: ProbeLedgerDeps = {}
): Promise<ProbeReserveResult> {
  try {
    const candidateKey = String(input.candidateKey ?? '').trim();
    const term = String(input.term ?? '').trim();
    const rawCountry = String(input.country ?? '').trim();
    const route = normalizeProbeRoute(input.route ?? 'youtube-innertube');
    if (!candidateKey || !term || !rawCountry) return denial(PROBE_REASONS.invalidInput);
    if (!route) return denial(PROBE_REASONS.routeNotAllowed);
    const country = canonicalCountry(rawCountry);

    const store = await resolveStore(deps);
    if (!store) return denial(PROBE_REASONS.noDatabase);

    const readSetting = deps.readSetting ?? defaultReadSetting;
    let caps: ProbeCaps;
    try {
      caps = await resolveProbeCaps(readSetting);
    } catch {
      return denial(PROBE_REASONS.settingsUnavailable);
    }
    if (route === 'youtube-data-api' && !caps.allowOfficial) {
      return denial(PROBE_REASONS.officialRouteDisabled);
    }

    const now = deps.now ? deps.now() : new Date();
    const nowIso = now.toISOString();
    const dayStartIso = utcDayStart(now).toISOString();

    return await store.transaction(async tx => {
      await tx.lockCandidate(candidateKey);
      const stats = await tx.getCandidateStats(candidateKey);
      const last = await tx.getLastAttempt(candidateKey);

      if (stats.attempts >= caps.maxPerCandidate) {
        return denial(PROBE_REASONS.candidateConcluded, last);
      }
      if (
        stats.firstReservedAt &&
        now.getTime() - new Date(stats.firstReservedAt).getTime() >= caps.maxAgeDays * 24 * 60 * 60 * 1000
      ) {
        return denial(PROBE_REASONS.candidateConcluded, last);
      }

      if (last?.outcome === 'INCONCLUSIVE') {
        const evidenceVersion = String(input.evidenceVersion ?? '').trim();
        if (!evidenceVersion || evidenceVersion === (last.evidenceVersion ?? '')) {
          return denial(PROBE_REASONS.inconclusiveNeedsEvidence, last);
        }
      }

      const inflight = await tx.getInflight(candidateKey, nowIso);
      if (inflight) {
        return { granted: false, duplicate: true, reason: PROBE_REASONS.duplicateInflight, probe: inflight };
      }

      if (input.attemptNo !== undefined) {
        const existing = await tx.findAttempt(candidateKey, input.attemptNo);
        if (existing) {
          return { granted: false, duplicate: true, reason: PROBE_REASONS.duplicateAttempt, probe: existing };
        }
        const expected = (last?.attemptNo ?? 0) + 1;
        if (!Number.isInteger(input.attemptNo) || input.attemptNo !== expected) {
          return denial(PROBE_REASONS.invalidAttemptNo, last);
        }
      }

      // A crashed/expired reservation consumes its attempt but must not hold
      // the candidate hostage for another 24h: only non-expired attempts
      // enforce the minimum interval.
      if (
        last &&
        last.status !== 'EXPIRED' &&
        now.getTime() - new Date(last.reservedAt).getTime() < caps.minIntervalHours * 60 * 60 * 1000
      ) {
        return denial(PROBE_REASONS.minInterval, last);
      }

      const globalCount = await tx.countProbesSince(dayStartIso);
      if (globalCount >= caps.maxPerDay) {
        return denial(PROBE_REASONS.globalDailyCap, last);
      }
      const countryCount = await tx.countProbesSince(dayStartIso, country);
      if (countryCount >= caps.maxPerCountryPerDay) {
        return denial(PROBE_REASONS.countryDailyCap, last);
      }

      const attemptNo = input.attemptNo ?? (last?.attemptNo ?? 0) + 1;
      const identity = `probe:${candidateKey}:attempt:${attemptNo}`;
      const inserted = await tx.insertAttempt({
        candidateKey,
        probeKey: identity,
        idempotencyKey: identity,
        term,
        country,
        route,
        providerKey: route === 'youtube-innertube' ? 'youtube-innertube' : 'youtube-search',
        units: 0,
        attemptNo,
        evidenceVersion: String(input.evidenceVersion ?? '').trim() || null,
        reservedAt: nowIso,
        expiresAt: new Date(now.getTime() + caps.inFlightTtlMinutes * 60 * 1000).toISOString(),
      });
      if (!inserted) {
        const existing = await tx.findAttempt(candidateKey, attemptNo);
        return existing
          ? { granted: false, duplicate: true, reason: PROBE_REASONS.duplicateAttempt, probe: existing }
          : denial(PROBE_REASONS.dbError);
      }
      return { granted: true, reason: PROBE_REASONS.granted, probe: inserted };
    });
  } catch (error) {
    console.warn(
      `[ProbeLedger] reservation failed closed: ${
        error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
      }`
    );
    return denial(PROBE_REASONS.dbError);
  }
}

/** Marks a reserved probe RUNNING. Returns null when the reservation is gone/expired. */
export async function markProbeRunning(
  probeId: string,
  deps: ProbeLedgerDeps = {}
): Promise<ProbeLedgerRow | null> {
  try {
    const store = await resolveStore(deps);
    if (!store) return null;
    const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
    return await store.markRunning(probeId, nowIso);
  } catch {
    return null;
  }
}

/** Records a terminal outcome. Never throws; null means the update failed. */
export async function recordProbeOutcome(
  update: Omit<ProbeOutcomeUpdate, 'completedAt'> & { completedAt?: string },
  deps: ProbeLedgerDeps = {}
): Promise<ProbeLedgerRow | null> {
  try {
    const store = await resolveStore(deps);
    if (!store) return null;
    return await store.recordOutcome({
      ...update,
      completedAt: update.completedAt ?? (deps.now ? deps.now() : new Date()).toISOString(),
    });
  } catch {
    return null;
  }
}

/**
 * Expires stale in-flight reservations (default 15 min TTL) so a crashed probe
 * can never block a candidate forever. Attempts are not refunded: a crash
 * consumes one of the three lifetime attempts, but the next reservation is not
 * held back by the 24h interval. Never throws.
 */
export async function sweepExpiredProbes(
  deps: ProbeLedgerDeps = {}
): Promise<SweepExpiredProbesResult> {
  try {
    const store = await resolveStore(deps);
    if (!store) return { expiredCount: 0, probeIds: [], error: PROBE_REASONS.noDatabase };
    const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
    const expired = await store.expireStale(nowIso);
    return { expiredCount: expired.length, probeIds: expired.map(row => row.id) };
  } catch {
    return { expiredCount: 0, probeIds: [], error: PROBE_REASONS.dbError };
  }
}

/** Read-only ledger inspection; never mutates. Never throws. */
export async function inspectProbeLedger(
  limit = 50,
  deps: ProbeLedgerDeps = {}
): Promise<InspectProbeLedgerResult> {
  try {
    const store = await resolveStore(deps);
    if (!store) return { rows: [], error: PROBE_REASONS.noDatabase };
    const bounded = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    return { rows: await store.list(bounded) };
  } catch {
    return { rows: [], error: PROBE_REASONS.dbError };
  }
}
