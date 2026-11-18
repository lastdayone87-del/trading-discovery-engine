/**
 * Durable community-acquisition URL work store.
 *
 * Phase 0 built the pure projection and the `community_acquisition_url_state`
 * table. This module is the Phase 1 bridge: it materializes missing work rows
 * from durable observations, claims bounded URL slices, and writes the result
 * of one inspection back to the ledger.
 *
 * The channel retry job remains the batch owner. The URL ledger owns:
 *   * which URLs still need work;
 *   * how many genuine attempts each URL has consumed;
 *   * whether a URL is pending, parked on capacity, resolved, or exhausted.
 *
 * Capacity/browser waits never consume an attempt. Only direct processed work
 * or a genuine transport/site failure increments `attempts`.
 */
import { getDb } from './db';
import { isCommunityRelevantObservation } from './inspector';
import {
  COMMUNITY_ACQUISITION_WORK_SURFACES,
  communityAcquisitionWorkKey,
  hasBrowserExecution,
  hasDirectProcessedAcquisitionEvidence,
  hasProcessedAcquisitionEvidence,
  isCommunityLedgerWorkObservation,
  isInfrastructureFailureClass,
  latestInspectionObservations,
  normalizeCommunityWorkUrl,
  observationOwnsRetry,
  projectCommunityAcquisitionWork,
  selectEffectiveInspectionObservation,
  type CommunityWorkObservation,
  type CommunityWorkProjectionRow,
  type CommunityWorkState,
} from './communityAcquisitionWorkLedger';

export interface CommunityWorkDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface CommunityWorkRow {
  workKey: string;
  channelId: string;
  url: string;
  normalizedUrl: string;
  surface: string;
  state: CommunityWorkState;
  required: boolean;
  recall: boolean;
  priority: number;
  neverExecuted: boolean;
  neverBrowserExecuted: boolean;
  attempts: number;
  maxAttempts: number;
  firstObservedAt: string;
  lastAttemptAt: string | null;
  nextEligibleAt: string;
  lastFailureClass: string | null;
  lastOutcome: string | null;
  terminalReason: string | null;
  terminalEvidence: Record<string, unknown>;
}

export interface CommunityWorkSummary {
  total: number;
  pending: number;
  pendingDue: number;
  running: number;
  resolved: number;
  parkedInfra: number;
  parkedExternal: number;
  exhausted: number;
  minNextEligibleAt: string | null;
  active: number;
}

const DEFAULT_SLICE_SIZE = 8;
const RUNNING_LEASE_MINUTES = 30;
const CAPACITY_BACKOFF_SECONDS = 300;
const GENUINE_BACKOFF_BASE_SECONDS = 30;
const GENUINE_BACKOFF_MAX_SECONDS = 900;

const TERMINAL_FAILURE_CLASSES = new Set([
  'UNSUPPORTED_CONTENT_TYPE',
  'LOGIN_WALL',
  'PAYWALL_WALL',
  'PERMANENT_ACCESS_BLOCK',
  'SSRF_BLOCKED',
  'REDIRECT_LOOP',
  'INVALID_REDIRECT',
  'REDIRECT_LIMIT',
]);

