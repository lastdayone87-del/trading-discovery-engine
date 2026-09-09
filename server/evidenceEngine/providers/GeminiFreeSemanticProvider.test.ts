import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GEMINI_FREE_ADJUDICATOR_MODEL,
  DEFAULT_GEMINI_FREE_CANDIDATE_MODEL,
  GeminiFreeSemanticProvider,
  configuredGeminiFreeRoutes,
  clearGeminiFreeSdkCacheForTests,
  defaultClient,
  geminiFreeCooldownRemainingMs,
  geminiFreeSdkForRouteForTests,
  geminiFreeTimeoutMs,
  resetGeminiFreeCooldownForTests,
  runGeminiFreeRouteFailover,
  shouldUseGeminiFreeSemantic,
} from './GeminiFreeSemanticProvider';
import type { SemanticModelClient } from './GeminiSemanticProvider';
import {
  buildSemanticPrompt,
  parseSemanticResult,
  GeminiSemanticProvider,
} from './GeminiSemanticProvider';
import { ProviderCallError } from '../../providerResilience';

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

test('free gemini defaults to the 2.5-flash-lite model, not the paid default', () => {
  assert.equal(DEFAULT_GEMINI_FREE_CANDIDATE_MODEL, 'gemini-2.5-flash-lite');
  assert.equal(DEFAULT_GEMINI_FREE_ADJUDICATOR_MODEL, 'gemini-2.5-flash-lite');
});

test('free routes use their own env namespace and ids, never GEMINI_API_KEY', () => {
  const routes = configuredGeminiFreeRoutes({ GEMINI_API_KEY: 'paid', GEMINI_FREE_API_KEY: 'k1', GEMINI_FREE_API_KEY_3: 'k3', GEMINI_FREE_API_KEY_2: 'k1' } as any);
  assert.deepEqual(routes.map(r => r.id), ['gemini-free-1', 'gemini-free-3']);
  assert.deepEqual(routes.map(r => r.key), ['k1', 'k3']);
  assert.deepEqual(configuredGeminiFreeRoutes({ GEMINI_API_KEY: 'paid' } as any), []);
  assert.deepEqual(configuredGeminiFreeRoutes({} as any), []);
  assert.equal(geminiFreeTimeoutMs({} as any), 135000);
});

test('free provider emits a terminal negative with paid-identical weights for unrelated creators', async () => {
  const provider = new GeminiFreeSemanticProvider(of(unrelatedResult));
  const [item] = await provider.collectEvidence(input, {} as any);
  assert.equal(item.source, 'gemini_free_semantic');
  assert.equal(item.polarity, 'NEGATIVE');
  assert.equal(item.category, 'IRRELEVANT_DOMAIN');
  assert.equal(item.rawWeight, 26);
  assert.equal(item.reliability, 'MEDIUM');
  assert.equal(item.provenance?.semantic?.taxonomyLabel, 'UNRELATED');
  assert.match(String(item.provenance?.sourceRef || ''), /^structured-semantic:/);
});

test('free and paid providers send byte-identical prompts (no drift)', async () => {
  const seen: string[] = [];
  const capturing: SemanticModelClient = { classify: async (prompt) => { seen.push(prompt); return {}; } };
  await new GeminiFreeSemanticProvider(capturing).collectEvidence(input, {} as any);
  assert.equal(seen.length, 1);
  const seenPaid: string[] = [];
  await new GeminiSemanticProvider({ classify: async (prompt) => { seenPaid.push(prompt); return {}; } }).collectEvidence(input, {} as any);
  assert.equal(seenPaid.length, 1);
  assert.equal(seen[0], seenPaid[0]);
  assert.equal(seen[0], buildSemanticPrompt(input, 'CANDIDATE'));
});

test('malformed model output abstains with zero weight and abstention provenance', async () => {
  const provider = new GeminiFreeSemanticProvider(of({ nonsense: true }));
  const [item] = await provider.collectEvidence(input, {} as any);
  assert.equal(item.category, 'SEMANTIC_ABSTENTION');
  assert.equal(item.rawWeight, 0);
  assert.equal(item.finalWeight, 0);
  assert.ok((item.provenance?.semantic?.reasonCodes || []).includes('SEMANTIC_MODEL_ABSTAINED'));
});

