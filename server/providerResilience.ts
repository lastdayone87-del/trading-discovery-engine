import { randomUUID } from 'node:crypto';

export type ProviderStatus = 'SUCCESS'|'TIMEOUT'|'CANCELLED'|'RATE_LIMITED'|'TRANSIENT_ERROR'|'PERMANENT_ERROR';
export type ProviderErrorClass = 'TIMEOUT'|'CANCELLED'|'RATE_LIMIT'|'TRANSIENT'|'PERMANENT_INPUT'|'CREDENTIALS_EXHAUSTED';

export interface ProviderCallContext {
  provider: string; operation: string; requestId?: string; runId?: string; jobId?: string;
  requestMetadata?: Record<string, string | null>;
  attempt?: number; reservedCost?: number; actualCost?: number; policyVersion?: string;
}
export interface ProviderCallEvent extends Required<Pick<ProviderCallContext,'provider'|'operation'>> {
  id: string; requestId?: string; runId?: string; jobId?: string; requestMetadata?: Record<string, string | null>; attempt: number;
  status: ProviderStatus; latencyMs: number; reservedCost: number; actualCost: number;
  errorClass?: ProviderErrorClass; policyVersion: string; occurredAt: string;
}

export type ProviderQuotaScope = 'DAILY'|'MINUTE';

export interface ProviderCallErrorOptions {
  cause?: unknown;
  status?: number;
  quotaExceeded?: boolean;
  providerReasons?: string[];
  /**
   * True when the failure belongs to one route/key/project and another route
   * may still succeed. Failover loops must advance past route-scoped errors;
   * job-scoped errors (bad prompt, unsupported model shape) still abort.
   */
  routeScoped?: boolean;
  /** Provider-supplied retry delay in milliseconds. */
  retryAfterMs?: number;
  /** Absolute epoch-ms at which the provider says the exhausted window resets. */
  cooldownUntilMs?: number;
  /** Daily quotas must not be retried on the per-minute cooldown clock. */
  quotaScope?: ProviderQuotaScope;
  /** Bounded provider quota identifier for diagnostics (never a credential). */
  quotaId?: string;
}

export class ProviderCallError extends Error {
  readonly status?: number;
  readonly quotaExceeded?: boolean;
  readonly providerReasons?: string[];
  readonly routeScoped: boolean;
  readonly retryAfterMs?: number;
  readonly cooldownUntilMs?: number;
  readonly quotaScope?: ProviderQuotaScope;
  readonly quotaId?: string;
  constructor(message: string, public readonly errorClass: ProviderErrorClass, public readonly retryable: boolean, options?: ProviderCallErrorOptions) {
    super(message, options); this.name='ProviderCallError';
    this.status=options?.status; this.quotaExceeded=options?.quotaExceeded; this.providerReasons=options?.providerReasons;
    this.routeScoped=options?.routeScoped===true;
    this.retryAfterMs=options?.retryAfterMs; this.cooldownUntilMs=options?.cooldownUntilMs;
    this.quotaScope=options?.quotaScope; this.quotaId=options?.quotaId;
  }
}

/** Parse Google `RetryInfo.retryDelay` values such as `"61986.75s"` or `"59s"`. */
export function parseProviderRetryDelayMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value * 1000);
  const text = String(value ?? '').trim();
  const match = /^([0-9]+(?:\.[0-9]+)?)s$/i.exec(text);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds * 1000) : undefined;
}

type GoogleQuotaFailure = {
  retryAfterMs?: number;
  quotaScope?: ProviderQuotaScope;
  quotaId?: string;
};

/**
 * Extract Google quota-failure details from an SDK error. The GenAI SDK puts
 * the complete JSON error envelope in `error.message`; direct HTTP callers may
 * instead expose `error.response.data` or `error.details`. Never throws.
 */
export function extractGoogleQuotaFailure(error: unknown): GoogleQuotaFailure {
  const value = error as any;
  const candidates: string[] = [];
  const push = (candidate: unknown) => {
    if (typeof candidate === 'string' && candidate.trim()) candidates.push(candidate);
    else if (candidate && typeof candidate === 'object') {
      try { candidates.push(JSON.stringify(candidate)); } catch { /* ignore */ }
    }
  };
  push(value?.message);
  push(value?.response?.data);
  push(value?.errorDetails);
  push(value?.details);
  push(value?.cause?.message);
  const body = candidates.join('\n');
  if (!body) return {};

  let retryDelay: unknown;
  let quotaId: string | undefined;
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const type = String(node['@type'] || node.type || '');
    if (/RetryInfo/i.test(type) && node.retryDelay != null) retryDelay ??= node.retryDelay;
    if (/QuotaFailure/i.test(type) && Array.isArray(node.violations)) {
      for (const violation of node.violations) {
        const id = String(violation?.quotaId || violation?.quotaMetric || '');
        if (!id) continue;
        // Prefer a daily quota over a per-minute quota when both are present:
        // the longer window is the one failover must respect.
        if (!quotaId || (/PerDay/i.test(id) && !/PerDay/i.test(quotaId))) quotaId = id;
      }
    }
    for (const child of Object.values(node)) visit(child);
  };

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start));
      visit(parsed);
      if (retryDelay != null && quotaId) break;
    } catch {
      // Fall through to bounded regex extraction below.
    }
  }
  if (retryDelay == null) {
    const match = /"retryDelay"\s*:\s*"([^"]+)"/i.exec(body);
    retryDelay = match?.[1];
  }
  if (!quotaId) {
    const match = /"(?:quotaId|quotaMetric)"\s*:\s*"([^"]+)"/i.exec(body);
    quotaId = match?.[1];
  }
  const quotaScope: ProviderQuotaScope | undefined = quotaId
    ? (/PerDay/i.test(quotaId) ? 'DAILY' : /PerMinute/i.test(quotaId) ? 'MINUTE' : undefined)
    : /PerDay/i.test(body) ? 'DAILY' : /PerMinute/i.test(body) ? 'MINUTE' : undefined;
  const result: GoogleQuotaFailure = {};
  const retryAfterMs = parseProviderRetryDelayMs(retryDelay);
  if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
  if (quotaScope !== undefined) result.quotaScope = quotaScope;
  if (quotaId) result.quotaId = quotaId.slice(0, 160);
  return result;
}

