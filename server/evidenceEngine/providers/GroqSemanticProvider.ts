import { randomUUID } from 'node:crypto';
import { appendProviderCallEvent, resolveGroqSemanticCooldownExpiryMs } from '../../db';
import { MAX_CRAWL_RESPONSE_CHARS, readBoundedResponseText } from '../../crawlResponseBounds';
import {
  ProviderCallError,
  classifyProviderError,
  statusFor,
  type ProviderCallEvent,
} from '../../providerResilience';
import { calibrateSemanticConfidence, SEMANTIC_CALIBRATION_VERSION } from '../semanticCalibration';
import type { EvidenceCategory, EvidenceItem, EvidenceProvider, LayeredKnowledgeContext, RawChannelInput } from '../types';
import {
  buildSemanticPrompt,
  candidateDocumentRefs,
  hasCreatorLevelSemanticContext,
  parseSemanticResult,
  semanticObservabilityFields,
  SEMANTIC_FEATURE_VERSION,
  SEMANTIC_PROMPT_VERSION,
  type SemanticModelClient,
  type SemanticModelResult,
  type SemanticObservabilityContext,
} from './GeminiSemanticProvider';

export const DEFAULT_GROQ_CANDIDATE_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_GROQ_ADJUDICATOR_MODEL = 'openai/gpt-oss-120b';
export const GROQ_API_BASE_URL = 'https://api.groq.com/openai/v1/chat/completions';

export interface GroqRoute { id: string; key: string; orgId?: string; }

/**
 * Quota-fate label for a route slot. Slots may name a shared organization via
 * GROQ_ORG_ID (slot 1) / GROQ_ORG_ID_2..N; unnamed slots each form their own
 * independent organization (one key per org). Routes sharing an org label
 * share one quota pool: a 429 on one cools all of them and never fails over
 * into them. Routes with distinct orgs hold independent quotas.
 */
export function groqOrgIdForSlot(env: NodeJS.ProcessEnv, slotNumber: number): string {
  const name = slotNumber === 1 ? 'GROQ_ORG_ID' : `GROQ_ORG_ID_${slotNumber}`;
  const label = String(env[name] || '').trim();
  return label || `slot-${slotNumber}`;
}

/** Fate-sharing identity consumed by cooldown and failover decisions. */
export function groqRouteOrg(route: { orgId?: unknown }): string {
  const label = String(route.orgId || '').trim();
  // Fail-closed legacy default: routes without an org label (hand-built test
  // fixtures, never production-configured routes) are assumed to share one
  // quota pool, preserving the pre-multi-org no-spill behavior.
  return label || 'shared';
}

/**
 * Slot number for a Groq key env name, or null when the name is not a key
 * slot. Unbounded: any numeric suffix >= 2 is accepted (gaps allowed, no
 * maximum); malformed suffixes (`_0`, `_1`, `_X`, `_EXTRA`) never match.
 */
export function groqKeySlotNumber(name: string): number | null {
  if (name === 'GROQ_API_KEY') return 1;
  // No leading zeros: `GROQ_API_KEY_02` would otherwise load as slot 2 while
  // slot diagnostics check the canonical `GROQ_API_KEY_2` and miss it.
  const match = /^GROQ_API_KEY_(0|[1-9][0-9]*)$/.exec(name);
  if (!match) return null;
  const slot = Number(match[1]);
  return Number.isSafeInteger(slot) && slot >= 2 ? slot : null;
}

/** Configured key slot numbers (1-based) with a non-empty key. */
export function groqConfiguredSlotNumbers(env: NodeJS.ProcessEnv = process.env): number[] {
  return Object.keys(env)
    .map(name => groqKeySlotNumber(name))
    .filter((slot): slot is number => slot !== null)
    .filter(slot => String(env[slot === 1 ? 'GROQ_API_KEY' : `GROQ_API_KEY_${slot}`] || '').trim())
    .sort((a, b) => a - b);
}

/**
 * Env var names for configured key slots without an explicit org label (one
 * per configured slot). Used for advisory startup visibility: unlabeled
 * slots are independent orgs by default, so a non-empty result is logged,
 * never rejected.
 */
export function missingGroqOrgLabels(env: NodeJS.ProcessEnv = process.env): string[] {
  return groqConfiguredSlotNumbers(env)
    .filter(slot => !String(env[slot === 1 ? 'GROQ_ORG_ID' : `GROQ_ORG_ID_${slot}`] || '').trim())
    .map(slot => (slot === 1 ? 'GROQ_ORG_ID' : `GROQ_ORG_ID_${slot}`));
}

/**
 * Return only ordered, non-empty route slots; credentials never leave this process.
 *
 * Configuration (config-only, no code changes, no key-count limit):
 * - `GROQ_API_KEY`, `GROQ_API_KEY_2`, `GROQ_API_KEY_3`, ... — any slot number
 *   >= 2 matches; gaps are fine; empty/whitespace values are skipped;
 *   identical key values are deduplicated; unrecognized names
 *   (`GROQ_API_KEY_0`, `GROQ_API_KEY_X`) are ignored.
 * - `GROQ_ORG_ID`, `GROQ_ORG_ID_2`, ... — quota-fate label per slot. Keys
 *   sharing one Groq account MUST share one label: provider rate limits
 *   apply per organization, so unlabeled same-account keys do NOT multiply
 *   capacity and failover would spill into the same exhausted pool.
 *   Unlabeled slots default to independent orgs (`slot-N`).
 * Adding, removing, or rotating a key takes effect on the next call without
 * a restart (routes are discovered from the environment on every call) and
 * never logs key values (telemetry carries route ids and org labels only).
 */
