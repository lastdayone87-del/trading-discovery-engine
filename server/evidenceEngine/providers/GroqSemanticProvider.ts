import { randomUUID } from 'node:crypto';
import { appendProviderCallEvent } from '../../db';
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
  hasCreatorLevelSemanticContext,
  parseSemanticResult,
  SEMANTIC_FEATURE_VERSION,
  SEMANTIC_PROMPT_VERSION,
  type SemanticModelClient,
} from './GeminiSemanticProvider';

export const DEFAULT_GROQ_CANDIDATE_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_GROQ_ADJUDICATOR_MODEL = 'openai/gpt-oss-120b';
export const GROQ_API_BASE_URL = 'https://api.groq.com/openai/v1/chat/completions';

export interface GroqRoute { id: string; key: string; }

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
    out.push({ id: `groq-${counter}`, key });
  }
  return out;
}

export function groqTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.GROQ_PROVIDER_TIMEOUT_MS || '135000');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 135000;
}

export async function runGroqRouteFailover<T>(routes: GroqRoute[], call: (route: GroqRoute) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const route of routes) {
    try {
      return await call(route);
    } catch (error) {
      lastError = error;
      // Mirror the Gemini route policy: never fail over on rate limits (burst
      // multiplication risk on shared/org-level quotas). Failover remains for
      // other retryable failures such as transient transport errors.
      if (error instanceof ProviderCallError && error.errorClass === 'RATE_LIMIT') throw error;
      if (!(error instanceof ProviderCallError) || !error.retryable) throw error;
    }
  }
  throw lastError || new ProviderCallError('No configured Groq route is available.', 'TRANSIENT', true);
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

function defaultClient(): SemanticModelClient | undefined {
  const routes = configuredGroqRoutes();
  if (!routes.length) return undefined;
  const timeoutMs = groqTimeoutMs();
  return { classify: async (prompt, model) => {
    const response = await runGroqRouteFailover(routes, async route => {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const base = {
        id: randomUUID(), provider: 'groq', operation: 'multilingual-semantic-classification',
        requestMetadata: { groqRoute: route.id }, attempt: 1,
        reservedCost: 0, policyVersion: 'provider-resilience-v1',
      };
      try {
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
        const text = await res.text();
        if (!res.ok) {
          throw Object.assign(new Error(`Groq HTTP ${res.status}: ${text.slice(0, 500)}`),
            { status: res.status, code: res.status });
        }
        const content = (JSON.parse(text) as any)?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content) {
          throw Object.assign(new Error('Groq returned no message content.'), { status: res.status });
        }
        await emitGroqEvent({
          ...base, status: 'SUCCESS', latencyMs: Date.now() - started,
          actualCost: 0, occurredAt: new Date().toISOString(),
        });
        return JSON.parse(content);
      } catch (error) {
        const aborted = controller.signal.aborted;
        const typed = aborted
          ? new ProviderCallError(`Groq call exceeded ${timeoutMs}ms deadline.`, 'TIMEOUT', true, { cause: error })
          : classifyProviderError(error);
        await emitGroqEvent({
          ...base, status: statusFor(typed), latencyMs: Date.now() - started,
          actualCost: 0, errorClass: typed.errorClass, occurredAt: new Date().toISOString(),
        });
        throw typed;
      } finally {
        clearTimeout(timer);
      }
    });
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
    if (result.supportedLanguage && (result.label === 'AMBIGUOUS' || result.confidence < 70) && process.env.MULTILINGUAL_ADJUDICATION_ENABLED === 'true' && model !== adjudicatorModel) {
      result = parseSemanticResult(await client.classify(buildSemanticPrompt(input, 'ADJUDICATION'), adjudicatorModel)); model = adjudicatorModel;
    }
    const calibrated = calibrateSemanticConfidence(result.confidence);
    const abstained = !result.supportedLanguage || result.label === 'AMBIGUOUS' || calibrated < 50 || result.citations.length === 0;
    const positive = result.label === 'ACTIVE_TRADING' || result.label === 'INVESTING_EDUCATION';
    const category: EvidenceCategory = abstained ? 'SEMANTIC_ABSTENTION' : positive ? 'METHODOLOGY_CONCEPT' : result.label === 'HYPE' ? 'HYPE_SPECULATION' : result.label === 'UNRELATED' ? 'IRRELEVANT_DOMAIN' : 'NON_TRADING_ADJACENT';
    const rawWeight = abstained ? 0 : positive ? 24 : 26;
    const finalWeight = abstained ? 0 : rawWeight * .65 * (calibrated / 100) * (positive ? 1 : -1);
    const semantic = { modelVersion: model, promptVersion: SEMANTIC_PROMPT_VERSION, featureVersion: SEMANTIC_FEATURE_VERSION, calibrationVersion: SEMANTIC_CALIBRATION_VERSION, taxonomyLabel: result.label, rawConfidence: result.confidence, calibratedConfidence: calibrated, detectedLanguages: result.languages, reasonCodes: [...fallbackReasonCodes, ...result.reasonCodes, ...(abstained ? ['SEMANTIC_MODEL_ABSTAINED'] : [])] };
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