function iso(value: unknown): string | null {
  if (!value) return null;
  const parsed = new Date(value as string | number | Date);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function database(db?: CommunityWorkDb): Promise<CommunityWorkDb> | CommunityWorkDb {
  return db || getDb() as unknown as Promise<CommunityWorkDb>;
}

export async function loadCommunityWorkObservations(
  channelId: string,
  options: { windowDays?: number; db?: CommunityWorkDb } = {},
): Promise<CommunityWorkObservation[]> {
  const db = await database(options.db);
  const windowDays = Math.max(1, Math.min(90, Math.floor(options.windowDays ?? 90)));
  const result = await db.query(
    `SELECT o.id,
            o.channel_id,
            o.requested_url,
            o.outcome,
            o.retryable,
            o.failure_class,
            o.observed_at,
            o.provenance
       FROM external_acquisition_observations o
      WHERE o.channel_id=$1
        AND o.observed_at > now() - ($2::text || ' days')::interval
        AND COALESCE(o.provenance->>'surface','') = ANY($3::text[])
      ORDER BY o.observed_at, o.id`,
    [channelId, String(windowDays), [...COMMUNITY_ACQUISITION_WORK_SURFACES]],
  );
  return result.rows.map(row => ({
    channelId: String(row.channel_id || ''),
    requestedUrl: String(row.requested_url || ''),
    outcome: String(row.outcome || ''),
    retryable: row.retryable === true,
    failureClass: row.failure_class ? String(row.failure_class) : null,
    observedAt: new Date(row.observed_at).toISOString(),
    id: row.id ? String(row.id) : undefined,
    provenance: row.provenance,
  }));
}

function initialLedgerState(row: CommunityWorkProjectionRow): { state: CommunityWorkState; reason: string | null } {
  if (row.state === 'RESOLVED') return { state: 'RESOLVED', reason: row.terminalReason || 'RESOLVED' };
  // A FOUND row with an outstanding retryable gap is still work for this URL;
  // ordinary FOUND rows are resolved. Multi-invite recall for other URLs is
  // represented by separate work keys.
  if (row.lastOutcome === 'FOUND' && !row.retryOwned) return { state: 'RESOLVED', reason: 'FOUND' };
  if (row.lastOutcome === 'INSPECTED_NO_MATCH' && !row.neverExecuted) {
    return { state: 'RESOLVED', reason: 'INSPECTED_NO_MATCH' };
  }
  if (isInfrastructureFailureClass(row.lastFailureClass)) {
    return { state: 'PARKED_INFRA', reason: row.lastFailureClass };
  }
  if (row.lastOutcome === 'ACQUISITION_FAILED' && !row.retryOwned) {
    return { state: 'RESOLVED', reason: row.lastFailureClass || 'TERMINAL_FAILURE' };
  }
  if (row.lastOutcome === 'PARTIALLY_INSPECTED' && !row.retryOwned) {
    return { state: 'RESOLVED', reason: row.lastFailureClass || 'TERMINAL_PARTIAL' };
  }
  return { state: 'PENDING', reason: null };
}

/**
 * Insert ledger rows that do not exist yet. Existing rows are never rewritten
 * here: their attempts, parks, and RUNNING leases are authoritative runtime
 * state. A later inspection updates the row through `completeCommunityWorkSlice`.
 */
export async function materializeCommunityWorkForChannel(
  channelId: string,
  options: { db?: CommunityWorkDb; windowDays?: number } = {},
): Promise<{ inserted: number; projected: number }> {
  const db = await database(options.db);
  const observations = await loadCommunityWorkObservations(channelId, {
    db,
    windowDays: options.windowDays,
  });
  if (observations.length === 0) return { inserted: 0, projected: 0 };
  const projection = projectCommunityAcquisitionWork(observations, { maxAttempts: Number.MAX_SAFE_INTEGER });

  const requiredRows = projection.rows.map(row => {
    const classified = initialLedgerState(row);
    return {
      work_key: row.workKey,
      channel_id: row.channelId,
      url: row.url,
      normalized_url: row.normalizedUrl,
      surface: row.surface,
      state: classified.state,
      required: true,
      recall: false,
      priority: 100,
      never_executed: row.neverExecuted,
      attempts: 0,
      max_attempts: 5,
      retryable: classified.state === 'PENDING' || classified.state === 'PARKED_INFRA',
      browser_executed: !row.neverBrowserExecuted,
      first_observed_at: row.firstObservedAt,
      last_attempt_at: null,
      next_eligible_at: classified.state === 'PARKED_INFRA'
        ? new Date(Date.now() + CAPACITY_BACKOFF_SECONDS * 1000).toISOString()
        : new Date().toISOString(),
      last_failure_class: row.lastFailureClass,
      last_outcome: row.lastOutcome,
      terminal_reason: classified.reason,
      terminal_evidence: {
        materializedFrom: 'external_acquisition_observations',
        latestOutcome: row.lastOutcome,
        latestFailureClass: row.lastFailureClass,
        retryOwned: row.retryOwned,
        observations: row.observations,
      },
    };
  });

  // Multi-invite recall: include relevant optional community URLs that are
  // not already required work rows. A FOUND or evidenced no-match URL is
  // resolved; unresolved optional URLs stay PENDING at lower priority so the
  // crawler never abandons other relevant sites after the first invite.
  const requiredKeys = new Set(requiredRows.map(row => row.work_key));
  const optionalGroups = new Map<string, { channelId: string; normalizedUrl: string; url: string; surface: string; observations: CommunityWorkObservation[] }>();
  for (const observation of observations) {
    if (isCommunityLedgerWorkObservation(observation)) continue;
    if (!COMMUNITY_ACQUISITION_WORK_SURFACES.has(String(asRecord(observation.provenance).surface || '').toUpperCase())) continue;
    if (!isCommunityRelevantObservation({ requestedUrl: observation.requestedUrl })) continue;
    const normalizedUrl = normalizeCommunityWorkUrl(observation.requestedUrl);
    if (!normalizedUrl) continue;
    const surface = String(asRecord(observation.provenance).surface || '').toUpperCase();
    const workKey = communityAcquisitionWorkKey(channelId, normalizedUrl, surface);
    if (requiredKeys.has(workKey)) continue;
    const group = optionalGroups.get(workKey);
    if (group) group.observations.push(observation);
    else optionalGroups.set(workKey, {
      channelId,
      normalizedUrl,
      url: observation.requestedUrl,
      surface,
      observations: [observation],
    });
  }
  const optionalRows = [...optionalGroups.entries()].map(([workKey, group]) => {
    const latest = selectEffectiveInspectionObservation(latestInspectionObservations(group.observations));
    if (!latest) return null;
    const terminal = terminalFor(latest);
    const processed = hasProcessedAcquisitionEvidence(latest);
    const directProcessed = hasDirectProcessedAcquisitionEvidence(latest);
    const browserExecuted = hasBrowserExecution(latest);
    const infra = isInfrastructureFailureClass(latest.failureClass);
    const state: CommunityWorkState = terminal.terminal
      ? 'RESOLVED'
      : infra
        ? 'PARKED_INFRA'
        : 'PENDING';
    return {
      work_key: workKey,
      channel_id: channelId,
      url: group.url,
      normalized_url: group.normalizedUrl,
      surface: group.surface,
      state,
      required: false,
      recall: true,
      priority: 10,
      never_executed: !group.observations.some(hasDirectProcessedAcquisitionEvidence),
      attempts: 0,
      max_attempts: 5,
      retryable: state === 'PENDING' || state === 'PARKED_INFRA',
      browser_executed: group.observations.some(hasBrowserExecution),
      first_observed_at: group.observations.reduce((min, obs) => obs.observedAt < min ? obs.observedAt : min, group.observations[0].observedAt),
      last_attempt_at: null,
      next_eligible_at: state === 'PENDING'
        ? new Date().toISOString()
        : state === 'PARKED_INFRA'
          ? new Date(Date.now() + CAPACITY_BACKOFF_SECONDS * 1000).toISOString()
          : new Date().toISOString(),
      last_failure_class: latest.failureClass || null,
      last_outcome: latest.outcome,
      terminal_reason: terminal.terminal ? terminal.reason : state === 'PARKED_INFRA' ? String(latest.failureClass || 'CAPACITY') : null,
      terminal_evidence: {
        materializedFrom: 'external_acquisition_observations',
        recall: true,
        latestOutcome: latest.outcome,
        latestFailureClass: latest.failureClass || null,
        observations: group.observations.length,
      },
    };
  }).filter((row): row is NonNullable<typeof row> => row !== null);
  const rows = [...requiredRows, ...optionalRows];

  const result = await db.query(
    `INSERT INTO community_acquisition_url_state(
       work_key,channel_id,url,normalized_url,surface,state,required,recall,priority,
       never_executed,attempts,max_attempts,retryable,browser_executed,first_observed_at,
       last_attempt_at,next_eligible_at,last_failure_class,last_outcome,
       terminal_reason,terminal_evidence
     )
     SELECT x.work_key,x.channel_id,x.url,x.normalized_url,x.surface,x.state,x.required,x.recall,x.priority,
            x.never_executed,x.attempts,x.max_attempts,x.retryable,x.browser_executed,x.first_observed_at,
            x.last_attempt_at,x.next_eligible_at,x.last_failure_class,x.last_outcome,
            x.terminal_reason,x.terminal_evidence
       FROM jsonb_to_recordset($1::jsonb) AS x(
         work_key text, channel_id text, url text, normalized_url text, surface text,
         state text, required boolean, recall boolean, priority integer,
         never_executed boolean, attempts integer, max_attempts integer,
         retryable boolean, browser_executed boolean, first_observed_at timestamptz,
         last_attempt_at timestamptz, next_eligible_at timestamptz,
         last_failure_class text, last_outcome text, terminal_reason text,
         terminal_evidence jsonb
       )
     ON CONFLICT (work_key) DO NOTHING`,
    [JSON.stringify(rows)],
  );
  return { inserted: result.rowCount || 0, projected: rows.length };
}

export async function hasCommunityWorkRows(channelId: string, db?: CommunityWorkDb): Promise<boolean> {
  const databaseClient = await database(db);
  const result = await databaseClient.query(
    `SELECT 1 FROM community_acquisition_url_state WHERE channel_id=$1 LIMIT 1`,
    [channelId],
  );
  return result.rows.length > 0;
}

/** Promote bounded parked rows whose backoff has elapsed. */
export async function promoteDueCommunityWork(
  db?: CommunityWorkDb,
  limit = 100,
): Promise<number> {
  const databaseClient = await database(db);
  const result = await databaseClient.query(
    `WITH due AS (
       SELECT work_key
         FROM community_acquisition_url_state
        WHERE state IN ('PARKED_INFRA','PARKED_EXTERNAL')
          AND next_eligible_at <= now()
        ORDER BY next_eligible_at, first_observed_at, work_key
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE community_acquisition_url_state s
        SET state='PENDING', next_eligible_at=now(), updated_at=now()
       FROM due
      WHERE s.work_key=due.work_key
      RETURNING s.work_key`,
    [Math.max(1, Math.floor(limit))],
  );
  return result.rowCount || 0;
}

/** Reset crashed RUNNING leases without charging an attempt. */
export async function resetStaleCommunityWork(
  db?: CommunityWorkDb,
  staleMinutes = RUNNING_LEASE_MINUTES,
): Promise<number> {
  const databaseClient = await database(db);
  const result = await databaseClient.query(
    `UPDATE community_acquisition_url_state
        SET state='PENDING', next_eligible_at=now(), updated_at=now()
      WHERE state='RUNNING'
        AND last_attempt_at < now() - ($1::text || ' minutes')::interval`,
    [String(Math.max(1, Math.floor(staleMinutes)))],
  );
  return result.rowCount || 0;
}

/**
 * Claim a bounded slice atomically. One URL belongs to one channel job, and
 * `FOR UPDATE SKIP LOCKED` prevents two workers from crawling the same slice.
 */
export async function claimCommunityWorkSlice(
  channelId: string,
  db?: CommunityWorkDb,
  limit = DEFAULT_SLICE_SIZE,
): Promise<CommunityWorkRow[]> {
  const databaseClient = await database(db);
  const result = await databaseClient.query(
    `WITH due AS (
       SELECT work_key
         FROM community_acquisition_url_state
        WHERE channel_id=$1
          AND state='PENDING'
          AND next_eligible_at <= now()
        ORDER BY priority DESC, never_executed DESC, first_observed_at ASC, work_key
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE community_acquisition_url_state s
        SET state='RUNNING',
            last_attempt_at=now(),
            next_eligible_at=now() + ($3::text || ' minutes')::interval,
            updated_at=now()
       FROM due
      WHERE s.work_key=due.work_key
      RETURNING s.work_key,s.channel_id,s.url,s.normalized_url,s.surface,s.state,
                s.required,s.recall,s.priority,s.never_executed,s.browser_executed,
                s.attempts,s.max_attempts,s.first_observed_at,s.last_attempt_at,
                s.next_eligible_at,s.last_failure_class,s.last_outcome,
                s.terminal_reason,s.terminal_evidence`,
    [channelId, Math.max(1, Math.floor(limit)), String(RUNNING_LEASE_MINUTES)],
  );
  return result.rows.map(rowToCommunityWorkRow);
}

function rowToCommunityWorkRow(row: any): CommunityWorkRow {
  return {
    workKey: String(row.work_key),
    channelId: String(row.channel_id),
    url: String(row.url),
    normalizedUrl: String(row.normalized_url),
    surface: String(row.surface),
    state: String(row.state) as CommunityWorkState,
    required: row.required !== false,
    recall: row.recall === true,
    priority: Number(row.priority ?? 100),
    neverExecuted: row.never_executed === true,
    neverBrowserExecuted: row.browser_executed !== true,
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 5),
    firstObservedAt: iso(row.first_observed_at) || new Date().toISOString(),
    lastAttemptAt: iso(row.last_attempt_at),
    nextEligibleAt: iso(row.next_eligible_at) || new Date().toISOString(),
    lastFailureClass: row.last_failure_class ? String(row.last_failure_class) : null,
    lastOutcome: row.last_outcome ? String(row.last_outcome) : null,
    terminalReason: row.terminal_reason ? String(row.terminal_reason) : null,
    terminalEvidence: asRecord(row.terminal_evidence),
  };
}