export function configuredGroqRoutes(env: NodeJS.ProcessEnv = process.env): GroqRoute[] {
  const names = Object.keys(env).filter(name => groqKeySlotNumber(name) !== null);
  names.sort((a, b) => {
    const routeNumber = (name: string) => groqKeySlotNumber(name) as number;
    return routeNumber(a) - routeNumber(b);
  });
  const seen = new Set<string>();
  let counter = 0;
  const out: GroqRoute[] = [];
  for (const name of names) {
    const key = String(env[name] || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    counter++;
    const slotNumber = groqKeySlotNumber(name) as number;
    out.push({ id: `groq-${counter}`, key, orgId: groqOrgIdForSlot(env, slotNumber) });
  }
  return out;
}

/** Node clamps setTimeout delays above 2^31-1 to ~1ms; reject absurd values instead of firing immediately. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

function clampTimeoutMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

export function groqTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.GROQ_PROVIDER_TIMEOUT_MS || '135000');
  return parsed > 0 ? clampTimeoutMs(parsed, 135000) : 135000;
}

/** Global provider-deadline rollout contract (mirrors the Gemini semantic call site). */
export function groqDeadlinesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROVIDER_DEADLINES_ENABLED !== 'false';
}

/**
 * Shared in-process Groq rate-limit cooldown. A genuine provider 429 arms it;
 * while armed, every worker short-circuits before any fetch, so repeated
 * ticks cannot re-hit the same limit window. The persisted
 * provider_call_events ledger (provider='groq', RATE_LIMITED) carries the
 * cross-replica state consumed by the queue gate and retry timing; this
 * in-process flag is the fast path for repeated in-process workers.
 */
export const DEFAULT_GROQ_RATE_LIMIT_COOLDOWN_MS = 90_000;
/** Stable marker identifying Groq rate-limit failures for retry-timing alignment. */
export const GROQ_RATE_LIMITED_REASON = 'GROQ_RATE_LIMITED';

export function groqRateLimitCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.GROQ_RATE_LIMIT_COOLDOWN_MS || '90000');
  return clampTimeoutMs(parsed, DEFAULT_GROQ_RATE_LIMIT_COOLDOWN_MS);
}

/** Per-organization in-process cooldown expiries (ms epoch), keyed by org label. No state is shared across organizations. */
const groqOrgCooldownUntilMs = new Map<string, number>();
/** Pool-wide remaining time: the maximum over all per-org windows. */
export function groqCooldownRemainingMs(nowMs: number = Date.now()): number {
  let remaining = 0;
  for (const untilMs of groqOrgCooldownUntilMs.values()) {
    remaining = Math.max(remaining, untilMs - nowMs);
  }
  return Math.max(0, remaining);
}

/** In-process cooldown remaining for one quota organization (never shared). */
export function groqOrgCooldownRemainingMs(orgId: string, nowMs: number = Date.now()): number {
  return Math.max(0, (groqOrgCooldownUntilMs.get(orgId) || 0) - nowMs);
}

function armGroqOrgCooldown(orgId: string, nowMs: number = Date.now()): void {
  groqOrgCooldownUntilMs.set(orgId, nowMs + groqRateLimitCooldownMs());
}

/** Test-only reset for the in-process cooldown. */
export function resetGroqCooldownForTests(orgId?: string): void {
  if (orgId === undefined) {
    groqOrgCooldownUntilMs.clear();
    return;
  }
  groqOrgCooldownUntilMs.delete(orgId);
}

function groqCooldownDeferredError(remainingMs: number): ProviderCallError {
  return Object.assign(
    new ProviderCallError('Groq semantic classification deferred during provider rate pressure.', 'RATE_LIMIT', true, {
      providerReasons: [GROQ_RATE_LIMITED_REASON],
    }),
    { groqCooldownDeferred: true, retryAfterMs: Math.max(0, remainingMs) },
  );
}

export interface GroqRouteFailoverOptions {
  /**
   * Synchronous per-org cooling read used to prefer healthy organizations.
   * Defaults to assuming no org is cooling (failover still advances across
   * orgs on a 429; same-org 429s never spill regardless of this predicate).
   */
  isOrgCooling?: (orgId: string) => boolean;
  /**
   * Failover-wide deadline (ms epoch): no new route attempt starts once it
   * has passed, bounding total failover time for latency-sensitive callers.
   * Absent by default (existing callers behave exactly as before).
   */
  deadlineAtMs?: number;
  nowMs?: () => number;
}

export async function runGroqRouteFailover<T>(
  routes: GroqRoute[],
  call: (route: GroqRoute) => Promise<T>,
  opts?: GroqRouteFailoverOptions,
): Promise<T> {
  const isCooling = opts?.isOrgCooling ?? (() => false);
  let lastError: unknown;
  const tried = new Set<GroqRoute>();
  // Stable order, healthy orgs first: configured order is preserved within
  // each group, so single-org deployments behave exactly as before.
  const ordered = [...routes].sort(
    (a, b) => Number(isCooling(groqRouteOrg(a))) - Number(isCooling(groqRouteOrg(b))),
  );
  for (const route of ordered) {
    if (opts?.deadlineAtMs !== undefined && (opts?.nowMs ?? Date.now)() >= opts.deadlineAtMs) {
      throw lastError || new ProviderCallError('Groq route pool aggregate deadline exhausted.', 'TIMEOUT', true);
    }
    // A 429 marks its whole organization tried (see catch below), so this
    // head-pick always lands on the next eligible independent org — a
    // same-org sibling of an exhausted account is never retried.
    if (tried.has(route)) continue;
    tried.add(route);
    // A paced wait can outlast the aggregate budget: recheck before calling
    // so an expired budget skips the fetch instead of wasting quota on a
    // result the caller has already abandoned.
    if (opts?.deadlineAtMs !== undefined && (opts?.nowMs ?? Date.now)() >= opts.deadlineAtMs) {
      throw lastError || new ProviderCallError('Groq route pool aggregate deadline exhausted.', 'TIMEOUT', true);
    }
    try {
      return await call(route);
    } catch (error) {
      lastError = error;
      if (error instanceof ProviderCallError && error.errorClass === 'RATE_LIMIT') {
        const failedOrg = failedGroqOrg(error, route);
        // Same-org routes share one quota pool: mark them all tried so the
        // loop head selects the next independent org (burst-multiplication
        // protection). Different-org routes hold independent quotas.
        for (const candidate of ordered) {
          if (groqRouteOrg(candidate) === failedOrg) tried.add(candidate);
        }
        if (!ordered.some(candidate => !tried.has(candidate))) throw error;
        continue;
      }
      if (!(error instanceof ProviderCallError) || !error.retryable) throw error;
    }
  }
  throw lastError || new ProviderCallError('No configured Groq route is available.', 'TRANSIENT', true);
}

