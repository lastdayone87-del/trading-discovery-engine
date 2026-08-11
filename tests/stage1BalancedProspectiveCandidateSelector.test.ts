import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectBalancedAdjudicationQueue,
  selectBalancedProspectiveCandidates,
} from '../server/stage1/balancedProspectiveCandidateSelector';

test('returns distinct likely trading and likely non-trading candidates', () => {
  const result = selectBalancedProspectiveCandidates([
    {
      channel_id: 'trading-1',
      readiness: 'READY_FOR_PROSPECTIVE_HUMAN_REVIEW',
      creator_focus_proposed_status: 'TRADING_CONFIRMED',
      creator_focus_probability: 0.91,
      creator_focus_lower_confidence_bound: 0.78,
      pending_since: '2026-08-01T00:00:00Z',
    },
    {
      channel_id: 'non-trading-1',
      readiness: 'READY_FOR_PROSPECTIVE_HUMAN_REVIEW',
      creator_focus_proposed_status: 'NON_TRADING',
      creator_focus_probability: 0.08,
      creator_focus_lower_confidence_bound: 0.01,
      pending_since: '2026-08-02T00:00:00Z',
    },
  ]);

  assert.equal(result.likelyTrading?.channel_id, 'trading-1');
  assert.equal(result.likelyNonTrading?.channel_id, 'non-trading-1');
  assert.equal(result.methodology.humanDecisionRequired, true);
  assert.equal(result.methodology.hintsAreGroundTruth, false);
  assert.equal(result.methodology.servingAuthority, false);
});

test('uses probabilities as hints when classifier abstains', () => {
  const result = selectBalancedProspectiveCandidates([
    {
      channel_id: 'higher-probability',
      readiness: 'READY_FOR_PROSPECTIVE_HUMAN_REVIEW',
      creator_focus_proposed_status: 'UNCERTAIN',
      creator_focus_probability: 0.72,
      creator_focus_lower_confidence_bound: 0.42,
      trading_status: 'NON_TRADING',
    },
    {
      channel_id: 'lower-probability',
      readiness: 'READY_FOR_PROSPECTIVE_HUMAN_REVIEW',
      creator_focus_proposed_status: 'UNCERTAIN',
      creator_focus_probability: 0.12,
      creator_focus_lower_confidence_bound: 0.02,
      trading_status: 'TRADING_CONFIRMED',
    },
  ]);

  assert.equal(result.likelyTrading?.channel_id, 'higher-probability');
  assert.equal(result.likelyNonTrading?.channel_id, 'lower-probability');
});

test('never recommends a non-ready row', () => {
  const result = selectBalancedProspectiveCandidates([
    {
      channel_id: 'not-ready',
      readiness: 'CREATOR_FOCUS_SNAPSHOT_MISSING',
      creator_focus_proposed_status: 'TRADING_CONFIRMED',
      creator_focus_probability: 0.99,
    },
    {
      channel_id: 'ready',
      readiness: 'READY_FOR_PROSPECTIVE_HUMAN_REVIEW',
      creator_focus_proposed_status: 'UNCERTAIN',
      creator_focus_probability: 0.5,
    },
  ]);

  assert.equal(result.likelyTrading?.channel_id, 'ready');
  assert.equal(result.likelyNonTrading, null);
});

test('uses operational status only as a tiebreaker when Creator Focus is uninformative', () => {
  const candidates = [
    {
      channel_id: 'known-trading',
      readiness: 'READY_FOR_PROSPECTIVE_HUMAN_REVIEW',
      creator_focus_proposed_status: 'UNCERTAIN',
      creator_focus_probability: 0,
      creator_focus_lower_confidence_bound: 0,
      trading_status: 'TRADING_CONFIRMED',
      assigned_at: '2026-08-02T00:00:00Z',
    },
    {
      channel_id: 'known-non-trading',
      readiness: 'READY_FOR_PROSPECTIVE_HUMAN_REVIEW',
      creator_focus_proposed_status: 'UNCERTAIN',
      creator_focus_probability: 0,
      creator_focus_lower_confidence_bound: 0,
      trading_status: 'NON_TRADING',
      assigned_at: '2026-08-01T00:00:00Z',
    },
  ];

  const result = selectBalancedProspectiveCandidates(candidates);
  assert.equal(result.likelyTrading?.channel_id, 'known-trading');
  assert.equal(result.likelyNonTrading?.channel_id, 'known-non-trading');
});

