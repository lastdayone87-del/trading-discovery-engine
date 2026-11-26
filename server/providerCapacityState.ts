export type ProviderCapacityName = 'HEALTHY' | 'EXHAUSTED' | 'PROBING' | 'BLOCKED';

export interface ProviderCapacityStatus {
  available: boolean;
  probe: boolean;
  resumeAt: number | null;
  reason: string | null;
}

export interface ProviderCapacityAccount {
  provider: 'gemini' | 'groq';
  scopeKey: string;
}

type CapacityDb = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
const CACHE_TTL_MS = 2_000;
const PROBE_LEASE_MS = 2 * 60_000;
let cached: { at: number; signature: string; value: ProviderCapacityStatus } | null = null;
let inFlight: { signature: string; promise: Promise<ProviderCapacityStatus> } | null = null;
let lastProbeDeliveredAt = 0;
let lastProbeSignature = '';

export function resetProviderCapacityCacheForTests(): void {
  cached = null;
  inFlight = null;
  lastProbeDeliveredAt = 0;
  lastProbeSignature = '';
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

function accountKey(provider: string, scopeKey: string): string {
  return `${provider}\u0000${scopeKey}`;
}

/**
 * Cache key for a route set. The same process serves callers with different
 * eligible-route sets (for example a Groq-only deployment and a worker that
 * explicitly asks about Gemini), so a status computed for one set must never
 * be reused for another.
 */
function accountsSignature(accounts: ProviderCapacityAccount[]): string {
  return [...new Set(accounts.map(account => accountKey(account.provider, account.scopeKey)))].sort().join('\u0001');
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
  return expiryMs(result.rows[0]?.resume_at) ?? input.resumeAt;
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
      WHERE provider=$1 AND scope_key=$2 AND (operation=$3 OR operation='*')
        AND state <> 'HEALTHY'`,
    [input.provider, input.scopeKey, input.operation],
  );
  invalidate();
}

interface CapacityRow {
  provider: string;
  scope_key: string;
  operation: string;
  state: ProviderCapacityName;
  resume_at: unknown;
  probe_lease_until: unknown;
  reason_code: string | null;
}

/**
 * Pool-level semantic availability. Missing account state is healthy: a
 * configured route that has never failed must remain eligible. A daily ('*')
 * quota row overrides any stale per-operation health for the same account.
 * Once every configured route is exhausted, exactly one caller may win a
 * short-lived probe lease; the others remain parked.
 */
export async function getSemanticCapacityStatus(
  accounts: ProviderCapacityAccount[] = [],
  nowMs: number = Date.now(),
  dbOverride?: CapacityDb,
): Promise<ProviderCapacityStatus> {
  const signature = accountsSignature(accounts);
  const fresh = cached;
  if (fresh && fresh.signature === signature && nowMs - fresh.at < CACHE_TTL_MS) return fresh.value;
  if (inFlight && inFlight.signature === signature) {
    const shared = await inFlight.promise;
    // A probe is a one-shot permission. Callers waiting on the same in-flight
    // read must not receive the winner's probe.
    if (shared.probe && lastProbeSignature === signature && Date.now() - lastProbeDeliveredAt < CACHE_TTL_MS) {
      return { ...shared, available: false, probe: false };
    }
    return shared;
  }
  const promise = (async () => {
    try {
      const client = await db(dbOverride);
      const rows = (await client.query(
        `SELECT provider, scope_key, operation, state, resume_at, probe_lease_until, reason_code
           FROM provider_capacity_state
          WHERE provider IN ('gemini','groq') AND operation IN ('*','multilingual-semantic-classification')`,
      )).rows as CapacityRow[];
      const configured = new Map<string, ProviderCapacityAccount>();
      for (const account of accounts) configured.set(accountKey(account.provider, account.scopeKey), account);
      // With no explicit account list, derive the universe from persisted rows.
      if (!configured.size) {
        for (const row of rows) configured.set(accountKey(row.provider, row.scope_key), { provider: row.provider as 'gemini' | 'groq', scopeKey: row.scope_key });
      }
      const rowsByAccount = new Map<string, CapacityRow[]>();
      for (const row of rows) {
        const key = accountKey(row.provider, row.scope_key);
        rowsByAccount.set(key, [...(rowsByAccount.get(key) || []), row]);
      }
      let healthy = configured.size === 0;
      const blockers: CapacityRow[] = [];
      for (const [key] of configured) {
        const accountRows = rowsByAccount.get(key) || [];
        if (!accountRows.length) {
          healthy = true;
          continue;
        }
        const daily = accountRows.find(row => row.operation === '*');
        const exact = accountRows.find(row => row.operation === 'multilingual-semantic-classification');
        const effective = daily && daily.state !== 'HEALTHY' ? daily : exact || daily;
        if (!effective || effective.state === 'HEALTHY') {
          healthy = true;
        } else {
          blockers.push(effective);
        }
      }
      let value: ProviderCapacityStatus = { available: true, probe: false, resumeAt: null, reason: null };
      if (!healthy) {
        const candidate = blockers
          .filter(row => (row.state === 'EXHAUSTED' || row.state === 'PROBING')
            && (expiryMs(row.resume_at) === null || (expiryMs(row.resume_at) as number) <= nowMs)
            && (expiryMs(row.probe_lease_until) === null || (expiryMs(row.probe_lease_until) as number) <= nowMs))
          .sort((a, b) => (a.operation === '*' ? 0 : 1) - (b.operation === '*' ? 0 : 1))[0];
        if (candidate) {
          const probe = await client.query(
            `UPDATE provider_capacity_state
                SET state='PROBING', probe_lease_until=now()+($4::int * interval '1 millisecond'), updated_at=now()
              WHERE provider=$1 AND scope_key=$2 AND operation=$3
                AND state IN ('EXHAUSTED','PROBING')
                AND (resume_at IS NULL OR resume_at <= now())
                AND (probe_lease_until IS NULL OR probe_lease_until <= now())
              RETURNING provider, scope_key, operation`,
            [candidate.provider, candidate.scope_key, candidate.operation, PROBE_LEASE_MS],
          );
          if (probe.rowCount) {
            value = { available: true, probe: true, resumeAt: null, reason: 'PROBE' };
          }
        }
        if (!value.probe) {
          const resumeTimes = blockers
            .map(row => expiryMs(row.resume_at))
            .filter((ms): ms is number => ms !== null && ms > nowMs);
          value = {
            available: false,
            probe: false,
            resumeAt: resumeTimes.length ? Math.min(...resumeTimes) : null,
            reason: String(blockers[0]?.reason_code || 'PROVIDER_CAPACITY_EXHAUSTED'),
          };
        }
      }
      if (value.probe) {
        lastProbeDeliveredAt = Date.now();
        lastProbeSignature = signature;
      } else {
        cached = { at: nowMs, signature, value };
      }
      return value;
    } catch {
      // A pre-migration/database read failure must not freeze discovery.
      return { available: true, probe: false, resumeAt: null, reason: null };
    } finally {
      if (inFlight?.signature === signature) inFlight = null;
    }
  })();
  inFlight = { signature, promise };
  return promise;
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
