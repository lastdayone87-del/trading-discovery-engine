import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GeminiSemanticProvider,
  geminiSemanticProviderContext,
  semanticObservabilityFields,
} from './evidenceEngine/providers/GeminiSemanticProvider';
import {
  GeminiFreeSemanticProvider,
  defaultClient as freeDefaultClient,
  resetGeminiFreeCooldownForTests,
} from './evidenceEngine/providers/GeminiFreeSemanticProvider';
import {
  GroqSemanticProvider,
  defaultClient as groqDefaultClient,
} from './evidenceEngine/providers/GroqSemanticProvider';
import { ProviderCallError } from './providerResilience';

const input = {
  channel_id: 'channel-1',
  channel_name: 'Example creator',
  description: 'Creator-level description with enough context for semantic classification.',
  video_titles: ['Example recent video'],
  video_descriptions: ['Description one'],
  job_id: 'job-observability-1',
  run_id: 'run-observability-1',
} as any;

const unrelatedResult = {
  label: 'UNRELATED',
  confidence: 96,
  supportedLanguage: true,
  reasonCodes: ['CREATOR_FOCUS_UNRELATED'],
  explanation: 'Sports commentary rather than trading.',
  concepts: ['sports commentary'],
  languages: [{ language: 'en', script: 'Latin', confidence: 100, field: 'channel_bio' }],
  citations: [{ field: 'channel_bio' }],
};

test('every semantic provider forwards job and run attribution to its model client', async () => {
  for (const Provider of [GeminiSemanticProvider, GeminiFreeSemanticProvider, GroqSemanticProvider]) {
    const seen: unknown[] = [];
    const client = {
      async classify(_prompt: string, _model: string, observability?: unknown) {
        seen.push(observability);
        return unrelatedResult;
      },
    };
    const provider = new Provider(client as any);
    await provider.collectEvidence(input, {} as any);
    assert.deepEqual(seen[0], { jobId: 'job-observability-1', runId: 'run-observability-1' }, Provider.name);
  }
});

test('shared attribution helpers emit only present fields and build the paid context', () => {
  assert.deepEqual(semanticObservabilityFields({ jobId: 'job-1', runId: 'run-1' }), { jobId: 'job-1', runId: 'run-1' });
  assert.deepEqual(semanticObservabilityFields({ jobId: 'job-1' }), { jobId: 'job-1' });
  assert.deepEqual(semanticObservabilityFields(undefined), {});
  assert.deepEqual(
    geminiSemanticProviderContext({ jobId: 'job-1', runId: 'run-1' }, { geminiRoute: 'route-1', geminiOrg: 'org-1' }),
    {
      provider: 'gemini',
      operation: 'multilingual-semantic-classification',
      jobId: 'job-1',
      runId: 'run-1',
      requestMetadata: { geminiRoute: 'route-1', geminiOrg: 'org-1' },
    },
  );
});

test('free-tier deferral ledger event carries job and run attribution', async () => {
  resetGeminiFreeCooldownForTests();
  const savedKey = process.env.GEMINI_FREE_API_KEY;
  process.env.GEMINI_FREE_API_KEY = 'test-key';
  const events: Array<{ jobId?: string; runId?: string }> = [];
  try {
    const client = freeDefaultClient(async event => { events.push(event as never); }, {
      persistedCooldownExpiryMs: async () => Date.now() + 60_000,
    });
    const error = await client!
      .classify('prompt', 'model', { jobId: 'job-free', runId: 'run-free' })
      .then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ProviderCallError && error.errorClass === 'RATE_LIMIT');
    assert.equal(events.length, 1);
    assert.equal(events[0].jobId, 'job-free');
    assert.equal(events[0].runId, 'run-free');
  } finally {
    if (savedKey === undefined) delete process.env.GEMINI_FREE_API_KEY;
    else process.env.GEMINI_FREE_API_KEY = savedKey;
    resetGeminiFreeCooldownForTests();
  }
});

test('groq success ledger event carries job and run attribution', async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;
  process.env.GROQ_API_KEY = 'test-key';
  const events: Array<{ jobId?: string; runId?: string }> = [];
  try {
    const client = groqDefaultClient(async event => { events.push(event as never); }, {
      persistedCooldownExpiryMs: async () => undefined,
    });
    await client!.classify('prompt', 'model', { jobId: 'job-groq', runId: 'run-groq' });
    assert.equal(events.length, 1);
    assert.equal(events[0].jobId, 'job-groq');
    assert.equal(events[0].runId, 'run-groq');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
  }
});

test('every provider writer uses the shared attribution path', () => {
  const paid = readFileSync(new URL('./evidenceEngine/providers/GeminiSemanticProvider.ts', import.meta.url), 'utf8');
  assert.match(paid, /context: geminiSemanticProviderContext\(observability/);
  for (const relative of [
    'evidenceEngine/providers/GeminiFreeSemanticProvider.ts',
    'evidenceEngine/providers/GroqSemanticProvider.ts',
  ]) {
    const source = readFileSync(new URL(`./${relative}`, import.meta.url), 'utf8');
    assert.match(source, /\.\.\.semanticObservabilityFields\(observability\)/, relative);
  }
});

test('the ingestion pipeline maps the active job/run onto the classifier input', () => {
  const pipeline = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  assert.match(pipeline, /job_id:options\?\.jobId\|\|candidate\.discoveryJobId,run_id:options\?\.runId\|\|candidate\.queryRunId/);
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(queue, /processChannelThroughPipeline\(enriched[\s\S]{0,240}jobId:job\.id/);
  assert.match(queue, /processDiscoveredChannel\(candidate[\s\S]{0,240}jobId: job\.id/);
});
