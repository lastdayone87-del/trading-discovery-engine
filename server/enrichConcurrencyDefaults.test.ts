import test from 'node:test';
import assert from 'node:assert/strict';
import { ENRICHMENT_WORKER_CONCURRENCY_DEFAULT, resolveEnrichmentWorkerCount } from './queueManager';

test('enrichment defaults to 3 workers (measured service demand)', () => {
  assert.equal(ENRICHMENT_WORKER_CONCURRENCY_DEFAULT, 3);
});

test('startup resolves the worker count from env with the default as fallback', () => {
  assert.equal(resolveEnrichmentWorkerCount({} as any), 3);
  assert.equal(resolveEnrichmentWorkerCount({ ENRICHMENT_WORKER_CONCURRENCY: '5' } as any), 5);
  assert.equal(resolveEnrichmentWorkerCount({ ENRICHMENT_WORKER_CONCURRENCY: '0' } as any), 1);
});

test('rendered fallback gate defaults to 1: the runtime lease serializes crawls', async () => {
  const saved = process.env.RENDERED_FALLBACK_CONCURRENCY;
  delete process.env.RENDERED_FALLBACK_CONCURRENCY;
  try {
    const module = await import(`./browserCommunityFallback.ts?concurrency-default-${Date.now()}`);
    assert.equal(module.renderedFallbackGate.snapshot().concurrency, 1);
  } finally {
    if (saved === undefined) delete process.env.RENDERED_FALLBACK_CONCURRENCY;
    else process.env.RENDERED_FALLBACK_CONCURRENCY = saved;
  }
});

test('rendered fallback concurrency stays within its designed 1..2 bounds', async () => {
  const saved = process.env.RENDERED_FALLBACK_CONCURRENCY;
  process.env.RENDERED_FALLBACK_CONCURRENCY = '9';
  try {
    const module = await import(`./browserCommunityFallback.ts?concurrency-clamp-${Date.now()}`);
    assert.equal(module.renderedFallbackGate.snapshot().concurrency, 2);
  } finally {
    if (saved === undefined) delete process.env.RENDERED_FALLBACK_CONCURRENCY;
    else process.env.RENDERED_FALLBACK_CONCURRENCY = saved;
  }
});
