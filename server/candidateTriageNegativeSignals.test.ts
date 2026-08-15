import test from 'node:test';
import assert from 'node:assert/strict';
import { triageAutonomousSearchCandidate } from './candidateTriage';
import type { DiscoveredChannelRaw } from './youtube';

const candidate = (title: string, description = ''): DiscoveredChannelRaw => ({
  channelId: 'UC_test_123',
  channelName: title,
  youtubeUrl: 'https://youtube.com/channel/UC_test_123',
  description,
  videoTitles: [title],
  matchedDocument: {
    type: 'VIDEO',
    title,
    description,
    publishedAt: new Date().toISOString()
  }
});

test('candidate triage withholds obvious gaming candidates early', () => {
  const result = triageAutonomousSearchCandidate(candidate('Minecraft Survival Gameplay Episode 12'), 'automated_query', false);
  assert.equal(result.disposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
  assert.ok(result.reasonCodes.includes('EXPLICIT_NON_TRADING_SIGNAL_DETECTED'));
});

test('candidate triage withholds obvious cooking candidates early', () => {
  const result = triageAutonomousSearchCandidate(candidate('Easy Pasta Recipes Kitchen Chef'), 'automated_query', false);
  assert.equal(result.disposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
  assert.ok(result.reasonCodes.includes('EXPLICIT_NON_TRADING_SIGNAL_DETECTED'));
});

test('candidate triage withholds obvious entertainment vlogs early', () => {
  const result = triageAutonomousSearchCandidate(candidate('Celebrity Gossip Vlog & Pranks'), 'automated_query', false);
  assert.equal(result.disposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
  assert.ok(result.reasonCodes.includes('EXPLICIT_NON_TRADING_SIGNAL_DETECTED'));
});

test('candidate triage admits explicit trading candidates', () => {
  const result = triageAutonomousSearchCandidate(candidate('Forex Scalping Price Action Strategy'), 'automated_query', false);
  assert.equal(result.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.ok(result.reasonCodes.includes('RETRIEVAL_DOCUMENT_HAS_EXPLICIT_TRADING_SIGNAL'));
});
