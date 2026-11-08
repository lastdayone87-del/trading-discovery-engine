import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'node:crypto';
import { appendProviderCallEvent, resolveGeminiFreeSemanticCooldownExpiryMs, GEMINI_FREE_COOLDOWN_DEFERRAL_METADATA_KEY } from '../../db';
import {
  ProviderCallError,
  classifyProviderError,
  providerFailureMetadata,
  statusFor,
  type ProviderCallEvent,
} from '../../providerResilience';
import { calibrateSemanticConfidence, SEMANTIC_CALIBRATION_VERSION } from '../semanticCalibration';
import { abortedByDeadline } from './abortReason';
import { readSemanticResultCache, SEMANTIC_RESULT_CACHE_HIT_REASON, writeSemanticResultCache } from '../semanticResultCache';
import { applySemanticPrefilter, recordSemanticPrefilterOutcome } from '../../semanticPrefilter';
import { classifySemanticPrompt, SEMANTIC_BATCH_PROMPT_VERSION, semanticBatchConfig } from '../semanticBatch';
import { isSemanticResultShape } from '../semanticResultShape';
import type { EvidenceCategory, EvidenceItem, EvidenceProvider, LayeredKnowledgeContext, RawChannelInput } from '../types';
import {
  buildSemanticPrompt,
  geminiBatchOutputConfig,
  hasCreatorLevelSemanticContext,
  parseSemanticResult,
  semanticObservabilityFields,
  SEMANTIC_FEATURE_VERSION,
  SEMANTIC_PROMPT_VERSION,
  type SemanticModelClient,
  type SemanticObservabilityContext,
} from './GeminiSemanticProvider';

/**
 * Independent free-tier Gemini semantic provider (Google AI Studio free tier,
 * default gemini-2.5-flash-lite). Shares the production prompt/parser/
 * calibration with the paid Gemini provider (single construction, no drift)
 * and duplicates everything identity-related so the two setups can never
 * interfere: own API keys, route ids, SDK instances, provider telemetry name,
 * cooldown ledger, retry tags, model/timeout env vars, and routing selector.
 * Never a fallback for — and never compared against — the paid provider.
 */

export const DEFAULT_GEMINI_FREE_CANDIDATE_MODEL = 'gemini-2.5-flash-lite';
export const DEFAULT_GEMINI_FREE_ADJUDICATOR_MODEL = 'gemini-2.5-flash-lite';

export interface GeminiFreeRoute { id: string; key: string; }

/** Return only ordered, non-empty route slots; credentials never leave this process. */
export function configuredGeminiFreeRoutes(env: NodeJS.ProcessEnv = process.env): GeminiFreeRoute[] {
  const names = Object.keys(env).filter(name => name === 'GEMINI_FREE_API_KEY' || /^GEMINI_FREE_API_KEY_[2-9][0-9]*$/.test(name));
  names.sort((a, b) => {
    const routeNumber = (name: string) => name === 'GEMINI_FREE_API_KEY' ? 1 : Number(name.slice('GEMINI_FREE_API_KEY_'.length));
    return routeNumber(a) - routeNumber(b);
  });
  const seen = new Set<string>();
  const out: GeminiFreeRoute[] = [];
  for (const name of names) {
    const key = String(env[name] || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const numeric = name === 'GEMINI_FREE_API_KEY' ? 1 : Number(name.slice('GEMINI_FREE_API_KEY_'.length));
    out.push({ id: `gemini-free-${numeric}`, key });
  }
  return out;
}

export function geminiFreeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.GEMINI_FREE_PROVIDER_TIMEOUT_MS || '135000');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 135000;
}

/** Global provider-deadline rollout contract (mirrors the paid Gemini call site). */
export function geminiFreeDeadlinesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROVIDER_DEADLINES_ENABLED !== 'false';
}

/**
 * Shared in-process free-tier rate-limit cooldown. A genuine provider 429 arms
 * it; while armed, every worker short-circuits before any SDK call. The
 * persisted provider_call_events ledger (provider='gemini-free',
 * RATE_LIMITED) carries the cross-replica state; this in-process flag is the
 * fast path. Fully separate from the paid Gemini ('gemini') ledger window.
 */
export const DEFAULT_GEMINI_FREE_RATE_LIMIT_COOLDOWN_MS = 90_000;
/** Stable marker identifying free-Gemini rate-limit failures for retry-timing alignment. */
export const GEMINI_FREE_RATE_LIMITED_REASON = 'GEMINI_FREE_RATE_LIMITED';