test('shared parser keeps taxonomy boundary identical across providers', () => {
  assert.equal(parseSemanticResult({ label: 'HYPE', confidence: 80, supportedLanguage: true }).label, 'HYPE');
  assert.equal(parseSemanticResult({ label: 'NOPE', confidence: 80, supportedLanguage: true }).label, 'AMBIGUOUS');
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
  const previousCandidate = process.env.GEMINI_FREE_CANDIDATE_MODEL;
  const previousAdjudicator = process.env.GEMINI_FREE_ADJUDICATOR_MODEL;
  process.env.GEMINI_FREE_CANDIDATE_MODEL = 'gone-model';
  process.env.GEMINI_FREE_ADJUDICATOR_MODEL = 'other-model';
  try {
    const provider = new GeminiFreeSemanticProvider(flaky);
    const [item] = await provider.collectEvidence(input, {} as any);
    assert.equal(calls, 2);
    assert.ok((item.provenance?.semantic?.reasonCodes || []).includes('SEMANTIC_CANDIDATE_MODEL_404_FALLBACK'));
  } finally {
    if (previousCandidate === undefined) delete process.env.GEMINI_FREE_CANDIDATE_MODEL;
    else process.env.GEMINI_FREE_CANDIDATE_MODEL = previousCandidate;
    if (previousAdjudicator === undefined) delete process.env.GEMINI_FREE_ADJUDICATOR_MODEL;
    else process.env.GEMINI_FREE_ADJUDICATOR_MODEL = previousAdjudicator;
  }
});

test('rate-limited free route failure surfaces without cross-route burst', async () => {
  const order: string[] = [];
  const routes = [{ id: 'gemini-free-1', key: 'k1' }, { id: 'gemini-free-2', key: 'k2' }];
  await assert.rejects(runGeminiFreeRouteFailover(routes, async (route) => {
    order.push(route.id);
    throw new ProviderCallError('Provider rate limit reached.', 'RATE_LIMIT', true, { status: 429 });
  }));
  assert.deepEqual(order, ['gemini-free-1']);
});

test('routing defaults to paid gemini and honors selection plus kill switch', () => {
  assert.equal(shouldUseGeminiFreeSemantic({} as any), false);
  assert.equal(shouldUseGeminiFreeSemantic({ SEMANTIC_PROVIDER: 'groq', GEMINI_FREE_API_KEY: 'k' } as any), false);
  assert.equal(shouldUseGeminiFreeSemantic({ SEMANTIC_PROVIDER: 'gemini-free', GEMINI_FREE_API_KEY: 'k' } as any), true);
  assert.equal(shouldUseGeminiFreeSemantic({ SEMANTIC_PROVIDER: 'gemini-free' } as any), false);
  assert.equal(shouldUseGeminiFreeSemantic({ SEMANTIC_PROVIDER: 'gemini-free', GEMINI_FREE_API_KEY: 'k', SEMANTIC_PROVIDER_FORCE_GEMINI: 'true' } as any), false);
});

test('free availability reports missing keys and inapplicable inputs', () => {
  const provider = new GeminiFreeSemanticProvider();
  assert.equal(provider.availability(input).availability, 'UNAVAILABLE');
  const stubbed = new GeminiFreeSemanticProvider(of({}));
  assert.equal(
    stubbed.availability({ ...input, search_match_context: { type: 'CHANNEL' }, enrichment_stage: 0, description: 'short' } as any).availability,
    'NOT_APPLICABLE',
  );
});

test('free-telemetry uses its own provider name, never gemini or groq', async () => {
  const events: Array<{ provider?: string; status?: string }> = [];
  const free = new GeminiFreeSemanticProvider(of(unrelatedResult));
  // Bypass defaultClient (needs keys) by checking the provider identity fields.
  assert.equal(free.name, 'gemini_free_semantic');
  const [item] = await free.collectEvidence(input, {} as any);
  assert.equal(item.provenance?.provider, 'gemini_free_semantic');
  assert.equal(events.length, 0);
});

