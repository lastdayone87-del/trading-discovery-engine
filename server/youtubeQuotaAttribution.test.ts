import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { clampQuotaUnits, fingerprintYouTubeKey, projectYouTubeQuotaUsage } from './youtubeQuotaAttribution';

test('YouTube key fingerprints are stable, non-secret, and distinct for different keys', () => {
  const first = fingerprintYouTubeKey('key-a');
  assert.equal(first, fingerprintYouTubeKey('key-a'));
  assert.notEqual(first, fingerprintYouTubeKey('key-b'));
  assert.equal(first.includes('key-a'), false);
  assert.equal(first.length, 32);
});

test('per-key usage clamps only the displayed value and never creates negative remaining quota', () => {
  assert.equal(clampQuotaUnits(8240, 10000), 8240);
  assert.equal(clampQuotaUnits(12000, 10000), 10000);
  assert.equal(clampQuotaUnits(-5, 10000), 0);
  assert.equal(clampQuotaUnits('not-a-number', 10000), 0);
});

test('projection follows configured key rotation by fingerprint and preserves exhausted state', () => {
  const first = 'key-a';
  const second = 'key-b';
  const rows = [{ keyFingerprint: fingerprintYouTubeKey(first), keyIndex: 1, unitsUsed: 8240, dailyLimit: 10000 }, { keyFingerprint: fingerprintYouTubeKey(second), keyIndex: 2, unitsUsed: 10000, dailyLimit: 10000 }];
  assert.deepEqual(projectYouTubeQuotaUsage([second, first], rows, 10000), [
    { keyIndex: 1, unitsUsed: 10000, remaining: 0, limit: 10000 },
    { keyIndex: 2, unitsUsed: 8240, remaining: 1760, limit: 10000 }
  ]);
});

test('a new quota day has zero usage for every configured key while preserving the same projection shape', () => {
  assert.deepEqual(projectYouTubeQuotaUsage(['key-a', 'key-b'], [], 10000), [
    { keyIndex: 1, unitsUsed: 0, remaining: 10000, limit: 10000 },
    { keyIndex: 2, unitsUsed: 0, remaining: 10000, limit: 10000 }
  ]);
});

test('every durable YouTube API charge receives the actually dispatched response key', () => {
  const source = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  // Durable charges flow either through incrementQuota directly or through
  // accountYouTubeQuotaResponse (same-response accounting retry); both must
  // resolve the key from the actual provider response, never a loop variable.
  const wrapperStart = source.indexOf('async function accountYouTubeQuotaResponse');
  assert.ok(wrapperStart >= 0, 'same-response accounting wrapper must exist');
  const wrapperEnd = source.indexOf('\n}\n', wrapperStart);
  const wrapper = source.slice(wrapperStart, wrapperEnd);
  assert.match(wrapper, /getYouTubeResponseProviderKey\(response\)/);
  assert.match(wrapper, /retryYouTubeQuotaAccounting/);
  // Outside the wrapper (which resolves the key from the response above),
  // every durable charge must carry the response-resolved key inline.
  const outside = source.slice(0, wrapperStart) + source.slice(wrapperEnd);
  const chargeLines = outside.split('\n').filter(line => line.includes('incrementQuota(') || line.includes('accountYouTubeQuotaResponse('));
  assert.ok(chargeLines.length >= 10);
  assert.equal(chargeLines.some(line => line.includes('incrementQuota(') && !line.includes('getYouTubeResponseProviderKey(')), false);
  assert.match(source, /youtubeResponseProviderContext\.set\(response,\{providerKey:dispatchedProviderKey/);
});

test('quota projection uses ordinal labels and never renders raw key material', () => {
  const source = readFileSync(new URL('../src/components/QueueMonitor.tsx', import.meta.url), 'utf8');
  assert.match(source, /Key #\{ku\.keyIndex\}/);
  assert.doesNotMatch(source, /ku\.maskedKey/);
  assert.match(source, /ku\.unitsUsed} \/ \{ku\.limit/);
  assert.match(source, /ku\.remaining/);
});
