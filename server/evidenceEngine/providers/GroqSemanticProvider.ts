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
  SEMANTIC_FEATURE_VERSION,
  SEMANTIC_PROMPT_VERSION,
  type SemanticModelClient,
  type SemanticModelResult,
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

/** Configured key slot numbers (1-based) with a non-empty key. */
export function groqConfiguredSlotNumbers(env: NodeJS.ProcessEnv = process.env): number[] {
  return Object.keys(env)
    .filter(name => name === 'GROQ_API_KEY' || /^GROQ_API_KEY_[2-9][0-9]*$/.test(name))
    .map(name => (name === 'GROQ_API_KEY' ? 1 : Number(name.slice('GROQ_API_KEY_'.length))))
    .filter(slot => String(env[slot === 1 ? 'GROQ_API_KEY' : `GROQ_API_KEY_${slot}`] || '').trim())
    .sort((a, b) => a - b);
}

/**
 * Env var names that must name an explicit org for production quota
 * separation (one per configured key slot). Empty means every route is
 * labeled; production startup rejects a non-empty result.
 */
export function missingGroqOrgLabels(env: NodeJS.ProcessEnv = process.env): string[] {
  return groqConfiguredSlotNumbers(env)
    .filter(slot => !String(env[slot === 1 ? 'GROQ_ORG_ID' : `GROQ_ORG_ID_${slot}`] || '').trim())
    .map(slot => (slot === 1 ? 'GROQ_ORG_ID' : `GROQ_ORG_ID_${slot}`));
}

/** Return only ordered, non-empty route slots; credentials never leave this process. */
export function configuredGroqRoutes(env: NodeJS.ProcessEnv = process.env): GroqRoute[] {
  const names = Object.keys(env).filter(name => name === 'GROQ_API_KEY' || /^GROQ_API_KEY_[2-9][0-9]*$/.test(name));
  names.sort((a, b) => {
    const routeNumber = (name: string) => name === 'GROQ_API_KEY' ? 1 : Number(name.slice('GROQ_API_KEY_'.length));
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
    const slotNumber = name === 'GROQ_API_KEY' ? 1 : Number(name.slice('GROQ_API_KEY_'.length));
    out.push({ id: `groq-${counter}`, key, orgId: groqOrgIdForSlot(env, slotNumber) });
  }
  return out;
}

export function groqTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.GROQ_PROVIDER_TIMEOUT_MS || '135000');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 135000;
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
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_GROQ_RATE_LIMIT_COOLDOWN_MS;
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
    // A 429 marks its whole organization tried (see catch below), so this
    // head-pick always lands on the next eligible independent org — a
    // same-org sibling of an exhausted account is never retried.
    if (tried.has(route)) continue;
    tried.add(route);
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
  return { classify: async (prompt, model) => {
    const response = await runGroqRouteFailover(routes, async route => {
      const started = Date.now();
      const controller = new AbortController();
      const timer = deadlinesEnabled ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      const orgId = groqRouteOrg(route);
      const base = {
        id: randomUUID(), provider: 'groq', operation: 'multilingual-semantic-classification',
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
      }
    }, { isOrgCooling: orgId => groqOrgCooldownRemainingMs(orgId) > 0 });
    return response;
  }};
}

async function classifyCandidateWith404Fallback(client: SemanticModelClient, candidatePrompt: string, candidateModel: string, fallbackModel: string) {
  try {
    return { value: await client.classify(candidatePrompt, candidateModel), model: candidateModel, fallbackUsed: false };
  } catch (error) {
    const isModel404 = error instanceof ProviderCallError && error.errorClass === 'PERMANENT_INPUT' && error.status === 404;
    if (!isModel404 || candidateModel === fallbackModel) throw error;
    console.warn('[Groq Semantic] Candidate model returned 404; retrying once with configured adjudicator model.', { candidateModel, fallbackModel });
    return { value: await client.classify(candidatePrompt, fallbackModel), model: fallbackModel, fallbackUsed: true };
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

  async collectEvidence(input: RawChannelInput, _knowledge: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const client = this.client();
    if (!client) return [];
    const candidateModel = process.env.GROQ_CANDIDATE_MODEL || DEFAULT_GROQ_CANDIDATE_MODEL;
    const adjudicatorModel = process.env.GROQ_ADJUDICATOR_MODEL || DEFAULT_GROQ_ADJUDICATOR_MODEL;
    const candidatePrompt = buildSemanticPrompt(input, 'CANDIDATE');
    const candidate = await classifyCandidateWith404Fallback(client, candidatePrompt, candidateModel, adjudicatorModel);
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
        const repaired = parseSemanticResult(await client.classify(buildCitationRepairPrompt(candidatePrompt, result, candidateDocumentRefs(input)), model));
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
    if (result.supportedLanguage && (result.label === 'AMBIGUOUS' || result.confidence < 70) && process.env.MULTILINGUAL_ADJUDICATION_ENABLED === 'true' && model !== adjudicatorModel) {
      result = parseSemanticResult(await client.classify(buildSemanticPrompt(input, 'ADJUDICATION'), adjudicatorModel)); model = adjudicatorModel;
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
