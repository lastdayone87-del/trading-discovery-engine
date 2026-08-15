import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSubscriberCountNumber, evaluateLowAudienceGate } from './lowAudienceGate';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('parseSubscriberCountNumber correctly parses numeric and compact formats', () => {
  assert.equal(parseSubscriberCountNumber('2'), 2);
  assert.equal(parseSubscriberCountNumber('18'), 18);
  assert.equal(parseSubscriberCountNumber('29'), 29);
  assert.equal(parseSubscriberCountNumber('30'), 30);
  assert.equal(parseSubscriberCountNumber('1.2K'), 1200);
  assert.equal(parseSubscriberCountNumber('1M'), 1000000);
  assert.equal(parseSubscriberCountNumber('hidden'), undefined);
  assert.equal(parseSubscriberCountNumber(undefined), undefined);
});

test('evaluateLowAudienceGate skips deep crawl for 1-29 subscribers and proceeds for 30+ or hidden', () => {
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

test('ingestionPipeline enforces country hard-rejection before low-audience budget gate', () => {
  const source = read('server/ingestionPipeline.ts');
  const countryRejectedIndex = source.indexOf("countryVal.status === 'REJECTED'");
  const lowAudienceGateIndex = source.indexOf('evaluateLowAudienceGate(candidate.subscriberCount)');
  assert.ok(countryRejectedIndex >= 0 && lowAudienceGateIndex >= 0);
  assert.ok(countryRejectedIndex < lowAudienceGateIndex, 'Country hard-rejection must precede low-audience budget gate in ingestion pipeline');
});
