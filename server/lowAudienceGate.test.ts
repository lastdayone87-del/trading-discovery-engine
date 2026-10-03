import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSubscriberCountNumber, evaluateLowAudienceGate, shouldReclassifyPreservedCompletedChannel } from './lowAudienceGate';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('parseSubscriberCountNumber correctly parses numeric and compact formats', () => {
  assert.equal(parseSubscriberCountNumber('2'), 2);
  assert.equal(parseSubscriberCountNumber('18'), 18);
  assert.equal(parseSubscriberCountNumber('29'), 29);
  assert.equal(parseSubscriberCountNumber('30'), 30);
  assert.equal(parseSubscriberCountNumber('1.2K'), 1200);
  assert.equal(parseSubscriberCountNumber('1M'), 1000000);
  assert.equal(parseSubscriberCountNumber('1.2K subscribers'), 1200);
  assert.equal(parseSubscriberCountNumber('29 subscribers'), 29);
  assert.equal(parseSubscriberCountNumber('hidden'), undefined);
  assert.equal(parseSubscriberCountNumber(undefined), undefined);
});

test('evaluateLowAudienceGate skips deep crawl for known 0-29 subscribers and proceeds for 30+ or hidden', () => {
  assert.equal(evaluateLowAudienceGate('0').shouldSkipDeepEnrichment, true);
  assert.equal(evaluateLowAudienceGate('2').shouldSkipDeepEnrichment, true);
  assert.equal(evaluateLowAudienceGate('18').shouldSkipDeepEnrichment, true);
  assert.equal(evaluateLowAudienceGate('29').shouldSkipDeepEnrichment, true);
  assert.equal(evaluateLowAudienceGate('30').shouldSkipDeepEnrichment, false);
  assert.equal(evaluateLowAudienceGate('45').shouldSkipDeepEnrichment, false);
  assert.equal(evaluateLowAudienceGate('500').shouldSkipDeepEnrichment, false);
  assert.equal(evaluateLowAudienceGate('hidden').shouldSkipDeepEnrichment, false);
});

test('evaluateLowAudienceGate allows reactivation when subscriber count grows from 18 to 35', () => {
  const initial = evaluateLowAudienceGate('18');
  assert.equal(initial.shouldSkipDeepEnrichment, true);

  const grown = evaluateLowAudienceGate('35');
  assert.equal(grown.shouldSkipDeepEnrichment, false);
});

test('preserved completed rows are reclassified only when fresh audience evidence is known low', () => {
  assert.equal(shouldReclassifyPreservedCompletedChannel('COMPLETED', evaluateLowAudienceGate('1')), true);
  assert.equal(shouldReclassifyPreservedCompletedChannel('COMPLETED', evaluateLowAudienceGate('hidden')), false);
  assert.equal(shouldReclassifyPreservedCompletedChannel('ENRICHMENT_PENDING', evaluateLowAudienceGate('1')), false);
  assert.equal(shouldReclassifyPreservedCompletedChannel('COMPLETED', evaluateLowAudienceGate('30')), false);
});

test('ingestionPipeline refreshes preserved completed rows without hiding unknown audience rows', () => {
  const source = read('server/ingestionPipeline.ts');
  assert.match(source, /shouldReclassifyPreservedCompletedChannel\(existing\.scan_status, refreshedAudienceGate\)/);
  assert.match(source, /existing\.scan_status = 'SKIPPED_LOW_AUDIENCE'/);
  assert.match(source, /const refreshedAudienceGate = evaluateLowAudienceGate\(candidate\.subscriberCount\)/);
});

test('ingestionPipeline enforces country hard-rejection before low-audience budget gate', () => {
  const source = read('server/ingestionPipeline.ts');
  const countryRejectedIndex = source.indexOf("countryVal.status === 'REJECTED'");
  const lowAudienceGateIndex = source.indexOf('const lowAudienceGate = evaluateLowAudienceGate(candidate.subscriberCount);');
  assert.ok(countryRejectedIndex >= 0 && lowAudienceGateIndex >= 0);
  assert.ok(countryRejectedIndex < lowAudienceGateIndex, 'Country hard-rejection must precede low-audience budget gate in ingestion pipeline');
});

test('handle-shaped and missing counts fail open as unavailable, never as low-audience', () => {
  for (const raw of ['@KelvinVinny', '@DerivativeTradingAcademy', '', undefined]) {
    const gate = evaluateLowAudienceGate(raw);
    assert.equal(gate.shouldSkipDeepEnrichment, false);
    assert.equal(gate.reasonCode, 'SUBSCRIBER_COUNT_UNAVAILABLE');
  }
});

test('ENRICH claim hydrates unavailable counts and enforces the gate before ENRICHING', () => {
  const source = read('server/queueManager.ts');
  const claimIdx = source.indexOf('Claim-time low-audience gate');
  assert.ok(claimIdx >= 0, 'claim-time audience gate exists');
  const enrichingIdx = source.indexOf("channel.scan_status = 'ENRICHING'");
  assert.ok(enrichingIdx > claimIdx, 'audience gate runs before ENRICHING is stamped');
  assert.match(source, /fetchYouTubeChannelCountryMetadata\(channelId, candidate\)/);
  assert.match(source, /reasonCode:'LOW_AUDIENCE_SKIP'/);
});

test('re-enqueue paths cannot bypass the low-audience gate on known-low counts', () => {
  const qm = read('server/queueManager.ts');
  assert.match(qm, /evaluateLowAudienceGate\(channel\.subscriber_count\)\.shouldSkipDeepEnrichment/);
  const iw = read('server/investigationWorkflow.ts');
  assert.match(iw, /evaluateLowAudienceGate\(row\.subscriber_count\)\.shouldSkipDeepEnrichment/);
  const recovery = read('server/operationalEnrichmentRecovery.ts');
  assert.match(recovery, /evaluateLowAudienceGate\(channel\.subscriber_count\)\.shouldSkipDeepEnrichment/);
});
