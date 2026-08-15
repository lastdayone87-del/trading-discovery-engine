import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateLowAudienceGate } from './lowAudienceGate';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('cheap channel metadata hydration requests subscriber statistics at the same one-unit boundary', () => {
  const source = read('server/youtube.ts');
  const start = source.indexOf('export async function fetchYouTubeChannelCountryMetadata');
  assert.ok(start >= 0);
  const block = source.slice(start);
  assert.match(block, /part:'snippet,brandingSettings,statistics'/);
  assert.match(block, /subscriberCount/);
  assert.match(block, /hiddenSubscriberCount === true/);
});

test('ingestion hydrates missing subscriber evidence before applying the low-audience gate or classifier', () => {
  const source = read('server/ingestionPipeline.ts');
  const missing = source.indexOf('const subscriberEvidenceMissing');
  const hydration = source.indexOf('if (needsCountryHydration || subscriberEvidenceMissing)');
  const gate = source.indexOf('// Phase 7: Low-Audience Budget Gate');
  const classifier = source.indexOf('// Step 2: GATE 2 - Evidence-Based Trading Verification Engine');
  assert.ok(missing >= 0 && hydration > missing);
  assert.ok(gate > hydration, 'subscriber preflight must complete before low-audience gate');
  assert.ok(classifier > gate, 'low-audience gate must stop the channel before deep classification');
});

test('subscriber preflight preserves agreed 1-29 / 30+ / hidden semantics', () => {
  assert.equal(evaluateLowAudienceGate('7').shouldSkipDeepEnrichment, true);
  assert.equal(evaluateLowAudienceGate('29').shouldSkipDeepEnrichment, true);
  assert.equal(evaluateLowAudienceGate('30').shouldSkipDeepEnrichment, false);
  assert.equal(evaluateLowAudienceGate('hidden').shouldSkipDeepEnrichment, false);
  assert.equal(evaluateLowAudienceGate(undefined).reasonCode, 'SUBSCRIBER_COUNT_UNAVAILABLE');
});
