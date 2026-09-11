import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GROQ_ADJUDICATOR_MODEL,
  DEFAULT_GROQ_CANDIDATE_MODEL,
  GroqSemanticProvider,
  buildCitationRepairPrompt,
  configuredGroqRoutes,
  defaultClient,
  groqCooldownRemainingMs,
  groqOrgCooldownRemainingMs,
  groqOrgIdForSlot,
  groqRouteOrg,
  groqTimeoutMs,
  isDecisiveButUncited,
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
  assert.equal(item.provenance?.semantic?.repairPromptVersion, undefined);
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
    const client = defaultClient(async event => { events.push(event); }, { persistedCooldownExpiryMs: async () => undefined });
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
    const client = defaultClient(async event => { events.push(event); }, { persistedCooldownExpiryMs: async () => undefined });
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
    const client = defaultClient(async event => { events.push(event); }, { persistedCooldownExpiryMs: async () => undefined });
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
    const client = defaultClient(async event => { events.push(event); }, { persistedCooldownExpiryMs: async () => undefined });
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
    const client = defaultClient(async event => { events.push(event); }, { persistedCooldownExpiryMs: async () => undefined });
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
    const client = defaultClient(async () => undefined, { persistedCooldownExpiryMs: async () => undefined });
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
    const client = defaultClient(async () => undefined, { persistedCooldownExpiryMs: async () => undefined });
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

test('cross-replica cooldown: a 429 persisted by one worker defers a fresh replica with zero fetches', async () => {
  resetGroqCooldownForTests();
  // Shared fake persisted ledger standing in for provider_call_events.
  let ledgerExpiryMs: number | undefined;
  const ledger = { persistedCooldownExpiryMs: async () => ledgerExpiryMs };
  let fetchesA = 0;
  let fetchesB = 0;
  const limited = () => new Response('{"error":{"message":"Rate limit reached"}}', {
    status: 429, headers: { 'content-type': 'application/json' },
  });
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key';
  try {
    // Replica A hits the limit; its telemetry persist updates the ledger.
    globalThis.fetch = (async () => { fetchesA++; return limited(); }) as unknown as typeof fetch;
    const eventsA: Array<{ status: string; requestMetadata?: Record<string, string | null> }> = [];
    const clientA = defaultClient(async event => {
      eventsA.push(event);
      if (event.status === 'RATE_LIMITED') ledgerExpiryMs = Date.now() + 60_000;
    }, ledger);
    const first = await clientA!.classify('prompt', 'model').then(() => null, (error: unknown) => error);
    assert.ok(first instanceof ProviderCallError && first.errorClass === 'RATE_LIMIT');
    assert.ok(((first as { providerReasons?: string[] }).providerReasons || []).includes('GROQ_RATE_LIMITED'));
    assert.equal(fetchesA, 1);
    assert.ok(ledgerExpiryMs !== undefined && ledgerExpiryMs > Date.now());
    // Genuine provider 429s carry no deferral tag, so the ledger keeps them.
    assert.equal(eventsA.length, 1);
    assert.equal(eventsA[0].requestMetadata?.groqCooldownDeferral, undefined);
    // Replica B never saw the 429 (cold in-process flag) but reads the ledger.
    resetGroqCooldownForTests();
    assert.equal(groqCooldownRemainingMs(), 0);
    globalThis.fetch = (async () => { fetchesB++; return limited(); }) as unknown as typeof fetch;
    const eventsB: Array<{ status: string; requestMetadata?: Record<string, string | null> }> = [];
    const clientB = defaultClient(async event => { eventsB.push(event); }, ledger);
    const second = await clientB!.classify('prompt', 'model').then(() => null, (error: unknown) => error);
    assert.equal(fetchesB, 0);
    assert.ok(second instanceof ProviderCallError && second.errorClass === 'RATE_LIMIT');
    assert.ok(((second as { providerReasons?: string[] }).providerReasons || []).includes('GROQ_RATE_LIMITED'));
    assert.ok(Number((second as { retryAfterMs?: unknown }).retryAfterMs) > 0);
    assert.equal(eventsB.length, 1);
    assert.equal(eventsB[0].status, 'RATE_LIMITED');
    // Deferral echoes are tagged so the persisted window never restarts.
    assert.equal(eventsB[0].requestMetadata?.groqCooldownDeferral, 'true');
    // The persisted hit also arms B's fast in-process flag for followers.
    assert.ok(groqCooldownRemainingMs() > 0);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
    resetGroqCooldownForTests();
  }
});