/** Next midnight Pacific (Google's daily-quota reset boundary), as epoch ms. */
export function nextPacificMidnightMs(nowMs: number = Date.now()): number {
  const timeZone = 'America/Los_Angeles';
  const offsetAt = (utcMs: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value || 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - utcMs;
  };
  const offset = offsetAt(nowMs);
  const local = new Date(nowMs + offset);
  const nextLocalMidnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 0, 0, 0);
  // Re-evaluate the offset at the reset instant so DST transitions cannot
  // shift the boundary by an hour.
  return nextLocalMidnightAsUtc - offsetAt(nextLocalMidnightAsUtc - offset);
}

/**
 * Resolve the effective cooldown expiry from a persisted rate-limit row.
 * Provider-declared absolute cooldowns (daily quotas) win over the fixed
 * per-minute cooldown when they extend further into the future.
 */
export function providerCooldownExpiryMs(
  occurredAt: unknown,
  cooldownUntilMs: unknown,
  defaultCooldownMs: number,
  nowMs: number = Date.now(),
): number | undefined {
  const occurredMs = occurredAt == null ? NaN : new Date(occurredAt as any).getTime();
  const declaredMs = Number(cooldownUntilMs);
  const hasDeclared = cooldownUntilMs != null && cooldownUntilMs !== '' && Number.isFinite(declaredMs);
  const fixedExpiry = Number.isFinite(occurredMs) ? occurredMs + defaultCooldownMs : undefined;
  const expiry = Math.max(fixedExpiry ?? 0, hasDeclared ? declaredMs : 0) || undefined;
  if (expiry === undefined || expiry <= nowMs) return undefined;
  return expiry;
}

function errorText(value: any): string {
  const pieces = [value?.message];
  if (value?.response?.data) {
    try { pieces.push(typeof value.response.data === 'string' ? value.response.data : JSON.stringify(value.response.data)); } catch { /* ignore */ }
  }
  return pieces.map(piece => String(piece ?? '')).join('\n');
}

export function classifyProviderError(error: unknown, nowMs: number = Date.now(), provider?: string): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  const value=error as any; const message=String(value?.message||value||'Provider call failed');
  const status=Number(value?.status||value?.code)||undefined;
  const reasons=Array.isArray(value?.providerReasons)?value.providerReasons.map(String):[];
  const body=errorText(value);
  // Route-scoped credential handling is meaningful for the semantic provider
  // boundaries, where another key/project can still serve. Other callers
  // (for example YouTube) keep their previous transient classification for a
  // non-quota 403 so key rotation remains free to try another key.
  const routeCredentialFailure = provider === undefined || provider === 'gemini' || provider === 'gemini-free' || provider === 'groq';
  if (value?.name==='AbortError') return new ProviderCallError('Provider call was cancelled.','CANCELLED',true,{cause:error});
  if (status===429 || /429|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(message)) {
    const quota=extractGoogleQuotaFailure(error);
    const quotaReasons=quota.quotaScope?[`PROVIDER_QUOTA_${quota.quotaScope}`]:[];
    return new ProviderCallError('Provider rate limit reached.','RATE_LIMIT',true,{
      cause:error,status,quotaExceeded:value?.quotaExceeded??!!quota.quotaId,
      providerReasons:[...reasons,...quotaReasons],
      retryAfterMs:quota.retryAfterMs,
      cooldownUntilMs:quota.retryAfterMs!=null?nowMs+quota.retryAfterMs:quota.quotaScope==='DAILY'?nextPacificMidnightMs(nowMs):undefined,
      quotaScope:quota.quotaScope,quotaId:quota.quotaId,
    });
  }
  if (status===400 && /organization_restricted/i.test(body)) {
    return new ProviderCallError('Provider route is restricted to a different organization.','CREDENTIALS_EXHAUSTED',false,{
      cause:error,status,providerReasons:[...reasons,'GROQ_ORGANIZATION_RESTRICTED'],routeScoped:true,
    });
  }
  if (status===400 && /json_validate_failed|json validation failed/i.test(body)) {
    return new ProviderCallError('Provider rejected the model completion as invalid JSON.','TRANSIENT',true,{
      cause:error,status,providerReasons:[...reasons,'GROQ_JSON_VALIDATION_FAILED'],routeScoped:true,
    });
  }
  if (status===401 || status===403) {
    if (!routeCredentialFailure) return new ProviderCallError('Transient provider failure.','TRANSIENT',true,{cause:error,status});
    // Credential rejection is route-scoped: advance to another independent
    // account. It stays retryable (TRANSIENT) because a different route may
    // serve; it is never rate-limit pressure, so it must not arm a cooldown.
    return new ProviderCallError('Provider rejected the route credential.','TRANSIENT',true,{
      cause:error,status,providerReasons:[...reasons,'PROVIDER_ROUTE_UNAUTHORIZED'],routeScoped:true,
    });
  }
  // Transient-looking messages keep their historical classification even when
  // carried on a 400/404/422 status: the specific 400 branches above already
  // claimed the two conditions that must not be treated as transport noise.
  if ([408,500,502,503,504].includes(status) || /ECONNRESET|ETIMEDOUT|high demand|temporar/i.test(message)) return new ProviderCallError('Transient provider failure.','TRANSIENT',true,{cause:error,status});
  if (status===400 || status===404 || status===422) return new ProviderCallError('Permanent provider input failure.','PERMANENT_INPUT',false,{cause:error,status,providerReasons:value?.providerReasons});
  return new ProviderCallError('Provider call failed.','TRANSIENT',true,{cause:error});
}

