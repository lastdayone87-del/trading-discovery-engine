import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GROQ_ADJUDICATOR_MODEL,
  DEFAULT_GROQ_CANDIDATE_MODEL,
  GroqSemanticProvider,
  configuredGroqRoutes,
  defaultClient,
  groqCooldownRemainingMs,
  groqTimeoutMs,
  resetGroqCooldownForTests,
  runGroqRouteFailover,
  shouldUseGroqSemantic,
} from './GroqSemanticProvider';
import type { SemanticModelClient } from './GeminiSemanticProvider';
import {
  buildSemanticPrompt,
  parseSemanticResult,
  GeminiSemanticProvider,
} from './GeminiSemanticProvider';
import { ProviderCallError } from '../../providerResilience';
import { ConfigurableWeightedStrategy } from '../scoringEngine';
import { getLayeredKnowledgeContext } from '../knowledgePacks';

const input = {
  channel_id: 'channel-1',
  channel_name: 'Example creator',
  description: 'Creator-level description with enough context for semantic classification.',
  video_titles: ['Example recent video', 'Another recent video'],
  video_descriptions: ['Description one', 'Description two'],
  country: 'United States',
} as any;

const unrelatedResult = {
  label: 'UNRELATED',
  confidence: 96,
  supportedLanguage: true,
  reasonCodes: ['CREATOR_FOCUS_UNRELATED'],
  explanation: 'The creator focuses on sports commentary rather than trading.',
  concepts: ['sports commentary'],
  languages: [{ language: 'en', script: 'Latin', confidence: 100, field: 'channel_bio' }],
  citations: [{ field: 'channel_bio' }],
};

const of = (value: unknown): SemanticModelClient => ({ classify: async () => value });

function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key] as string;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
  }
}

test('groq provider emits a terminal negative with identical weights for unrelated creators', async () => {
  const provider = new GroqSemanticProvider(of(unrelatedResult));
  const [item] = await provider.collectEvidence(input, {} as any);
  assert.equal(item.source, 'groq_semantic');
  assert.equal(item.polarity, 'NEGATIVE');
  assert.equal(item.category, 'IRRELEVANT_DOMAIN');
  assert.equal(item.rawWeight, 26);
  assert.equal(item.reliability, 'MEDIUM');
  assert.equal(item.provenance?.semantic?.taxonomyLabel, 'UNRELATED');
  assert.match(String(item.provenance?.sourceRef || ''), /^structured-semantic:/);
});

test('groq and gemini providers send byte-identical prompts (no drift)', async () => {
  const seen: string[] = [];
  const capturing: SemanticModelClient = { classify: async (prompt) => { seen.push(prompt); return {}; } };
  await new GroqSemanticProvider(capturing).collectEvidence(input, {} as any);
  assert.equal(seen.length, 1);
  const seenGemini: string[] = [];
  await new GeminiSemanticProvider({ classify: async (prompt) => { seenGemini.push(prompt); return {}; } }).collectEvidence(input, {} as any);
  assert.equal(seenGemini.length, 1);
  assert.equal(seen[0], seenGemini[0]);
  assert.equal(seen[0], buildSemanticPrompt(input, 'CANDIDATE'));
});

test('malformed model output abstains with zero weight and abstention provenance', async () => {
  const provider = new GroqSemanticProvider(of({ nonsense: true }));
  const [item] = await provider.collectEvidence(input, {} as any);
  assert.equal(item.category, 'SEMANTIC_ABSTENTION');
  assert.equal(item.rawWeight, 0);
  assert.equal(item.finalWeight, 0);
  assert.equal(item.reliability, 'LOWER');
  assert.ok((item.provenance?.semantic?.reasonCodes || []).includes('SEMANTIC_MODEL_ABSTAINED'));
});