export const GROQ_VOCABULARY_OPERATION = 'vocabulary-extraction';
export const DEFAULT_GROQ_VOCABULARY_MODEL = DEFAULT_GROQ_CANDIDATE_MODEL;
export const DEFAULT_GROQ_VOCABULARY_MIN_INTERVAL_MS = 2500;
export const DEFAULT_GROQ_VOCABULARY_AGGREGATE_TIMEOUT_MS = 120_000;
export const DEFAULT_GROQ_EMIT_BUDGET_MS = 2500;

/**
 * Emits one telemetry event under a hard time budget. A hung or failing write
 * is dropped instead of stalling the caller: telemetry must never delay or
 * reclassify an extraction attempt. The timer is always cleared, so settled
 * emits leave no scheduled work behind.
 */
async function emitBounded(
  emit: (event: ProviderCallEvent) => Promise<void>,
  event: ProviderCallEvent,
  budgetMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      emit(event).catch(() => undefined),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, Math.max(0, budgetMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function groqVocabularyMinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.GROQ_VOCABULARY_MIN_INTERVAL_MS || '2500');
  return clampTimeoutMs(parsed, DEFAULT_GROQ_VOCABULARY_MIN_INTERVAL_MS);
}

export function groqVocabularyAggregateMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.GROQ_VOCABULARY_AGGREGATE_TIMEOUT_MS || '120000');
  return parsed > 0 ? clampTimeoutMs(parsed, DEFAULT_GROQ_VOCABULARY_AGGREGATE_TIMEOUT_MS) : DEFAULT_GROQ_VOCABULARY_AGGREGATE_TIMEOUT_MS;
}

interface GroqVocabularyOrgPaceState {
  tail: Promise<void>;
  lastStartMs: number;
}

const groqVocabularyOrgPace = new Map<string, GroqVocabularyOrgPaceState>();

/** Test-only reset for extraction pacing (one org, or all when omitted). */
export function resetGroqVocabularyPacingForTests(orgId?: string): void {
  if (orgId === undefined) {
    groqVocabularyOrgPace.clear();
    return;
  }
  groqVocabularyOrgPace.delete(orgId);
}

/**
 * Runs fn under the organization's pacing gate. Callers serialize through a
 * per-org promise chain, then wait out the minimum interval measured from the
 * last actual start — concurrent callers space out instead of bunching, and
 * an abandoned holder always releases via finally, so no slot can poison
 * later calls. Same-org keys share one bucket (one quota pool by provider
 * design); independent orgs pace independently. Cross-process coordination is
 * intentionally out of scope (single-container deployment): the persisted
 * cooldown ledger remains the cross-replica backstop, and any 429 arms the
 * shared per-org cooldown.
 */
export async function withGroqOrgPacingSlot<T>(
  orgId: string,
  minIntervalMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  fn: () => Promise<T>
): Promise<T> {
  let state = groqVocabularyOrgPace.get(orgId);
  if (!state) {
    state = { tail: Promise.resolve(), lastStartMs: 0 };
    groqVocabularyOrgPace.set(orgId, state);
  }
  const prev = state.tail;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  state.tail = prev.then(() => gate);
  try {
    await prev;
    const waitMs = state.lastStartMs + Math.max(0, minIntervalMs) - now();
    if (waitMs > 0) await sleep(waitMs);
    state.lastStartMs = now();
    return await fn();
  } finally {
    release();
  }
}

export interface GroqTextCompletionDeps {
  emit?: (event: ProviderCallEvent) => Promise<void>;
  persistedCooldownExpiryMs?: (orgId?: string) => Promise<number | undefined>;
  minIntervalMs?: number;
  timeoutMs?: number;
  aggregateMs?: number;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
  /**
   * Content admissibility decided by the caller (which owns sources and the
   * admission rules). A false verdict fails the route as non-retryable so
   * failover breaks to the cross-model fallback instead of burning more
   * same-model quota or recording a false success.
   */
  validateContent?: (content: string) => boolean;
  /**
   * Hard time budget for each telemetry emit inside the adapter. Telemetry is
   * best-effort: a hung provider_call_events write must not stall the internal
   * failover promise (delaying the next route or turning a completed fetch
   * into an aggregate TIMEOUT) or hold a pool connection past the caller's
   * bound. Defaults to DEFAULT_GROQ_EMIT_BUDGET_MS; tests inject a stub.
   */
  emitBudgetMs?: number;
}

/**
 * Raw text completion over the Groq route pool for vocabulary extraction.
 * Reuses route discovery (unbounded key slots — adding keys is config-only),
 * per-org cooldowns, org-aware failover, bounded bodies, pacing, and the
 * shared error taxonomy; the semantic-classification path is untouched.
 * Returns undefined when no keys are configured (fail-closed, no fetch).
 * Callers parse via parseNativeVocabularyResponse, which skips non-JSON
 * output, so provider prose can never become vocabulary.
 */