export function geminiFreeRateLimitCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.GEMINI_FREE_RATE_LIMIT_COOLDOWN_MS || '90000');
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_GEMINI_FREE_RATE_LIMIT_COOLDOWN_MS;
}

let geminiFreeCooldownUntilMs = 0;
export function geminiFreeCooldownRemainingMs(nowMs: number = Date.now()): number {
  return Math.max(0, geminiFreeCooldownUntilMs - nowMs);
}

/** Test-only reset for the in-process cooldown. */
export function resetGeminiFreeCooldownForTests(): void {
  geminiFreeCooldownUntilMs = 0;
}

function geminiFreeCooldownDeferredError(remainingMs: number): ProviderCallError {
  return Object.assign(
    new ProviderCallError('Free Gemini semantic classification deferred during provider rate pressure.', 'RATE_LIMIT', true, {
      providerReasons: [GEMINI_FREE_RATE_LIMITED_REASON],
    }),
    { geminiFreeCooldownDeferred: true, retryAfterMs: Math.max(0, remainingMs) },
  );
}

/**
 * Local cooldown expiry for one classified rate-limit failure. The provider's
 * declared reset (a daily quota's next reset, or a minute window) is
 * authoritative when it extends beyond the configured short cooldown, so the
 * fast in-process gate can never reopen before the persisted ledger resolver.
 */
export function geminiFreeFailureCooldownUntilMs(typed: ProviderCallError, nowMs: number = Date.now()): number {
  const declared = typed.cooldownUntilMs != null && Number.isFinite(typed.cooldownUntilMs)
    ? typed.cooldownUntilMs
    : 0;
  return Math.max(nowMs + geminiFreeRateLimitCooldownMs(), declared);
}

/**
 * Merge a fresh failure into the in-process gate without ever shrinking an
 * already-armed window. A daily reset can be hours away, so a later per-minute
 * 429 (or a concurrent call's short RetryInfo) must not reopen the account
 * before that reset.
 */
export function nextGeminiFreeCooldownUntilMs(currentUntilMs: number, typed: ProviderCallError, nowMs: number = Date.now()): number {
  return Math.max(currentUntilMs, geminiFreeFailureCooldownUntilMs(typed, nowMs));
}

/**
 * Failure metadata persisted on the event row. Local deferral echoes stay
 * tagged so the resolver/metrics exclude them; genuine upstream failures carry
 * the typed cooldown/quota fields the resolver reads on every replica.
 */
export function geminiFreeFailureMetadata(typed: ProviderCallError, deferred: boolean): Record<string, string> {
  return deferred
    ? { [GEMINI_FREE_COOLDOWN_DEFERRAL_METADATA_KEY]: 'true' }
    : providerFailureMetadata(typed);
}

export interface GeminiFreeRouteFailoverOptions {
  /** Caller cancellation: no route may start after this signal aborts. */
  signal?: AbortSignal;
}

function geminiFreeFailoverCancelled(signal?: AbortSignal): ProviderCallError {
  return new ProviderCallError('Free Gemini route failover cancelled by caller.', 'CANCELLED', true, { cause: signal?.reason });
}

export async function runGeminiFreeRouteFailover<T>(routes: GeminiFreeRoute[], call: (route: GeminiFreeRoute) => Promise<T>, opts?: GeminiFreeRouteFailoverOptions): Promise<T> {
  let lastError: unknown;
  for (const route of routes) {
    if (opts?.signal?.aborted) {
      if (abortedByDeadline(opts.signal)) {
        throw new ProviderCallError('Free Gemini route failover deadline exhausted.', 'TIMEOUT', true, { cause: opts.signal.reason });
      }
      throw geminiFreeFailoverCancelled(opts.signal);
    }
    try {
      return await call(route);
    } catch (error) {
      lastError = error;
      // The caller already abandoned this evaluation; do not advance to
      // another key (or emit further timeout telemetry) for it.
      if (opts?.signal?.aborted) throw error;
      // Free-tier rate limits are project-level, not key-level: failing over
      // to another key after a 429 would multiply the burst. Failover remains
      // for other retryable failures such as transient transport errors.
      if (error instanceof ProviderCallError && error.errorClass === 'RATE_LIMIT') throw error;
      if (!(error instanceof ProviderCallError) || !error.retryable) throw error;
    }
  }
  throw lastError || new ProviderCallError('No configured free Gemini route is available.', 'TRANSIENT', true);
}