export const statusFor=(e:ProviderCallError):ProviderStatus => e.errorClass==='TIMEOUT'?'TIMEOUT':e.errorClass==='CANCELLED'?'CANCELLED':e.errorClass==='RATE_LIMIT'?'RATE_LIMITED':e.retryable?'TRANSIENT_ERROR':'PERMANENT_ERROR';
export type ProviderEventSink=(event:ProviderCallEvent)=>Promise<void>;

const GEMINI_CAPACITY_LOCK_NAMESPACE = 741963285;
const GEMINI_SEMANTIC_OPERATION = 'multilingual-semantic-classification';
const GEMINI_VOCABULARY_OPERATION = 'vocabulary-extraction';
const GEMINI_LOCK_POLL_MS = 100;
const GEMINI_OUTCOME_CLEANUP_TIMEOUT_MS = 1000;

export const DEFAULT_GEMINI_ROUTE_ID = 'gemini-1';

/** Return configured Gemini route IDs from environment (no credentials exposed). */
export function configuredGeminiRouteIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = Object.keys(env).filter(name => name === 'GEMINI_API_KEY' || /^GEMINI_API_KEY_[2-9][0-9]*$/.test(name));
  names.sort((a, b) => {
    const routeNumber = (name: string) => name === 'GEMINI_API_KEY' ? 1 : Number(name.slice('GEMINI_API_KEY_'.length));
    return routeNumber(a) - routeNumber(b);
  });
  const seen = new Set<string>();
  return names.flatMap(name => {
    const key = String(env[name] || '').trim();
    if (!key || seen.has(key)) return [];
    seen.add(key);
    const numeric = name === 'GEMINI_API_KEY' ? 1 : Number(name.slice('GEMINI_API_KEY_'.length));
    return [resolveGeminiRouteId(`gemini-${numeric}`)];
  });
}

/**
 * Configured Gemini account labels, matching the provider's
 * `geminiOrgIdForSlot`: an explicit GEMINI_ORG_ID(_N) label, else the slot's
 * own independent account. Used only to scope ledger reads; never a secret.
 */
function configuredGeminiOrgIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = Object.keys(env).filter(name => name === 'GEMINI_API_KEY' || /^GEMINI_API_KEY_[2-9][0-9]*$/.test(name));
  names.sort((a, b) => {
    const slot = (name: string) => name === 'GEMINI_API_KEY' ? 1 : Number(name.slice('GEMINI_API_KEY_'.length));
    return slot(a) - slot(b);
  });
  const seenKeys = new Set<string>();
  const orgs: string[] = [];
  for (const name of names) {
    const key = String(env[name] || '').trim();
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const slot = name === 'GEMINI_API_KEY' ? 1 : Number(name.slice('GEMINI_API_KEY_'.length));
    const orgName = slot === 1 ? 'GEMINI_ORG_ID' : `GEMINI_ORG_ID_${slot}`;
    const label = String(env[orgName] || '').trim();
    orgs.push(label || `slot-${slot}`);
  }
  return orgs;
}

/** Resolve only machine-owned route identifiers; never expose or persist credentials. */
export function resolveGeminiRouteId(value: unknown): string {
  const candidate = String(value || '').trim();
  return /^gemini-[1-9][0-9]*$/.test(candidate) ? candidate : DEFAULT_GEMINI_ROUTE_ID;
}

type GeminiCapacitySnapshot = {
  nowMs: number;
  lastGeminiAtMs?: number;
  lastRateLimitAtMs?: number;
  /** Absolute expiry carried by the latest rate-limit event (daily quota reset). */
  rateLimitCooldownUntilMs?: number;
  /** Quota scope of the latest rate-limit event, when the provider declared it. */
  rateLimitQuotaScope?: ProviderQuotaScope;
  lastSemanticAtMs?: number;
  lastVocabularyAtMs?: number;
  /** All Gemini calls for this account inside the rolling quota window. */
  orgCallsInWindow?: number;
};

type GeminiCapacityConfig = {
  globalMinIntervalMs: number;
  semanticRateLimitCooldownMs: number;
  vocabularyRateLimitSuppressionMs: number;
  vocabularySemanticQuietMs: number;
  vocabularyMinIntervalMs: number;
  maxInlineWaitMs?: number;
  semanticMaxInlineWaitMs?: number;
  /** Rolling-window length for the per-account token bucket. */
  orgRateLimitWindowMs?: number;
  /** 0 disables the bucket; otherwise DEFER once the window is full. */
  orgMaxCallsPerWindow?: number;
};

export type GeminiCapacityDecision = { action:'RUN'|'WAIT'|'DEFER'; waitMs:number; reasonCode?:string };

function envMs(name:string, fallback:number):number {
  const raw=process.env[name];
  // Empty values are how deployment UIs represent "unset"; treating them as
  // numeric zero would silently disable the fallback window (e.g. the 90s
  // Gemini semantic cooldown).
  if(raw===undefined||raw===null||raw.trim()==='')return fallback;
  const parsed=Number(raw);
  return Number.isFinite(parsed)&&parsed>=0?parsed:fallback;
}

