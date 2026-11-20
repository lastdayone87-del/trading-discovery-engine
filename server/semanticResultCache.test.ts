import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isCacheableSemanticResult,
  isUsableCachedResult,
  SEMANTIC_RESULT_CACHE_VERSION,
  SEMANTIC_RESULT_CACHE_BACKGROUND_CONCURRENCY,
  SEMANTIC_RESULT_CACHE_BACKGROUND_WRITE_TIMEOUT_MS,
  DEFAULT_SEMANTIC_RESULT_CACHE_TIMEOUT_MS,
  resetSemanticResultCacheCircuitForTests,
  semanticResultCacheEnabled,
  semanticResultCacheKey,
  scheduleSemanticResultCacheWrite,
  semanticResultCacheWriteBacklogForTests,
  flushSemanticResultCacheWritesForTests,
  setSemanticResultCacheWriterForTests,
  type SemanticCacheHit,
  type SemanticResultCachePort,
} from './evidenceEngine/semanticResultCache';
import { canonicalJsonStringify } from './classificationInputChecksum';
import type { RawChannelInput } from './evidenceEngine/types';
import { GeminiSemanticProvider, type SemanticModelClient } from './evidenceEngine/providers/GeminiSemanticProvider';
import { GeminiFreeSemanticProvider } from './evidenceEngine/providers/GeminiFreeSemanticProvider';
import { GroqSemanticProvider } from './evidenceEngine/providers/GroqSemanticProvider';

const baseInput: RawChannelInput = {
  channel_name: '  Order Flow Lab  ',
  description: 'Futures trading education.',
  country: 'US',
  external_links: ['https://b.example', 'https://a.example'],
  video_titles: ['Liquidity sweeps'],
  job_id: 'job-a',
  run_id: 'run-a',
};

const identity = {
  input: baseInput,
  provider: 'gemini_semantic',
  promptVersion: 'prompt-v1',
  featureVersion: 'feature-v1',
  modelVersion: 'model-v1',
  adjudicatorModelVersion: 'model-v2',
  adjudicationEnabled: true,
};

const complete = {
  label: 'ACTIVE_TRADING', confidence: 88, supportedLanguage: true,
  reasonCodes: ['REPEATED_EXECUTION_DISCUSSION'], explanation: 'Futures execution.',
  concepts: ['risk'], languages: [], citations: [{ field: 'video_title', index: 0 }],
};

test('semantic cache identity is stable across job/run attribution and input ordering', () => {
  const replayed = {
    ...baseInput,
    channel_name: 'Order Flow Lab',
    external_links: ['https://a.example', 'https://b.example'],
    job_id: 'job-b',
    run_id: 'run-b',
  };
  assert.equal(
    semanticResultCacheKey(identity).cacheKey,
    semanticResultCacheKey({ ...identity, input: replayed }).cacheKey
  );
  assert.equal(semanticResultCacheKey(identity).inputChecksum, semanticResultCacheKey({ ...identity, input: replayed }).inputChecksum);
});

test('only model-facing evidence and declared context affect the cache key', () => {
  const corpus = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `doc-${index}`,
    field: index === 0 ? 'channel_bio' as const : 'video_title' as const,
    index,
    text: `document ${index}`,
    sourceFamilyId: 'family-1',
  }));
  const base = semanticResultCacheKey({ ...identity, input: { ...baseInput, evidence_corpus: corpus(45) } });
  const nonModelFacingChanges = semanticResultCacheKey({
    ...identity,
    input: {
      ...baseInput,
      subscriber_count: 999_999,
      video_count: 12_345,
      evidence_corpus: [
        ...corpus(40),
        { id: 'late', field: 'video_title' as const, index: 99, text: 'beyond prompt limit', sourceFamilyId: 'family-2' },
        { id: 'retrieval', field: 'search_match_context' as const, text: 'trading query', sourceFamilyId: 'search' },
        { id: 'activity', field: 'activity_metadata' as const, text: '2 uploads', sourceFamilyId: 'activity' },
      ],
    },
  });
  assert.equal(base.cacheKey, nonModelFacingChanges.cacheKey);
  assert.equal(base.inputChecksum, nonModelFacingChanges.inputChecksum);
  // Declared country and language hints are serialized into the prompt, so a
  // change the model can see must be a miss.
  assert.notEqual(
    base.cacheKey,
    semanticResultCacheKey({ ...identity, input: { ...baseInput, evidence_corpus: corpus(45), country: 'GB' } }).cacheKey,
  );
});

