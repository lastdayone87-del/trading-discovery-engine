import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SEMANTIC_RESULT_CACHE_VERSION,
  isUsableCachedResult,
  resetSemanticResultCacheCircuitForTests,
  semanticResultCacheEnabled,
  semanticResultCacheKey,
} from './evidenceEngine/semanticResultCache';
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
  const complete = {
    label: 'ACTIVE_TRADING', confidence: 88, supportedLanguage: true,
    reasonCodes: ['REPEATED_EXECUTION_DISCUSSION'], explanation: 'Futures execution.',
    concepts: ['risk'], languages: [], citations: [{ field: 'video_title', index: 0 }],
  };
  assert.equal(isUsableCachedResult(complete), true);
  assert.equal(isUsableCachedResult({ label: 'ACTIVE_TRADING', citations: [] }), false);
  assert.equal(isUsableCachedResult({ ...complete, confidence: Number.NaN }), false);
  assert.equal(isUsableCachedResult({ ...complete, supportedLanguage: 'yes' }), false);
  assert.equal(isUsableCachedResult({ ...complete, citations: 'none' }), false);
  assert.equal(isUsableCachedResult(null), false);
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
    assert.match(source, /if \(!this\.injectedClient\) await writeSemanticResultCache/, `${file} must not let test clients write production cache`);
    assert.match(source, /SEMANTIC_RESULT_CACHE_HIT_REASON/, `${file} must mark cache hits`);
  }
});