function geminiCapacityConfig():GeminiCapacityConfig {
  const orgMaxCalls = Number(process.env.GEMINI_ORG_MAX_CALLS_PER_MINUTE ?? '10');
  const orgWindowMs = Number(process.env.GEMINI_ORG_RATE_WINDOW_MS ?? '60000');
  return {
    // Pacing is per configured account. The legacy name stays honored so an
    // existing deployment keeps its interval, but one account's call no
    // longer delays every other independent project.
    globalMinIntervalMs: envMs('GEMINI_ORG_MIN_INTERVAL_MS', envMs('GEMINI_GLOBAL_MIN_INTERVAL_MS', 6000)),
    semanticRateLimitCooldownMs: envMs('GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS', 90000),
    vocabularyRateLimitSuppressionMs: envMs('GEMINI_VOCABULARY_RATE_LIMIT_SUPPRESSION_MS', 15*60*1000),
    vocabularySemanticQuietMs: envMs('GEMINI_VOCABULARY_SEMANTIC_QUIET_MS', 2*60*1000),
    vocabularyMinIntervalMs: envMs('GEMINI_VOCABULARY_MIN_INTERVAL_MS', 30000),
    maxInlineWaitMs: envMs('GEMINI_CAPACITY_MAX_INLINE_WAIT_MS', 8000),
    semanticMaxInlineWaitMs: envMs('GEMINI_SEMANTIC_MAX_INLINE_WAIT_MS', 8000),
    orgRateLimitWindowMs: Number.isFinite(orgWindowMs) && orgWindowMs > 0 ? orgWindowMs : 60000,
    // 0 is an explicit opt-out; negative/garbage falls back to the default.
    orgMaxCallsPerWindow: Number.isFinite(orgMaxCalls) && orgMaxCalls >= 0 ? orgMaxCalls : 10,
  };
}

export function decideGeminiCapacity(operation:string, snapshot:GeminiCapacitySnapshot, config:GeminiCapacityConfig=geminiCapacityConfig()):GeminiCapacityDecision {
  const age=(value?:number)=>value==null?Number.POSITIVE_INFINITY:Math.max(0,snapshot.nowMs-value);
  const maxInlineWaitMs=config.maxInlineWaitMs??8000;
  const semanticMaxInlineWaitMs=config.semanticMaxInlineWaitMs??maxInlineWaitMs;
  // Per-account token bucket. The advisory lock serializes only calls that
  // share this account, so independent Google projects are no longer paced by
  // one another. A full window defers; it never silently drops the call.
  const bucketCapacity = config.orgMaxCallsPerWindow ?? 10;
  if (bucketCapacity > 0 && (snapshot.orgCallsInWindow ?? 0) >= bucketCapacity) {
    return {action:'DEFER',waitMs:0,reasonCode:'GEMINI_ORG_TOKEN_BUCKET_EMPTY'};
  }
  const globalWait=Math.max(0,config.globalMinIntervalMs-age(snapshot.lastGeminiAtMs));
  // A provider-declared absolute reset (daily quota) is authoritative and
  // must not be retried on the short per-minute cooldown clock. For per-minute
  // limits the provider may declare a shorter retry delay than our fixed
  // cooldown; take the larger of the two so this gate never reopens before the
  // persisted resolver (providerCooldownExpiryMs) does.
  const declaredRateLimitWait=snapshot.rateLimitCooldownUntilMs!=null
    ? Math.max(0,snapshot.rateLimitCooldownUntilMs-snapshot.nowMs)
    : 0;
  const dailyDeclaredExpired=snapshot.rateLimitQuotaScope==='DAILY'&&declaredRateLimitWait<=0;
  const minuteRateLimitWait=dailyDeclaredExpired
    ? 0
    : age(snapshot.lastRateLimitAtMs)<config.semanticRateLimitCooldownMs
      ? config.semanticRateLimitCooldownMs-age(snapshot.lastRateLimitAtMs)
      : 0;
  if(operation===GEMINI_VOCABULARY_OPERATION){
    if(declaredRateLimitWait>0||(!dailyDeclaredExpired&&age(snapshot.lastRateLimitAtMs)<config.vocabularyRateLimitSuppressionMs)) return {action:'DEFER',waitMs:0,reasonCode:'VOCABULARY_DEFERRED_RATE_PRESSURE'};
    if(age(snapshot.lastSemanticAtMs)<config.vocabularySemanticQuietMs) return {action:'DEFER',waitMs:0,reasonCode:'VOCABULARY_DEFERRED_SEMANTIC_PRIORITY'};
    const vocabularyWait=Math.max(0,config.vocabularyMinIntervalMs-age(snapshot.lastVocabularyAtMs));
    const waitMs=Math.max(globalWait,vocabularyWait);
    if(waitMs>maxInlineWaitMs) return {action:'DEFER',waitMs:0,reasonCode:'VOCABULARY_DEFERRED_CAPACITY_WAIT'};
    return {action:waitMs>0?'WAIT':'RUN',waitMs};
  }
  const rateLimitWait=Math.max(declaredRateLimitWait,minuteRateLimitWait);
  const waitMs=Math.max(globalWait,rateLimitWait);
  const isSemantic=operation===GEMINI_SEMANTIC_OPERATION;
  const waitCeiling=isSemantic?semanticMaxInlineWaitMs:maxInlineWaitMs;
  if(waitMs>waitCeiling) return {action:'DEFER',waitMs:0,reasonCode:isSemantic?'SEMANTIC_DEFERRED_RATE_PRESSURE':'GEMINI_OPERATION_DEFERRED_RATE_PRESSURE'};
  return {action:waitMs>0?'WAIT':'RUN',waitMs};
}

/**
 * Returns the timestamp (ms since epoch) at which the Gemini semantic provider
 * cooldown will expire, based on the last RATE_LIMITED event persisted in
 * provider_call_events for an account this process can actually serve.
 * Returns undefined if no configured Gemini account has a recorded rate limit
 * or the cooldown has already elapsed.
 *
 * Gemini rate limits are project-level, so each independent account's window
 * derives only from rows tagged with that account. This legacy pool-wide
 * resolver keeps its no-argument call shape for the queue retry fallback, but
 * never lets an untagged or unrelated account's 429 cool configured projects.
 *
 * This is the single authoritative source of Gemini semantic cooldown state.
 * It queries the same provider_call_events table used by acquireGeminiCapacity,
 * so there are no independent clocks or parallel rate limiters.
 */
