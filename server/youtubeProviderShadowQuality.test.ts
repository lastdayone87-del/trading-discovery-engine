import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateProviderShadowCandidate, summarizeProviderShadowQuality } from './youtubeProviderShadowQuality';

const NOW = Date.parse('2026-08-12T00:00:00.000Z');

test('recent explicit trading video is routed as plausible without claiming production confirmation', () => {
  const result = evaluateProviderShadowCandidate({
    channelId: 'UCtrader',
    channelTitle: 'Market Desk',
    title: 'DAX futures trading and order flow review',
    publishedAt: '2026-08-05T00:00:00.000Z'
  }, NOW);
  assert.equal(result.tradingRoutingDisposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.ok(result.matchedSignals.length > 0);
  assert.equal(result.freshnessBucket, 'LE_30D');
  assert.equal(result.productionConfirmationMeasured, false);
  assert.equal(result.productionWrites, false);
});

test('ancient matched video is withheld by the same production retrieval freshness firewall', () => {
  const result = evaluateProviderShadowCandidate({
    channelId: 'UCold',
    channelTitle: 'Old Trader',
    title: 'Forex trading tutorial',
    publishedAt: '2016-01-01T00:00:00.000Z'
  }, NOW);
  assert.equal(result.tradingRoutingDisposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
  assert.equal(result.freshnessBucket, 'STALE_GT_730D');
});

test('unrelated Latin-script result is withheld before downstream spend', () => {
  const result = evaluateProviderShadowCandidate({
    channelId: 'UCvlog',
    channelTitle: 'Weekend Family',
    title: 'Food and travel vlog',
    publishedAt: '2026-08-10T00:00:00.000Z'
  }, NOW);
  assert.equal(result.tradingRoutingDisposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
  assert.equal(result.matchedSignals.length, 0);
});

test('missing publication timestamp remains unknown rather than being called fresh or stale', () => {
  const result = evaluateProviderShadowCandidate({
    channelId: 'UCunknown',
    channelTitle: 'Options Trader',
    title: 'Options trading setup'
  }, NOW);
  assert.equal(result.freshnessBucket, 'UNKNOWN');
  assert.equal(result.matchedVideoAgeDays, null);
});

test('summary keeps freshness and routing metrics separate from production classification', () => {
  const items = [
    evaluateProviderShadowCandidate({ channelId: '1', channelTitle: 'Trader', title: 'stock trading', publishedAt: '2026-08-10T00:00:00.000Z' }, NOW),
    evaluateProviderShadowCandidate({ channelId: '2', channelTitle: 'Vlogger', title: 'family vlog', publishedAt: '2026-01-01T00:00:00.000Z' }, NOW),
    evaluateProviderShadowCandidate({ channelId: '3', channelTitle: 'Trader', title: 'forex trading' }, NOW)
  ];
  const summary = summarizeProviderShadowQuality(items);
  assert.equal(summary.candidatesEvaluated, 3);
  assert.equal(summary.recent30d, 1);
  assert.equal(summary.unknownFreshness, 1);
  assert.equal(summary.productionConfirmationMeasured, false);
  assert.equal(summary.productionWrites, false);
});