test('semantic cache key changes with evidence, prompt, feature, model, and adjudication configuration', () => {
  const original = semanticResultCacheKey(identity).cacheKey;
  assert.notEqual(original, semanticResultCacheKey({ ...identity, input: { ...baseInput, description: 'Changed.' } }).cacheKey);
  assert.notEqual(original, semanticResultCacheKey({ ...identity, promptVersion: 'prompt-v2' }).cacheKey);
  assert.notEqual(original, semanticResultCacheKey({ ...identity, featureVersion: 'feature-v2' }).cacheKey);
  assert.notEqual(original, semanticResultCacheKey({ ...identity, modelVersion: 'model-v2' }).cacheKey);
  assert.notEqual(original, semanticResultCacheKey({ ...identity, adjudicatorModelVersion: 'model-v3' }).cacheKey);
  assert.notEqual(original, semanticResultCacheKey({ ...identity, adjudicationEnabled: false }).cacheKey);
});

test('batch and citation-repair prompt versions invalidate cached results', () => {
  const original = semanticResultCacheKey(identity).cacheKey;
  assert.notEqual(original, semanticResultCacheKey({ ...identity, batchPromptVersion: 'semantic-batch-array-2' }).cacheKey);
  assert.notEqual(original, semanticResultCacheKey({ ...identity, repairPromptVersion: 'citation-repair-3' }).cacheKey);
  assert.notEqual(
    semanticResultCacheKey({ ...identity, batchPromptVersion: 'semantic-batch-array-1' }).cacheKey,
    semanticResultCacheKey({ ...identity, batchPromptVersion: 'semantic-batch-array-1', repairPromptVersion: 'citation-repair-2' }).cacheKey,
  );
});

test('provider request settings invalidate cached results', () => {
  const original = semanticResultCacheKey(identity).cacheKey;
  assert.notEqual(original, semanticResultCacheKey({ ...identity, requestSettings: 'chars=24000|tokens=6000|completion=800|reasoning=' }).cacheKey);
  assert.notEqual(
    semanticResultCacheKey({ ...identity, requestSettings: 'chars=24000|tokens=6000|completion=800|reasoning=' }).cacheKey,
    semanticResultCacheKey({ ...identity, requestSettings: 'chars=24000|tokens=6000|completion=1600|reasoning=' }).cacheKey,
  );
});

test('canonical JSON sorts object keys recursively but preserves array order', () => {
  assert.equal(
    canonicalJsonStringify({ b: 1, a: { d: [3, 2], c: 2 } }),
    canonicalJsonStringify({ a: { c: 2, d: [3, 2] }, b: 1 }),
  );
  assert.notEqual(canonicalJsonStringify({ a: [1, 2] }), canonicalJsonStringify({ a: [2, 1] }));
});

test('semantic cache version is part of the key contract', () => {
  assert.equal(SEMANTIC_RESULT_CACHE_VERSION, 'semantic-result-cache-v2');
  assert.equal(semanticResultCacheKey(identity).cacheKey.length, 64);
});

test('semantic cache defaults on and has an explicit rollback switch', () => {
  resetSemanticResultCacheCircuitForTests();
  assert.equal(semanticResultCacheEnabled({} as any), true);
  assert.equal(semanticResultCacheEnabled({ SEMANTIC_RESULT_CACHE_ENABLED: 'true' } as any), true);
  assert.equal(semanticResultCacheEnabled({ SEMANTIC_RESULT_CACHE_ENABLED: 'false' } as any), false);
});

