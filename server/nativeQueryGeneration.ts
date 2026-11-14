import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { appendProviderCallEvent } from './db';
import { detectLanguage } from './languageDetection';
import {
  getCandidateMemory,
  getGenerationBatch,
  queryGenerationBatchKey,
  rememberQueryCandidates,
  upsertGenerationBatch,
  type CandidateMemoryRow,
} from './queryGenerationMemory';
import {
  classifyCandidateDuplicate,
  dedupeCandidateBatch,
  normalizeCandidateText,
  type CandidateHistoryItem,
} from './queryDuplicateGuard';
import {
  queryGenerationLabel,
  type QueryGenerationMode,
  type QueryGenerationProvenance,
  type QueryGenerationSource,
} from './queryGenerationProvenance';
import { isForbiddenProseQuery } from './queryPlanner';
import { isSearchableTradingTerm } from './terminologySearchability';
import { executeProviderCall, resolveGeminiRouteId } from './providerResilience';
import { geminiOrgIdForSlot } from './evidenceEngine/providers/GeminiSemanticProvider';

export const NATIVE_QUERY_PROMPT_VERSION = 'native-query-v1';
export const NATIVE_QUERY_BATCH_SIZE = 100;
export const NATIVE_QUERY_BATCH_TTL_DAYS = 14;
export const NATIVE_QUERY_REPLACEMENT_THRESHOLD = 0.6;

export interface NativeQueryGenerationContext {
  country: string;
  language: string;
  regionCode?: string;
  mode: QueryGenerationMode;
  existingQueries: CandidateHistoryItem[];
  candidateMemory: CandidateMemoryRow[];
  coverageGaps: string[];
  autocompleteSuggestions: string[];
  localVocabulary: string[];
}

export interface NativeQueryCandidate {
  query: string;
  language: string;
  intent: string;
  confidence: number;
  source: QueryGenerationSource;
  mode: QueryGenerationMode;
  provider: string | null;
  model: string | null;
  promptVersion: string;
  batchId: string | null;
  persona: string | null;
  scenario: string | null;
  provenance: QueryGenerationProvenance;
}

export interface NativeQueryGenerationResult {
  candidates: NativeQueryCandidate[];
  rejected: Array<{ query: string; reasons: string[] }>;
  batchId: string;
  provider: string | null;
  model: string | null;
  cached: boolean;
  duplicateRate: number;
}

type TextGenerator = (prompt: string) => Promise<{ text: string; provider: string; model: string } | null>;

const PERSONAS: Record<QueryGenerationMode, string[]> = {
  OPEN_WORLD: [
    'a local trading insider describing searches a foreign marketer would miss',
    'a beginner who does not know the English trading vocabulary',
    'an active derivatives trader looking for practical local content',
    'a prop-firm candidate comparing local platforms and challenges',
    'a crypto investor looking for local-language risk education',
    'a semi-professional trader looking for communities and live analysis',
  ],
  REAL_SIGNAL: [
    'a local creator describing how their audience searches for trading help',
    'a market participant using local platforms, brokers and exchanges',
    'a viewer looking for a specific local instrument or session',
  ],
  GROUNDED: [
    'a search editor filling a known coverage gap without repeating existing queries',
    'a local trader extending a proven search intention into an adjacent topic',
  ],
};

const SCENARIOS = [
  'before the local market opens',
  'after a sharp market move',
  'while comparing local brokers or platforms',
  'while learning a specific strategy from scratch',
  'while looking for live market commentary',
  'while evaluating a prop-firm challenge',
  'while researching local tax or regulatory treatment of trading',
  'while looking for a trading community or mentor',
];

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function contextDigest(context: NativeQueryGenerationContext): string {
  return createHash('sha256').update(stableJson({
    country: context.country,
    language: context.language,
    regionCode: context.regionCode || null,
    mode: context.mode,
    existing: context.existingQueries.map(item => normalizeCandidateText(item.query)).slice(0, 200),
    gaps: [...context.coverageGaps].sort(),
    autocomplete: [...context.autocompleteSuggestions].sort().slice(0, 100),
    vocabulary: [...context.localVocabulary].sort().slice(0, 120),
  })).digest('hex');
}