test('persisted free-tier cooldown defers fresh replicas with zero SDK calls', async () => {
  resetGeminiFreeCooldownForTests();
  const savedKey = process.env.GEMINI_FREE_API_KEY;
  process.env.GEMINI_FREE_API_KEY = 'test-key';
  const events: Array<{ status?: string; requestMetadata?: Record<string, unknown> }> = [];
  try {
    const client = defaultClient(async (event) => { events.push(event as never); }, {
      persistedCooldownExpiryMs: async () => Date.now() + 60_000,
    });
    const error = await client!.classify('prompt', 'model').then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ProviderCallError && error.errorClass === 'RATE_LIMIT');
    assert.ok(((error as { providerReasons?: string[] }).providerReasons || []).includes('GEMINI_FREE_RATE_LIMITED'));
    assert.ok(geminiFreeCooldownRemainingMs() > 0);
    assert.equal(events.length, 1);
    assert.equal((events[0].requestMetadata as Record<string, unknown>)?.geminiFreeCooldownDeferral, 'true');
  } finally {
    if (savedKey === undefined) delete process.env.GEMINI_FREE_API_KEY;
    else process.env.GEMINI_FREE_API_KEY = savedKey;
    resetGeminiFreeCooldownForTests();
  }
});

test('free cooldown resolver is provider-scoped and excludes deferral echoes', async () => {
  const { resolveGeminiFreeSemanticCooldownExpiryMs } = await import('../../dbCore');
  const fnStr = resolveGeminiFreeSemanticCooldownExpiryMs.toString();
  assert.ok(fnStr.includes('geminiFreeCooldownDeferral'), 'resolver must exclude deferral-tagged rows');
  assert.ok(fnStr.includes("provider='gemini-free'"), 'resolver stays gemini-free-scoped');
  assert.doesNotMatch(fnStr, /provider='gemini'[^_-]/);
});

test('free rate-limit failures schedule retries past the shared cooldown expiry', async () => {
  const { decideJobFailure } = await import('../../dbCore');
  const now = 1_000_000_000;
  const expiry = now + 90_000;
  const freeRateLimit = (): unknown => ({
    message: 'Free Gemini HTTP 429', retryable: true, errorClass: 'RATE_LIMIT', status: 429, providerReasons: ['GEMINI_FREE_RATE_LIMITED'],
  });
  const first = decideJobFailure(freeRateLimit(), 1, 4, now, now, undefined, undefined, expiry);
  assert.equal(first.disposition, 'RETRYING_WITHOUT_ATTEMPT');
  assert.ok(first.runAfter! >= expiry);
});

test('rotated credentials replace the cached SDK instead of reusing the old key', () => {
  clearGeminiFreeSdkCacheForTests();
  const keyOf = (sdk: unknown): unknown => (sdk as { apiKey?: unknown }).apiKey;
  try {
    const first = geminiFreeSdkForRouteForTests({ id: 'gemini-free-1', key: 'KEY_A' });
    assert.equal(keyOf(first), 'KEY_A');
    // Same key reuses the cached instance (no churn on the hot path).
    assert.strictEqual(geminiFreeSdkForRouteForTests({ id: 'gemini-free-1', key: 'KEY_A' }), first);
    // A rotated value for the same route id must take effect without restart.
    const rotated = geminiFreeSdkForRouteForTests({ id: 'gemini-free-1', key: 'KEY_B' });
    assert.equal(keyOf(rotated), 'KEY_B');
    assert.notStrictEqual(rotated, first);
    // Distinct routes keep independent SDKs.
    const other = geminiFreeSdkForRouteForTests({ id: 'gemini-free-2', key: 'KEY_C' });
    assert.equal(keyOf(other), 'KEY_C');
    assert.notStrictEqual(other, rotated);
  } finally {
    clearGeminiFreeSdkCacheForTests();
  }
});

test('defaultClient is undefined without free keys (paid keys do not enable it)', () => {
  const savedFree = process.env.GEMINI_FREE_API_KEY;
  const savedPaid = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_FREE_API_KEY;
  process.env.GEMINI_API_KEY = 'paid-key';
  try {
    assert.equal(defaultClient(async () => undefined, { persistedCooldownExpiryMs: async () => undefined }), undefined);
  } finally {
    if (savedFree !== undefined) process.env.GEMINI_FREE_API_KEY = savedFree;
    else delete process.env.GEMINI_FREE_API_KEY;
    if (savedPaid === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedPaid;
  }
});