test('persisted cooldown outage fails open to a live fetch', async () => {
  resetGroqCooldownForTests();
  let fetches = 0;
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  process.env.GROQ_API_KEY = 'test-key';
  try {
    const client = defaultClient(async () => undefined, {
      persistedCooldownExpiryMs: async () => { throw new Error('ledger down'); },
    });
    assert.deepEqual(await client!.classify('prompt', 'model'), { ok: true });
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
    resetGroqCooldownForTests();
  }
});

test('expired persisted window resumes fetching', async () => {
  resetGroqCooldownForTests();
  let fetches = 0;
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  process.env.GROQ_API_KEY = 'test-key';
  try {
    const client = defaultClient(async () => undefined, {
      persistedCooldownExpiryMs: async () => Date.now() - 1_000,
    });
    assert.deepEqual(await client!.classify('prompt', 'model'), { ok: true });
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
    resetGroqCooldownForTests();
  }
});

test('repeated deferrals never restart the persisted cooldown window', async () => {
  // Emulates the ledger contract: the authoritative expiry derives from the
  // latest untagged RATE_LIMITED row, so tagged deferral echoes cannot move it.
  const { resolveGroqSemanticCooldownExpiryMs } = await import('../../dbCore');
  const fnStr = resolveGroqSemanticCooldownExpiryMs.toString();
  assert.ok(fnStr.includes('groqCooldownDeferral'), 'resolver must exclude deferral-tagged rows');
  assert.ok(fnStr.includes("provider='groq'") || fnStr.includes('provider=\'groq\''), 'resolver stays groq-scoped');
});

test('isDecisiveButUncited admits only confident supported labels missing citations', () => {
  const base = { ...unrelatedResult, confidence: 96, supportedLanguage: true };
  assert.equal(isDecisiveButUncited({ ...base, citations: [] } as any), true);
  assert.equal(isDecisiveButUncited({ ...base, citations: [{ field: 'channel_bio' }] } as any), false);
  assert.equal(isDecisiveButUncited({ ...base, label: 'AMBIGUOUS', citations: [] } as any), false);
  assert.equal(isDecisiveButUncited({ ...base, confidence: 10, citations: [] } as any), false);
  assert.equal(isDecisiveButUncited({ ...base, supportedLanguage: false, citations: [] } as any), false);
});

test('repair prompt preserves the original decision and reuses the candidate prompt', () => {
  const refs = [{ field: 'channel_bio' }, { field: 'video_title', index: 0 }];
  const prompt = buildCitationRepairPrompt('{"task":"CANDIDATE"}', { label: 'UNRELATED', confidence: 96, supportedLanguage: true } as any, refs as never);
  assert.match(prompt, /UNRELATED/);
  assert.match(prompt, /citations/);
  assert.ok(prompt.includes('{"task":"CANDIDATE"}'));
});

test('V3 repair prompt enumerates the supplied refs with the honesty clause', () => {
  const refs = [{ field: 'channel_bio' }, { field: 'video_title', index: 0 }];
  const prompt = buildCitationRepairPrompt('{"task":"CANDIDATE"}', { label: 'UNRELATED', confidence: 96, supportedLanguage: true } as any, refs as never);
  assert.ok(prompt.includes('You may only cite from this exact list: [{"field":"channel_bio"}, {"field":"video_title","index":0}]'));
  assert.match(prompt, /never invent a reference/);
});

test('citation repair recovers a decisive-but-uncited result without changing its label', async () => {
  const uncited = { ...unrelatedResult, confidence: 96, citations: [] };
  const cited = { ...unrelatedResult, confidence: 96 };
  const seen: string[] = [];
  const repairing: SemanticModelClient = { classify: async prompt => { seen.push(prompt); return seen.length === 1 ? uncited : cited; } };
  const [item] = await new GroqSemanticProvider(repairing).collectEvidence(input, {} as any);
  assert.equal(seen.length, 2);
  assert.match(seen[1], /citations/);
  assert.match(seen[1], /You may only cite from this exact list/);
  assert.match(seen[1], /never invent a reference/);
  assert.ok(seen[1].includes('{"field":"channel_bio"}'));
  assert.equal(item.category, 'IRRELEVANT_DOMAIN');
  assert.equal(item.polarity, 'NEGATIVE');
  assert.ok((item.provenance?.semantic?.reasonCodes || []).includes('SEMANTIC_CITATION_REPAIR'));
  assert.ok(!(item.provenance?.semantic?.reasonCodes || []).includes('SEMANTIC_MODEL_ABSTAINED'));
});