function buildPrompt(context: NativeQueryGenerationContext, persona: string, scenario: string, rejected: string[], count: number): string {
  const existing = context.existingQueries.map(item => item.query).filter(Boolean).slice(0, 100);
  const gaps = context.coverageGaps.slice(0, 16);
  const suggestions = context.autocompleteSuggestions.slice(0, 60);
  const vocabulary = context.localVocabulary.slice(0, 80);
  return `You are a local YouTube search expert for ${context.country} (${context.regionCode || 'unknown region'}), language ${context.language}.

Generate ${count} natural YouTube search queries that real people in this country would type to find trading channels, signal providers, forex/crypto/stock traders, or trading educators.

Think as ${persona}. The search happens ${scenario}.

Rules:
- Write in the local language and natural local phrasing. Do not translate English keywords word-for-word.
- Include short and longer phrases (2-6 words), local slang, abbreviations, platforms, brokers, exchanges, instruments, audiences, formats and search intentions.
- Use the supplied local vocabulary and real autocomplete suggestions when they are useful.
- Avoid generic phrases, clickbait, hashtags, emojis, dates, episode numbers, calls to action and channel names.
- Do not repeat, reorder, paraphrase or trivially vary any already-covered query.
- Target the coverage gaps only where useful; otherwise explore genuinely new topics and search intentions.
- Return only valid JSON: {"queries":[{"query":"...","intent":"strategy","confidence":0.8}]}

Already covered (do not repeat):
${existing.length ? existing.map(query => `- ${query}`).join('\n') : '- none'}

Coverage gaps / underrepresented areas:
${gaps.length ? gaps.map(gap => `- ${gap}`).join('\n') : '- none supplied'}

Real local autocomplete suggestions (context, not a mandatory list):
${suggestions.length ? suggestions.map(suggestion => `- ${suggestion}`).join('\n') : '- none supplied'}

Local vocabulary, instruments and platforms:
${vocabulary.length ? vocabulary.map(term => `- ${term}`).join('\n') : '- none supplied'}

Previously rejected duplicates for this replacement pass:
${rejected.length ? rejected.map(query => `- ${query}`).join('\n') : '- none'}`;
}

function parseResponse(text: string): Array<{ query: string; intent?: string; confidence?: number }> {
  const stripped = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  if (!stripped) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).queries)
      ? (parsed as Record<string, unknown>).queries as unknown[]
      : [];
  return rows.flatMap(row => {
    if (typeof row === 'string') return [{ query: row }];
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    const query = typeof item.query === 'string' ? item.query : '';
    if (!query.trim()) return [];
    return [{
      query,
      intent: typeof item.intent === 'string' ? item.intent : undefined,
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : undefined,
    }];
  });
}

const ALLOWED_INTENTS = new Set([
  'futures', 'forex', 'stocks', 'options', 'strategy', 'indicators', 'education',
  'market_analysis', 'premarket_prep', 'session_analysis', 'live_trading',
  'trading_journals', 'psychology',
]);

function normalizeIntent(value: string | undefined): string {
  const candidate = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  return ALLOWED_INTENTS.has(candidate) ? candidate : 'strategy';
}