test('unsupported-language and low-confidence results abstain like the gemini path', async () => {
  const unsupported = new GroqSemanticProvider(of({ ...unrelatedResult, supportedLanguage: false }));
  const [u] = await unsupported.collectEvidence(input, {} as any);
  assert.equal(u.category, 'SEMANTIC_ABSTENTION');
  assert.ok((u.provenance?.semantic?.reasonCodes || []).includes('SEMANTIC_MODEL_ABSTAINED'));
  const low = new GroqSemanticProvider(of({ ...unrelatedResult, confidence: 10 }));
  const [lowItem] = await low.collectEvidence(input, {} as any);
  assert.equal(lowItem.category, 'SEMANTIC_ABSTENTION');
  const nocite = new GroqSemanticProvider(of({ ...unrelatedResult, citations: [] }));
  const [noCiteItem] = await nocite.collectEvidence(input, {} as any);
  assert.equal(noCiteItem.category, 'SEMANTIC_ABSTENTION');
});

test('candidate model 404 retries once with adjudicator and preserves fallback provenance', async () => {
  let calls = 0;
  const flaky: SemanticModelClient = {
    classify: async (_prompt, model) => {
      calls++;
      if (model === 'gone-model') {
        throw new ProviderCallError('Missing model.', 'PERMANENT_INPUT', false, { status: 404 });
      }
      return unrelatedResult;
    },
  };
  const previousCandidate = process.env.GROQ_CANDIDATE_MODEL;
  const previousAdjudicator = process.env.GROQ_ADJUDICATOR_MODEL;
  process.env.GROQ_CANDIDATE_MODEL = 'gone-model';
  process.env.GROQ_ADJUDICATOR_MODEL = 'other-model';
  try {
    const provider = new GroqSemanticProvider(flaky);
    const [item] = await provider.collectEvidence(input, {} as any);
    assert.equal(calls, 2);
    assert.ok((item.provenance?.semantic?.reasonCodes || []).includes('SEMANTIC_CANDIDATE_MODEL_404_FALLBACK'));
  } finally {
    if (previousCandidate === undefined) delete process.env.GROQ_CANDIDATE_MODEL;
    else process.env.GROQ_CANDIDATE_MODEL = previousCandidate;
    if (previousAdjudicator === undefined) delete process.env.GROQ_ADJUDICATOR_MODEL;
    else process.env.GROQ_ADJUDICATOR_MODEL = previousAdjudicator;
  }
});

test('non-404 permanent failures do not invoke fallback model', async () => {
  let calls = 0;
  const failing: SemanticModelClient = {
    classify: async () => {
      calls++;
      throw new ProviderCallError('Bad request.', 'PERMANENT_INPUT', false, { status: 400 });
    },
  };
  const provider = new GroqSemanticProvider(failing);
  await assert.rejects(provider.collectEvidence(input, {} as any));
  assert.equal(calls, 1);
});

test('configured groq routes are ordered, non-empty, and deduplicated', () => {
  const routes = configuredGroqRoutes({ GROQ_API_KEY: 'k1', GROQ_API_KEY_3: 'k3', GROQ_API_KEY_2: 'k1' } as any);
  assert.deepEqual(routes.map(r => r.id), ['groq-1', 'groq-2']);
  assert.deepEqual(routes.map(r => r.key), ['k1', 'k3']);
  assert.deepEqual(configuredGroqRoutes({} as any), []);
  assert.equal(groqTimeoutMs({} as any), 135000);
  assert.equal(groqTimeoutMs({ GROQ_PROVIDER_TIMEOUT_MS: '5000' } as any), 5000);
});

test('retryable groq route failure advances to the next authorized route', async () => {
  const order: string[] = [];
  const routes = [{ id: 'groq-1', key: 'k1' }, { id: 'groq-2', key: 'k2' }];
  const result = await runGroqRouteFailover(routes, async (route) => {
    order.push(route.id);
    if (route.id === 'groq-1') throw new ProviderCallError('Transient.', 'TRANSIENT', true);
    return 'recovered';
  });
  assert.equal(result, 'recovered');
  assert.deepEqual(order, ['groq-1', 'groq-2']);
});

