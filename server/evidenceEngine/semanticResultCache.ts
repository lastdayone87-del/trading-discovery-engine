import { createHash } from 'node:crypto';
import { classificationInputChecksum } from '../classificationInputChecksum';
import type { RawChannelInput } from './types';
import type { SemanticModelResult } from './providers/GeminiSemanticProvider';
import { isSemanticResultShape } from './semanticResultShape';

/**
 * Phase 4 semantic result cache.
 *
 * The cache key is the evidence fingerprint (`input_checksum`) plus every
 * model-facing version input. Attribution (job/run) is deliberately excluded
 * by `classificationInputChecksum`, so the same channel recheck under a new
 * job is a hit, while any evidence or version change is a miss.
 *
 * The cache is fail-open: a database outage, corrupt row, or disabled flag
 * degrades to a normal provider call. It must never change classification
 * semantics, only avoid paying for an identical question twice.
 */
export const SEMANTIC_RESULT_CACHE_VERSION = 'semantic-result-cache-v1';
export const SEMANTIC_RESULT_CACHE_HIT_REASON = 'SEMANTIC_RESULT_CACHE_HIT';
export const DEFAULT_SEMANTIC_RESULT_CACHE_TIMEOUT_MS = 500;

export interface SemanticResultCacheIdentity {
  input: RawChannelInput;
  provider: string;
  promptVersion: string;
  featureVersion: string;
  modelVersion: string;
  adjudicatorModelVersion?: string;
  adjudicationEnabled?: boolean;
  /** Prompt that produced this result through the batch scheduler, if any. */
  batchPromptVersion?: string;
  /** Provider-specific repair prompt whose output can be part of the result. */
  repairPromptVersion?: string;
  /**
   * Provider request settings that change the model-facing call (prompt caps,
   * completion allowance, reasoning effort). Changing one must not serve
   * results generated under the old configuration.
   */
  requestSettings?: string;
}

export interface SemanticResultCacheOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CachedSemanticValue {
  result: SemanticModelResult;
  modelVersion: string;
  fallbackUsed?: boolean;
  repairPromptVersion?: string;
}

export interface SemanticCacheHit extends CachedSemanticValue {
  cacheKey: string;
  inputChecksum: string;
  hit: true;
}

export function semanticResultCacheKey(identity: SemanticResultCacheIdentity): { cacheKey: string; inputChecksum: string } {
  const inputChecksum = classificationInputChecksum(identity.input);
  const cacheKey = createHash('sha256').update(JSON.stringify([
    SEMANTIC_RESULT_CACHE_VERSION,
    inputChecksum,
    identity.provider,
    identity.promptVersion,
    identity.featureVersion,
    identity.modelVersion,
    identity.adjudicatorModelVersion || '',
    identity.adjudicationEnabled === true,
    identity.batchPromptVersion || '',
    identity.repairPromptVersion || '',
    identity.requestSettings || '',
  ])).digest('hex');
  return { cacheKey, inputChecksum };
}

export function semanticResultCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SEMANTIC_RESULT_CACHE_ENABLED !== 'false';
}

function semanticResultCacheTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SEMANTIC_RESULT_CACHE_TIMEOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_SEMANTIC_RESULT_CACHE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_SEMANTIC_RESULT_CACHE_TIMEOUT_MS;
}

/**
 * Bound a cache query by the caller's deadline and the cache timeout. The
 * underlying pool query may keep running after the race settles; that is
 * acceptable for a best-effort cache, while the classification path must
 * never wait on a stalled connection.
 */
function boundedCacheOperation<T>(operation: Promise<T>, options: SemanticResultCacheOptions, env: NodeJS.ProcessEnv): Promise<T> {
  const signal = options.signal;
  if (signal?.aborted) {
    // The query may already be in flight; consume its rejection so an
    // abandoned cache operation cannot surface as an unhandled rejection.
    operation.catch(() => undefined);
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Cache operation aborted.'));
  }
  const timeoutMs = options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : semanticResultCacheTimeoutMs(env);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      run();
    };
    const timer = setTimeout(() => settle(() => reject(new Error('Semantic result cache operation timed out.'))), timeoutMs);
    timer.unref?.();
    const onAbort = () => settle(() => reject(signal?.reason instanceof Error ? signal.reason : new Error('Cache operation aborted.')));
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => settle(() => resolve(value)),
      error => settle(() => reject(error)),
    );
  });
}

/**
 * Structural guard for cached rows. The cache is fail-open, so an incomplete
 * or corrupt row must be treated as a miss. Validate every field the provider
 * consumes downstream, not just the label: a partial object must never reach
 * evidence construction.
 */
export function isUsableCachedResult(value: unknown): value is SemanticModelResult {
  return isSemanticResultShape(value);
}