function assessCandidate(input: {
  query: string;
  country: string;
  language: string;
  intent?: string;
  confidence?: number;
  source: QueryGenerationSource;
  mode: QueryGenerationMode;
  provider: string | null;
  model: string | null;
  batchId: string;
  persona: string | null;
  scenario: string | null;
  prefix?: string | null;
  promptVersion?: string | null;
  generatedAt?: string | null;
}): { candidate: NativeQueryCandidate | null; reasons: string[] } {
  const query = input.query.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const reasons: string[] = [];
  if (!query) reasons.push('EMPTY');
  if (query.length < 4 || query.length > 80) reasons.push('LENGTH');
  const tokens = query.split(/\s+/u).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) reasons.push('TOKEN_COUNT');
  if (isForbiddenProseQuery(query)) reasons.push('FORBIDDEN_PROSE');
  if (/[@#]/u.test(query)) reasons.push('HASHTAG_OR_HANDLE');
  if (/(https?:\/\/|www\.)/iu.test(query)) reasons.push('URL');
  if (/\b(subscribe|follow|like|comment|telegram|whatsapp|discord)\b/iu.test(query)) reasons.push('CTA_OR_PLATFORM');
  const detected = detectLanguage(query, { countryHint: input.country });
  if (detected.language !== 'und' && detected.language !== input.language) {
    // Local trading vocabulary often contains English terms. Reject only when
    // the detector found a different *local* language, not generic English.
    if (!(input.language !== 'en' && detected.language === 'en')) reasons.push('LANGUAGE_MISMATCH');
  }
  if (!reasons.length) {
    const gate = isSearchableTradingTerm({
      term: query,
      termType: 'PHRASE',
      country: input.country,
      language: input.language,
      maxTokens: 6,
      requireTradingSemantics: true,
    });
    if (!gate.eligible) reasons.push(...gate.reasons.map(reason => `GATE_${reason.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`));
  }
  if (reasons.length) return { candidate: null, reasons: [...new Set(reasons)] };
  const provenance: QueryGenerationProvenance = {
    source: input.source,
    mode: input.mode,
    provider: input.provider,
    model: input.model,
    promptVersion: input.promptVersion || NATIVE_QUERY_PROMPT_VERSION,
    batchId: input.batchId,
    country: input.country,
    language: input.language,
    persona: input.persona,
    scenario: input.scenario,
    prefix: input.prefix || null,
    generatedAt: input.generatedAt || new Date().toISOString(),
  };
  return {
    candidate: {
      query,
      language: input.language,
      intent: normalizeIntent(input.intent),
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.65)),
      source: input.source,
      mode: input.mode,
      provider: input.provider,
      model: input.model,
      promptVersion: input.promptVersion || NATIVE_QUERY_PROMPT_VERSION,
      batchId: input.batchId,
      persona: input.persona,
      scenario: input.scenario,
      provenance,
    },
    reasons: [],
  };
}

async function callGroq(prompt: string): Promise<{ text: string; provider: string; model: string } | null> {
  try {
    const { runGroqTextCompletion } = await import('./evidenceEngine/providers/GroqSemanticProvider');
    const text = await runGroqTextCompletion({ prompt, operation: 'native-query-generation' });
    if (!text?.trim() || !parseResponse(text).length) return null;
    return { text, provider: 'groq', model: process.env.GROQ_CANDIDATE_MODEL || 'groq' };
  } catch {
    return null;
  }
}

async function callGemini(prompt: string): Promise<{ text: string; provider: string; model: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.NATIVE_QUERY_GEMINI_MODEL || 'gemini-3.6-flash';
  try {
    const response = await executeProviderCall({
      context: {
        provider: 'gemini',
        operation: 'native-query-generation',
        requestMetadata: {
          geminiRoute: resolveGeminiRouteId('gemini-1'),
          geminiOrg: geminiOrgIdForSlot(process.env, 1),
        },
      },
      timeoutMs: Number(process.env.GEMINI_PROVIDER_TIMEOUT_MS || '45000'),
      enabled: process.env.PROVIDER_DEADLINES_ENABLED === 'true',
      emit: appendProviderCallEvent,
      call: signal => ai.models.generateContent({
        model,
        contents: prompt,
        config: { responseMimeType: 'application/json', abortSignal: signal },
      }),
    });
    const text = String((response as { text?: string }).text || '').trim();
    return text && parseResponse(text).length ? { text, provider: 'gemini', model } : null;
  } catch {
    return null;
  }
}

async function defaultGenerateText(prompt: string): Promise<{ text: string; provider: string; model: string } | null> {
  return await callGroq(prompt) || await callGemini(prompt);
}