test('failed repair still abstains with the no-citations tag', async () => {
  const uncited = { ...unrelatedResult, confidence: 96, citations: [] };
  let calls = 0;
  const stubborn: SemanticModelClient = { classify: async () => { calls++; return uncited; } };
  const [item] = await new GroqSemanticProvider(stubborn).collectEvidence(input, {} as any);
  assert.equal(calls, 2);
  assert.equal(item.category, 'SEMANTIC_ABSTENTION');
  assert.ok((item.provenance?.semantic?.reasonCodes || []).includes('SEMANTIC_ABSTAIN_NO_CITATIONS'));
  const throwing: SemanticModelClient = {
    classify: async prompt => {
      calls++;
      if (String(prompt).includes('missing required field citations')) throw new Error('repair outage');
      return uncited;
    },
  };
  calls = 0;
  const [fallback] = await new GroqSemanticProvider(throwing).collectEvidence(input, {} as any);
  assert.equal(fallback.category, 'SEMANTIC_ABSTENTION');
  assert.ok((fallback.provenance?.semantic?.reasonCodes || []).includes('SEMANTIC_ABSTAIN_NO_CITATIONS'));
});

test('repair never fires for cited, ambiguous, low-confidence, or unsupported results', async () => {
  const shapes = [
    { ...unrelatedResult, confidence: 96 },
    { ...unrelatedResult, confidence: 96, label: 'AMBIGUOUS', citations: [] },
    { ...unrelatedResult, confidence: 10, citations: [] },
    { ...unrelatedResult, confidence: 96, supportedLanguage: false, citations: [] },
  ];
  for (const shape of shapes) {
    let calls = 0;
    const counting: SemanticModelClient = { classify: async () => { calls++; return shape; } };
    await new GroqSemanticProvider(counting).collectEvidence(input, {} as any);
    assert.equal(calls, 1);
  }
});

test('repaired n-cooking shape resolves the recorded disagreement end to end', async () => {
  const uncited = { ...unrelatedResult, confidence: 96, citations: [] };
  const cited = { ...unrelatedResult, confidence: 96 };
  const repairing: SemanticModelClient = { classify: async prompt => (String(prompt).includes('missing required field citations') ? cited : uncited) };
  const [item] = await new GroqSemanticProvider(repairing).collectEvidence(input, {} as any);
  assert.equal(item.category, 'IRRELEVANT_DOMAIN');
  const context = getLayeredKnowledgeContext('United States');
  const collection = {
    sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false,
    fieldsPresent: ['description'], reasonCodes: [],
    providers: [{ provider: 'groq_semantic', availability: 'AVAILABLE', evidenceCount: 1, outcome: 'EXECUTED_WITH_EVIDENCE', reasonCodes: ['PROVIDER_EVIDENCE_EMITTED'] }],
    terminalNegativeSufficiency: { status: 'SUFFICIENT', creatorLevelCoverage: true, independentSourceFamilies: 2, independentObservations: 2, reasonCodes: ['CREATOR_LEVEL_NEGATIVE_COVERAGE'] },
  } as any;
  const decision = new ConfigurableWeightedStrategy().evaluateDecision([item], context, 'United States', collection);
  assert.equal(decision.status, 'NON_TRADING');
  assert.ok(decision.decisionPolicy?.reasonCodes.includes('HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED'));
});

test('repair preserves the original decision when the model tries to change it', async () => {
  const uncited = { ...unrelatedResult, confidence: 96, citations: [] };
  const seen: string[] = [];
  const rewriting: SemanticModelClient = {
    classify: async prompt => {
      seen.push(prompt);
      if (seen.length === 1) return uncited;
      return { label: 'HYPE', confidence: 99, supportedLanguage: false, reasonCodes: ['REWRITE'], explanation: 'changed', concepts: ['hype'], languages: [], citations: [{ field: 'channel_bio' }] };
    },
  };
  const [item] = await new GroqSemanticProvider(rewriting).collectEvidence(input, {} as any);
  assert.equal(seen.length, 2);
  assert.equal(item.category, 'IRRELEVANT_DOMAIN');
  assert.equal(item.polarity, 'NEGATIVE');
  assert.equal(item.provenance?.semantic?.taxonomyLabel, 'UNRELATED');
  assert.equal(item.provenance?.semantic?.rawConfidence, 96);
  assert.ok((item.provenance?.semantic?.reasonCodes || []).includes('SEMANTIC_CITATION_REPAIR'));
  assert.equal(item.provenance?.semantic?.repairPromptVersion, 'citation-repair-2');
});