export async function getGeminiSemanticCooldownExpiry(
  nowMs: number = Date.now(),
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> = async (sql, values) => {
    const { getDb } = await import('./db');
    const db = await getDb();
    return db.query(sql, values);
  },
): Promise<number | undefined> {
  const orgIds = [...new Set(configuredGeminiOrgIds())];
  // No configured paid-Gemini account means this pool gate has no account to
  // describe; a global unscoped read would only group independent projects.
  if (!orgIds.length) return undefined;
  const config = geminiCapacityConfig();
  try {
    const res = await query(
      `SELECT occurred_at,
              MAX((request_metadata->>'cooldownUntilMs')::bigint)
                FILTER (WHERE request_metadata->>'cooldownUntilMs' ~ '^[0-9]+$') OVER () AS cooldown_until_ms
         FROM provider_call_events
        WHERE provider='gemini' AND status='RATE_LIMITED'
          AND request_metadata->>'geminiOrg' = ANY($1::text[])
          AND occurred_at >= now() - interval '2 days'
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgIds],
    );
    const row = res.rows[0];
    if (!row?.occurred_at) return undefined;
    return providerCooldownExpiryMs(row.occurred_at, row.cooldown_until_ms, config.semanticRateLimitCooldownMs, nowMs);
  } catch {
    return undefined;
  }
}

/**
 * Returns true when the Gemini semantic provider is in an active cooldown
 * that would cause a semantic classification call to DEFER.
 *
 * Gemini rate limits are project-level: a single RATE_LIMITED event on any
 * route triggers a shared cooldown that blocks all semantic operations.
 * This matches acquireGeminiCapacity's global scope.
 */
export async function isGeminiSemanticCooldownActive(nowMs: number = Date.now()): Promise<boolean> {
  const expiry = await getGeminiSemanticCooldownExpiry(nowMs);
  return expiry !== undefined && expiry > nowMs;
}

/**
 * Per-account Gemini cooldown expiry from the persisted ledger. Each
 * account's window derives only from RATE_LIMITED rows tagged with its own
 * org label; untagged rows cool no account (fail-open for at most one window
 * after deploy, after which every semantic path tags its rows). A 429 on one
 * account never affects another account's window.
 */
export async function getGeminiOrgSemanticCooldownExpiry(orgId: string, nowMs: number = Date.now()): Promise<number | undefined> {
  const config = geminiCapacityConfig();
  try {
    const { getDb } = await import('./db');
    const db = await getDb();
    const res = await db.query(
      `SELECT occurred_at,
              MAX((request_metadata->>'cooldownUntilMs')::bigint)
                FILTER (WHERE request_metadata->>'cooldownUntilMs' ~ '^[0-9]+$') OVER () AS cooldown_until_ms
         FROM provider_call_events
        WHERE provider='gemini' AND status='RATE_LIMITED'
          AND request_metadata->>'geminiOrg'=$1
          AND occurred_at >= now() - interval '2 days'
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgId]
    );
    const row = res.rows[0];
    if (!row?.occurred_at) return undefined;
    return providerCooldownExpiryMs(row.occurred_at, row.cooldown_until_ms, config.semanticRateLimitCooldownMs, nowMs);
  } catch {
    return undefined;
  }
}

/** True while the given Gemini account is inside its own rate-limit cooldown. */
export async function isGeminiOrgCooldownActive(orgId: string, nowMs: number = Date.now()): Promise<boolean> {
  const expiry = await getGeminiOrgSemanticCooldownExpiry(orgId, nowMs);
  return expiry !== undefined && expiry > nowMs;
}

/**
 * Returns the authoritative Gemini semantic cooldown duration in milliseconds.
 * Used by retry scheduling to ensure run_after respects the provider cooldown.
 */
export function geminiSemanticCooldownMs(): number {
  return geminiCapacityConfig().semanticRateLimitCooldownMs;
}

/**
 * Returns true when the Groq semantic pool is inside its shared rate-limit
 * cooldown (any route's RATE_LIMITED event still within the window).
 * Delegates to the persisted-ledger resolver so queue admission and retry
 * timing read one authoritative state. Dynamic import preserves the
 * module's existing lazy database boundary.
 */
export async function isGroqSemanticCooldownActive(nowMs: number = Date.now()): Promise<boolean> {
  const { resolveGroqSemanticCooldownExpiryMs } = await import('./dbCore');
  const expiry = await resolveGroqSemanticCooldownExpiryMs(nowMs);
  return expiry !== undefined && expiry > nowMs;
}

/**
 * Per-organization Groq cooldown: true only while THIS org's window is
 * active. Independent orgs never block each other; routes sharing one org
 * label share one window.
 */
export async function isGroqOrgCooldownActive(orgId: string, nowMs: number = Date.now()): Promise<boolean> {
  const { resolveGroqOrgCooldownExpiryMs } = await import('./dbCore');
  const expiry = await resolveGroqOrgCooldownExpiryMs(orgId, nowMs);
  return expiry !== undefined && expiry > nowMs;
}

/**
 * Returns true when the independent free-tier Gemini pool is inside its
 * shared rate-limit cooldown. Reads ONLY the provider='gemini-free' ledger —
 * never the paid 'gemini' window — so the two setups gate independently.
 * Delegates to the persisted-ledger resolver so queue admission and retry
 * timing read one authoritative state. Dynamic import preserves the
 * module's existing lazy database boundary.
 */
export async function isGeminiFreeSemanticCooldownActive(nowMs: number = Date.now()): Promise<boolean> {
  const { resolveGeminiFreeSemanticCooldownExpiryMs } = await import('./dbCore');
  const expiry = await resolveGeminiFreeSemanticCooldownExpiryMs(nowMs);
  return expiry !== undefined && expiry > nowMs;
}

function abortError():Error{const error=new Error('aborted');error.name='AbortError';return error;}

function waitForCapacity(ms:number,signal?:AbortSignal):Promise<void>{
  if(ms<=0)return signal?.aborted?Promise.reject(abortError()):Promise.resolve();
  return new Promise((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>;
    const onAbort=()=>{clearTimeout(timer);reject(abortError())};
    if(signal?.aborted)return onAbort();
    timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve()},ms);
    signal?.addEventListener('abort',onAbort,{once:true});
  });
}