/**
 * Generate a country/language native query batch with cache, memory, exact and
 * semantic dedup. Provider output never enters query_library here; callers
 * turn accepted candidates into frontier proposals and existing admission
 * decides whether they can execute.
 */
export async function generateNativeQueriesWithLlm(input: {
  context: NativeQueryGenerationContext;
  count?: number;
  /** Deterministic test seam; production uses Groq then Gemini. */
  generateText?: TextGenerator;
}): Promise<NativeQueryGenerationResult> {
  const context = input.context;
  const count = Math.max(1, Math.min(NATIVE_QUERY_BATCH_SIZE, Math.trunc(input.count ?? NATIVE_QUERY_BATCH_SIZE)));
  const digest = contextDigest(context);
  const batchKey = queryGenerationBatchKey({
    country: context.country,
    language: context.language,
    source: 'LLM',
    mode: context.mode,
    promptVersion: NATIVE_QUERY_PROMPT_VERSION,
    contextDigest: digest,
  });
  const cachedHistory: CandidateHistoryItem[] = [
    ...context.existingQueries,
    ...context.candidateMemory.filter(row => row.batchKey !== batchKey).map(row => ({ query: row.normalizedQuery, country: context.country, intent: null })),
  ];
  const cached = await getGenerationBatch(batchKey).catch(() => null);
  if (cached && Array.isArray(cached.candidates)) {
    // Memory may have changed since the batch was written (for example a
    // query was admitted elsewhere or a prompt was rejected). Re-apply the
    // exact/semantic guard instead of trusting the old cache blindly.
    const refreshed = dedupeCandidateBatch(cached.candidates as NativeQueryCandidate[], cachedHistory);
    return {
      candidates: refreshed.accepted.slice(0, count),
      rejected: [
        ...(Array.isArray(cached.rejected) ? cached.rejected as Array<{ query: string; reasons: string[] }> : []),
        ...refreshed.rejected.map(item => ({ query: item.candidate.query, reasons: [item.decision.class || 'DUPLICATE'] })),
      ],
      batchId: batchKey,
      provider: typeof cached.provider === 'string' ? cached.provider : null,
      model: typeof cached.model === 'string' ? cached.model : null,
      cached: true,
      duplicateRate: Number(cached.duplicateRate || 0),
    };
  }

  const generate = input.generateText || defaultGenerateText;
  const personas = PERSONAS[context.mode];
  const persona = personas[Math.abs(digest.charCodeAt(0) + digest.charCodeAt(1)) % personas.length];
  const scenario = SCENARIOS[Math.abs(digest.charCodeAt(2) + digest.charCodeAt(3)) % SCENARIOS.length];
  const history: CandidateHistoryItem[] = [
    ...context.existingQueries,
    ...context.candidateMemory.filter(row => row.batchKey !== batchKey).map(row => ({ query: row.normalizedQuery, country: context.country, intent: null })),
  ];
  const accepted: NativeQueryCandidate[] = [];
  const rejected: Array<{ query: string; reasons: string[] }> = [];
  let provider: string | null = null;
  let model: string | null = null;
  let lastText = '';

  for (let pass = 0; pass < 2; pass += 1) {
    const prompt = buildPrompt(context, persona, scenario, rejected.map(item => item.query), count);
    const response = await generate(prompt);
    if (!response?.text) break;
    const parsed = parseResponse(response.text);
    if (!parsed.length) break;
    provider = response.provider;
    model = response.model;
    lastText = response.text;
    for (const row of parsed) {
      const assessed = assessCandidate({
        query: row.query,
        country: context.country,
        language: context.language,
        intent: row.intent,
        confidence: row.confidence,
        source: 'LLM',
        mode: context.mode,
        provider,
        model,
        batchId: batchKey,
        persona,
        scenario,
      });
      if (!assessed.candidate) {
        rejected.push({ query: row.query, reasons: assessed.reasons });
        continue;
      }
      const duplicate = classifyCandidateDuplicate(
        { query: assessed.candidate.query, country: context.country, intent: assessed.candidate.intent },
        history,
      );
      if (duplicate.duplicate) {
        rejected.push({ query: assessed.candidate.query, reasons: [duplicate.class || 'DUPLICATE'] });
        continue;
      }
      accepted.push(assessed.candidate);
      history.push({ query: assessed.candidate.query, country: context.country, intent: assessed.candidate.intent });
      if (accepted.length >= count) break;
    }
    if (accepted.length >= Math.ceil(count * NATIVE_QUERY_REPLACEMENT_THRESHOLD)) break;
    if (!rejected.length) break;
  }

  const duplicateRate = parsedCount(lastText) > 0 ? rejected.length / parsedCount(lastText) : 0;
  const result: NativeQueryGenerationResult = {
    candidates: accepted.slice(0, count),
    rejected,
    batchId: batchKey,
    provider,
    model,
    cached: false,
    duplicateRate: Math.round(duplicateRate * 10000) / 10000,
  };
  // A provider outage is not a low-novelty result. Do not cache an empty
  // batch for the full TTL, otherwise a transient key/network failure would
  // suppress generation for two weeks.
  if (!lastText) return result;
  await rememberQueryCandidates([
    ...accepted.map(candidate => ({
      country: context.country,
      language: context.language,
      source: 'LLM' as const,
      mode: context.mode,
      query: candidate.query,
      status: 'PROPOSED' as const,
      batchKey,
      metadata: { intent: candidate.intent, confidence: candidate.confidence },
    })),
    ...rejected.map(item => ({
      country: context.country,
      language: context.language,
      source: 'LLM' as const,
      mode: context.mode,
      query: item.query,
      status: 'REJECTED' as const,
      reasonCodes: item.reasons,
      batchKey,
    })),
  ]).catch(() => 0);
  await upsertGenerationBatch({
    batchKey,
    country: context.country,
    language: context.language,
    source: 'LLM',
    mode: context.mode,
    provider,
    model,
    promptVersion: NATIVE_QUERY_PROMPT_VERSION,
    inputFingerprint: digest,
    payload: {
      candidates: result.candidates,
      rejected: result.rejected,
      provider,
      model,
      duplicateRate: result.duplicateRate,
      label: result.candidates[0] ? queryGenerationLabel(result.candidates[0].provenance) : null,
    },
    duplicateRate: result.duplicateRate,
    acceptedCount: result.candidates.length,
    expiresAt: new Date(Date.now() + NATIVE_QUERY_BATCH_TTL_DAYS * 86_400_000).toISOString(),
    status: accepted.length ? 'COMPLETED' : 'LOW_NOVELTY',
  }).catch(() => undefined);
  return result;
}

