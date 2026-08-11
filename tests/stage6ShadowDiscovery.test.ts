import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREATOR_FRONTIER_POLICY_VERSION,
  projectCreatorFrontier,
} from '../server/discovery/creatorFrontier';
import {
  OUTCOME_FEEDBACK_POLICY_VERSION,
  projectOutcomeFeedback,
} from '../server/discovery/outcomeFeedback';

test('creator frontier remains explicitly shadow-only', () => {
  const result = projectCreatorFrontier({
    channelId: 'creator-1',
    lastUploadAt: '2026-08-01T00:00:00.000Z',
    uploadsLast90Days: 12,
    evidenceSufficiency: 'SUFFICIENT',
    authorityScore: 0.8,
    communityScore: 0.7,
    uncertainty: 0.2,
  }, new Date('2026-08-11T00:00:00.000Z'));

  assert.equal(result.policyVersion, CREATOR_FRONTIER_POLICY_VERSION);
  assert.equal(result.servingAuthority, false);
  assert.equal(result.disposition, 'PRIORITIZE');
  assert.ok(result.score >= 0.65);
});

test('creator frontier preserves exploration value for uncertain identities', () => {
  const result = projectCreatorFrontier({
    channelId: 'unknown-creator',
    lastUploadAt: '2026-08-10T00:00:00.000Z',
    uploadsLast90Days: 2,
    evidenceSufficiency: 'MISSING',
    uncertainty: 1,
  }, new Date('2026-08-11T00:00:00.000Z'));

  assert.equal(result.servingAuthority, false);
  assert.notEqual(result.disposition, 'PRIORITIZE');
  assert.ok(result.reasons.includes('UNCERTAINTY_EXPLORATION_VALUE'));
  assert.ok(result.reasons.includes('MISSING_EVIDENCE'));
});

test('outcome feedback rejects biased observational history for policy learning', () => {
  const result = projectOutcomeFeedback({
    query: 'NQ Futures',
    lane: 'keyword-exploration',
    channelId: 'creator-2',
    outcome: 'HUMAN_ACCEPTED',
    randomized: false,
  });

  assert.equal(result.policyVersion, OUTCOME_FEEDBACK_POLICY_VERSION);
  assert.equal(result.servingAuthority, false);
  assert.equal(result.eligibleForPolicyLearning, false);
  assert.equal(result.reason, 'OBSERVATIONAL_ONLY');
});

test('outcome feedback permits randomized or propensity-recorded shadow learning', () => {
  const randomized = projectOutcomeFeedback({
    query: 'Order Flow',
    lane: 'exploration',
    channelId: 'creator-3',
    outcome: 'ADMITTED',
    randomized: true,
  });
  const propensity = projectOutcomeFeedback({
    query: 'DAX Trading',
    lane: 'creator-frontier',
    channelId: 'creator-4',
    outcome: 'HUMAN_REJECTED',
    randomized: false,
    allocationProbability: 0.25,
  });

  assert.equal(randomized.eligibleForPolicyLearning, true);
  assert.equal(propensity.eligibleForPolicyLearning, true);
  assert.equal(randomized.servingAuthority, false);
  assert.equal(propensity.servingAuthority, false);
});