export async function runGroqTextCompletion(
  input: { prompt: string; model?: string; operation?: string },
  deps?: GroqTextCompletionDeps
): Promise<string | undefined> {
  const routes = configuredGroqRoutes();
  if (!routes.length) return undefined;
  // Cooling pre-filter (extraction-local): known-cooling orgs are excluded
  // before pacing or fetching, so no wait is spent on a short-circuit and
  // fallback stays fast. The shared failover loop is untouched (semantic
  // behavior identical); expiry is time-based so orgs rejoin on their own.
  const usable = routes.filter(route => groqOrgCooldownRemainingMs(groqRouteOrg(route)) <= 0);
  if (!usable.length) {
    const remainingMs = Math.max(0, ...routes.map(route => groqOrgCooldownRemainingMs(groqRouteOrg(route))));
    throw Object.assign(
      new ProviderCallError('Groq routes cooling; deferring.', 'RATE_LIMIT', true, {
        providerReasons: [GROQ_RATE_LIMITED_REASON],
      }),
      { groqCooldownDeferred: true, retryAfterMs: remainingMs }
    );
  }
  const operation = input.operation || GROQ_VOCABULARY_OPERATION;
  const model = input.model || process.env.GROQ_CANDIDATE_MODEL || DEFAULT_GROQ_VOCABULARY_MODEL;
  const timeoutMs = deps?.timeoutMs ?? groqTimeoutMs();
  const emit = deps?.emit ?? emitGroqEvent;
  const emitBudgetMs = deps?.emitBudgetMs ?? DEFAULT_GROQ_EMIT_BUDGET_MS;
  const persistedCooldownExpiryMs = deps?.persistedCooldownExpiryMs ?? defaultPersistedCooldownExpiryMs;
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const now = deps?.nowMs ?? Date.now;
  const sleep = deps?.sleepMs ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const minIntervalMs = deps?.minIntervalMs ?? groqVocabularyMinIntervalMs();
  // Aggregate deadline: the whole pool attempt (all routes) stays bounded so
  // Gemini fallback is reached in finite time. Per-attempt timers below take
  // the minimum of the route timeout and the remaining aggregate budget.
  const deadlineAtMs = now() + (deps?.aggregateMs ?? groqVocabularyAggregateMs());
  // Outer bound: pacing sleeps, cooldown-ledger reads, and telemetry emits
  // are individually small but unbounded in principle. The race guarantees
  // caller progress (Gemini fallback) by the aggregate deadline even if an
  // inner wait stalls. A late inner settlement still emits its telemetry but
  // its result is discarded — double-spend with fallback is possible but rare
  // and deduped downstream.
  const pending = runGroqRouteFailover(usable, async route => {
    const started = Date.now();
    const controller = new AbortController();
    // Extraction always enforces a finite deadline, independent of the
    // general provider-deadline rollout flag: a stalled request or body must
    // fail into fallback, never hang the caller.
    const attemptTimeoutMs = Math.max(1, Math.min(timeoutMs, deadlineAtMs - Date.now()));
    const attemptDeadlineMs = started + attemptTimeoutMs;
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    const orgId = groqRouteOrg(route);
    const base = {
      id: randomUUID(), provider: 'groq', operation,
      requestMetadata: { groqRoute: route.id, groqOrg: orgId, groqModel: model }, attempt: 1,
      reservedCost: 0, policyVersion: 'provider-resilience-v1',
    };
    try {
      const remainingMs = groqOrgCooldownRemainingMs(orgId);
      if (remainingMs > 0) throw groqCooldownDeferredError(remainingMs);
      // Bounded ledger read: a stalled database must not outlive the
      // aggregate budget. Timeout or failure fails open (the in-process
      // cooldown and 429-driven arming remain authoritative). The losing
      // timer is always cleared so settled lookups retain no resources.
      // The budget is also bounded by the attempt deadline: preflight waits
      // must not consume the timeout and then fetch with a pre-aborted
      // signal — the attempt is abandoned as soon as either bound lapses.
      let persistedExpiryMs: number | undefined;
      let lookupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const lookupBudgetMs = Math.max(0, Math.min(deadlineAtMs, attemptDeadlineMs) - now());
        if (lookupBudgetMs <= 0) {
          persistedExpiryMs = undefined;
        } else {
          persistedExpiryMs = await new Promise<number | undefined>(resolve => {
            let settled = false;
            lookupTimer = setTimeout(() => {
              if (!settled) {
                settled = true;
                resolve(undefined);
              }
            }, lookupBudgetMs);
            persistedCooldownExpiryMs(orgId).then(
              value => {
                if (!settled) {
                  settled = true;
                  resolve(value);
                }
              },
              () => {
                if (!settled) {
                  settled = true;
                  resolve(undefined);
                }
              }
            );
          });
        }
      } catch {
        persistedExpiryMs = undefined;
      } finally {
        if (lookupTimer !== undefined) clearTimeout(lookupTimer);
      }
      if (persistedExpiryMs !== undefined && persistedExpiryMs > Date.now()) {
        const known = groqOrgCooldownUntilMs.get(orgId) || 0;
        groqOrgCooldownUntilMs.set(orgId, Math.max(known, persistedExpiryMs));
        throw groqCooldownDeferredError(persistedExpiryMs - Date.now());
      }
      // Paced start, serialized per org: cooldown preflight is complete, and
      // the gate re-checks both the cooldown (another caller may have armed
      // it while this call waited) and the budget before fetching.
      return await withGroqOrgPacingSlot(orgId, minIntervalMs, now, sleep, async () => {
        const recooledMs = groqOrgCooldownRemainingMs(orgId);
        if (recooledMs > 0) throw groqCooldownDeferredError(recooledMs);
        if (Date.now() >= Math.min(deadlineAtMs, attemptDeadlineMs)) {
          throw new ProviderCallError('Groq extraction exceeded its aggregate deadline.', 'TIMEOUT', true);
        }
        const res = await fetchImpl(GROQ_API_BASE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${route.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: input.prompt }],
          ...groqRequestExtras(),
        }),
        signal: controller.signal,
      });
      const bounded = await readBoundedResponseText(res);
      if (bounded.truncated) {
        throw Object.assign(
          new Error(`Groq response exceeded the ${MAX_CRAWL_RESPONSE_CHARS}-char bound.`),
          { status: res.status },
        );
      }
      const text = bounded.text;
      if (!res.ok) {
        throw Object.assign(new Error(`Groq HTTP ${res.status}: ${text.slice(0, 500)}`),
          { status: res.status, code: res.status });
      }
      const content = (JSON.parse(text) as any)?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content) {
        throw new ProviderCallError('Groq returned no message content.', 'TRANSIENT', false, {
          status: res.status,
        });
      }
      // Content must parse as JSON (mirroring the caller's parser). All
      // content failures below are non-retryable within the pool: an empty,
      // braceless, or malformed-but-complete completion repeats identically
      // at temperature 0 with json_object mode, so retrying would burn one
      // paced attempt per remaining org. Failover breaks immediately toward
      // Gemini instead. Telemetry carries metadata only, never content.
      // Whether the JSON carries usable vocabulary is decided caller-side,
      // where a different model (Gemini) can still be tried.
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new ProviderCallError('Groq returned no JSON object.', 'TRANSIENT', false, {
          status: res.status,
        });
      }
      try {
        JSON.parse(jsonMatch[0]);
      } catch {
        // Truncation (bounded body above) stays retryable: another attempt
        // may return complete output. Malformed-but-complete JSON will not —
        // at temperature 0 with json_object mode it repeats identically —
        // so it breaks failover immediately toward Gemini instead of burning
        // one paced attempt per remaining org.
        throw new ProviderCallError('Groq returned malformed JSON.', 'TRANSIENT', false, {
          status: res.status,
        });
      }
      // SUCCESS means the provider returned a well-formed completion;
      // extraction yield (usable vocabulary) is measured downstream by the
      // caller and admission counts. Retrying another same-model org on
      // content issues would burn independent quota for an identical prompt,
      // so content problems fall through to the cross-model Gemini fallback.
      if (deps?.validateContent && !deps.validateContent(content)) {
        throw new ProviderCallError('Groq completion has no admissible vocabulary.', 'TRANSIENT', false, {
          status: res.status,
        });
      }
      await emitBounded(emit, {
        ...base, status: 'SUCCESS', latencyMs: Date.now() - started,
        actualCost: 0, occurredAt: new Date().toISOString(),
      }, emitBudgetMs);
      return content;
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const typed = aborted
        ? new ProviderCallError(`Groq call exceeded ${timeoutMs}ms deadline.`, 'TIMEOUT', true, { cause: error })
        : classifyProviderError(error);
      if (!aborted && typed.errorClass === 'RATE_LIMIT' && (error as { groqCooldownDeferred?: unknown })?.groqCooldownDeferred !== true) {
        armGroqOrgCooldown(orgId);
      }
      if (typed.errorClass === 'RATE_LIMIT') {
        const reasons = Array.isArray((typed as { providerReasons?: unknown }).providerReasons)
          ? ((typed as { providerReasons?: unknown }).providerReasons as string[]).map(String)
          : [];
        if (!reasons.includes(GROQ_RATE_LIMITED_REASON)) {
          (typed as { providerReasons?: string[] }).providerReasons = [...reasons, GROQ_RATE_LIMITED_REASON];
        }
        (typed as { groqOrg?: string }).groqOrg = orgId;
      }
      const deferred = (error as { groqCooldownDeferred?: unknown })?.groqCooldownDeferred === true;
      await emitBounded(emit, {
        ...base, status: statusFor(typed), latencyMs: Date.now() - started,
        actualCost: 0, errorClass: typed.errorClass, occurredAt: new Date().toISOString(),
        ...(deferred ? { requestMetadata: { ...base.requestMetadata, groqCooldownDeferral: 'true' } } : {}),
      }, emitBudgetMs);
      throw typed;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, {
    isOrgCooling: orgId => groqOrgCooldownRemainingMs(orgId) > 0,
    deadlineAtMs,
    nowMs: now,
  });
  let aggregateTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    pending.catch(() => undefined);
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        aggregateTimer = setTimeout(
          () => reject(new ProviderCallError('Groq extraction exceeded its aggregate deadline.', 'TIMEOUT', true)),
          Math.max(0, deadlineAtMs - now())
        );
      }),
    ]);
  } finally {
    if (aggregateTimer !== undefined) clearTimeout(aggregateTimer);
  }
}