function parsedCount(text: string): number {
  return parseResponse(text).length;
}

/** Exposed for tests and the autocomplete generator to use the same validator. */
export function assessGeneratedNativeQuery(input: {
  query: string;
  country: string;
  language: string;
  intent?: string;
  confidence?: number;
  source: QueryGenerationSource;
  mode: QueryGenerationMode;
  provider: string | null;
  model: string | null;
  batchId: string;
  persona?: string | null;
  scenario?: string | null;
  prefix?: string | null;
  promptVersion?: string | null;
  generatedAt?: string | null;
}): NativeQueryCandidate | null {
  return assessCandidate({
    ...input,
    persona: input.persona || null,
    scenario: input.scenario || null,
    prefix: input.prefix || null,
    promptVersion: input.promptVersion || null,
    generatedAt: input.generatedAt || null,
  }).candidate;
}

/** Exposed for tests: pure duplicate check over generated candidates. */
export function dedupeGeneratedCandidates<T extends { query: string; country: string; intent?: string | null }>(
  candidates: T[],
  history: CandidateHistoryItem[] = [],
): { accepted: T[]; rejected: Array<{ candidate: T; decision: ReturnType<typeof classifyCandidateDuplicate> }> } {
  return dedupeCandidateBatch(candidates, history);
}
