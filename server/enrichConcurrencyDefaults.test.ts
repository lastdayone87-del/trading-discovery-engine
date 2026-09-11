import test from 'node:test';
import assert from 'node:assert/strict';
import { ENRICHMENT_WORKER_CONCURRENCY_DEFAULT } from './queueManager';

test('enrichment defaults to 3 workers (measured service demand)', () => {
  assert.equal(ENRICHMENT_WORKER_CONCURRENCY_DEFAULT, 3);
});

test('rendered fallback gate defaults to its design max of 2', async () => {
  const saved = process.env.RENDERED_FALLBACK_CONCURRENCY;
  delete process.env.RENDERED_FALLBACK_CONCURRENCY;
  try {
    const module = await import(`./browserCommunityFallback.ts?concurrency-default-${Date.now()}`);
    assert.equal(module.renderedFallbackGate.snapshot().concurrency, 2);
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