/** Organization that produced a rate-limit failure: carried on the error when present, else the attempting route's org. */
function failedGroqOrg(error: unknown, route: GroqRoute): string {
  const carried = (error as { groqOrg?: unknown }).groqOrg;
  const label = String(carried || '').trim();
  return label || groqRouteOrg(route);
}

function groqRequestExtras(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const extras: Record<string, unknown> = {
    temperature: 0,
    response_format: { type: 'json_object' },
    max_completion_tokens: Math.max(1, Math.floor(Number(env.GROQ_MAX_COMPLETION_TOKENS || '800')) || 800),
  };
  // Reasoning effort is opt-in per model family: unsupported values 400 on
  // models without reasoning controls, so the default request carries none
  // (matches the benchmarked baseline behavior).
  if (env.GROQ_REASONING_EFFORT) extras.reasoning_effort = env.GROQ_REASONING_EFFORT;
  return extras;
}

function emitGroqEvent(event: ProviderCallEvent): Promise<void> {
  return appendProviderCallEvent(event).catch(() => undefined);
}

/** Test seam: the emit sink is injectable so telemetry ordering is unit-testable without a database. */
export interface GroqDefaultClientDeps {
  /**
   * Per-organization persisted-cooldown read, resolving to that org's expiry
   * (ms epoch) or undefined when no window is active. Defaults to the
   * persisted ledger so a 429 seen by any replica (or any earlier process)
   * defers this one too; tests inject a stub. Fail-open: a ledger outage
   * must never block classification. Existing no-arg stubs remain assignable.
   */
  persistedCooldownExpiryMs?: (orgId?: string) => Promise<number | undefined>;
}