test('non-retryable groq route failure does not spill into another route', async () => {
  const order: string[] = [];
  const routes = [{ id: 'groq-1', key: 'k1' }, { id: 'groq-2', key: 'k2' }];
  await assert.rejects(runGroqRouteFailover(routes, async (route) => {
    order.push(route.id);
    throw new ProviderCallError('Bad request.', 'PERMANENT_INPUT', false, { status: 400 });
  }));
  assert.deepEqual(order, ['groq-1']);
});

test('rate-limited groq route failure surfaces without cross-route burst', async () => {
  const order: string[] = [];
  const routes = [{ id: 'groq-1', key: 'k1' }, { id: 'groq-2', key: 'k2' }];
  await assert.rejects(runGroqRouteFailover(routes, async (route) => {
    order.push(route.id);
    throw new ProviderCallError('Provider rate limit reached.', 'RATE_LIMIT', true, { status: 429 });
  }));
  assert.deepEqual(order, ['groq-1']);
});

test('routing defaults to gemini and honors selection plus kill switch', () => {
  assert.equal(shouldUseGroqSemantic({} as any), false);
  assert.equal(shouldUseGroqSemantic({ SEMANTIC_PROVIDER: 'groq' } as any), false);
  assert.equal(shouldUseGroqSemantic({ SEMANTIC_PROVIDER: 'groq', GROQ_API_KEY: 'k' } as any), true);
  assert.equal(shouldUseGroqSemantic({ SEMANTIC_PROVIDER: 'groq', GROQ_API_KEY: 'k', SEMANTIC_PROVIDER_FORCE_GEMINI: 'true' } as any), false);
  assert.equal(shouldUseGroqSemantic({ SEMANTIC_PROVIDER: 'gemini', GROQ_API_KEY: 'k' } as any), false);
});

test('groq availability reports missing keys and inapplicable inputs', () => {
  withEnv({ GROQ_API_KEY: undefined }, () => {
    const saved = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      const provider = new GroqSemanticProvider();
      assert.equal(provider.availability(input).availability, 'UNAVAILABLE');
    } finally {
      if (saved !== undefined) process.env.GROQ_API_KEY = saved;
    }
  });
  const provider = new GroqSemanticProvider(of({}));
  assert.equal(
    provider.availability({ ...input, search_match_context: { type: 'CHANNEL' }, enrichment_stage: 0, description: 'short' } as any).availability,
    'NOT_APPLICABLE',
  );
});

test('shared parser keeps taxonomy boundary identical across providers', () => {
  assert.equal(parseSemanticResult({ label: 'HYPE', confidence: 80, supportedLanguage: true }).label, 'HYPE');
  assert.equal(parseSemanticResult({ label: 'NOPE', confidence: 80, supportedLanguage: true }).label, 'AMBIGUOUS');
  assert.equal(DEFAULT_GROQ_CANDIDATE_MODEL, 'openai/gpt-oss-120b');
  assert.equal(DEFAULT_GROQ_ADJUDICATOR_MODEL, 'openai/gpt-oss-120b');
});

