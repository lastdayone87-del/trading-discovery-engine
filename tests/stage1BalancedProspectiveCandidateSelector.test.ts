import assert from 'node:assert/strict';
import test from 'node:test';
import { selectBalancedProspectiveCandidates } from '../server/stage1/balancedProspectiveCandidateSelector';

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
    },
    {
      channel_id: 'lower-probability',
      readiness: 'READY_FOR_PROSPECTIVE_HUMAN_REVIEW',
      creator_focus_proposed_status: 'UNCERTAIN',
      creator_focus_probability: 0.12,
      creator_focus_lower_confidence_bound: 0.02,
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
