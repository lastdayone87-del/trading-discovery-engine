/**
 * Durable per-key YouTube cap-refusal accounting.
 *
 * The enforced path refuses a dispatch before any provider request, so the
 * refusal never reaches job_attempts. The only historical record was the
 * application log, which Docker rotates and which disappears on restart. This
 * module writes an idempotent event row and increments a per-day/key counter in
 * one statement, then exposes a small read model for the stop-rule monitor.
 *
 * The counter is deliberately independent of the application log: a monitor
 * restart, a log rotation, or a crash between the refusal and the log flush
 * cannot reset or duplicate it. The Pacific quota day is part of both keys, so
 * a new day starts at zero without a cleanup job.
 */

export interface KeyCapRefusalQueryClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

export interface KeyCapRefusalInput {
  quotaDay: string;
  operationId: string;
  keyFingerprint: string;
  projectedUnits: number;
  requestUnits: number;
  capUnits: number;
}

export interface KeyCapRefusalRecordResult {
  inserted: boolean;
  refusals: number;
}

export interface KeyCapRefusalSummary {
  quotaDay: string;
  refusals: number;
  keys: number;
  lastRefusedAt: string | null;
}

export interface KeyCapRefusalKeyCount {
  keyFingerprint: string;
  refusals: number;
  projectedUnitsMax: number;
  lastRequestUnits: number;
  firstRefusedAt: string;
  lastRefusedAt: string;
}

const QUOTA_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One statement: insert the dispatch-identity event, and only when that insert
 * was new increment the (quota day, key) counter. A duplicate operation_id
 * therefore returns inserted=false and leaves the counter unchanged, even
 * under concurrent retries.
 */
export const RECORD_KEY_CAP_REFUSAL_SQL = `
WITH inserted AS (
  INSERT INTO youtube_key_cap_refusal_events
    (quota_day, operation_id, key_fingerprint, projected_units, request_units, cap_units)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (quota_day, operation_id) DO NOTHING
  RETURNING 1
), counted AS (
  INSERT INTO youtube_key_cap_refusal_counters
    (quota_day, key_fingerprint, refusals, projected_units_max, last_request_units, first_refused_at, last_refused_at)
  SELECT $1, $3, 1, $4, $5, now(), now()
    FROM inserted
  ON CONFLICT (quota_day, key_fingerprint) DO UPDATE SET
    refusals = youtube_key_cap_refusal_counters.refusals + 1,
    projected_units_max = GREATEST(
      youtube_key_cap_refusal_counters.projected_units_max,
      EXCLUDED.projected_units_max
    ),
    last_request_units = EXCLUDED.last_request_units,
    last_refused_at = now()
  RETURNING refusals
)
SELECT COALESCE((SELECT refusals FROM counted), 0)::bigint AS refusals,
       EXISTS(SELECT 1 FROM inserted) AS inserted
`;

export const READ_KEY_CAP_REFUSAL_SUMMARY_SQL = `
SELECT quota_day,
       COALESCE(SUM(refusals), 0)::bigint AS refusals,
       COUNT(*)::int AS keys,
       MAX(last_refused_at) AS last_refused_at
  FROM youtube_key_cap_refusal_counters
 WHERE quota_day = $1
 GROUP BY quota_day
`;

export const READ_KEY_CAP_REFUSAL_COUNTER_SQL = `
SELECT refusals
  FROM youtube_key_cap_refusal_counters
 WHERE quota_day = $1 AND key_fingerprint = $2
`;

export const READ_KEY_CAP_REFUSAL_KEY_COUNTS_SQL = `
SELECT key_fingerprint,
       refusals,
       projected_units_max,
       last_request_units,
       first_refused_at,
       last_refused_at
  FROM youtube_key_cap_refusal_counters
 WHERE quota_day = $1
 ORDER BY refusals DESC, key_fingerprint ASC
`;