test('hallucinated citations never become evidence', async () => {
  const uncited = { ...unrelatedResult, confidence: 96, citations: [] };
  const hallucinations = [
    { field: 'playlist_name', index: 0 },
    { field: 'video_title', index: 99 },
    { field: 'channel_bio', sourceId: 'someone-elses-doc' },
  ];
  for (const citation of hallucinations) {
    let calls = 0;
    const hallucinating: SemanticModelClient = {
      classify: async prompt => {
        calls++;
        return String(prompt).includes('missing required field citations')
          ? { ...unrelatedResult, confidence: 96, citations: [citation] }
          : uncited;
      },
    };
    const [item] = await new GroqSemanticProvider(hallucinating).collectEvidence(input, {} as any);
    assert.equal(calls, 2);
    assert.equal(item.category, 'SEMANTIC_ABSTENTION', `citation ${JSON.stringify(citation)} must not score`);
    assert.ok((item.provenance?.semantic?.reasonCodes || []).includes('SEMANTIC_ABSTAIN_NO_CITATIONS'));
  }
});

test('retainSuppliedCitations keeps exact references only', async () => {
  const { retainSuppliedCitations } = await import('./GroqSemanticProvider');
  const refs = [{ field: 'channel_bio' }, { field: 'video_title', index: 0 }];
  assert.deepEqual(
    retainSuppliedCitations(
      [{ field: 'channel_bio' }, { field: 'video_title', index: 0 }, { field: 'video_title', index: 3 }] as never,
      refs as never,
    ),
    [{ field: 'channel_bio' }, { field: 'video_title', index: 0 }],
  );
});

test('adjudication replacing a repaired result drops the repair code', async () => {
  const saved = { ...process.env };
  process.env.MULTILINGUAL_ADJUDICATION_ENABLED = 'true';
  process.env.GROQ_CANDIDATE_MODEL = 'candidate-model';
  process.env.GROQ_ADJUDICATOR_MODEL = 'adjudicator-model';
  try {
    const uncited = { ...unrelatedResult, confidence: 65, citations: [] };
    const repaired = { ...unrelatedResult, confidence: 65, citations: [{ field: 'channel_bio' }] };
    const adjudicated = { ...unrelatedResult, label: 'AMBIGUOUS', confidence: 40, citations: [{ field: 'channel_bio' }] };
    let calls = 0;
    const routing: SemanticModelClient = {
      classify: async (prompt, model) => {
        calls++;
        assert.equal(model, calls === 3 ? 'adjudicator-model' : 'candidate-model');
        if (String(prompt).includes('missing required field citations')) return repaired;
        if (String(prompt).includes('"task":"ADJUDICATION"')) return adjudicated;
        return uncited;
      },
    };
    const [item] = await new GroqSemanticProvider(routing).collectEvidence(input, {} as any);
    assert.equal(calls, 3);
    assert.equal(item.category, 'SEMANTIC_ABSTENTION');
    assert.ok(!(item.provenance?.semantic?.reasonCodes || []).includes('SEMANTIC_CITATION_REPAIR'));
  } finally {
    if (saved.MULTILINGUAL_ADJUDICATION_ENABLED === undefined) delete process.env.MULTILINGUAL_ADJUDICATION_ENABLED;
    else process.env.MULTILINGUAL_ADJUDICATION_ENABLED = saved.MULTILINGUAL_ADJUDICATION_ENABLED;
    if (saved.GROQ_CANDIDATE_MODEL === undefined) delete process.env.GROQ_CANDIDATE_MODEL;
    else process.env.GROQ_CANDIDATE_MODEL = saved.GROQ_CANDIDATE_MODEL;
    if (saved.GROQ_ADJUDICATOR_MODEL === undefined) delete process.env.GROQ_ADJUDICATOR_MODEL;
    else process.env.GROQ_ADJUDICATOR_MODEL = saved.GROQ_ADJUDICATOR_MODEL;
  }
});