async function queryWithDeadline(client:any,text:string,values:any[],signal?:AbortSignal,deadlineAtMs?:number):Promise<any>{
  if(signal?.aborted)throw abortError();
  const remainingMs=deadlineAtMs==null?undefined:deadlineAtMs-Date.now();
  if(remainingMs!=null&&remainingMs<=0)throw abortError();
  const query:any={text,values};
  if(remainingMs!=null)query.query_timeout=Math.max(1,remainingMs);
  const result=await client.query(query);
  if(signal?.aborted)throw abortError();
  return result;
}

type GeminiPersistenceContext={signal?:AbortSignal;deadlineAtMs?:number};
type GeminiCapacityLease={
  persistOutcome:(event:ProviderCallEvent,persistenceContext?:GeminiPersistenceContext)=>Promise<void>;
  release:()=>Promise<void>;
};

export function geminiCapacityDeferralError(operation:string, reasonCode?:string, retryAfterMs?:number):ProviderCallError {
  const isVocabulary=operation===GEMINI_VOCABULARY_OPERATION;
  const isSemantic=operation===GEMINI_SEMANTIC_OPERATION;
  const message=isVocabulary
    ? 'Gemini vocabulary extraction deferred to protect semantic classification capacity.'
    : isSemantic
      ? 'Gemini semantic classification deferred during provider rate pressure.'
      : 'Gemini operation deferred during provider rate pressure.';
  return new ProviderCallError(message,'TRANSIENT',true,{
    providerReasons:[reasonCode||'GEMINI_CAPACITY_DEFERRED'],
    ...(retryAfterMs!=null&&Number.isFinite(retryAfterMs)&&retryAfterMs>0?{retryAfterMs:Math.floor(retryAfterMs)}:{}),
  });
}

async function connectWithAbort(db:any,signal?:AbortSignal):Promise<any>{
  if(!signal)return db.connect();
  if(signal.aborted)throw abortError();
  return new Promise((resolve,reject)=>{
    let settled=false;
    const onAbort=()=>{if(settled)return;settled=true;signal.removeEventListener('abort',onAbort);reject(abortError())};
    signal.addEventListener('abort',onAbort,{once:true});
    db.connect().then((client:any)=>{
      if(settled){client.release();return;}
      settled=true;signal.removeEventListener('abort',onAbort);resolve(client);
    },(error:unknown)=>{
      if(settled)return;
      settled=true;signal.removeEventListener('abort',onAbort);reject(error);
    });
  });
}