function emitGeminiFreeEvent(event: ProviderCallEvent): Promise<void> {
  return appendProviderCallEvent(event).catch(() => undefined);
}

/** Test seam: the emit sink is injectable so telemetry ordering is unit-testable without a database. */
export interface GeminiFreeDefaultClientDeps {
  /**
   * Shared-cooldown read, resolving to the persisted expiry (ms epoch) or
   * undefined when no window is active. Fail-open: a ledger outage must never
   * block classification.
   */
  persistedCooldownExpiryMs?: () => Promise<number | undefined>;
}

async function defaultPersistedCooldownExpiryMs(): Promise<number | undefined> {
  try {
    return await resolveGeminiFreeSemanticCooldownExpiryMs();
  } catch {
    return undefined;
  }
}

/**
 * Bounds the persisted cooldown lookup by the classify attempt's remaining
 * wall-clock budget, so a stalled database lookup terminates inside
 * GEMINI_FREE_PROVIDER_TIMEOUT_MS instead of hanging the worker past the
 * abort timer (which only governs the later SDK request). On budget expiry
 * the controller is aborted and a timeout error is thrown, so the existing
 * aborted-error path classifies it exactly like an SDK timeout (TIMEOUT,
 * retryable, same telemetry, no cooldown arming). Ordinary lookup errors
 * still fail open to undefined, and a disabled deadline rollout preserves
 * the previous unbounded behavior.
 */