function backoffSeconds(attempts: number, infra: boolean): number {
  if (infra) return CAPACITY_BACKOFF_SECONDS;
  return Math.min(
    GENUINE_BACKOFF_MAX_SECONDS,
    GENUINE_BACKOFF_BASE_SECONDS * Math.pow(2, Math.max(0, attempts - 1)),
  );
}

function terminalFor(latest: CommunityWorkObservation): { terminal: boolean; reason: string } {
  // A FOUND row can still own a bounded required gap on the same URL. It stays
  // claimable until that gap closes, while a plain FOUND URL is resolved.
  if (latest.outcome === 'FOUND' && !observationOwnsRetry(latest)) {
    return { terminal: true, reason: 'FOUND' };
  }
  if (latest.outcome === 'INSPECTED_NO_MATCH' && hasProcessedAcquisitionEvidence(latest)) {
    return { terminal: true, reason: 'INSPECTED_NO_MATCH' };
  }
  const failureClass = String(latest.failureClass || '').toUpperCase();
  if (TERMINAL_FAILURE_CLASSES.has(failureClass)) return { terminal: true, reason: failureClass };
  if (latest.outcome === 'ACQUISITION_FAILED' && latest.retryable === false) {
    return { terminal: true, reason: failureClass || 'TERMINAL_FAILURE' };
  }
  if (latest.outcome === 'PARTIALLY_INSPECTED' && latest.retryable === false) {
    return { terminal: true, reason: failureClass || 'TERMINAL_PARTIAL' };
  }
  return { terminal: false, reason: '' };
}