test('builds a finite disjoint queue only from independent-adjudication-ready rows', () => {
  const candidates = [
    {
      channel_id: 'trading-1',
      readiness: 'NOT_PENDING_REVIEW',
      adjudication_readiness: 'READY_FOR_INDEPENDENT_ADJUDICATION',
      creator_focus_proposed_status: 'TRADING_CONFIRMED',
      creator_focus_probability: 0.95,
      creator_focus_lower_confidence_bound: 0.82,
      assigned_at: '2026-08-01T00:00:00Z',
    },
    {
      channel_id: 'trading-2',
      readiness: 'NOT_PENDING_REVIEW',
      adjudication_readiness: 'READY_FOR_INDEPENDENT_ADJUDICATION',
      creator_focus_proposed_status: 'TRADING_CONFIRMED',
      creator_focus_probability: 0.88,
      creator_focus_lower_confidence_bound: 0.71,
      assigned_at: '2026-08-02T00:00:00Z',
    },
    {
      channel_id: 'non-trading-1',
      readiness: 'NOT_PENDING_REVIEW',
      adjudication_readiness: 'READY_FOR_INDEPENDENT_ADJUDICATION',
      creator_focus_proposed_status: 'NON_TRADING',
      creator_focus_probability: 0.04,
      creator_focus_lower_confidence_bound: 0.01,
      assigned_at: '2026-08-03T00:00:00Z',
    },
    {
      channel_id: 'not-ready',
      readiness: 'NOT_PENDING_REVIEW',
      adjudication_readiness: 'DIAGNOSTIC_MISSING_AFTER_ASSIGNMENT',
      creator_focus_proposed_status: 'NON_TRADING',
      creator_focus_probability: 0.01,
    },
  ];

  const result = selectBalancedAdjudicationQueue(candidates, 1);
  assert.deepEqual(result.likelyTrading.map(row => row.channel_id), ['trading-1']);
  assert.deepEqual(result.likelyNonTrading.map(row => row.channel_id), ['non-trading-1']);
  assert.equal(result.methodology.humanDecisionRequired, true);
  assert.equal(result.methodology.hintsAreGroundTruth, false);
  assert.equal(result.methodology.operationalStatusIsGroundTruth, false);
  assert.equal(result.methodology.servingAuthority, false);
  assert.equal(result.methodology.queueMutation, false);
});

test('zero-signal adjudication queue uses operational status only to separate review lanes', () => {
  const candidates = [
    {
      channel_id: 'trading-confirmed',
      readiness: 'NOT_PENDING_REVIEW',
      adjudication_readiness: 'READY_FOR_INDEPENDENT_ADJUDICATION',
      creator_focus_proposed_status: 'UNCERTAIN',
      creator_focus_probability: 0,
      creator_focus_lower_confidence_bound: 0,
      trading_status: 'TRADING_CONFIRMED',
    },
    {
      channel_id: 'non-trading',
      readiness: 'NOT_PENDING_REVIEW',
      adjudication_readiness: 'READY_FOR_INDEPENDENT_ADJUDICATION',
      creator_focus_proposed_status: 'UNCERTAIN',
      creator_focus_probability: 0,
      creator_focus_lower_confidence_bound: 0,
      trading_status: 'NON_TRADING',
    },
    {
      channel_id: 'uncertain',
      readiness: 'NOT_PENDING_REVIEW',
      adjudication_readiness: 'READY_FOR_INDEPENDENT_ADJUDICATION',
      creator_focus_proposed_status: 'UNCERTAIN',
      creator_focus_probability: 0,
      creator_focus_lower_confidence_bound: 0,
      trading_status: 'NEEDS_REVIEW',
    },
  ];

  const result = selectBalancedAdjudicationQueue(candidates, 1);
  assert.deepEqual(result.likelyTrading.map(row => row.channel_id), ['trading-confirmed']);
  assert.deepEqual(result.likelyNonTrading.map(row => row.channel_id), ['non-trading']);
});

test('caps adjudication queue size and never duplicates a candidate across hint lanes', () => {
  const candidates = Array.from({ length: 80 }, (_, index) => ({
    channel_id: `candidate-${index}`,
    readiness: 'NOT_PENDING_REVIEW',
    adjudication_readiness: 'READY_FOR_INDEPENDENT_ADJUDICATION',
    creator_focus_proposed_status: 'UNCERTAIN',
    creator_focus_probability: index / 100,
    creator_focus_lower_confidence_bound: index / 200,
  }));

  const result = selectBalancedAdjudicationQueue(candidates, 1000);
  assert.equal(result.requestedPerClass, 50);
  assert.equal(result.likelyTrading.length, 50);
  assert.equal(result.likelyNonTrading.length, 30);
  const tradingIds = new Set(result.likelyTrading.map(row => row.channel_id));
  assert.equal(result.likelyNonTrading.some(row => tradingIds.has(row.channel_id)), false);
});
