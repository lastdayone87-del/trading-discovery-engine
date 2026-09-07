import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GROQ_ADJUDICATOR_MODEL,
  DEFAULT_GROQ_CANDIDATE_MODEL,
  GroqSemanticProvider,
  configuredGroqRoutes,
  groqTimeoutMs,
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