/**
 * Apply one inspected slice to the ledger. Rows are keyed by the deterministic
 * work key, so observations from the slice cannot update another URL.
 */
export async function completeCommunityWorkSlice(
  channelId: string,
  claimed: readonly CommunityWorkRow[],
  options: { db?: CommunityWorkDb; windowDays?: number } = {},
): Promise<{ updated: number; resolved: number; parked: number; exhausted: number; pending: number }> {
  if (claimed.length === 0) return { updated: 0, resolved: 0, parked: 0, exhausted: 0, pending: 0 };
  const db = await database(options.db);
  const observations = await loadCommunityWorkObservations(channelId, {
    db,
    windowDays: options.windowDays,
  });
  const grouped = new Map<string, CommunityWorkObservation[]>();
  for (const observation of observations) {
    const normalized = normalizeCommunityWorkUrl(observation.requestedUrl);
    if (!normalized) continue;
    const surface = String(asRecord(observation.provenance).surface || '').toUpperCase();
    const key = communityAcquisitionWorkKey(channelId, normalized, surface);
    const group = grouped.get(key);
    if (group) group.push(observation);
    else grouped.set(key, [observation]);
  }

  let updated = 0;
  let resolved = 0;
  let parked = 0;
  let exhausted = 0;
  let pending = 0;

  for (const row of claimed) {
    const group = grouped.get(row.workKey) || [];
    const latest = selectEffectiveInspectionObservation(latestInspectionObservations(group));
    if (!latest) {
      // The URL was not present in this slice's collected links. Do not charge
      // an attempt; keep it available for a future inspection but back off so a
      // stale ledger row cannot spin.
      await db.query(
        `UPDATE community_acquisition_url_state
            SET state='PENDING',
                next_eligible_at=now() + interval '5 minutes',
                updated_at=now(),
                terminal_evidence=terminal_evidence || $2::jsonb
          WHERE work_key=$1`,
        [row.workKey, JSON.stringify({ lastSliceObserved: false })],
      );
      pending++;
      updated++;
      continue;
    }

    const processed = hasProcessedAcquisitionEvidence(latest);
    const directProcessed = hasDirectProcessedAcquisitionEvidence(latest);
    const browserExecuted = hasBrowserExecution(latest);
    const infra = isInfrastructureFailureClass(latest.failureClass);
    const terminal = terminalFor(latest);
    const attemptDelta = (processed || (latest.outcome === 'ACQUISITION_FAILED' && !infra)) ? 1 : 0;
    const attempts = row.attempts + attemptDelta;

    let state: CommunityWorkState;
    let reason: string | null = null;
    let nextEligibleAt = new Date().toISOString();
    if (terminal.terminal) {
      state = 'RESOLVED';
      reason = terminal.reason;
      resolved++;
    } else if (infra) {
      state = 'PARKED_INFRA';
      reason = String(latest.failureClass || 'CAPACITY');
      nextEligibleAt = new Date(Date.now() + backoffSeconds(row.attempts, true) * 1000).toISOString();
      parked++;
    } else if (attempts >= row.maxAttempts) {
      state = 'EXHAUSTED';
      reason = 'MAX_ATTEMPTS';
      exhausted++;
    } else {
      state = 'PENDING';
      nextEligibleAt = new Date(Date.now() + backoffSeconds(attempts, false) * 1000).toISOString();
      pending++;
    }

    const neverExecuted = row.neverExecuted && !directProcessed;
    const browserExecutedResult = row.neverBrowserExecuted ? browserExecuted : true;
    await db.query(
      `UPDATE community_acquisition_url_state
          SET state=$2,
              never_executed=$3,
              browser_executed=$4,
              attempts=$5,
              last_attempt_at=COALESCE($6,last_attempt_at),
              next_eligible_at=$7,
              last_failure_class=$8,
              last_outcome=$9,
              terminal_reason=$10,
              terminal_evidence=$11::jsonb,
              retryable=$12,
              updated_at=now()
        WHERE work_key=$1`,
      [
        row.workKey,
        state,
        neverExecuted,
        browserExecutedResult,
        attempts,
        iso(latest.observedAt),
        nextEligibleAt,
        latest.failureClass || null,
        latest.outcome,
        reason,
        JSON.stringify({
          observationId: latest.id || null,
          observedAt: latest.observedAt,
          outcome: latest.outcome,
          failureClass: latest.failureClass || null,
          processed,
          directProcessed,
          browserExecuted: latest.outcome === 'FOUND' ? true : browserExecuted,
          attempts,
          retryOwned: observationOwnsRetry(latest),
        }),
        state === 'PENDING' || state === 'PARKED_INFRA',
      ],
    );
    updated++;
  }

  return { updated, resolved, parked, exhausted, pending };
}