test('malformed model content emits exactly one failure event, never a false success', async () => {
  const events: Array<{ status: string }> = [];
  const malformed = new Response(JSON.stringify({ choices: [{ message: { content: 'not-json{{{' } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  globalThis.fetch = (async () => malformed) as unknown as typeof fetch;
  process.env.GROQ_API_KEY = 'test-key';
  try {
    const client = defaultClient(async event => { events.push(event); });
    await assert.rejects(client!.classify('prompt', 'model'), (error: unknown) => error instanceof ProviderCallError);
    assert.equal(events.length, 1);
    assert.notEqual(events[0].status, 'SUCCESS');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
  }
});

test('valid model content emits exactly one success event with the parsed value', async () => {
  const events: Array<{ status: string }> = [];
  const valid = new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  globalThis.fetch = (async () => valid) as unknown as typeof fetch;
  process.env.GROQ_API_KEY = 'test-key';
  try {
    const client = defaultClient(async event => { events.push(event); });
    assert.deepEqual(await client!.classify('prompt', 'model'), { ok: true });
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'SUCCESS');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
  }
});

test('groq-routed classifications populate the semantic audit trail with the serving model', async () => {
  const provider = new GroqSemanticProvider(of(unrelatedResult));
  const [item] = await provider.collectEvidence(input, {} as any);
  assert.equal(item.source, 'groq_semantic');
  const context = getLayeredKnowledgeContext('United States');
  const collection = {
    sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false,
    fieldsPresent: ['description'], reasonCodes: [],
    providers: [{ provider: 'groq_semantic', availability: 'AVAILABLE', evidenceCount: 1, outcome: 'EXECUTED_WITH_EVIDENCE', reasonCodes: ['PROVIDER_EVIDENCE_EMITTED'] }],
    terminalNegativeSufficiency: { status: 'SUFFICIENT', creatorLevelCoverage: true, independentSourceFamilies: 2, independentObservations: 2, reasonCodes: ['CREATOR_LEVEL_NEGATIVE_COVERAGE'] },
  } as any;
  const decision = new ConfigurableWeightedStrategy().evaluateDecision([item], context, 'United States', collection);
  // ai_reviewed expression from tradingRelevanceClassifier must hold for Groq.
  assert.ok(!!decision.geminiSemanticSummary);
  assert.equal(decision.geminiSemanticSummary?.modelUsed, 'openai/gpt-oss-120b');
  assert.equal(decision.geminiSemanticSummary?.isTrading, 'NO');
  assert.match(decision.geminiSemanticSummary?.reason || '', /UNRELATED/);
  assert.equal(decision.status, 'NON_TRADING');
});

test('production routing matrix: unset/gemini stay on Gemini, groq+key selects Groq, kill switch wins immediately', () => {
  const groqKeys = Object.keys(process.env).filter(name => name === 'GROQ_API_KEY' || /^GROQ_API_KEY_[2-9][0-9]*$/.test(name));
  const savedGroq: Record<string, string | undefined> = {};
  for (const name of groqKeys) savedGroq[name] = process.env[name];
  const savedProvider = process.env.SEMANTIC_PROVIDER;
  const savedForce = process.env.SEMANTIC_PROVIDER_FORCE_GEMINI;
  for (const name of groqKeys) delete process.env[name];
  try {
    delete process.env.SEMANTIC_PROVIDER;
    delete process.env.SEMANTIC_PROVIDER_FORCE_GEMINI;
    assert.equal(shouldUseGroqSemantic(), false);
    process.env.SEMANTIC_PROVIDER = 'gemini';
    process.env.GROQ_API_KEY = 'k';
    assert.equal(shouldUseGroqSemantic(), false);
    process.env.SEMANTIC_PROVIDER = 'groq';
    assert.equal(shouldUseGroqSemantic(), true);
    process.env.SEMANTIC_PROVIDER_FORCE_GEMINI = 'true';
    assert.equal(shouldUseGroqSemantic(), false);
  } finally {
    for (const name of groqKeys) {
      if (savedGroq[name] === undefined) delete process.env[name];
      else process.env[name] = savedGroq[name] as string;
    }
    if (savedProvider === undefined) delete process.env.SEMANTIC_PROVIDER;
    else process.env.SEMANTIC_PROVIDER = savedProvider;
    if (savedForce === undefined) delete process.env.SEMANTIC_PROVIDER_FORCE_GEMINI;
    else process.env.SEMANTIC_PROVIDER_FORCE_GEMINI = savedForce;
    if (!groqKeys.includes('GROQ_API_KEY')) delete process.env.GROQ_API_KEY;
  }
});

test('groq abstentions audit as UNCERTAIN, never trading approval', async () => {
  const abstained = new GroqSemanticProvider(of({ ...unrelatedResult, supportedLanguage: false }));
  const [item] = await abstained.collectEvidence(input, {} as any);
  assert.equal(item.category, 'SEMANTIC_ABSTENTION');
  const context = getLayeredKnowledgeContext('United States');
  const collection = {
    sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false,
    fieldsPresent: ['description'], reasonCodes: [],
    providers: [{ provider: 'groq_semantic', availability: 'AVAILABLE', evidenceCount: 0, outcome: 'ABSTAINED_LOW_CONFIDENCE', reasonCodes: ['SEMANTIC_MODEL_ABSTAINED'] }],
    terminalNegativeSufficiency: { status: 'INSUFFICIENT', creatorLevelCoverage: false, independentSourceFamilies: 0, independentObservations: 0, reasonCodes: [] },
  } as any;
  const decision = new ConfigurableWeightedStrategy().evaluateDecision([item], context, 'United States', collection);
  assert.equal(decision.geminiSemanticSummary?.isTrading, 'UNCERTAIN');
});

test('oversized provider responses fail closed with one failure event, never SUCCESS', async () => {
  const events: Array<{ status: string }> = [];
  const envelope = JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] });
  const oversized = new Response(envelope + 'y'.repeat(2_100_000), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  globalThis.fetch = (async () => oversized) as unknown as typeof fetch;
  process.env.GROQ_API_KEY = 'test-key';
  try {
    const client = defaultClient(async event => { events.push(event); });
    await assert.rejects(client!.classify('prompt', 'model'), (error: unknown) => error instanceof ProviderCallError);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'TRANSIENT_ERROR');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
  }
});

test('groq 429 arms the shared cooldown: repeat workers short-circuit without fetching', async () => {
  resetGroqCooldownForTests();
  const events: Array<{ status: string }> = [];
  let fetches = 0;
  const limited = new Response('{"error":{"message":"Rate limit reached"}}', {
    status: 429, headers: { 'content-type': 'application/json' },
  });
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  globalThis.fetch = (async () => { fetches++; return limited.clone(); }) as unknown as typeof fetch;
  process.env.GROQ_API_KEY = 'test-key';
  try {
    const client = defaultClient(async event => { events.push(event); });
    const first = await client!.classify('prompt', 'model').then(() => null, (error: unknown) => error);
    assert.ok(first instanceof ProviderCallError && first.errorClass === 'RATE_LIMIT');
    assert.ok((first as { providerReasons?: string[] }).providerReasons?.includes('GROQ_RATE_LIMITED'));
    assert.equal(fetches, 1);
    assert.ok(groqCooldownRemainingMs() > 0);
    // Repeated worker ticks during the window: no new fetches, one deferred failure each.
    const repeats = await Promise.all([0, 1, 2, 3, 4].map(() => client!.classify('prompt', 'model').then(() => null, (error: unknown) => error)));
    assert.equal(fetches, 1);
    assert.ok(repeats.every(error => error instanceof ProviderCallError && error.errorClass === 'RATE_LIMIT'));
    assert.ok(repeats.every(error => Number((error as { retryAfterMs?: unknown }).retryAfterMs) > 0));
    assert.equal(events.length, 6);
    assert.ok(events.every(event => event.status !== 'SUCCESS'));
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
    resetGroqCooldownForTests();
  }
});

test('groq cooldown recovery: requests resume after expiry', async () => {
  resetGroqCooldownForTests();
  const events: Array<{ status: string }> = [];
  let fetches = 0;
  let limited = true;
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  const savedCooldown = process.env.GROQ_RATE_LIMIT_COOLDOWN_MS;
  globalThis.fetch = (async () => {
    fetches++;
    if (limited) return new Response('{"error":{"message":"Rate limit reached"}}', { status: 429, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  process.env.GROQ_API_KEY = 'test-key';
  process.env.GROQ_RATE_LIMIT_COOLDOWN_MS = '50';
  try {
    const client = defaultClient(async event => { events.push(event); });
    await assert.rejects(client!.classify('prompt', 'model'));
    assert.equal(fetches, 1);
    limited = false;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(await client!.classify('prompt', 'model'), { ok: true });
    assert.equal(fetches, 2);
    assert.equal(events.at(-1)?.status, 'SUCCESS');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
    if (savedCooldown === undefined) delete process.env.GROQ_RATE_LIMIT_COOLDOWN_MS;
    else process.env.GROQ_RATE_LIMIT_COOLDOWN_MS = savedCooldown;
    resetGroqCooldownForTests();
  }
});

test('disabled deadlines never abort groq calls', async () => {
  resetGroqCooldownForTests();
  const valid = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  const savedDeadlines = process.env.PROVIDER_DEADLINES_ENABLED;
  const savedTimeout = process.env.GROQ_PROVIDER_TIMEOUT_MS;
  globalThis.fetch = (async () => { await new Promise(resolve => setTimeout(resolve, 60)); return valid(); }) as unknown as typeof fetch;
  process.env.GROQ_API_KEY = 'test-key';
  process.env.PROVIDER_DEADLINES_ENABLED = 'false';
  process.env.GROQ_PROVIDER_TIMEOUT_MS = '20';
  try {
    const client = defaultClient(async () => undefined);
    assert.deepEqual(await client!.classify('prompt', 'model'), { ok: true });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
    if (savedDeadlines === undefined) delete process.env.PROVIDER_DEADLINES_ENABLED;
    else process.env.PROVIDER_DEADLINES_ENABLED = savedDeadlines;
    if (savedTimeout === undefined) delete process.env.GROQ_PROVIDER_TIMEOUT_MS;
    else process.env.GROQ_PROVIDER_TIMEOUT_MS = savedTimeout;
    resetGroqCooldownForTests();
  }
});

test('enabled deadlines preserve timeout classification and cleanup', async () => {
  resetGroqCooldownForTests();
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  const savedDeadlines = process.env.PROVIDER_DEADLINES_ENABLED;
  const savedTimeout = process.env.GROQ_PROVIDER_TIMEOUT_MS;
  globalThis.fetch = ((url: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  })) as unknown as typeof fetch;
  process.env.GROQ_API_KEY = 'test-key';
  process.env.PROVIDER_DEADLINES_ENABLED = 'true';
  process.env.GROQ_PROVIDER_TIMEOUT_MS = '20';
  try {
    const client = defaultClient(async () => undefined);
    await assert.rejects(
      client!.classify('prompt', 'model'),
      (error: unknown) => error instanceof ProviderCallError && error.errorClass === 'TIMEOUT' && error.retryable,
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
    if (savedDeadlines === undefined) delete process.env.PROVIDER_DEADLINES_ENABLED;
    else process.env.PROVIDER_DEADLINES_ENABLED = savedDeadlines;
    if (savedTimeout === undefined) delete process.env.GROQ_PROVIDER_TIMEOUT_MS;
    else process.env.GROQ_PROVIDER_TIMEOUT_MS = savedTimeout;
    resetGroqCooldownForTests();
  }
});

test('groq rate-limit failures schedule retries past the shared cooldown expiry', async () => {
  const { decideJobFailure } = await import('../../dbCore');
  const now = 1_000_000_000;
  const expiry = now + 90_000;
  const groqRateLimit = (): unknown => ({
    message: 'Groq HTTP 429', retryable: true, errorClass: 'RATE_LIMIT', status: 429, providerReasons: ['GROQ_RATE_LIMITED'],
  });
  const first = decideJobFailure(groqRateLimit(), 1, 4, now, now, undefined, expiry);
  assert.equal(first.disposition, 'RETRYING_WITHOUT_ATTEMPT');
  assert.ok(first.runAfter! >= expiry);
  const concurrent = [1, 2, 3].map(attempt => decideJobFailure(groqRateLimit(), attempt, 4, now, now, undefined, expiry));
  assert.ok(concurrent.every(result => result.disposition === 'RETRYING_WITHOUT_ATTEMPT' && result.runAfter! >= expiry));
  const noExpiry = decideJobFailure(groqRateLimit(), 1, 4, now, now, undefined, undefined);
  assert.equal(noExpiry.runAfter, now + 30_000);
  const unmarked = decideJobFailure({ message: 'x', retryable: true, errorClass: 'TRANSIENT' }, 1, 4, now, now, undefined, expiry);
  assert.equal(unmarked.runAfter, now + 30_000);
});