async function acquireGeminiCapacity(context:ProviderCallContext,signal?:AbortSignal,deadlineAtMs?:number):Promise<GeminiCapacityLease|undefined>{
  if(context.provider!=='gemini') return undefined;
  const routeId = resolveGeminiRouteId(context.requestMetadata?.geminiRoute);
  // Quota-fate identity: the serving account's org label when the caller
  // tags it, else the route id (same-account routes always share the label,
  // so the fallback only matters for untagged legacy callers).
  const orgId = String((context.requestMetadata as any)?.geminiOrg || routeId);
  let client:any;
  try{
    const { getDb }=await import('./db');
    const db=await getDb();
    while(true){
      if(signal?.aborted)throw abortError();
      client=await connectWithAbort(db,signal);
      // Per-account advisory lock: same account calls serialize; independent
      // Google projects proceed in parallel. hashtext gives a stable int4
      // object key without storing or exposing credentials.
      const lock=await queryWithDeadline(client,'SELECT pg_try_advisory_lock($1,hashtext($2)) AS acquired',[GEMINI_CAPACITY_LOCK_NAMESPACE,orgId],signal,deadlineAtMs);
      if(lock.rows[0]?.acquired)break;
      client.release();client=undefined;
      await waitForCapacity(GEMINI_LOCK_POLL_MS,signal);
    }
    if(signal?.aborted)throw abortError();
    const capacityConfig = geminiCapacityConfig();
    const [lastAny,lastRate,lastSemantic,lastVocabulary,orgWindowCalls]=await Promise.all([
      // Pacing is per account. Strict org match: an untagged legacy row is
      // not evidence about any specific project (fail-open for one window).
      // Capacity deferrals never reached Google and must not reset pacing.
      queryWithDeadline(client,`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND request_metadata->>'geminiOrg'=$1 AND COALESCE(request_metadata->>'geminiCapacityDeferral','') <> 'true' ORDER BY occurred_at DESC LIMIT 1`,[orgId],signal,deadlineAtMs),
      // Rate limits are per-account: only this account's own RATE_LIMITED
      // rows feed its cooldown window (strict org tag match — untagged rows
      // cool no account), so one exhausted account never paces the healthy
      // ones.
      queryWithDeadline(client,`SELECT occurred_at, request_metadata->>'quotaScope' AS quota_scope, MAX((request_metadata->>'cooldownUntilMs')::bigint) FILTER (WHERE request_metadata->>'cooldownUntilMs' ~ '^[0-9]+$') OVER () AS cooldown_until_ms FROM provider_call_events WHERE provider='gemini' AND status='RATE_LIMITED' AND request_metadata->>'geminiOrg'=$1 AND occurred_at >= now() - interval '2 days' ORDER BY occurred_at DESC LIMIT 1`,[orgId],signal,deadlineAtMs),
      queryWithDeadline(client,`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND operation=$1 AND request_metadata->>'geminiOrg'=$2 AND COALESCE(request_metadata->>'geminiCapacityDeferral','') <> 'true' ORDER BY occurred_at DESC LIMIT 1`,[GEMINI_SEMANTIC_OPERATION,orgId],signal,deadlineAtMs),
      queryWithDeadline(client,`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND operation=$1 AND request_metadata->>'geminiOrg'=$2 AND COALESCE(request_metadata->>'geminiCapacityDeferral','') <> 'true' ORDER BY occurred_at DESC LIMIT 1`,[GEMINI_VOCABULARY_OPERATION,orgId],signal,deadlineAtMs),
      // Rolling per-account token bucket. Counts every attempt that reached
      // the provider (including failures) because quota is consumed by
      // attempts, not successes. Deferral echoes are excluded so a full
      // bucket cannot refill itself with retries.
      queryWithDeadline(client,`SELECT COUNT(*)::int AS calls, MIN(occurred_at) AS oldest FROM provider_call_events WHERE provider='gemini' AND occurred_at > now() - ($1::int * interval '1 millisecond') AND request_metadata->>'geminiOrg'=$2 AND COALESCE(request_metadata->>'geminiCapacityDeferral','') <> 'true'`,[capacityConfig.orgRateLimitWindowMs ?? 60000,orgId],signal,deadlineAtMs)
    ]);
    const at=(row:any)=>row?.occurred_at?new Date(row.occurred_at).getTime():undefined;
    const declaredCooldownUntil=Number(lastRate.rows[0]?.cooldown_until_ms);
    const quotaScope=lastRate.rows[0]?.quota_scope;
    const decision=decideGeminiCapacity(context.operation,{nowMs:Date.now(),lastGeminiAtMs:at(lastAny.rows[0]),lastRateLimitAtMs:at(lastRate.rows[0]),rateLimitCooldownUntilMs:Number.isFinite(declaredCooldownUntil)?declaredCooldownUntil:undefined,rateLimitQuotaScope:quotaScope==='DAILY'||quotaScope==='MINUTE'?quotaScope:undefined,lastSemanticAtMs:at(lastSemantic.rows[0]),lastVocabularyAtMs:at(lastVocabulary.rows[0]),orgCallsInWindow:Number(orgWindowCalls.rows[0]?.calls||0)},capacityConfig);
    if(decision.action==='DEFER'){
      // Align a bucket wait with the oldest counted attempt leaving the
      // rolling window, instead of a generic exponential retry.
      const oldestMs=orgWindowCalls.rows[0]?.oldest?new Date(orgWindowCalls.rows[0].oldest).getTime():undefined;
      const bucketRetryAfterMs=decision.reasonCode==='GEMINI_ORG_TOKEN_BUCKET_EMPTY'&&oldestMs!=null&&Number.isFinite(oldestMs)
        ? Math.max(1,oldestMs+(capacityConfig.orgRateLimitWindowMs??60000)-Date.now())
        : undefined;
      try{
        await client.query({text:'SELECT pg_advisory_unlock($1,hashtext($2))',values:[GEMINI_CAPACITY_LOCK_NAMESPACE,orgId],query_timeout:1000});
        client.release();
      }catch{
        // If the unlock cannot be confirmed, destroy the session so its
        // advisory lock cannot outlive the deferral.
        client.release(true);
      }
      client=undefined;
      // Carry the deferring account so retry scheduling can align run_after
      // with this account's cooldown instead of a global window. The route
      // id is kept alongside for ledger correlation.
      throw Object.assign(geminiCapacityDeferralError(context.operation,decision.reasonCode,bucketRetryAfterMs),{geminiRoute:routeId,geminiOrg:orgId});
    }
    if(decision.waitMs>0) await waitForCapacity(decision.waitMs,signal);
    if(signal?.aborted)throw abortError();
    return {
      persistOutcome:async(event:ProviderCallEvent,persistenceContext?:GeminiPersistenceContext)=>{
        if(!client)return;
        await queryWithDeadline(client,`INSERT INTO provider_call_events(id,provider,operation,request_id,run_id,job_id,request_metadata,attempt,status,latency_ms,reserved_cost,actual_cost,error_class,policy_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(id) DO NOTHING`,[event.id,event.provider,event.operation,event.requestId||null,event.runId||null,event.jobId||null,JSON.stringify(event.requestMetadata||{}),event.attempt,event.status,event.latencyMs,event.reservedCost,event.actualCost,event.errorClass||null,event.policyVersion,event.occurredAt],persistenceContext?.signal??signal,persistenceContext?.deadlineAtMs??deadlineAtMs);
      },
      release:async()=>{if(!client)return;const leasedClient=client;client=undefined;try{await leasedClient.query({text:'SELECT pg_advisory_unlock($1,hashtext($2))',values:[GEMINI_CAPACITY_LOCK_NAMESPACE,orgId],query_timeout:1000});leasedClient.release();}catch{leasedClient.release(true);}}
    };
  }catch(error){
    if(client){const leasedClient=client;client=undefined;try{await leasedClient.query({text:'SELECT pg_advisory_unlock($1,hashtext($2))',values:[GEMINI_CAPACITY_LOCK_NAMESPACE,orgId],query_timeout:1000});leasedClient.release();}catch{leasedClient.release(true);}}
    if(error instanceof ProviderCallError) throw error;
    if((error as any)?.name==='AbortError')throw error;
    if(context.operation===GEMINI_VOCABULARY_OPERATION) throw new ProviderCallError('Gemini vocabulary extraction deferred because capacity state is unavailable.','TRANSIENT',true,{cause:error,providerReasons:['VOCABULARY_CAPACITY_STATE_UNAVAILABLE']});
    return undefined;
  }
}

function safeProviderReasons(values?:string[]):string[]{
  return Array.isArray(values)?values.map(String).filter(value=>/^[A-Z0-9_.:-]{1,80}$/.test(value)).slice(0,6):[];
}

/** Bounded, credential-free failure metadata persisted for cooldown/health readers. */
export function providerFailureMetadata(typed:ProviderCallError):Record<string,string>{
  const extra:Record<string,string>={};
  if(typed.cooldownUntilMs!=null&&Number.isFinite(typed.cooldownUntilMs))extra.cooldownUntilMs=String(Math.floor(typed.cooldownUntilMs));
  if(typed.retryAfterMs!=null&&Number.isFinite(typed.retryAfterMs))extra.retryAfterMs=String(Math.floor(typed.retryAfterMs));
  if(typed.quotaScope)extra.quotaScope=typed.quotaScope;
  if(typed.quotaId)extra.quotaId=typed.quotaId.slice(0,160);
  if(typed.routeScoped)extra.routeScoped='true';
  const reasons=safeProviderReasons(typed.providerReasons);
  if(reasons.length)extra.providerReasons=reasons.join(',');
  return extra;
}