test('groq org labels default to slot-unique orgs; explicit labels honored', () => {
  assert.equal(groqOrgIdForSlot({} as any, 1), 'slot-1');
  assert.equal(groqOrgIdForSlot({} as any, 3), 'slot-3');
  assert.equal(groqOrgIdForSlot({ GROQ_ORG_ID: 'acme' } as any, 1), 'acme');
  assert.equal(groqOrgIdForSlot({ GROQ_ORG_ID_2: 'acme' } as any, 2), 'acme');
  assert.equal(groqOrgIdForSlot({ GROQ_ORG_ID_2: '  ' } as any, 2), 'slot-2');
  const routes = configuredGroqRoutes({ GROQ_API_KEY: 'k1', GROQ_API_KEY_2: 'k2', GROQ_API_KEY_3: 'k1' } as any);
  assert.deepEqual(routes.map(r => r.orgId), ['slot-1', 'slot-2']);
  const shared = configuredGroqRoutes({ GROQ_API_KEY: 'k1', GROQ_API_KEY_2: 'k2', GROQ_ORG_ID: 'acme', GROQ_ORG_ID_2: 'acme' } as any);
  assert.deepEqual(shared.map(r => r.orgId), ['acme', 'acme']);
  assert.equal(groqRouteOrg({}), 'shared');
  assert.equal(groqRouteOrg({ orgId: 'acme' }), 'acme');
});

test('429 on one groq org fails over to the next healthy org', async () => {
  const order: string[] = [];
  const result = await runGroqRouteFailover(
    [
      { id: 'groq-1', key: 'k1', orgId: 'org-a' },
      { id: 'groq-2', key: 'k2', orgId: 'org-b' },
    ],
    async route => {
      order.push(route.id);
      if (route.id === 'groq-1') throw new ProviderCallError('Rate limit reached.', 'RATE_LIMIT', true, { status: 429 });
      return { route: route.id };
    },
  );
  assert.deepEqual(order, ['groq-1', 'groq-2']);
  assert.deepEqual(result, { route: 'groq-2' });
});

test('exhausted groq orgs progress until a healthy org serves', async () => {
  const order: string[] = [];
  const result = await runGroqRouteFailover(
    [
      { id: 'groq-1', key: 'k1', orgId: 'org-a' },
      { id: 'groq-2', key: 'k2', orgId: 'org-b' },
      { id: 'groq-3', key: 'k3', orgId: 'org-c' },
    ],
    async route => {
      order.push(route.id);
      if (route.id !== 'groq-3') throw new ProviderCallError('Rate limit reached.', 'RATE_LIMIT', true, { status: 429 });
      return { route: route.id };
    },
  );
  assert.deepEqual(order, ['groq-1', 'groq-2', 'groq-3']);
  assert.deepEqual(result, { route: 'groq-3' });
});

test('all groq orgs exhausted surfaces the last 429 after one attempt each', async () => {
  const order: string[] = [];
  const thrown = new ProviderCallError('Rate limit reached.', 'RATE_LIMIT', true, { status: 429 });
  const caught = await runGroqRouteFailover(
    [
      { id: 'groq-1', key: 'k1', orgId: 'org-a' },
      { id: 'groq-2', key: 'k2', orgId: 'org-b' },
    ],
    async route => {
      order.push(route.id);
      throw thrown;
    },
  ).then(() => null, (error: unknown) => error);
  assert.equal(caught, thrown);
  assert.deepEqual(order, ['groq-1', 'groq-2']);
});

test('same-org groq 429 never spills into the shared pool', async () => {
  const order: string[] = [];
  const thrown = new ProviderCallError('Rate limit reached.', 'RATE_LIMIT', true, { status: 429 });
  const caught = await runGroqRouteFailover(
    [
      { id: 'groq-1', key: 'k1', orgId: 'acme' },
      { id: 'groq-2', key: 'k2', orgId: 'acme' },
    ],
    async route => {
      order.push(route.id);
      throw thrown;
    },
  ).then(() => null, (error: unknown) => error);
  assert.equal(caught, thrown);
  assert.deepEqual(order, ['groq-1']);
});