test('structurally corrupt cached rows are treated as misses', () => {
  assert.equal(isUsableCachedResult(complete), true);
  assert.equal(isUsableCachedResult({ label: 'ACTIVE_TRADING', citations: [] }), false);
  assert.equal(isUsableCachedResult({ ...complete, citations: [] }), false, 'uncited abstentions are not replayable verdicts');
  assert.equal(isUsableCachedResult({ ...complete, confidence: Number.NaN }), false);
  assert.equal(isUsableCachedResult({ ...complete, confidence: 101 }), false);
  assert.equal(isUsableCachedResult({ ...complete, supportedLanguage: 'yes' }), false);
  assert.equal(isUsableCachedResult({ ...complete, citations: 'none' }), false);
  assert.equal(isUsableCachedResult({ ...complete, languages: [{ language: 'en', script: 'Latin', confidence: 90, field: 'not_a_field' }] }), false);
  assert.equal(isUsableCachedResult({ ...complete, citations: [{ field: 'video_title', index: -1 }] }), false);
  assert.equal(isUsableCachedResult(null), false);
});

test('cached and persisted citations must resolve to supplied documents', () => {
  assert.equal(isUsableCachedResult(complete, baseInput), true);
  assert.equal(isUsableCachedResult({ ...complete, citations: [{ field: 'video_title', index: 999 }] }, baseInput), false);
  assert.equal(isUsableCachedResult({ ...complete, citations: [{ field: 'channel_title', index: 0 }] }, baseInput), false);
  assert.equal(isCacheableSemanticResult(complete, baseInput), true);
  assert.equal(isCacheableSemanticResult({ ...complete, citations: [{ field: 'video_title', index: 999 }] }, baseInput), false);
});

test('degenerate and uncited results are never persisted', () => {
  assert.equal(isCacheableSemanticResult(complete), true);
  assert.equal(isCacheableSemanticResult({ ...complete, citations: [] }), false);
  assert.equal(isCacheableSemanticResult({ label: 'AMBIGUOUS' }), false);
  assert.equal(isCacheableSemanticResult(null), false);
});

const providerInput = {
  channel_id: 'cache-channel',
  channel_name: 'Order Flow Lab',
  description: 'Futures trading education and risk management.',
  video_titles: ['Liquidity sweeps', 'Risk management'],
  video_descriptions: ['Futures execution.', 'Position sizing.'],
  country: 'US',
} as any;

const providerVerdict = {
  label: 'ACTIVE_TRADING',
  confidence: 88,
  supportedLanguage: true,
  reasonCodes: ['REPEATED_EXECUTION_DISCUSSION'],
  explanation: 'The creator teaches futures execution.',
  concepts: ['risk'],
  languages: [{ language: 'en', script: 'Latin', confidence: 95, field: 'channel_bio' }],
  citations: [{ field: 'channel_bio' }],
};

function cacheHarness(hit?: SemanticCacheHit) {
  const reads: Array<{ identity: any; env: any; options: any }> = [];
  const writes: Array<{ identity: any; value: any; env: any; options: any }> = [];
  const port: SemanticResultCachePort = {
    async read(identity, env, options) {
      reads.push({ identity, env, options });
      return hit;
    },
    scheduleWrite(identity, value, env, options) {
      writes.push({ identity, value, env, options });
    },
  };
  return { port, reads, writes };
}

const providerCases = [
  ['gemini_semantic', GeminiSemanticProvider],
  ['gemini_free_semantic', GeminiFreeSemanticProvider],
  ['groq_semantic', GroqSemanticProvider],
] as const;