/**
 * A cache write is only useful when the result survived the provider boundary
 * with citations. Degenerate/uncited replies (empty model output, failed
 * citation repair) are transient and must stay retryable instead of being
 * replayed for the same evidence forever.
 */
export function isCacheableSemanticResult(value: unknown): value is SemanticModelResult {
  return isUsableCachedResult(value) && value.citations.length > 0;
}

// Fail-open circuit breaker: a missing/unreachable database must not make
// every classification wait on a doomed connection attempt.
const CACHE_CIRCUIT_BREAKER_MS = 60_000;
let consecutiveFailures = 0;
let circuitOpenUntilMs = 0;

function cacheCircuitClosed(nowMs = Date.now()): boolean {
  return nowMs >= circuitOpenUntilMs;
}

function noteCacheFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= 3) {
    circuitOpenUntilMs = Date.now() + CACHE_CIRCUIT_BREAKER_MS;
    consecutiveFailures = 0;
  }
}

function noteCacheSuccess(): void {
  consecutiveFailures = 0;
  circuitOpenUntilMs = 0;
}

/** Test seam: clears the process-local fail-open circuit. */
export function resetSemanticResultCacheCircuitForTests(): void {
  consecutiveFailures = 0;
  circuitOpenUntilMs = 0;
}

export async function readSemanticResultCache(
  identity: SemanticResultCacheIdentity,
  env: NodeJS.ProcessEnv = process.env,
  options: SemanticResultCacheOptions = {},
): Promise<SemanticCacheHit | undefined> {
  if (!semanticResultCacheEnabled(env) || !cacheCircuitClosed()) return undefined;
  const { cacheKey, inputChecksum } = semanticResultCacheKey(identity);
  try {
    // Resolve the connection inside the same deadline race: getDb() retries
    // startup connections and can block for minutes during an outage.
    const res = await boundedCacheOperation((async () => {
      const { getDb } = await import('../db');
      const db = await getDb();
      return db.query(
        `SELECT result,model_version,fallback_used,repair_prompt_version
           FROM semantic_classification_cache
          WHERE cache_key=$1`,
        [cacheKey]
      );
    })(), options, env);
    noteCacheSuccess();
    const row = res.rows[0];
    if (!row) return undefined;
    if (!isUsableCachedResult(row.result)) {
      await boundedCacheOperation((async () => {
        const { getDb } = await import('../db');
        const db = await getDb();
        return db.query('DELETE FROM semantic_classification_cache WHERE cache_key=$1', [cacheKey]);
      })(), {}, env).catch(() => undefined);
      return undefined;
    }
    await boundedCacheOperation((async () => {
      const { getDb } = await import('../db');
      const db = await getDb();
      return db.query('UPDATE semantic_classification_cache SET hits=hits+1,last_hit_at=now() WHERE cache_key=$1', [cacheKey]);
    })(), options, env).catch(() => undefined);
    return {
      cacheKey,
      inputChecksum,
      hit: true,
      result: row.result,
      modelVersion: String(row.model_version || identity.modelVersion),
      fallbackUsed: row.fallback_used === true,
      repairPromptVersion: row.repair_prompt_version ? String(row.repair_prompt_version) : undefined,
    };
  } catch (error) {
    if (!options.signal?.aborted) noteCacheFailure();
    return undefined;
  }
}

export async function writeSemanticResultCache(
  identity: SemanticResultCacheIdentity,
  value: CachedSemanticValue,
  env: NodeJS.ProcessEnv = process.env,
  options: SemanticResultCacheOptions = {},
): Promise<void> {
  if (!semanticResultCacheEnabled(env) || !cacheCircuitClosed()) return;
  // Never persist a partial/degenerate result: the reader would reject it
  // anyway, and an uncited abstention must remain eligible for a later retry.
  if (!isCacheableSemanticResult(value.result)) return;
  const { cacheKey, inputChecksum } = semanticResultCacheKey(identity);
  try {
    await boundedCacheOperation((async () => {
      const { getDb } = await import('../db');
      const db = await getDb();
      return db.query(
        `INSERT INTO semantic_classification_cache(
          cache_key,input_checksum,prompt_version,feature_version,model_version,
          adjudicator_model_version,adjudication_enabled,provider,result,
          fallback_used,repair_prompt_version,batch_prompt_version
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(cache_key) DO NOTHING`,
        [
          cacheKey,
          inputChecksum,
          identity.promptVersion,
          identity.featureVersion,
          value.modelVersion,
          identity.adjudicatorModelVersion || null,
          identity.adjudicationEnabled === true,
          identity.provider,
          JSON.stringify(value.result),
          value.fallbackUsed === true,
          value.repairPromptVersion || null,
          identity.batchPromptVersion || null,
        ]
      );
    })(), options, env);
    noteCacheSuccess();
  } catch (error) {
    if (!options.signal?.aborted) noteCacheFailure();
  }
}
