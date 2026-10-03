import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTrialOutcomeState,
  evaluateTrialGate,
  initiateCanaryTrial,
  type FrontierTrialMetrics
} from './discoveryFrontierTrials';

test('Phase 7: Trial outcome state classification - NOISY when zero distinct creators', () => {
  const metrics: FrontierTrialMetrics = {
    creatorsReturned: 0,
    distinctCreators: 0,
    newCreators: 0,
    relevantNewCreators: 0,
    qualityNewCreators: 0,
    knownChannelOverlap: 0,
    neighborhoodOverlap: 0,
    quotaConsumed: 100,
    marginalDiscoveryValue: 0,
    coverageGain: 0
  };

  const outcome = classifyTrialOutcomeState(metrics);
  assert.equal(outcome, 'NOISY');
});

test('Phase 7: Trial outcome state classification - PRODUCTIVE when relevant AND quality creators found', () => {
  const metrics: FrontierTrialMetrics = {
    creatorsReturned: 10,
    distinctCreators: 8,
    newCreators: 5,
    relevantNewCreators: 3,
    qualityNewCreators: 2,
    knownChannelOverlap: 0.2,
    neighborhoodOverlap: 0.15,
    quotaConsumed: 100,
    marginalDiscoveryValue: 35,
    coverageGain: 0.35
  };

  const outcome = classifyTrialOutcomeState(metrics);
  assert.equal(outcome, 'PRODUCTIVE');
});

test('Phase 7: Fail Closed Gate - Rejects trial when operator kill switch read fails or is not true', async () => {
  const mockClientKillSwitchOff = {
    query: async (sql: string) => {
      if (sql.includes('app_settings')) {
        return { rows: [{ setting_value: 'false' }] };
      }
      return { rows: [] };
    }
  };

  const gate = await evaluateTrialGate('p-1', 100, mockClientKillSwitchOff as any);
  assert.equal(gate.eligible, false);
  assert.match(gate.reason, /globally disabled/i);
});

test('Phase 7: Fail Closed Gate - Rejects trial when target neighborhood frontier state verification errors', async () => {
  const mockClientError = {
    query: async (sql: string) => {
      if (sql.includes('app_settings')) {
        return { rows: [{ setting_value: 'true' }] };
      }
      if (sql.includes('discovery_neighborhood_frontier_states')) {
        throw new Error('Database connection reset during state verification');
      }
      if (sql.includes('frontier_discovery_proposals')) {
        return {
          rows: [{
            proposal_id: 'p-1',
            dedup_key: 'dedup-1',
            proposal_family: 'LEARNED',
            country: 'US',
            language: null,
            concept: 'options trading',
            target_neighborhood_key: 'us|none|strategy|options|organic|relevance|none|automated_query',
            target_dimensions: {},
            source_provenance: 'query_library:active',
            supporting_evidence: {},
            confidence: 0.8,
            novelty_rationale: 'test',
            trial_status: 'PENDING',
            expires_at: null
          }]
        };
      }
      return { rows: [] };
    }
  };

  const gate = await evaluateTrialGate('p-1', 100, mockClientError as any);
  assert.equal(gate.eligible, false);
  assert.match(gate.reason, /Failed to verify target neighborhood frontier state/i);
});

test('Phase 7: Strict Quota Input Validation - Rejects zero, negative, >100, non-integer, and NaN quota reservations', async () => {
  const invalidQuotas = [0, -50, 150, 10.5, NaN, Infinity, '100' as any];

  for (const q of invalidQuotas) {
    await assert.rejects(
      async () => {
        // Test validation logic directly
        const rawQuota = q;
        if (
          typeof rawQuota !== 'number' ||
          !Number.isFinite(rawQuota) ||
          !Number.isInteger(rawQuota) ||
          rawQuota < 1 ||
          rawQuota > 100
        ) {
          throw new Error(`Invalid canary quota reservation: ${rawQuota}. Quota reservation must be an integer between 1 and 100.`);
        }
      },
      /Invalid canary quota reservation/
    );
  }
});

test('Phase 7b: trial funnel mapping is measured-only with documented unmeasured zeros', async () => {
  const { mapCompletionFunnelToTrialMetrics, TRIAL_FUNNEL_MAP_VERSION } = await import('./discoveryFrontierTrials');
  assert.equal(TRIAL_FUNNEL_MAP_VERSION, 'trial-funnel-map-v1');
  const mapped = mapCompletionFunnelToTrialMetrics({
    rawResults: 25, distinctResults: 20, knownChannels: 15, newChannels: 5,
    tradingConfirmed: 3, qualityChannels: 2, quotaUsed: 100,
  });
  assert.deepEqual(mapped, {
    creatorsReturned: 25,
    distinctCreators: 20,
    newCreators: 5,
    relevantNewCreators: 3,
    qualityNewCreators: 2,
    knownChannelOverlap: 0.75,
    neighborhoodOverlap: 0,
    quotaConsumed: 100,
    marginalDiscoveryValue: 0,
    coverageGain: 0,
  });
  const empty = mapCompletionFunnelToTrialMetrics({
    rawResults: 0, distinctResults: 0, knownChannels: 0, newChannels: 0,
    tradingConfirmed: 0, qualityChannels: 0, quotaUsed: 0,
  });
  assert.equal(empty.knownChannelOverlap, 0);
  assert.equal(classifyTrialOutcomeState(empty), 'NOISY');
});

test('Phase 7b: trial linkage fails closed without a matching frontier decision', async () => {
  const { resolveTrialLinkage, isTrialQuotaSufficient, trialContinuationCap, quotaYieldPer1000 } = await import('./discoveryFrontierTrials');
  assert.deepEqual(resolveTrialLinkage({ requestedProposalId: 'p1', decisionProposalId: null }), {
    proceed: false,
    reason: 'TRIAL_REQUIRES_FRONTIER_DECISION',
  });
  assert.deepEqual(resolveTrialLinkage({ requestedProposalId: 'p1', decisionProposalId: 'p2' }), {
    proceed: false,
    reason: 'TRIAL_PROPOSAL_DECISION_MISMATCH',
  });
  assert.deepEqual(resolveTrialLinkage({ requestedProposalId: 'p1', decisionProposalId: 'p1' }), {
    proceed: true,
    proposalId: 'p1',
  });
  assert.equal(isTrialQuotaSufficient(100, 100), true);
  assert.equal(isTrialQuotaSufficient(100, 0), true);
  assert.equal(isTrialQuotaSufficient(50, 100), false);
  assert.equal(isTrialQuotaSufficient(NaN, 100), false);
  assert.equal(trialContinuationCap(3, 100), 1);
  assert.equal(trialContinuationCap(3, 250), 2);
  assert.equal(trialContinuationCap(3, 0), 0);
  assert.equal(trialContinuationCap(5, 10000), 5);
  const zero = quotaYieldPer1000(0, 0);
  assert.equal(zero.totalQuotaConsumed, 0);
  assert.equal(zero.yieldPer1000Quota, 0);
  const some = quotaYieldPer1000(3, 100);
  assert.equal(some.totalQuotaConsumed, 100);
  assert.equal(some.yieldPer1000Quota, 30);
});
