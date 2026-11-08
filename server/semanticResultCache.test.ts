import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isCacheableSemanticResult,
  isUsableCachedResult,
  SEMANTIC_RESULT_CACHE_VERSION,
  resetSemanticResultCacheCircuitForTests,
  semanticResultCacheEnabled,
  semanticResultCacheKey,
} from './evidenceEngine/semanticResultCache';
import { canonicalJsonStringify } from './classificationInputChecksum';
import type { RawChannelInput } from './evidenceEngine/types';

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
  assert.equal(SEMANTIC_RESULT_CACHE_VERSION, 'semantic-result-cache-v1');
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
  assert.equal(isUsableCachedResult({ ...complete, confidence: Number.NaN }), false);
  assert.equal(isUsableCachedResult({ ...complete, confidence: 101 }), false);
  assert.equal(isUsableCachedResult({ ...complete, supportedLanguage: 'yes' }), false);
  assert.equal(isUsableCachedResult({ ...complete, citations: 'none' }), false);
  assert.equal(isUsableCachedResult({ ...complete, languages: [{ language: 'en', script: 'Latin', confidence: 90, field: 'not_a_field' }] }), false);
  assert.equal(isUsableCachedResult({ ...complete, citations: [{ field: 'video_title', index: -1 }] }), false);
  assert.equal(isUsableCachedResult(null), false);
});

test('degenerate and uncited results are never persisted', () => {
  assert.equal(isCacheableSemanticResult(complete), true);
  assert.equal(isCacheableSemanticResult({ ...complete, citations: [] }), false);
  assert.equal(isCacheableSemanticResult({ label: 'AMBIGUOUS' }), false);
  assert.equal(isCacheableSemanticResult(null), false);
});

test('all production semantic providers wire the cache and keep injected clients isolated', () => {
  for (const file of [
    'server/evidenceEngine/providers/GeminiSemanticProvider.ts',
    'server/evidenceEngine/providers/GroqSemanticProvider.ts',
    'server/evidenceEngine/providers/GeminiFreeSemanticProvider.ts',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /readSemanticResultCache/, `${file} must read the cache`);
    assert.match(source, /writeSemanticResultCache/, `${file} must write the cache`);
    assert.match(source, /this\.injectedClient \? undefined : await readSemanticResultCache/, `${file} must not let test clients read production cache`);
    assert.match(source, /if \(!this\.injectedClient && cacheable\) await writeSemanticResultCache/, `${file} must gate cache writes on a structurally valid result`);
    assert.match(source, /isSemanticResultShape\(/, `${file} must validate the model result before caching`);
    assert.match(source, /SEMANTIC_RESULT_CACHE_HIT_REASON/, `${file} must mark cache hits`);
    assert.match(source, /fallbackReasonCodes = \[[\s\S]*SEMANTIC_RESULT_CACHE_HIT_REASON/, `${file} must append the cache-hit reason to the result`);
    assert.match(source, /readSemanticResultCache\(cacheIdentity, process\.env, \{ signal \}\)/, `${file} must bound cache reads by the caller deadline`);
    assert.match(source, /writeSemanticResultCache\(cacheIdentity,[\s\S]{0,400}process\.env, \{ signal \}\)/, `${file} must bound cache writes by the caller deadline`);
  }
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
  assert.match(source, /isCacheableSemanticResult\(value\.result\)/, 'writes must reject degenerate results');
  assert.match(source, /value\.citations\.length > 0/, 'only cited results may be cached');
  assert.match(source, /batch_prompt_version/, 'the batch prompt version must be persisted for operator purges');
  assert.match(source, /identity\.batchPromptVersion \|\| null/, 'the persisted batch version must come from the cache identity');
});
