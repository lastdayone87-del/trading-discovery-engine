import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryRecord } from '../src/types';
import { evaluateAutonomousQueryAuthority } from './autonomousQueryAuthority';
import { triageAutonomousSearchCandidate } from './candidateTriage';
import { RETRIEVAL_SPECIFICITY_POLICY_VERSION } from './retrievalSpecificity';

function query(overrides: Partial<QueryRecord> = {}): QueryRecord {
  return {
    id: overrides.id || 1,
    query: overrides.query || 'BEL20 Trading',
    country: overrides.country || 'Belgium',
    collection: overrides.collection || 'EXPERIMENTAL',
    intent: overrides.intent || 'stocks',
    times_executed: overrides.times_executed || 0,
    total_channels_found: 0,
    unique_channels_found: 0,
    quality_channels_found: 0,
    community_channels_found: 0,
    avg_quality_score: 0,
    performance_score: overrides.performance_score || 0,
    created_at: '2026-08-01T00:00:00.000Z',
    status: 'ACTIVE',
    ...overrides
  };
}

function metadata(type: string, template: string, eligibility = 'STANDALONE') {
  return {
    queryTemplate: template,
    retrievalSpecificity: { policyVersion: RETRIEVAL_SPECIFICITY_POLICY_VERSION, eligibility },
    atoms: [{ type, retrievalPolicy: { policyVersion: RETRIEVAL_SPECIFICITY_POLICY_VERSION, eligibility } }]
  };
}

test('legacy stored query without current retrieval provenance is rejected before quota spend', () => {
  const decision = evaluateAutonomousQueryAuthority(query({ query: 'Order Flow', generation_metadata: undefined } as any));
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasonCodes.includes('CURRENT_RETRIEVAL_PROVENANCE_MISSING'));
});

test('generic standalone method is rejected even when historical metadata called it standalone', () => {
  const decision = evaluateAutonomousQueryAuthority(query({
    query: 'Order Flow',
    country: 'Germany',
    generation_metadata: metadata('METHOD', 'SINGLE_ATOM')
  } as any));
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasonCodes.includes('STANDALONE_METHOD_REQUIRES_CONCRETE_TRADING_ANCHOR'));
});

test('concrete instrument plus method remains authorized', () => {
  const m = metadata('INSTRUMENT', 'COMPACT_PAIR');
  (m.atoms as any[]).push({ type: 'METHOD', retrievalPolicy: { policyVersion: RETRIEVAL_SPECIFICITY_POLICY_VERSION, eligibility: 'MODIFIER_ONLY' } });
  const decision = evaluateAutonomousQueryAuthority(query({ query: 'BEL20 Order Flow', generation_metadata: m } as any));
  assert.equal(decision.eligible, true);
});

test('autonomous candidate with no trading signal is withheld before expensive processing', () => {
  const decision = triageAutonomousSearchCandidate({
    channelId: 'UCexample0000000000000000', channelName: 'Madeleine Beelen', youtubeUrl: 'https://youtube.com/channel/x',
    description: '', videoTitles: ['Weekend family vlog'], videoDescriptions: ['Travel and food in Belgium'],
    matchedDocument: { type: 'VIDEO', title: 'Weekend family vlog', description: 'Travel and food in Belgium' }
  }, 'automated_query', false);
  assert.equal(decision.disposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
});

test('autonomous candidate with explicit trading content receives one bounded chance', () => {
  const decision = triageAutonomousSearchCandidate({
    channelId: 'UCexample0000000000000001', channelName: 'OC-Trades', youtubeUrl: 'https://youtube.com/channel/y',
    description: '', videoTitles: ['BEL20 futures trading review'], videoDescriptions: ['Order flow and risk management'],
    matchedDocument: { type: 'VIDEO', title: 'BEL20 futures trading review', description: 'Order flow and risk management' }
  }, 'automated_query', false);
  assert.equal(decision.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.ok(decision.reasonCodes.includes('RETRIEVAL_DOCUMENT_HAS_HIGH_SPECIFICITY_TRADING_SIGNAL'));
});

test('music creator is withheld even when retrieval text contains an accidental finance word', () => {
  const decision = triageAutonomousSearchCandidate({
    channelId: 'UCmusic00000000000000001', channelName: 'Jessye Belleval', youtubeUrl: 'https://youtube.com/channel/music',
    description: '', videoTitles: ['Palolé Palolé'], videoDescriptions: [''],
    matchedDocument: {
      type: 'VIDEO',
      title: 'Jessye Belleval - Palolé Palolé (Clip Officiel 4K)',
      description: 'Zouk love official music video. Streaming options available now.'
    }
  }, 'automated_query', false);
  assert.equal(decision.disposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
  assert.ok(decision.reasonCodes.includes('EXPLICIT_NON_TRADING_DOMAIN_DETECTED'));
  assert.ok(decision.matchedSignals.includes('MUSIC_ARTIST'));
});

test('dominant unrelated domain beats a stray high-specificity trading phrase', () => {
  const decision = triageAutonomousSearchCandidate({
    channelId: 'UCmusic00000000000000002', channelName: 'Artist Channel', youtubeUrl: 'https://youtube.com/channel/music2',
    description: '', videoTitles: ['New single'], videoDescriptions: [''],
    matchedDocument: {
      type: 'VIDEO',
      title: 'Official Music Video - New Single',
      description: 'Singer talks about trading stories in the studio.'
    }
  }, 'automated_query', false);
  assert.equal(decision.disposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
  assert.ok(decision.reasonCodes.includes('CONFLICTING_RETRIEVAL_DOMAINS'));
});

test('one broad financial product word is not enough for canonical autonomous admission', () => {
  const decision = triageAutonomousSearchCandidate({
    channelId: 'UCambiguous00000000000001', channelName: 'Career Desk', youtubeUrl: 'https://youtube.com/channel/ambiguous',
    description: '', videoTitles: ['Understanding your options'], videoDescriptions: [''],
    matchedDocument: { type: 'VIDEO', title: 'Understanding your options', description: 'A general explainer.' }
  }, 'automated_query', false);
  assert.equal(decision.disposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
  assert.ok(decision.reasonCodes.includes('AMBIGUOUS_RETRIEVAL_CONTEXT'));
});

test('multiple concrete market contexts can corroborate a retrieval hypothesis without generic prose', () => {
  const decision = triageAutonomousSearchCandidate({
    channelId: 'UCmarket0000000000000001', channelName: 'NQ Desk', youtubeUrl: 'https://youtube.com/channel/nq',
    description: '', videoTitles: ['NQ futures 0DTE recap'], videoDescriptions: [''],
    matchedDocument: { type: 'VIDEO', title: 'NQ futures 0DTE recap', description: 'Nasdaq session recap.' }
  }, 'automated_query', false);
  assert.equal(decision.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.ok(decision.reasonCodes.includes('MULTIPLE_MARKET_CONTEXT_SIGNALS_CORROBORATE_RETRIEVAL'));
});