test('groq 429 on org 1 arms only org 1: org 2 serves without fetching twice', async () => {
  resetGroqCooldownForTests();
  const savedFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  for (const name of ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_ORG_ID', 'GROQ_ORG_ID_2']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  let fetches = 0;
  globalThis.fetch = (async (_url: unknown, init: any) => {
    fetches++;
    const key = String(init?.headers?.Authorization || '');
    if (key.includes('key-one')) {
      return new Response('{"error":{"message":"Rate limit reached"}}', { status: 429, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  process.env.GROQ_API_KEY = 'key-one';
  process.env.GROQ_API_KEY_2 = 'key-two';
  try {
    const client = defaultClient(async () => undefined, { persistedCooldownExpiryMs: async () => undefined });
    assert.deepEqual(await client!.classify('prompt', 'model'), { ok: true });
    assert.equal(fetches, 2);
    assert.ok(groqOrgCooldownRemainingMs('slot-1') > 0, 'org 1 must be cooling');
    assert.equal(groqOrgCooldownRemainingMs('slot-2'), 0, 'org 2 must stay clear');
    assert.ok(groqCooldownRemainingMs() > 0, 'pool aggregate still observes pressure');
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name] as string;
    }
    resetGroqCooldownForTests();
  }
});

test('shared-org groq 429 cools the whole account, independent orgs unaffected', async () => {
  resetGroqCooldownForTests();
  const savedFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  for (const name of ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_ORG_ID', 'GROQ_ORG_ID_2']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  globalThis.fetch = (async () => {
    return new Response('{"error":{"message":"Rate limit reached"}}', { status: 429, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  process.env.GROQ_API_KEY = 'shared-key-one';
  process.env.GROQ_API_KEY_2 = 'shared-key-two';
  process.env.GROQ_ORG_ID = 'acme';
  process.env.GROQ_ORG_ID_2 = 'acme';
  try {
    const client = defaultClient(async () => undefined, { persistedCooldownExpiryMs: async () => undefined });
    await assert.rejects(client!.classify('prompt', 'model'));
    assert.ok(groqOrgCooldownRemainingMs('acme') > 0, 'shared account must be cooling');
    assert.equal(groqOrgCooldownRemainingMs('slot-9'), 0, 'unrelated orgs must stay clear');
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name] as string;
    }
    resetGroqCooldownForTests();
  }
});

test('A1 → A2 → B never retries the exhausted same-org sibling', async () => {
  const order: string[] = [];
  const result = await runGroqRouteFailover(
    [
      { id: 'groq-1', key: 'k1', orgId: 'org-a' },
      { id: 'groq-2', key: 'k2', orgId: 'org-a' },
      { id: 'groq-3', key: 'k3', orgId: 'org-b' },
    ],
    async route => {
      order.push(route.id);
      if (route.id !== 'groq-3') throw new ProviderCallError('Rate limit reached.', 'RATE_LIMIT', true, { status: 429 });
      return { route: route.id };
    },
  );
  assert.deepEqual(order, ['groq-1', 'groq-3']);
  assert.deepEqual(result, { route: 'groq-3' });
});

test('groq defaults adjudicate low-confidence results with two same-model calls', async () => {
  const saved: Record<string, string | undefined> = {};
  for (const name of ['GROQ_CANDIDATE_MODEL', 'GROQ_ADJUDICATOR_MODEL', 'MULTILINGUAL_ADJUDICATION_ENABLED']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.MULTILINGUAL_ADJUDICATION_ENABLED = 'true';
  try {
    const calls: Array<{ prompt: string; model: string }> = [];
    const low = { ...unrelatedResult, confidence: 10 };
    const provider = new GroqSemanticProvider({ classify: async (prompt: string, model: string) => { calls.push({ prompt, model }); return low; } });
    await provider.collectEvidence(input, {} as any);
    assert.equal(calls.length, 2, 'candidate + adjudication passes must both run on identical defaults');
    assert.ok(calls[0].prompt.includes('"task":"CANDIDATE"'));
    assert.ok(calls[1].prompt.includes('"task":"ADJUDICATION"'));
    assert.deepEqual(calls.map(call => call.model), [DEFAULT_GROQ_CANDIDATE_MODEL, DEFAULT_GROQ_ADJUDICATOR_MODEL]);
    assert.equal(DEFAULT_GROQ_CANDIDATE_MODEL, DEFAULT_GROQ_ADJUDICATOR_MODEL);
  } finally {
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name] as string;
    }
  }
});