test('every semantic provider reads and writes the cache through observable behavior', async () => {
  for (const [name, Provider] of providerCases) {
    const harness = cacheHarness();
    let observability: any;
    const client: SemanticModelClient = {
      async classify(_prompt, _model, observed) {
        observability = observed;
        return providerVerdict;
      },
    };
    const provider = new Provider(client, harness.port);
    const [item] = await provider.collectEvidence(providerInput, {} as any);
    assert.equal(harness.reads.length, 1, `${name} must read the cache before calling the model`);
    assert.equal(harness.writes.length, 1, `${name} must schedule exactly one write for a cited verdict`);
    assert.equal(harness.writes[0].identity.provider, name);
    assert.equal(harness.writes[0].value.result.label, 'ACTIVE_TRADING');
    assert.match(String(observability?.requestMetadata?.evidenceChecksum), /^[0-9a-f]{64}$/, `${name} must attach the evidence checksum`);
    assert.equal(observability?.requestMetadata?.channelId, providerInput.channel_id);
    assert.equal(item.category, 'METHODOLOGY_CONCEPT');
    assert.ok(!item.provenance?.semantic?.reasonCodes.includes('SEMANTIC_RESULT_CACHE_HIT'));
  }
});

test('every semantic provider replays a cache hit without calling the model or rewriting it', async () => {
  for (const [name, Provider] of providerCases) {
    const hit: SemanticCacheHit = {
      cacheKey: 'cached-key',
      inputChecksum: 'cached-checksum',
      hit: true,
      result: providerVerdict as any,
      modelVersion: 'cached-model',
    };
    const harness = cacheHarness(hit);
    let modelCalls = 0;
    const client: SemanticModelClient = {
      async classify() {
        modelCalls += 1;
        throw new Error('MODEL_MUST_NOT_RUN_ON_CACHE_HIT');
      },
    };
    const provider = new Provider(client, harness.port);
    const [item] = await provider.collectEvidence(providerInput, {} as any);
    assert.equal(modelCalls, 0, `${name} must not call the model on a cache hit`);
    assert.equal(harness.writes.length, 0, `${name} must not rewrite an unchanged cache entry`);
    assert.ok(item.provenance?.semantic?.reasonCodes.includes('SEMANTIC_RESULT_CACHE_HIT'), `${name} must mark the hit`);
  }
});

test('every semantic provider skips the cache write for a malformed model verdict', async () => {
  for (const [name, Provider] of providerCases) {
    const harness = cacheHarness();
    const client: SemanticModelClient = {
      async classify() {
        return { ...providerVerdict, confidence: 101 };
      },
    };
    const provider = new Provider(client, harness.port);
    await provider.collectEvidence(providerInput, {} as any);
    assert.equal(harness.writes.length, 0, `${name} must not persist a malformed verdict`);
  }
});

test('provider-specific cache identities include repair, request and batch versions', () => {
  const groq = readFileSync('server/evidenceEngine/providers/GroqSemanticProvider.ts', 'utf8');
  assert.match(groq, /repairPromptVersion: SEMANTIC_CITATION_REPAIR_PROMPT_VERSION/, 'Groq cache identity must include the repair prompt version');
  assert.match(groq, /requestSettings: groqRequestSettingsKey\(\)/, 'Groq cache identity must include prompt/completion settings');
  assert.match(groq, /batchPromptVersion: semanticBatchConfig\(\)\.enabled \? SEMANTIC_BATCH_PROMPT_VERSION : undefined/, 'Groq cache identity must include the batch prompt version');
});

