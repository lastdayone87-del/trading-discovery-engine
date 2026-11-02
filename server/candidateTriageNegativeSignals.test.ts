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

test('candidate triage does not treat "borsa di studio" as a market signal', () => {
  const result = triageAutonomousSearchCandidate(candidate('Borsa di studio per studenti italiani'), 'automated_query', false);
  assert.notEqual(result.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.ok(!result.matchedSignals.includes('LATIN_MARKET_FINANCE'));
});

test('candidate triage still recognizes named Italian exchanges', () => {
  const result = triageAutonomousSearchCandidate(candidate('Borsa di Milano'), 'automated_query', false);
  assert.equal(result.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.ok(result.matchedSignals.includes('LATIN_MARKET_FINANCE'));
});

test('candidate triage does not treat bare French "bourse" or Dutch "beurs" as market signals', () => {
  const french = triageAutonomousSearchCandidate(candidate("Bourse d'études pour étudiants français"), 'automated_query', false);
  assert.notEqual(french.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.ok(!french.matchedSignals.includes('LATIN_MARKET_FINANCE'));

  const dutch = triageAutonomousSearchCandidate(candidate('Beurs met tweedehands boeken en curiosa'), 'automated_query', false);
  assert.notEqual(dutch.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.ok(!dutch.matchedSignals.includes('LATIN_MARKET_FINANCE'));
});

test('candidate triage still recognizes qualified French and Dutch market phrases', () => {
  const french = triageAutonomousSearchCandidate(candidate('Analyse boursière du CAC 40'), 'automated_query', false);
  assert.equal(french.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.ok(french.matchedSignals.includes('LATIN_MARKET_FINANCE'));

  // No `aandelen`: this must pass only because the qualified Dutch `beurs`
  // phrase is recognized, so removing that matcher fails the test.
  const dutch = triageAutonomousSearchCandidate(candidate('Beurs analyse en nieuws'), 'automated_query', false);
  assert.equal(dutch.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.ok(dutch.matchedSignals.includes('LATIN_MARKET_FINANCE'));
});