/** Release claimed rows after a pre-persistence worker failure without charging an attempt. */
export async function releaseCommunityWorkSlice(
  workKeys: readonly string[],
  db?: CommunityWorkDb,
  nextEligibleAt = new Date(Date.now() + 60_000).toISOString(),
): Promise<number> {
  if (workKeys.length === 0) return 0;
  const databaseClient = await database(db);
  const result = await databaseClient.query(
    `UPDATE community_acquisition_url_state
        SET state='PENDING', next_eligible_at=$2, updated_at=now()
      WHERE work_key = ANY($1::text[])
        AND state='RUNNING'`,
    [[...workKeys], nextEligibleAt],
  );
  return result.rowCount || 0;
}

export async function communityWorkSummary(channelId: string, db?: CommunityWorkDb): Promise<CommunityWorkSummary> {
  const databaseClient = await database(db);
  const result = await databaseClient.query(
    `SELECT state,
            count(*)::int AS n,
            count(*) FILTER (WHERE state='PENDING' AND next_eligible_at<=now())::int AS pending_due,
            min(next_eligible_at) FILTER (
              WHERE state IN ('PENDING','RUNNING','PARKED_INFRA','PARKED_EXTERNAL')
            ) AS min_next
       FROM community_acquisition_url_state
      WHERE channel_id=$1
      GROUP BY state`,
    [channelId],
  );
  const summary: CommunityWorkSummary = {
    total: 0,
    pending: 0,
    pendingDue: 0,
    running: 0,
    resolved: 0,
    parkedInfra: 0,
    parkedExternal: 0,
    exhausted: 0,
    minNextEligibleAt: null,
    active: 0,
  };
  for (const row of result.rows) {
    const n = Number(row.n || 0);
    const next = iso(row.min_next);
    summary.total += n;
    if (next && (!summary.minNextEligibleAt || next < summary.minNextEligibleAt)) {
      summary.minNextEligibleAt = next;
    }
    switch (String(row.state)) {
      case 'PENDING': summary.pending += n; summary.pendingDue += Number(row.pending_due || 0); break;
      case 'RUNNING': summary.running += n; break;
      case 'RESOLVED': summary.resolved += n; break;
      case 'PARKED_INFRA': summary.parkedInfra += n; break;
      case 'PARKED_EXTERNAL': summary.parkedExternal += n; break;
      case 'EXHAUSTED': summary.exhausted += n; break;
      default: break;
    }
  }
  summary.active = summary.pending + summary.running;
  return summary;
}

