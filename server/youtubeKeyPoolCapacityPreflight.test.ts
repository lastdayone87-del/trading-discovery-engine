import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { availableKeyIndexes } from './youtube';
import { YouTubeKeyPoolCapacityExhaustedError, type KeyCapCapacitySnapshot } from './quotaKeyCapShadow';
import { youtubeProviderCooldown } from './youtubeProviderCooldown';
import { fingerprintYouTubeKey } from './youtubeQuotaAttribution';
import { getNextYouTubeQuotaResetAt } from './youtubeQuotaDay';

const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');

const uniqueKey = (suffix: string): string => `preflight-test-${suffix}-${process.pid}-${Date.now()}`;

function snapshot(key: string, settledUnits: number, leaseUnits = 0, earliestLeaseExpiryMs?: number): KeyCapCapacitySnapshot {
  return {
    keyFingerprint: fingerprintYouTubeKey(key),
    settledUnits,
    leaseUnits,
    remainingUnits: Math.max(0, 9_000 - settledUnits - leaseUnits),
    ...(earliestLeaseExpiryMs ? { earliestLeaseExpiryMs } : {}),
  };
}

function block(startNeedle: string, endNeedle: string): string {
  const start = youtube.indexOf(startNeedle);
  assert.ok(start >= 0, `${startNeedle} must exist`);
  const end = youtube.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(end > start, `${endNeedle} must follow ${startNeedle}`);
  return youtube.slice(start, end);
}

test('preflight has a bounded deadline and falls back to atomic admission', () => {
  const preflight = block('const KEY_CAP_PREFLIGHT_TIMEOUT_MS', 'async function availableKeyIndexes');
  assert.match(preflight, /KEY_CAP_PREFLIGHT_TIMEOUT_MS = 2_000/);
  assert.match(preflight, /Promise\.race/);
  assert.match(preflight, /clearTimeout\(timer\)/);
});

test('preflight reads cooling keys so their earlier cooldown refines the retry', () => {
  const helper = block('async function availableKeyIndexes', 'function throwIfAllProvidersCoolingDown');
  assert.match(helper, /const rotation = keys\.map/);
  assert.match(helper, /readKeyCapCapacityWithinDeadline\(\s*rotation\.map/);
  assert.match(helper, /!youtubeProviderCooldown\.eligible\(keys\[index\]\)/);
  assert.match(helper, /youtubeProviderCooldown\.retryAt\(keys\[index\]\)/);
  assert.match(helper, /Math\.min\(summary\.retryAt, \.\.\.coolingRetryTimes\)/);
  assert.match(helper, /return indexes;/);
});

test('optional metadata hydration degrades on pool-wide cap capacity', () => {
  const start = youtube.indexOf('export async function fetchYouTubeChannelCountryMetadata');
  assert.ok(start >= 0);
  const metadata = youtube.slice(start);
  assert.match(metadata, /error instanceof YouTubeKeyPoolCapacityExhaustedError/);
  assert.match(metadata, /countryMetadataStatus: 'UNAVAILABLE'/);
});

test('locator resolution propagates the last filtered attempt failure', () => {
  const resolver = block(
    'export async function resolveYouTubeLocatorAuthoritatively',
    'export interface YouTubeChannelPage',
  );
  assert.match(resolver, /attempt === providerIndexes\.length - 1/);
  assert.doesNotMatch(resolver, /attempt === keys\.length - 1/);
});

test('enrichment gates mandatory stage units and degrades the optional details call', () => {
  const enrichment = block('export async function fetchYouTubeChannelEnrichment', '/** One-unit basic metadata hydration');
  assert.match(enrichment, /enrichmentRequestUnits = stage >= 2 \? 102 : 2/);
  assert.match(enrichment, /if \(!isYouTubeKeyCapError\(error\)\) throw error;/);
});

test('preflight selects only keys that can serve the request from a stubbed snapshot', async () => {
  const availableKey = uniqueKey('available');
  const exhaustedKey = uniqueKey('exhausted');
  const keys = [exhaustedKey, availableKey];
  const indexes = await availableKeyIndexes(keys, 100, {
    resolveEnforcement: async () => true,
    readCapacity: async () => [snapshot(exhaustedKey, 9_000), snapshot(availableKey, 0)],
  });
  assert.equal(indexes.length, 1);
  assert.equal(fingerprintYouTubeKey(keys[indexes[0]]), fingerprintYouTubeKey(availableKey));
});

test('preflight returns one pool verdict when every key is at the cap', async () => {
  const first = uniqueKey('first');
  const second = uniqueKey('second');
  await assert.rejects(
    availableKeyIndexes([first, second], 100, {
      resolveEnforcement: async () => true,
      readCapacity: async () => [snapshot(first, 9_000), snapshot(second, 9_500)],
    }),
    (error: unknown) => error instanceof YouTubeKeyPoolCapacityExhaustedError
      && error.permanentlyExhaustedKeys === 2
      && error.temporarilyUnavailableKeys === 0
      && error.insufficientUntilResetKeys === 0
      && Math.abs(error.retryAt - getNextYouTubeQuotaResetAt(new Date())) < 5_000,
  );
});

test('preflight timeout falls back to atomic admission without blocking dispatch', async () => {
  const first = uniqueKey('timeout-a');
  const second = uniqueKey('timeout-b');
  const started = Date.now();
  const indexes = await availableKeyIndexes([first, second], 100, {
    resolveEnforcement: async () => true,
    readCapacity: () => new Promise<KeyCapCapacitySnapshot[]>(() => undefined),
    timeoutMs: 20,
  });
  assert.deepEqual([...indexes].sort(), [0, 1]);
  assert.ok(Date.now() - started < 1_000, 'timeout must bound the advisory read');
});

test('preflight includes a cooling key with capacity in the deferred retry time', async () => {
  const activeKey = uniqueKey('active');
  const coolingKey = uniqueKey('cooling');
  youtubeProviderCooldown.succeeded(coolingKey);
  const cooldownRetryAt = youtubeProviderCooldown.failed(coolingKey, 'RATE_LIMITED');
  try {
    await assert.rejects(
      availableKeyIndexes([activeKey, coolingKey], 100, {
        resolveEnforcement: async () => true,
        readCapacity: async () => [snapshot(activeKey, 9_000), snapshot(coolingKey, 0)],
      }),
      (error: unknown) => error instanceof YouTubeKeyPoolCapacityExhaustedError
        && error.retryAt <= cooldownRetryAt
        && error.retryAt < getNextYouTubeQuotaResetAt(new Date()),
    );
  } finally {
    youtubeProviderCooldown.succeeded(coolingKey);
  }
});

test('preflight is skipped when enforcement is off', async () => {
  let read = false;
  const indexes = await availableKeyIndexes([uniqueKey('off')], 100, {
    resolveEnforcement: async () => false,
    readCapacity: async () => { read = true; return []; },
  });
  assert.equal(indexes.length, 1);
  assert.equal(read, false);
});
