import { createHash } from 'node:crypto';
import { classificationInputChecksum } from '../classificationInputChecksum';
import type { RawChannelInput } from './types';
import type { SemanticModelResult } from './providers/GeminiSemanticProvider';

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

export interface SemanticResultCacheIdentity {
  input: RawChannelInput;
  provider: string;
  promptVersion: string;
  featureVersion: string;
  modelVersion: string;
  adjudicatorModelVersion?: string;
  adjudicationEnabled?: boolean;
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
  ])).digest('hex');
  return { cacheKey, inputChecksum };
}

export function semanticResultCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SEMANTIC_RESULT_CACHE_ENABLED !== 'false';
}

/**
 * Structural guard for cached rows. The cache is fail-open, so an incomplete
 * or corrupt row must be treated as a miss. Validate every field the provider
 * consumes downstream, not just the label: a partial object must never reach
 * evidence construction.
 */
export function isUsableCachedResult(value: unknown): value is SemanticModelResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<SemanticModelResult>;
  return typeof result.label === 'string' &&
    typeof result.confidence === 'number' && Number.isFinite(result.confidence) &&
    typeof result.supportedLanguage === 'boolean' &&
    typeof result.explanation === 'string' &&
    Array.isArray(result.reasonCodes) && result.reasonCodes.every(code => typeof code === 'string') &&
    Array.isArray(result.concepts) && result.concepts.every(concept => typeof concept === 'string') &&
    Array.isArray(result.languages) &&
    Array.isArray(result.citations);
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
  env: NodeJS.ProcessEnv = process.env
): Promise<SemanticCacheHit | undefined> {
  if (!semanticResultCacheEnabled(env) || !cacheCircuitClosed()) return undefined;
  const { cacheKey, inputChecksum } = semanticResultCacheKey(identity);
  try {
    const { getDb } = await import('../db');
    const db = await getDb();
    const res = await db.query(
      `UPDATE semantic_classification_cache
       SET hits=hits+1,last_hit_at=now()
       WHERE cache_key=$1
       RETURNING result,model_version,fallback_used,repair_prompt_version`,
      [cacheKey]
    );
    noteCacheSuccess();
    const row = res.rows[0];
    if (!row || !isUsableCachedResult(row.result)) return undefined;
    return {
      cacheKey,
      inputChecksum,
      hit: true,
      result: row.result,
      modelVersion: String(row.model_version || identity.modelVersion),
      fallbackUsed: row.fallback_used === true,
      repairPromptVersion: row.repair_prompt_version ? String(row.repair_prompt_version) : undefined,
    };
  } catch {
    noteCacheFailure();
    return undefined;
  }
}

export async function writeSemanticResultCache(
  identity: SemanticResultCacheIdentity,
  value: CachedSemanticValue,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!semanticResultCacheEnabled(env) || !cacheCircuitClosed()) return;
  const { cacheKey, inputChecksum } = semanticResultCacheKey(identity);
  try {
    const { getDb } = await import('../db');
    const db = await getDb();
    await db.query(
      `INSERT INTO semantic_classification_cache(
        cache_key,input_checksum,prompt_version,feature_version,model_version,
        adjudicator_model_version,adjudication_enabled,provider,result,
        fallback_used,repair_prompt_version
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
      ]
    );
    noteCacheSuccess();
  } catch {
    noteCacheFailure();
  }
}
