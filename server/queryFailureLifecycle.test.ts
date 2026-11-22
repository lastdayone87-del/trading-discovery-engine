import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyQueryBackoff, deriveQueryFailureState } from './queryQuality/lifecycle';

const now = new Date('2026-01-01T00:00:00.000Z');

test('provider outages and capacity failures are exempt from query-quality backoff', () => {
  for (const kind of ['PROVIDER_FAILURE', 'PROVIDER_CAPACITY']) {
    const decision = classifyQueryBackoff(kind, now);
    assert.equal(decision.failures, 0);
    assert.equal(decision.backoffUntil, null);
    assert.deepEqual(decision.reasonCodes, ['PROVIDER_FAILURE_EXEMPT']);
  }
});

test('query-input failures receive a bounded temporary backoff', () => {
  const decision = classifyQueryBackoff('INVALID_QUERY', now);
  assert.equal(decision.failures, 1);
  assert.equal(decision.backoffUntil, '2026-01-01T00:15:00.000Z');
});

test('a successful run resets the failure streak and provider failures break it without counting', () => {
  const reset = deriveQueryFailureState([
    { status: 'COMPLETED', completedAt: '2026-01-01T00:03:00.000Z', failureKind: null },
    { status: 'FAILED', completedAt: '2026-01-01T00:02:00.000Z', failureKind: 'INVALID_QUERY' },
    { status: 'FAILED', completedAt: '2026-01-01T00:01:00.000Z', failureKind: 'INVALID_QUERY' },
  ], now);
  assert.equal(reset.consecutiveFailures, 0);
  assert.equal(reset.backoffUntil, null);

  const providerBreak = deriveQueryFailureState([
    { status: 'FAILED', completedAt: '2026-01-01T00:02:00.000Z', failureKind: 'PROVIDER_FAILURE' },
    { status: 'FAILED', completedAt: '2026-01-01T00:01:00.000Z', failureKind: 'INVALID_QUERY' },
  ], now);
  assert.equal(providerBreak.consecutiveFailures, 0);
  assert.equal(providerBreak.backoffUntil, null);
});

test('failure recording classifies provider failure once and leaves the cooldown to the lifecycle authority', () => {
  const source = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function failQueryRun');
  const end = source.indexOf('\nexport ', start + 10);
  const body = source.slice(start, end);
  assert.match(body, /failureKind/);
  assert.match(body, /PROVIDER_CAPACITY/);
  assert.doesNotMatch(body, /next_eligible_at=GREATEST/);
  assert.match(source, /next_eligible_at=NULL/);
});
