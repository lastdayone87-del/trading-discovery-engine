import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');

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
  assert.match(helper, /readKeyCapCapacityWithinDeadline\(keys, rotation/);
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
