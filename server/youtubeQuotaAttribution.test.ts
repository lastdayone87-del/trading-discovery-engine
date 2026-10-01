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
    { keyIndex: 1, unitsUsed: 10000, remaining: 0, limit: 10000, quotaGroup: null, projectUnitsUsed: 10000 },
    { keyIndex: 2, unitsUsed: 8240, remaining: 1760, limit: 10000, quotaGroup: null, projectUnitsUsed: 8240 }
  ]);
});

test('a new quota day has zero usage for every configured key while preserving the same projection shape', () => {
  assert.deepEqual(projectYouTubeQuotaUsage(['key-a', 'key-b'], [], 10000), [
    { keyIndex: 1, unitsUsed: 0, remaining: 10000, limit: 10000, quotaGroup: null, projectUnitsUsed: 0 },
    { keyIndex: 2, unitsUsed: 0, remaining: 10000, limit: 10000, quotaGroup: null, projectUnitsUsed: 0 }
  ]);
});

test('distinct quota groups keep independent remaining capacity', () => {
  const rows = [
    { keyFingerprint: fingerprintYouTubeKey('key-a'), keyIndex: 1, unitsUsed: 9000, dailyLimit: 10000 },
    { keyFingerprint: fingerprintYouTubeKey('key-b'), keyIndex: 2, unitsUsed: 1000, dailyLimit: 10000 },
  ];
  assert.deepEqual(projectYouTubeQuotaUsage(['key-a', 'key-b'], rows, 10000, ['proj-a', 'proj-b']), [
    { keyIndex: 1, unitsUsed: 9000, remaining: 1000, limit: 10000, quotaGroup: 'proj-a', projectUnitsUsed: 9000 },
    { keyIndex: 2, unitsUsed: 1000, remaining: 9000, limit: 10000, quotaGroup: 'proj-b', projectUnitsUsed: 1000 }
  ]);
});

test('shared quota group reports project-level remaining on every member key', () => {
  const rows = [
    { keyFingerprint: fingerprintYouTubeKey('key-a'), keyIndex: 1, unitsUsed: 6000, dailyLimit: 10000 },
    { keyFingerprint: fingerprintYouTubeKey('key-b'), keyIndex: 2, unitsUsed: 4000, dailyLimit: 10000 },
  ];
  const projection = projectYouTubeQuotaUsage(['key-a', 'key-b'], rows, 10000, ['proj-a', 'proj-a']);
  assert.deepEqual(projection, [
    { keyIndex: 1, unitsUsed: 6000, remaining: 0, limit: 10000, quotaGroup: 'proj-a', projectUnitsUsed: 10000 },
    { keyIndex: 2, unitsUsed: 4000, remaining: 0, limit: 10000, quotaGroup: 'proj-a', projectUnitsUsed: 10000 }
  ]);
});

test('project usage reflects over-limit recorded charges while remaining floors at zero', () => {
  const rows = [
    { keyFingerprint: fingerprintYouTubeKey('key-a'), keyIndex: 1, unitsUsed: 12000, dailyLimit: 10000 },
  ];
  assert.deepEqual(projectYouTubeQuotaUsage(['key-a'], rows, 10000, ['proj-a']), [
    { keyIndex: 1, unitsUsed: 10000, remaining: 0, limit: 10000, quotaGroup: 'proj-a', projectUnitsUsed: 12000 }
  ]);
  const shared = [
    { keyFingerprint: fingerprintYouTubeKey('key-a'), keyIndex: 1, unitsUsed: 9000, dailyLimit: 10000 },
    { keyFingerprint: fingerprintYouTubeKey('key-b'), keyIndex: 2, unitsUsed: 9000, dailyLimit: 10000 },
  ];
  const projection = projectYouTubeQuotaUsage(['key-a', 'key-b'], shared, 10000, ['proj-a', 'proj-a']);
  assert.equal(projection[0].projectUnitsUsed, 18000);
  assert.equal(projection[0].remaining, 0);
  assert.equal(projection[0].unitsUsed, 9000);
});

test('every durable YouTube API charge receives the actually dispatched response key', () => {
  const source = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const chargeLines = source.split('\n').filter(line => line.includes('incrementQuota('));
  assert.ok(chargeLines.length >= 10);
  assert.equal(chargeLines.some(line => !line.includes('getYouTubeResponseProviderKey(')), false);
  assert.match(source, /youtubeResponseProviderContext\.set\(response,\{providerKey:dispatchedProviderKey/);
});

test('quota projection uses ordinal labels and never renders raw key material', () => {
  const source = readFileSync(new URL('../src/components/QueueMonitor.tsx', import.meta.url), 'utf8');
  assert.match(source, /Key #\{ku\.keyIndex\}/);
  assert.doesNotMatch(source, /ku\.maskedKey/);
  assert.match(source, /ku\.unitsUsed} \/ \{ku\.limit/);
  assert.match(source, /ku\.remaining/);
});
