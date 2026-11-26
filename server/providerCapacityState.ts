export type ProviderCapacityName = 'HEALTHY' | 'EXHAUSTED' | 'PROBING' | 'BLOCKED';

export interface ProviderCapacityStatus {
  available: boolean;
  probe: boolean;
  resumeAt: number | null;
  reason: string | null;
}

type CapacityDb = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
const CACHE_TTL_MS = 2_000;
const PROBE_LEASE_MS = 2 * 60_000;
let cached: { at: number; value: ProviderCapacityStatus } | null = null;
let inFlight: Promise<ProviderCapacityStatus> | null = null;

export function resetProviderCapacityCacheForTests(): void {
  cached = null;
  inFlight = null;
}

function invalidate(): void {
  cached = null;
  inFlight = null;
}

async function db(override?: CapacityDb): Promise<CapacityDb> {
  if (override) return override;
  const { getDb } = await import('./db');
  return getDb();
}

function expiryMs(value: unknown): number | null {
  if (value == null || value === '') return null;
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Persist an upstream provider quota/credential failure. This is deliberately
 * separate from local capacity deferrals: those never reached the provider and
 * must not open or extend a provider circuit.
 */
export async function recordProviderCapacityExhausted(input: {
  provider: 'gemini' | 'groq';
  scopeKey: string;
  operation: string;
  state: 'EXHAUSTED' | 'BLOCKED';
  reasonCode: string;
  resumeAt: number;
  sourceEventId?: string | null;
}, dbOverride?: CapacityDb): Promise<number> {
  const resumeAt = Number.isFinite(input.resumeAt) && input.resumeAt > Date.now()
    ? new Date(input.resumeAt).toISOString()
    : null;
  const client = await db(dbOverride);
  const result = await client.query(
    `INSERT INTO provider_capacity_state
       (provider, scope_key, operation, state, reason_code, resume_at, observed_at, updated_at, source_event_id, generation, probe_lease_until)
     VALUES ($1,$2,$3,$4,$5,$6,now(),now(),$7,1,NULL)
     ON CONFLICT (provider, scope_key, operation) DO UPDATE SET
       state=CASE WHEN provider_capacity_state.state='BLOCKED' THEN 'BLOCKED' ELSE excluded.state END,
       reason_code=excluded.reason_code,
       resume_at=CASE
         WHEN provider_capacity_state.state='EXHAUSTED'
          AND provider_capacity_state.resume_at IS NOT NULL
          AND excluded.resume_at IS NOT NULL
          AND provider_capacity_state.resume_at > excluded.resume_at
         THEN provider_capacity_state.resume_at
         ELSE excluded.resume_at
       END,
       observed_at=now(),
       updated_at=now(),
       source_event_id=excluded.source_event_id,
       generation=provider_capacity_state.generation+1,
       probe_lease_until=NULL
     RETURNING resume_at`,
    [input.provider, input.scopeKey, input.operation, input.state, input.reasonCode, resumeAt, input.sourceEventId || null],
  );
  invalidate();
  const persisted = expiryMs(result.rows[0]?.resume_at);
  return persisted ?? input.resumeAt;
}

/** A successful upstream call closes the circuit for that account/operation. */
export async function recordProviderCapacitySuccess(input: {
  provider: 'gemini' | 'groq';
  scopeKey: string;
  operation: string;
}, dbOverride?: CapacityDb): Promise<void> {
  const client = await db(dbOverride);
  await client.query(
    `UPDATE provider_capacity_state
        SET state='HEALTHY', resume_at=NULL, probe_lease_until=NULL,
            last_success_at=now(), updated_at=now(), generation=generation+1
      WHERE provider=$1 AND scope_key=$2 AND (operation=$3 OR operation='*')`,
    [input.provider, input.scopeKey, input.operation],
  );
  invalidate();
}

const SEMANTIC_OPERATIONS = ['*', 'multilingual-semantic-classification'];

/**
 * Pool-level semantic availability. Returns true while any configured route is
 * healthy. When every route is exhausted and its reset time has arrived, one
 * caller wins a probe lease; all other callers remain parked until the probe
 * reports success or a new reset time.
 */
export async function getSemanticCapacityStatus(nowMs: number = Date.now(), dbOverride?: CapacityDb): Promise<ProviderCapacityStatus> {
  const fresh = cached;
  if (fresh && nowMs - fresh.at < CACHE_TTL_MS) return fresh.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const client = await db(dbOverride);
      const rows = (await client.query(
        `SELECT provider, scope_key, operation, state, resume_at, probe_lease_until, reason_code
           FROM provider_capacity_state
          WHERE provider IN ('gemini','groq') AND operation = ANY($1::text[])`,
        [SEMANTIC_OPERATIONS],
      )).rows as Array<Record<string, unknown>>;
      let value: ProviderCapacityStatus = { available: true, probe: false, resumeAt: null, reason: null };
      if (rows.length) {
        const healthy = rows.some(row => row.state === 'HEALTHY');
        if (!healthy) {
          const probe = await client.query(
            `WITH candidate AS (
               SELECT provider, scope_key, operation
                 FROM provider_capacity_state
                WHERE provider IN ('gemini','groq')
                  AND operation = ANY($1::text[])
                  AND state IN ('EXHAUSTED','PROBING')
                  AND (resume_at IS NULL OR resume_at <= now())
                  AND (probe_lease_until IS NULL OR probe_lease_until <= now())
                ORDER BY COALESCE(resume_at, now()), provider, scope_key
                LIMIT 1
             )
             UPDATE provider_capacity_state s
                SET state='PROBING', probe_lease_until=now()+($2::int * interval '1 millisecond'), updated_at=now()
               FROM candidate c
              WHERE s.provider=c.provider AND s.scope_key=c.scope_key AND s.operation=c.operation
              RETURNING s.provider, s.scope_key, s.operation`,
            [SEMANTIC_OPERATIONS, PROBE_LEASE_MS],
          );
          if (probe.rowCount) {
            value = { available: true, probe: true, resumeAt: null, reason: 'PROBE' };
          } else {
            const resumeTimes = rows
              .map(row => expiryMs(row.resume_at))
              .filter((ms): ms is number => ms !== null && ms > nowMs);
            value = {
              available: false,
              probe: false,
              resumeAt: resumeTimes.length ? Math.min(...resumeTimes) : null,
              reason: String(rows[0]?.reason_code || 'PROVIDER_CAPACITY_EXHAUSTED'),
            };
          }
        }
      }
      invalidate();
      // A probe is a one-shot permission. Never cache it, or another worker
      // could receive the same probe slot during the lease window.
      if (!value.probe) cached = { at: nowMs, value };
      return value;
    } catch {
      // A pre-migration/database read failure must not freeze discovery.
      return { available: true, probe: false, resumeAt: null, reason: null };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export async function getProviderCapacitySnapshot(dbOverride?: CapacityDb): Promise<Array<Record<string, unknown>>> {
  const client = await db(dbOverride);
  return (await client.query(
    `SELECT provider, scope_key, operation, state, reason_code, resume_at,
            probe_lease_until, last_success_at, generation, updated_at
       FROM provider_capacity_state
      ORDER BY provider, scope_key, operation`,
  )).rows;
}