export async function executeProviderCall<T>(args:{context:ProviderCallContext; timeoutMs:number; enabled?:boolean; signal?:AbortSignal; call:(signal:AbortSignal)=>Promise<T>; emit:ProviderEventSink; trace?:(stage:string)=>void}):Promise<T>{
  // An already-aborted caller must never start a billable request. Without
  // this check the abort listener is installed after the fact, so downstream
  // route failover can issue further calls for an abandoned evaluation.
  if(args.signal?.aborted)throw new ProviderCallError('Provider call was cancelled before execution.','CANCELLED',true,{cause:args.signal.reason});
  const started=Date.now(), id=randomUUID(), controller=new AbortController();
  const base={id,provider:args.context.provider,operation:args.context.operation,requestId:args.context.requestId,runId:args.context.runId,jobId:args.context.jobId,requestMetadata:args.context.requestMetadata,attempt:args.context.attempt||1,reservedCost:args.context.reservedCost||0,policyVersion:args.context.policyVersion||'provider-resilience-v1'};
  let capacityLease:GeminiCapacityLease|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined; let timedOut=false;
  const abort=()=>controller.abort(args.signal?.reason); args.signal?.addEventListener('abort',abort,{once:true});
  const deadlineAtMs=args.enabled!==false&&args.timeoutMs>0?started+args.timeoutMs:undefined;
  if(deadlineAtMs!=null) timer=setTimeout(()=>{timedOut=true;controller.abort();},Math.max(0,deadlineAtMs-Date.now()));
  const releaseCapacity=async()=>{if(!capacityLease)return;const lease=capacityLease;capacityLease=undefined;await lease.release();};
  const persistCapacityOutcome=async(event:ProviderCallEvent,persistenceContext?:GeminiPersistenceContext)=>{if(capacityLease)await capacityLease.persistOutcome(event,persistenceContext);};
  try{
    capacityLease=await acquireGeminiCapacity(args.context,controller.signal,deadlineAtMs);
    if(controller.signal.aborted)throw abortError();
    args.trace?.('before provider-call at server/providerResilience.ts');
    const value=await args.call(controller.signal);
    args.trace?.('after provider-call at server/providerResilience.ts');
    const event:ProviderCallEvent={...base,status:'SUCCESS',latencyMs:Date.now()-started,actualCost:args.context.actualCost||0,occurredAt:new Date().toISOString()};
    try { await persistCapacityOutcome(event); } catch (pacingStateError) { console.warn('[Gemini Capacity Diagnostic] Failed to persist successful pacing outcome before unlock.',String((pacingStateError as any)?.message||pacingStateError)); }
    await releaseCapacity();
    await args.emit(event).catch(()=>undefined);
    return value;
  }catch(error){
    // A caller-supplied deadline aborts through the same controller. Preserve
    // its TIMEOUT class instead of collapsing it to a generic CANCELLED.
    const callerAbortClass=args.signal?.aborted?(args.signal.reason as {errorClass?:string}|undefined)?.errorClass:undefined;
    const typed=timedOut?new ProviderCallError(`Provider call exceeded ${args.timeoutMs}ms deadline.`,'TIMEOUT',true,{cause:error})
      :callerAbortClass==='TIMEOUT'?new ProviderCallError('Provider call exceeded the caller deadline.','TIMEOUT',true,{cause:error})
        :classifyProviderError(error,Date.now(),args.context.provider);
    args.trace?.(`provider-call-caught (${typed.errorClass})`);
    if(args.context.provider==='gemini')console.warn('[Gemini Provider Diagnostic]',JSON.stringify({operation:args.context.operation,errorClass:typed.errorClass,status:typed.status??null,retryable:typed.retryable,providerReasons:safeProviderReasons(typed.providerReasons)}));
    // A capacity deferral never reached Google. Tag the observability row so
    // pacing and the rolling token bucket never count their own echoes as new
    // quota consumption (which would keep a full account full forever).
    const capacityDeferral=args.context.provider==='gemini'&&!capacityLease&&safeProviderReasons(typed.providerReasons).some(reason=>reason==='GEMINI_ORG_TOKEN_BUCKET_EMPTY'||reason==='GEMINI_CAPACITY_DEFERRED'||reason.includes('_DEFERRED_'));
    const event:ProviderCallEvent={...base,requestMetadata:{...base.requestMetadata,...providerFailureMetadata(typed),...(capacityDeferral?{geminiCapacityDeferral:'true'}:{})},status:statusFor(typed),latencyMs:Date.now()-started,actualCost:0,errorClass:typed.errorClass,occurredAt:new Date().toISOString()};
    if(capacityLease&&(typed.errorClass==='TIMEOUT'||typed.errorClass==='CANCELLED')){
      const cleanupController=new AbortController();
      const cleanupDeadlineAtMs=Date.now()+GEMINI_OUTCOME_CLEANUP_TIMEOUT_MS;
      const cleanupTimer=setTimeout(()=>cleanupController.abort(),GEMINI_OUTCOME_CLEANUP_TIMEOUT_MS);
      try { await persistCapacityOutcome(event,{signal:cleanupController.signal,deadlineAtMs:cleanupDeadlineAtMs}); } catch {} finally { clearTimeout(cleanupTimer); }
    } else {
      await persistCapacityOutcome(event).catch(()=>undefined);
    }
    await releaseCapacity();
    await args.emit(event).catch(()=>undefined);
    throw typed;
  }finally{
    if(timer)clearTimeout(timer); args.signal?.removeEventListener('abort',abort);
    await releaseCapacity();
  }
}