async function defaultPersistedCooldownExpiryMs(orgId?: string): Promise<number | undefined> {
  try {
    const { resolveGroqSemanticCooldownExpiryMs, resolveGroqOrgCooldownExpiryMs } = await import('../../db');
    if (orgId === undefined) return await resolveGroqSemanticCooldownExpiryMs();
    return await resolveGroqOrgCooldownExpiryMs(orgId);
  } catch {
    return undefined;
  }
}

export function defaultClient(
  emit: (event: ProviderCallEvent) => Promise<void> = emitGroqEvent,
  deps?: GroqDefaultClientDeps,
): SemanticModelClient | undefined {
  const routes = configuredGroqRoutes();
  if (!routes.length) return undefined;
  const timeoutMs = groqTimeoutMs();
  const deadlinesEnabled = groqDeadlinesEnabled();
  const persistedCooldownExpiryMs = deps?.persistedCooldownExpiryMs ?? defaultPersistedCooldownExpiryMs;
  return { classify: async (prompt, model, observability, signal) => {
    const response = await runGroqRouteFailover(routes, async route => {
      const started = Date.now();
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(signal?.reason);
      if (signal?.aborted) controller.abort(signal.reason);
      else signal?.addEventListener('abort', abortFromCaller, { once: true });
      const timer = deadlinesEnabled ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      const orgId = groqRouteOrg(route);
      const base = {
        id: randomUUID(), provider: 'groq', operation: 'multilingual-semantic-classification',
        ...semanticObservabilityFields(observability),
        requestMetadata: { groqRoute: route.id, groqOrg: orgId }, attempt: 1,
        reservedCost: 0, policyVersion: 'provider-resilience-v1',
      };
      try {
        // Per-org cooldown short-circuit: never spend a fetch while this
        // organization's window is armed. Thrown inside the try so the catch
        // below still emits exactly one failure event (keeping the persisted
        // ledger fresh) and the sentinel skips re-arming. Failover advances
        // past a cooling org to the next healthy organization; other orgs
        // are unaffected, so concurrent workers converge instead of storming.
        const remainingMs = groqOrgCooldownRemainingMs(orgId);
        if (remainingMs > 0) throw groqCooldownDeferredError(remainingMs);
        // Cross-replica gate: the in-process flag above only knows this
        // process. A 429 recorded by another replica (or an earlier process)
        // lives in the persisted ledger — consult this org's window on every
        // classification so fresh replicas and queue-bypassing paths
        // (rechecks, shadow runners) also defer instead of re-hitting the
        // window. Fail-open on ledger errors; also arms the fast in-process
        // flag for followers of the same org.
        let persistedExpiryMs: number | undefined;
        try {
          persistedExpiryMs = await persistedCooldownExpiryMs(orgId);
        } catch {
          persistedExpiryMs = undefined;
        }
        if (persistedExpiryMs !== undefined && persistedExpiryMs > Date.now()) {
          const known = groqOrgCooldownUntilMs.get(orgId) || 0;
          groqOrgCooldownUntilMs.set(orgId, Math.max(known, persistedExpiryMs));
          throw groqCooldownDeferredError(persistedExpiryMs - Date.now());
        }
        const res = await fetch(GROQ_API_BASE_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${route.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'Return only valid JSON matching the requested schema.' },
              { role: 'user', content: prompt },
            ],
            ...groqRequestExtras(),
          }),
          signal: controller.signal,
        });
        // Bounded body: the completion envelope is capped server-side, but a
        // misbehaving origin/proxy must never grow the heap. A cut envelope
        // fails closed as a transient provider error (retryable), never as a
        // parsed success.
        const bounded = await readBoundedResponseText(res);
        if (bounded.truncated) {
          throw Object.assign(
            new Error(`Groq response exceeded the ${MAX_CRAWL_RESPONSE_CHARS}-char bound.`),
            { status: res.status },
          );
        }
        const text = bounded.text;
        if (!res.ok) {
          throw Object.assign(new Error(`Groq HTTP ${res.status}: ${text.slice(0, 500)}`),
            { status: res.status, code: res.status });
        }
        const content = (JSON.parse(text) as any)?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content) {
          throw Object.assign(new Error('Groq returned no message content.'), { status: res.status });
        }
        // Parse before persisting SUCCESS: a malformed completion must emit
        // exactly one terminal event (the failure below), never a false
        // success that the conflicting failure insert cannot overwrite.
        const parsedContent = JSON.parse(content);
        await emit({
          ...base, status: 'SUCCESS', latencyMs: Date.now() - started,
          actualCost: 0, occurredAt: new Date().toISOString(),
        });
        return parsedContent;
      } catch (error) {
        const aborted = controller.signal.aborted;
        const typed = aborted
          ? new ProviderCallError(`Groq call exceeded ${timeoutMs}ms deadline.`, 'TIMEOUT', true, { cause: error })
          : classifyProviderError(error);
        if (!aborted && typed.errorClass === 'RATE_LIMIT' && (error as { groqCooldownDeferred?: unknown })?.groqCooldownDeferred !== true) {
          // Genuine provider 429: arm only this organization's cooldown. The
          // deferred sentinel above is excluded so short-circuits never
          // extend the window indefinitely. Other orgs keep serving.
          armGroqOrgCooldown(orgId);
        }
        if (typed.errorClass === 'RATE_LIMIT') {
          const reasons = Array.isArray((typed as { providerReasons?: unknown }).providerReasons)
            ? ((typed as { providerReasons?: unknown }).providerReasons as string[]).map(String)
            : [];
          if (!reasons.includes(GROQ_RATE_LIMITED_REASON)) {
            (typed as { providerReasons?: string[] }).providerReasons = [...reasons, GROQ_RATE_LIMITED_REASON];
          }
          // Carry the failed organization for org-aware failover and
          // per-org retry scheduling downstream.
          (typed as { groqOrg?: string }).groqOrg = orgId;
        }
        // Deferred short-circuits stay observable but must never restart the
        // persisted window: the shared expiry derives from the latest
        // RATE_LIMITED row, so a deferral is tagged and the resolver below
        // excludes tagged rows. Genuine provider 429s carry no tag.
        const deferred = (error as { groqCooldownDeferred?: unknown })?.groqCooldownDeferred === true;
        await emit({
          ...base, status: statusFor(typed), latencyMs: Date.now() - started,
          actualCost: 0, errorClass: typed.errorClass, occurredAt: new Date().toISOString(),
          ...(deferred ? { requestMetadata: { ...base.requestMetadata, groqCooldownDeferral: 'true' } } : {}),
        });
        throw typed;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromCaller);
      }
    }, { isOrgCooling: orgId => groqOrgCooldownRemainingMs(orgId) > 0 });
    return response;
  }};
}