function normalizedRefusalInput(input: KeyCapRefusalInput): KeyCapRefusalInput {
  const quotaDay = String(input.quotaDay || '');
  const operationId = String(input.operationId || '');
  const keyFingerprint = String(input.keyFingerprint || '');
  const projectedUnits = Number(input.projectedUnits);
  const requestUnits = Number(input.requestUnits);
  const capUnits = Number(input.capUnits);
  if (
    !QUOTA_DAY_PATTERN.test(quotaDay) ||
    !operationId ||
    !keyFingerprint ||
    !Number.isSafeInteger(projectedUnits) || projectedUnits < 0 ||
    !Number.isSafeInteger(requestUnits) || requestUnits <= 0 ||
    !Number.isSafeInteger(capUnits) || capUnits <= 0
  ) {
    throw new Error('INVALID_KEY_CAP_REFUSAL_INPUT');
  }
  return { quotaDay, operationId, keyFingerprint, projectedUnits, requestUnits, capUnits };
}

export async function recordYouTubeKeyCapRefusal(
  client: KeyCapRefusalQueryClient,
  input: KeyCapRefusalInput,
): Promise<KeyCapRefusalRecordResult> {
  const normalized = normalizedRefusalInput(input);
  const result = await client.query(RECORD_KEY_CAP_REFUSAL_SQL, [
    normalized.quotaDay,
    normalized.operationId,
    normalized.keyFingerprint,
    normalized.projectedUnits,
    normalized.requestUnits,
    normalized.capUnits,
  ]);
  const row = result.rows?.[0] || {};
  const inserted = row.inserted === true;
  let refusals = Number(row.refusals);
  if (!inserted) {
    // The idempotent statement cannot see a counter row committed by a
    // concurrent duplicate inside the same statement snapshot. Read it in a
    // fresh statement so callers always receive the exact current count.
    const current = await client.query(READ_KEY_CAP_REFUSAL_COUNTER_SQL, [
      normalized.quotaDay,
      normalized.keyFingerprint,
    ]);
    refusals = Number(current.rows?.[0]?.refusals);
  }
  return {
    inserted,
    refusals: Number.isFinite(refusals) ? refusals : 0,
  };
}

/**
 * Observability must never change the cap verdict. A missing migration, a
 * saturated pool, or a statement timeout returns false and the caller still
 * throws the original typed cap error.
 */
export async function recordYouTubeKeyCapRefusalSafe(
  client: KeyCapRefusalQueryClient,
  input: KeyCapRefusalInput,
): Promise<boolean> {
  try {
    const result = await recordYouTubeKeyCapRefusal(client, input);
    return result.inserted;
  } catch {
    return false;
  }
}

export async function readYouTubeKeyCapRefusalSummary(
  client: KeyCapRefusalQueryClient,
  quotaDay: string,
): Promise<KeyCapRefusalSummary> {
  const result = await client.query(READ_KEY_CAP_REFUSAL_SUMMARY_SQL, [quotaDay]);
  const row = result.rows?.[0];
  const refusals = Number(row?.refusals);
  return {
    quotaDay,
    refusals: Number.isFinite(refusals) ? refusals : 0,
    keys: Number(row?.keys) || 0,
    lastRefusedAt: row?.last_refused_at ? new Date(row.last_refused_at as string | Date).toISOString() : null,
  };
}

export async function readYouTubeKeyCapRefusalKeyCounts(
  client: KeyCapRefusalQueryClient,
  quotaDay: string,
): Promise<KeyCapRefusalKeyCount[]> {
  const result = await client.query(READ_KEY_CAP_REFUSAL_KEY_COUNTS_SQL, [quotaDay]);
  return (result.rows || []).map(row => ({
    keyFingerprint: String(row.key_fingerprint || ''),
    refusals: Number(row.refusals) || 0,
    projectedUnitsMax: Number(row.projected_units_max) || 0,
    lastRequestUnits: Number(row.last_request_units) || 0,
    firstRefusedAt: new Date(row.first_refused_at as string | Date).toISOString(),
    lastRefusedAt: new Date(row.last_refused_at as string | Date).toISOString(),
  }));
}