/**
 * Mark PENDING rows that cannot possibly produce useful community evidence as
 * resolved. This is deliberately conservative: malformed/non-HTTP URLs and
 * asset/JS/CSS/PDF-style destinations only. Affiliate and redirect URLs stay.
 */
export async function retireUnusableCommunityWork(
  channelId: string,
  db?: CommunityWorkDb,
): Promise<number> {
  const databaseClient = await database(db);
  const result = await databaseClient.query(
    `UPDATE community_acquisition_url_state
        SET state='RESOLVED',
            terminal_reason='UNUSABLE_URL',
            terminal_evidence=terminal_evidence || $2::jsonb,
            updated_at=now()
      WHERE channel_id=$1
        AND state='PENDING'
        AND (
          url !~* '^https?://'
          OR url ~* '\\.(pdf|zip|rar|7z|png|jpe?g|gif|webp|svg|ico|bmp|tiff|mp4|m4v|mov|avi|mkv|webm|mp3|wav|ogg|flac|woff2?|ttf|otf|eot|css|js|map|json|xml|rss)([?#].*)?$'
          OR url ~* '(^|/)undefined([/?#]|$)'
          OR length(url) > 2048
        )`,
    [channelId, JSON.stringify({ reason: 'unusable_url_pre_browser' })],
  );
  return result.rowCount || 0;
}