async function classifyCandidateWith404Fallback(client: SemanticModelClient, candidatePrompt: string, candidateModel: string, fallbackModel: string, observability?: SemanticObservabilityContext, signal?: AbortSignal) {
  try {
    return { value: await client.classify(candidatePrompt, candidateModel, observability, signal), model: candidateModel, fallbackUsed: false };
  } catch (error) {
    const isModel404 = error instanceof ProviderCallError && error.errorClass === 'PERMANENT_INPUT' && error.status === 404;
    if (!isModel404 || candidateModel === fallbackModel) throw error;
    console.warn('[Groq Semantic] Candidate model returned 404; retrying once with configured adjudicator model.', { candidateModel, fallbackModel });
    return { value: await client.classify(candidatePrompt, fallbackModel, observability, signal), model: fallbackModel, fallbackUsed: true };
  }
}

/**
 * Decisive-but-uncited shape: the model committed to a supported,
 * non-ambiguous label at terminal confidence yet supplied zero usable field
 * citations, so the result would abstain for lack of evidence attribution —
 * not for lack of a decision. This is the only shape eligible for citation
 * repair; every other abstention trigger is left untouched.
 */
export function isDecisiveButUncited(result: SemanticModelResult): boolean {
  return (
    result.supportedLanguage &&
    result.label !== 'AMBIGUOUS' &&
    calibrateSemanticConfidence(result.confidence) >= 50 &&
    result.citations.length === 0
  );
}

/**
 * Targeted citation-repair prompt (V3): preserves the original decision and
 * asks only for the missing field citations, enumerating the exact supplied
 * references with an honesty clause. The original candidate prompt is reused
 * verbatim so no prompt behavior can drift. Measured offline: 3/3 resolution
 * with 15/15 valid citations and 100% label/polarity preservation, against
 * 1/3 for the unlisted preface; the closed list without the honesty clause
 * resolved 0/3 and must not ship.
 */
export const SEMANTIC_CITATION_REPAIR_PROMPT_VERSION = 'citation-repair-2';
export function buildCitationRepairPrompt(
  candidatePrompt: string,
  result: SemanticModelResult,
  refs: Array<{ field: string; index?: number; sourceId?: string }>,
): string {
  const refList = refs.map(ref => JSON.stringify(ref)).join(', ');
  return [
    'Your previous classification is missing required field citations.',
    `Keep label=${result.label}, confidence=${result.confidence}, supportedLanguage=${result.supportedLanguage}.`,
    `You may only cite from this exact list: [${refList}]. Cite only list entries, with matching field, index, and sourceId. If no listed reference supports the decision, return "citations":[] — never invent a reference.`,
    'Return the complete classification JSON with citations populated from the supplied field references; an uncited classification cannot be used.',
    `Original request: ${candidatePrompt}`,
  ].join(' ');
}

/**
 * Retains only repaired citations that exactly reference a document supplied
 * in this input's candidate prompt (field + index + source identifier, with
 * absent values equal). An allowlisted-but-absent field, an out-of-range
 * index, or a mismatched source identifier is dropped: fabricated
 * attribution can never become scored evidence.
 */
export function retainSuppliedCitations(
  citations: SemanticModelResult['citations'],
  refs: Array<{ field: string; index?: number; sourceId?: string }>,
): SemanticModelResult['citations'] {
  return citations.filter(citation =>
    refs.some(ref => ref.field === citation.field && (ref.index ?? null) === (citation.index ?? null) && (ref.sourceId ?? null) === (citation.sourceId ?? null)),
  );
}

export class GroqSemanticProvider implements EvidenceProvider {
  name = 'groq_semantic' as const;
  constructor(private readonly injectedClient?: SemanticModelClient) {}
  private client() { return this.injectedClient || defaultClient(); }
  availability(input: RawChannelInput) {
    if (!this.client()) return { availability: 'UNAVAILABLE' as const, reason: 'GROQ_API_KEY is not configured.' };
    if (!hasCreatorLevelSemanticContext(input)) {
      return { availability: 'NOT_APPLICABLE' as const, reason: 'Retrieval-only candidate has no independent creator-level semantic context yet.' };
    }
    return { availability: 'AVAILABLE' as const };
  }

