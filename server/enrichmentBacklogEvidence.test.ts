import test from 'node:test';
import assert from 'node:assert/strict';
import { ENRICHMENT_DIAGNOSTIC_QUERIES } from './enrichmentBacklogDiagnostics';
import { enrichmentOperationalFailure, OperationalEnrichmentProviderError } from './enrichmentOperationalFailure';

test('enrichment backlog diagnostics use the durable queue PROCESSING state for active jobs', () => {
  assert.match(ENRICHMENT_DIAGNOSTIC_QUERIES.aggregate, /status='PROCESSING'/);
  assert.match(ENRICHMENT_DIAGNOSTIC_QUERIES.oldest, /status IN \('PENDING','PROCESSING'\)/);
  assert.doesNotMatch(ENRICHMENT_DIAGNOSTIC_QUERIES.aggregate, /status='RUNNING'/);
});

test('operational enrichment retry preserves failed provider and governed reason codes', () => {
  const error = enrichmentOperationalFailure({
    degraded: true,
    providers: [
      {
        provider: 'gemini_semantic',
        availability: 'FAILED',
        reasonCodes: ['PROVIDER_RATE_LIMIT', 'SEMANTIC_DEFERRED_RATE_PRESSURE']
      }
    ]
  } as any, true);

  assert.ok(error instanceof OperationalEnrichmentProviderError);
  assert.equal(error.errorClass, 'TRANSIENT');
  assert.equal(error.retryable, true);
  assert.deepEqual(error.providerReasons, ['PROVIDER_RATE_LIMIT', 'SEMANTIC_DEFERRED_RATE_PRESSURE']);
  assert.deepEqual(error.providerFailures, [
    { provider: 'gemini_semantic', reasonCodes: ['PROVIDER_RATE_LIMIT', 'SEMANTIC_DEFERRED_RATE_PRESSURE'] }
  ]);
  assert.match(error.message, /gemini_semantic\[PROVIDER_RATE_LIMIT\|SEMANTIC_DEFERRED_RATE_PRESSURE\]/);
});

test('non-operational provider degradation is not converted into infrastructure retry', () => {
  const error = enrichmentOperationalFailure({
    degraded: true,
    providers: [
      {
        provider: 'gemini_semantic',
        availability: 'FAILED',
        reasonCodes: ['PROVIDER_PERMANENT_INPUT']
      }
    ]
  } as any, true);

  assert.equal(error, null);
});