test('cache operations are fail-open and deadline-bounded', () => {
  const source = readFileSync('server/evidenceEngine/semanticResultCache.ts', 'utf8');
  assert.match(source, /function boundedCacheOperation/, 'cache reads and writes must share a deadline-bound helper');
  assert.match(source, /DEFAULT_SEMANTIC_RESULT_CACHE_TIMEOUT_MS = 500/);
  assert.match(source, /signal\?\.addEventListener\('abort', onAbort/, 'cache operations must honor caller cancellation');
  assert.match(source, /operation\.catch\(\(\) => undefined\)/, 'an already-aborted cache operation must consume its rejection');
  const readFn = source.match(/export async function readSemanticResultCache[\s\S]*?\n}/)?.[0] || '';
  assert.match(readFn, /boundedCacheOperation\(\(async \(\) => \{[\s\S]*?await import\('\.\.\/db'\)[\s\S]*?await getDb\(\)/, 'getDb must resolve inside the cache deadline race');
  assert.match(source, /DELETE FROM semantic_classification_cache WHERE cache_key=\$1/, 'invalid rows must be deleted rather than replayed');
  assert.match(source, /isCacheableSemanticResult\(value\.result, identity\.input\)/, 'writes must reject degenerate results and out-of-corpus citations');
  assert.match(source, /isUsableCachedResult\(row\.result, identity\.input\)/, 'reads must validate citations against the supplied evidence');
  assert.match(source, /void boundedCacheOperation\(/, 'hit counting must not add a blocking round trip');
  assert.match(source, /if \(!hitCountInFlight\)/, 'hit counting must be single-flight under database slowness');
  assert.match(source, /hitCountInFlight = false/, 'the single-flight guard must clear when the write settles');
  assert.match(source, /citationsReferenceSuppliedDocuments/, 'citations must resolve to supplied documents');
  assert.match(source, /batch_prompt_version/, 'the batch prompt version must be persisted for operator purges');
  assert.match(source, /identity\.batchPromptVersion \|\| null/, 'the persisted batch version must come from the cache identity');
  for (const file of [
    'server/evidenceEngine/providers/GeminiSemanticProvider.ts',
    'server/evidenceEngine/providers/GroqSemanticProvider.ts',
    'server/evidenceEngine/providers/GeminiFreeSemanticProvider.ts',
  ]) {
    const provider = readFileSync(file, 'utf8');
    assert.match(provider, /semanticResultWasBatched\(/, `${file} must keep multi-channel batch results out of the cache`);
  }
});


test('disabled cache writes are a no-op and the backlog flushes', async () => {
  scheduleSemanticResultCacheWrite(identity, { result: complete as any, modelVersion: 'model-v1' }, { SEMANTIC_RESULT_CACHE_ENABLED: 'false' } as any);
  assert.equal(semanticResultCacheWriteBacklogForTests(), 0);
  await flushSemanticResultCacheWritesForTests();
  assert.equal(semanticResultCacheWriteBacklogForTests(), 0);
});

test('an enabled scheduled write enters the backlog and drains on flush', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  setSemanticResultCacheWriterForTests(async () => { await gate; });
  try {
    scheduleSemanticResultCacheWrite(identity, { result: complete as any, modelVersion: 'model-v1' }, {} as any);
    assert.ok(semanticResultCacheWriteBacklogForTests() > 0, 'scheduling an enabled write must queue observable work');
    release();
    await flushSemanticResultCacheWritesForTests();
    assert.equal(semanticResultCacheWriteBacklogForTests(), 0);
  } finally {
    release();
    setSemanticResultCacheWriterForTests(undefined);
    await flushSemanticResultCacheWritesForTests();
  }
});

test('the scheduled writer has a bounded timeout and concurrency contract', () => {
  const source = readFileSync('server/evidenceEngine/semanticResultCache.ts', 'utf8');
  assert.match(source, /scheduleSemanticResultCacheWrite/, 'background writer must exist');
  assert.equal(SEMANTIC_RESULT_CACHE_BACKGROUND_WRITE_TIMEOUT_MS, 5_000);
  assert.ok(
    SEMANTIC_RESULT_CACHE_BACKGROUND_WRITE_TIMEOUT_MS > DEFAULT_SEMANTIC_RESULT_CACHE_TIMEOUT_MS,
    'background writes may take longer than the caller read deadline but remain bounded',
  );
  assert.match(source, /semanticResultCacheWriteTimeoutMs\(env\)/, 'background writer must honor the configured write timeout');
  assert.match(source, /pendingSemanticCacheWrites/, 'background writes must be tracked for flush');
  assert.equal(SEMANTIC_RESULT_CACHE_BACKGROUND_CONCURRENCY, 4, 'background writes must be bounded');
  assert.match(source, /holdUntilSettled/, 'queued writes must hold their concurrency slot until the DB operation settles');
});