  async collectEvidence(input: RawChannelInput, _knowledge: LayeredKnowledgeContext, signal?: AbortSignal): Promise<EvidenceItem[]> {
    const client = this.client();
    if (!client) return [];
    const candidateModel = process.env.GROQ_CANDIDATE_MODEL || DEFAULT_GROQ_CANDIDATE_MODEL;
    const adjudicatorModel = process.env.GROQ_ADJUDICATOR_MODEL || DEFAULT_GROQ_ADJUDICATOR_MODEL;
    const observability = { jobId: input.job_id, runId: input.run_id };
    const candidatePrompt = buildSemanticPrompt(input, 'CANDIDATE');
    const candidate = await classifyCandidateWith404Fallback(client, candidatePrompt, candidateModel, adjudicatorModel, observability, signal);
    let result = parseSemanticResult(candidate.value);
    let model = candidate.model;
    const fallbackReasonCodes = candidate.fallbackUsed ? ['SEMANTIC_CANDIDATE_MODEL_404_FALLBACK'] : [];
    // Citation repair (Groq-only): a decisive-but-uncited result would abstain
    // for missing attribution, not for lack of a decision. Offer exactly one
    // targeted retry demanding citations. The original decision fields are
    // preserved in code (prompt text is unenforceable on model output) and
    // only citations referencing supplied documents are retained; a
    // still-uncited result abstains as before, so unsupported classifications
    // can never pass this gate.
    let repairUsed = false;
    let repairedCitations: SemanticModelResult['citations'] | null = null;
    if (isDecisiveButUncited(result)) {
      try {
        const repaired = parseSemanticResult(await client.classify(buildCitationRepairPrompt(candidatePrompt, result, candidateDocumentRefs(input)), model, observability, signal));
        const retained = retainSuppliedCitations(repaired.citations, candidateDocumentRefs(input));
        if (retained.length > 0) {
          result = { ...result, citations: retained };
          repairedCitations = retained;
          repairUsed = true;
        }
      } catch {
        // Repair is best-effort: keep the original result, which abstains.
      }
    }
    // The repair code marks only results that survive to evidence
    // construction with their repaired citations: a later adjudication that
    // replaces the result drops the code with it. Evaluated below, after
    // adjudication has had its chance to replace the result.
    const repairSurvived = () => repairUsed && repairedCitations !== null && result.citations === repairedCitations;
    // Second pass runs unless adjudication already occurred (candidate served
    // from the adjudicator model via 404 fallback). Gated on occurrence, not
    // on model-name inequality, so identical candidate/adjudicator defaults
    // still adjudicate low-confidence results.
    if (result.supportedLanguage && (result.label === 'AMBIGUOUS' || result.confidence < 70) && process.env.MULTILINGUAL_ADJUDICATION_ENABLED === 'true' && !candidate.fallbackUsed) {
      result = parseSemanticResult(await client.classify(buildSemanticPrompt(input, 'ADJUDICATION'), adjudicatorModel, observability, signal)); model = adjudicatorModel;
    }
    const calibrated = calibrateSemanticConfidence(result.confidence);
    const abstained = !result.supportedLanguage || result.label === 'AMBIGUOUS' || calibrated < 50 || result.citations.length === 0;
    const positive = result.label === 'ACTIVE_TRADING' || result.label === 'INVESTING_EDUCATION';
    const category: EvidenceCategory = abstained ? 'SEMANTIC_ABSTENTION' : positive ? 'METHODOLOGY_CONCEPT' : result.label === 'HYPE' ? 'HYPE_SPECULATION' : result.label === 'UNRELATED' ? 'IRRELEVANT_DOMAIN' : 'NON_TRADING_ADJACENT';
    const rawWeight = abstained ? 0 : positive ? 24 : 26;
    const finalWeight = abstained ? 0 : rawWeight * .65 * (calibrated / 100) * (positive ? 1 : -1);
    const semantic = { modelVersion: model, promptVersion: SEMANTIC_PROMPT_VERSION, featureVersion: SEMANTIC_FEATURE_VERSION, calibrationVersion: SEMANTIC_CALIBRATION_VERSION, ...(repairSurvived() ? { repairPromptVersion: SEMANTIC_CITATION_REPAIR_PROMPT_VERSION } : {}), taxonomyLabel: result.label, rawConfidence: result.confidence, calibratedConfidence: calibrated, detectedLanguages: result.languages, reasonCodes: [...fallbackReasonCodes, ...(repairSurvived() ? ['SEMANTIC_CITATION_REPAIR'] : []), ...result.reasonCodes, ...(abstained ? ['SEMANTIC_MODEL_ABSTAINED'] : []), ...(abstained && isDecisiveButUncited(result) ? ['SEMANTIC_ABSTAIN_NO_CITATIONS'] : [])] };
    const citations=result.citations.map(ref=>{const video=ref.field==='video_title'||ref.field==='video_description'?input.videos?.[ref.index||0]:undefined,family=video?.source_family_id||(ref.field==='channel_title'||ref.field==='channel_bio'?input.channel_source_family_id:undefined),entity=video?.source_entity_id||((video||ref.field==='channel_title'||ref.field==='channel_bio')?input.channel_entity_id:undefined);return {...ref,...(family?{sourceFamilyId:family}:{}),...(entity?{sourceEntityId:entity}:{})};});
    return [{
      id: `semantic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, source: this.name, polarity: positive || abstained ? 'POSITIVE' : 'NEGATIVE', category,
      fact: `Multilingual semantic evidence [${result.label}]: ${result.explanation}`, rawMatches: abstained ? [] : result.concepts,
      confidence: calibrated, reliability: abstained ? 'LOWER' : 'MEDIUM', reliabilityMultiplier: abstained ? .4 : .65, rawWeight, finalWeight,
      provenance: { provider: this.name, type: category, matchedTerm: result.concepts.join(', ') || result.label, sourceRef: `structured-semantic:${model}`, fields: citations, semantic }, timestamp: new Date().toISOString()
    }];
  }
}

/**
 * Semantic-provider routing predicate. Default is Gemini (status quo ante):
 * Groq serves a channel only when explicitly selected AND the kill switch is
 * off AND at least one Groq route is configured. Evaluated per channel
 * evaluation (not at construction) so the kill switch takes effect without
 * a restart.
 */
export function shouldUseGroqSemantic(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SEMANTIC_PROVIDER_FORCE_GEMINI === 'true') return false;
  if (env.SEMANTIC_PROVIDER !== 'groq') return false;
  return configuredGroqRoutes(env).length > 0;
}