async function persistedCooldownExpiryWithinBudget(
  lookup: () => Promise<number | undefined>,
  startedMs: number,
  timeoutMs: number,
  deadlinesEnabled: boolean,
  controller: AbortController,
): Promise<number | undefined> {
  if (!deadlinesEnabled) return lookup();
  const remainingMs = timeoutMs - (Date.now() - startedMs);
  if (remainingMs <= 0) {
    controller.abort();
    throw new ProviderCallError(`Free Gemini call exceeded ${timeoutMs}ms deadline.`, 'TIMEOUT', true);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProviderCallError(`Free Gemini call exceeded ${timeoutMs}ms deadline.`, 'TIMEOUT', true));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * SDK cache keyed by route id. Credential contract: deployment credentials
 * are process-start configuration (Railway env / .env), but route
 * enumeration re-reads env on every client construction — so a rotated key
 * value for the SAME route id must replace the cached SDK instead of reusing
 * the previous credential until restart. The cached key is therefore
 * validated on every hit; a mismatch recreates the SDK with the current key.
 * Cache entries never leave this module (isolation from the paid provider's
 * own cache is by construction: separate Map, separate route ids).
 */
const sdkByRoute = new Map<string, { sdk: GoogleGenAI; key: string }>();

/** Test-only reset for the SDK cache. */
export function clearGeminiFreeSdkCacheForTests(): void {
  sdkByRoute.clear();
}

/**
 * Test-only seam: resolve (and cache) the SDK for a route without a network
 * call, so credential rotation is observable without touching the provider.
 */
export function geminiFreeSdkForRouteForTests(route: GeminiFreeRoute): GoogleGenAI {
  return sdkFor(route);
}

function sdkFor(route: GeminiFreeRoute): GoogleGenAI {
  const cached = sdkByRoute.get(route.id);
  if (cached && cached.key === route.key) return cached.sdk;
  const sdk = new GoogleGenAI({ apiKey: route.key });
  sdkByRoute.set(route.id, { sdk, key: route.key });
  return sdk;
}

export function defaultClient(
  emit: (event: ProviderCallEvent) => Promise<void> = emitGeminiFreeEvent,
  deps?: GeminiFreeDefaultClientDeps,
): SemanticModelClient | undefined {
  const routes = configuredGeminiFreeRoutes();
  if (!routes.length) return undefined;
  const timeoutMs = geminiFreeTimeoutMs();
  const deadlinesEnabled = geminiFreeDeadlinesEnabled();
  const persistedCooldownExpiryMs = deps?.persistedCooldownExpiryMs ?? defaultPersistedCooldownExpiryMs;
  return {
    batchGroup: 'gemini-free-semantic',
    classify: async (prompt, model, observability, signal, options) => {
      const response = await runGeminiFreeRouteFailover(routes, async route => {
        const started = Date.now();
        const controller = new AbortController();
        const abortFromCaller = () => controller.abort(signal?.reason);
        if (signal?.aborted) controller.abort(signal.reason);
        else signal?.addEventListener('abort', abortFromCaller, { once: true });
        // Track why the controller aborted: only a deadline expiry is a
        // TIMEOUT. A caller cancellation must stay CANCELLED in telemetry and
        // provider reports instead of masquerading as a slow provider.
        let deadlineExpired = false;
        const timer = deadlinesEnabled ? setTimeout(() => { deadlineExpired = true; controller.abort(); }, timeoutMs) : undefined;
        const base = {
          id: randomUUID(), provider: 'gemini-free', operation: 'multilingual-semantic-classification',
          ...semanticObservabilityFields(observability),
          requestMetadata: { ...(observability?.requestMetadata || {}), geminiFreeRoute: route.id }, attempt: 1,
          reservedCost: 0, policyVersion: 'provider-resilience-v1',
        };
        try {
          const remainingMs = geminiFreeCooldownRemainingMs();
          if (remainingMs > 0) throw geminiFreeCooldownDeferredError(remainingMs);
          let persistedExpiryMs: number | undefined;
          try {
            persistedExpiryMs = await persistedCooldownExpiryWithinBudget(
              persistedCooldownExpiryMs, started, timeoutMs, deadlinesEnabled, controller,
            );
          } catch (error) {
            // Budget-expiry timeouts propagate (the controller is already
            // aborted, so the outer handler classifies them exactly like an
            // SDK timeout); ordinary ledger errors fail open as before.
            if (error instanceof ProviderCallError && error.errorClass === 'TIMEOUT') throw error;
            persistedExpiryMs = undefined;
          }
          if (persistedExpiryMs !== undefined && persistedExpiryMs > Date.now()) {
            geminiFreeCooldownUntilMs = Math.max(geminiFreeCooldownUntilMs, persistedExpiryMs);
            throw geminiFreeCooldownDeferredError(persistedExpiryMs - Date.now());
          }
          const raw = await sdkFor(route).models.generateContent({
            model,
            contents: prompt,
            config: { responseMimeType: 'application/json', temperature: 0, abortSignal: controller.signal, ...geminiBatchOutputConfig(options?.batchSize) },
          });
          const parsed = JSON.parse(raw.text || '{}');
          await emit({
            ...base, status: 'SUCCESS', latencyMs: Date.now() - started,
            actualCost: 0, occurredAt: new Date().toISOString(),
          });
          return parsed;
        } catch (error) {
          const aborted = controller.signal.aborted;
          const callerTimedOut = (controller.signal.reason as { errorClass?: string } | undefined)?.errorClass === 'TIMEOUT';
          const typed = error instanceof ProviderCallError && error.errorClass === 'TIMEOUT'
            ? error
            : aborted
              ? (deadlineExpired || callerTimedOut)
                ? new ProviderCallError(deadlineExpired
                  ? `Free Gemini call exceeded ${timeoutMs}ms deadline.`
                  : 'Free Gemini call exceeded the caller deadline.', 'TIMEOUT', true, { cause: error })
                : geminiFreeFailoverCancelled(signal)
              : classifyProviderError(error);
          if (!aborted && typed.errorClass === 'RATE_LIMIT' && (error as { geminiFreeCooldownDeferred?: unknown })?.geminiFreeCooldownDeferred !== true) {
            geminiFreeCooldownUntilMs = nextGeminiFreeCooldownUntilMs(geminiFreeCooldownUntilMs, typed);
          }
          if (typed.errorClass === 'RATE_LIMIT') {
            const reasons = Array.isArray((typed as { providerReasons?: unknown }).providerReasons)
              ? ((typed as { providerReasons?: unknown }).providerReasons as string[]).map(String)
              : [];
            if (!reasons.includes(GEMINI_FREE_RATE_LIMITED_REASON)) {
              (typed as { providerReasons?: string[] }).providerReasons = [...reasons, GEMINI_FREE_RATE_LIMITED_REASON];
            }
          }
          const deferred = (error as { geminiFreeCooldownDeferred?: unknown })?.geminiFreeCooldownDeferred === true;
          await emit({
            ...base, status: statusFor(typed), latencyMs: Date.now() - started,
            actualCost: 0, errorClass: typed.errorClass, occurredAt: new Date().toISOString(),
            requestMetadata: { ...base.requestMetadata, ...geminiFreeFailureMetadata(typed, deferred) },
          });
          throw typed;
        } finally {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', abortFromCaller);
        }
      }, { signal });
      return response;
    },
  };
}

async function classifyCandidateWith404Fallback(client: SemanticModelClient, candidatePrompt: string, candidateModel: string, fallbackModel: string, observability?: SemanticObservabilityContext, signal?: AbortSignal) {
  try {
    return { value: await classifySemanticPrompt({ client, prompt: candidatePrompt, model: candidateModel, observability, signal }), model: candidateModel, fallbackUsed: false };
  } catch (error) {
    const isModel404 = error instanceof ProviderCallError && error.errorClass === 'PERMANENT_INPUT' && error.status === 404;
    if (!isModel404 || candidateModel === fallbackModel) throw error;
    console.warn('[GeminiFree Semantic] Candidate model returned 404; retrying once with configured adjudicator model.', { candidateModel, fallbackModel });
    return { value: await classifySemanticPrompt({ client, prompt: candidatePrompt, model: fallbackModel, observability, signal }), model: fallbackModel, fallbackUsed: true };
  }
}

export class GeminiFreeSemanticProvider implements EvidenceProvider {
  name = 'gemini_free_semantic' as const;
  constructor(private readonly injectedClient?: SemanticModelClient) {}
  private client() { return this.injectedClient || defaultClient(); }
  availability(input: RawChannelInput) {
    if (!this.client()) return { availability: 'UNAVAILABLE' as const, reason: 'GEMINI_FREE_API_KEY is not configured.' };
    if (!hasCreatorLevelSemanticContext(input)) {
      return { availability: 'NOT_APPLICABLE' as const, reason: 'Retrieval-only candidate has no independent creator-level semantic context yet.' };
    }
    const prefilter = applySemanticPrefilter(input, this.name);
    if (prefilter.skip) {
      return { availability: 'NOT_APPLICABLE' as const, reason: `Semantic prefilter withheld semantic quota: ${prefilter.decision?.reasonCodes.join(',') || 'WITHHELD'}.` };
    }
    return { availability: 'AVAILABLE' as const };
  }

  async collectEvidence(input: RawChannelInput, _knowledge: LayeredKnowledgeContext, signal?: AbortSignal): Promise<EvidenceItem[]> {
    const client = this.client();
    if (!client) return [];
    const candidateModel = process.env.GEMINI_FREE_CANDIDATE_MODEL || DEFAULT_GEMINI_FREE_CANDIDATE_MODEL;
    const adjudicatorModel = process.env.GEMINI_FREE_ADJUDICATOR_MODEL || DEFAULT_GEMINI_FREE_ADJUDICATOR_MODEL;
    const observability = { jobId: input.job_id, runId: input.run_id };
    const adjudicationEnabled = process.env.GEMINI_FREE_ADJUDICATION_ENABLED === 'true';
    const cacheIdentity = {
      input,
      provider: this.name,
      promptVersion: SEMANTIC_PROMPT_VERSION,
      featureVersion: SEMANTIC_FEATURE_VERSION,
      modelVersion: candidateModel,
      adjudicatorModelVersion: adjudicatorModel,
      adjudicationEnabled,
      batchPromptVersion: semanticBatchConfig().enabled ? SEMANTIC_BATCH_PROMPT_VERSION : undefined,
    };
    const cached = this.injectedClient ? undefined : await readSemanticResultCache(cacheIdentity, process.env, { signal });
    let result: ReturnType<typeof parseSemanticResult>;
    let model: string;
    let fallbackReasonCodes: string[];
    if (cached) {
      result = cached.result;
      model = cached.modelVersion;
      fallbackReasonCodes = [
        ...(cached.fallbackUsed ? ['SEMANTIC_CANDIDATE_MODEL_404_FALLBACK'] : []),
        SEMANTIC_RESULT_CACHE_HIT_REASON,
      ];
    } else {
      const candidatePrompt = buildSemanticPrompt(input, 'CANDIDATE');
      const candidate = await classifyCandidateWith404Fallback(client, candidatePrompt, candidateModel, adjudicatorModel, observability, signal);
      // Only a complete model reply may be cached. parseSemanticResult turns
      // a missing/partial reply into an AMBIGUOUS abstention; persisting that
      // placeholder would replay it for the same evidence indefinitely.
      let cacheable = isSemanticResultShape(candidate.value);
      result = parseSemanticResult(candidate.value);
      model = candidate.model;
      fallbackReasonCodes = candidate.fallbackUsed ? ['SEMANTIC_CANDIDATE_MODEL_404_FALLBACK'] : [];
      // Adjudication is a second pass with the ADJUDICATION prompt for
      // AMBIGUOUS/low-confidence candidates. Unlike an earlier same-model
      // guard, the pass runs whenever it is enabled and the result qualifies —
      // with default models candidate and adjudicator intentionally share
      // gemini-2.5-flash-lite, and skipping then would silently disable the
      // flag. Decisive results still cost exactly one call (first conditions).
      if (result.supportedLanguage && (result.label === 'AMBIGUOUS' || result.confidence < 70) && adjudicationEnabled) {
        const adjudicatedValue = await classifySemanticPrompt({ client, prompt: buildSemanticPrompt(input, 'ADJUDICATION'), model: adjudicatorModel, observability, signal });
        cacheable = isSemanticResultShape(adjudicatedValue);
        result = parseSemanticResult(adjudicatedValue); model = adjudicatorModel;
      }
      if (!this.injectedClient && cacheable) await writeSemanticResultCache(cacheIdentity, { result, modelVersion: model, fallbackUsed: candidate.fallbackUsed }, process.env, { signal });
    }
    // Shadow validation for the Phase 4 prefilter gate. Observability only:
    // it never changes the verdict, and enforce mode records nothing because
    // withheld channels never reach this provider.
    recordSemanticPrefilterOutcome(input, this.name, result.label);
    const calibrated = calibrateSemanticConfidence(result.confidence);
    const abstained = !result.supportedLanguage || result.label === 'AMBIGUOUS' || calibrated < 50 || result.citations.length === 0;
    const positive = result.label === 'ACTIVE_TRADING' || result.label === 'INVESTING_EDUCATION';
    const category: EvidenceCategory = abstained ? 'SEMANTIC_ABSTENTION' : positive ? 'METHODOLOGY_CONCEPT' : result.label === 'HYPE' ? 'HYPE_SPECULATION' : result.label === 'UNRELATED' ? 'IRRELEVANT_DOMAIN' : 'NON_TRADING_ADJACENT';
    const rawWeight = abstained ? 0 : positive ? 24 : 26;
    const finalWeight = abstained ? 0 : rawWeight * .65 * (calibrated / 100) * (positive ? 1 : -1);
    const semantic = { modelVersion: model, promptVersion: SEMANTIC_PROMPT_VERSION, featureVersion: SEMANTIC_FEATURE_VERSION, calibrationVersion: SEMANTIC_CALIBRATION_VERSION, taxonomyLabel: result.label, rawConfidence: result.confidence, calibratedConfidence: calibrated, detectedLanguages: result.languages, reasonCodes: [...fallbackReasonCodes, ...result.reasonCodes, ...(abstained ? ['SEMANTIC_MODEL_ABSTAINED'] : [])] };
    const citations = result.citations.map(ref => {
      const video = ref.field === 'video_title' || ref.field === 'video_description' ? input.videos?.[ref.index || 0] : undefined;
      const family = video?.source_family_id || (ref.field === 'channel_title' || ref.field === 'channel_bio' ? input.channel_source_family_id : undefined);
      const entity = video?.source_entity_id || ((video || ref.field === 'channel_title' || ref.field === 'channel_bio') ? input.channel_entity_id : undefined);
      return { ...ref, ...(family ? { sourceFamilyId: family } : {}), ...(entity ? { sourceEntityId: entity } : {}) };
    });
    return [{
      id: `semantic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, source: this.name, polarity: positive || abstained ? 'POSITIVE' : 'NEGATIVE', category,
      fact: `Multilingual semantic evidence [${result.label}]: ${result.explanation}`, rawMatches: abstained ? [] : result.concepts,
      confidence: calibrated, reliability: abstained ? 'LOWER' : 'MEDIUM', reliabilityMultiplier: abstained ? .4 : .65, rawWeight, finalWeight,
      provenance: { provider: this.name, type: category, matchedTerm: result.concepts.join(', ') || result.label, sourceRef: `structured-semantic:${model}`, fields: citations, semantic }, timestamp: new Date().toISOString()
    }];
  }
}

/**
 * Semantic-provider routing predicate. Default keeps the paid Gemini setup
 * (status quo ante): the free setup serves a channel only when explicitly
 * selected AND the kill switch is off AND at least one free route is
 * configured. Evaluated per channel evaluation (not at construction) so the
 * kill switch takes effect without a restart. SEMANTIC_PROVIDER can name only
 * one provider, so the free and Groq selectors are mutually exclusive.
 */
export function shouldUseGeminiFreeSemantic(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SEMANTIC_PROVIDER_FORCE_GEMINI === 'true') return false;
  if (env.SEMANTIC_PROVIDER !== 'gemini-free') return false;
  return configuredGeminiFreeRoutes(env).length > 0;
}
