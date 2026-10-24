import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADAPTIVE_PILOT_DEFAULT_SEED,
  ADAPTIVE_PILOT_POLICY_VERSION,
  aggregateAdaptivePilotMetrics,
  assignAdaptivePilotArm,
  computeAdaptivePilotMetrics,
  materializeAdaptiveDiscoveryPilotProposals,
  resolveAdaptivePilotConfig,
  summarizeAdaptivePilotMetrics,
  type AdaptivePilotArm,
  type AdaptivePilotAssignment
} from './adaptiveDiscoveryPilot';
import { buildFrontierProposal, extractCreatorDerivedConcept, type DiscoveryFrontierProposal } from './discoveryProposalGenerators';
import { filterAdaptivePilotCandidates } from './discoveryFrontierAllocator';

const nativeProposal = (country = 'US'): DiscoveryFrontierProposal => buildFrontierProposal({
  proposalFamily: 'COUNTRY_NATIVE',
  country,
  concept: 'S&P 500 futures',
  sourceProvenance: 'test:native',
  supportingEvidence: { nativeTerm: 'S&P 500 futures', sourceProvenanceFamily: 'COUNTRY_VOCABULARY' },
  confidence: 0.9,
  noveltyRationale: 'fixture'
});

const derivedProposal = (country = 'US'): DiscoveryFrontierProposal => buildFrontierProposal({
  proposalFamily: 'CREATOR_DERIVED',
  country,
  concept: 'price action',
  sourceProvenance: 'creator_metadata:test:price action',
  supportingEvidence: {
    channelId: 'creator-1',
    channelTitle: 'Creator One',
    nativeTerm: 'price action',
    sourceProvenanceFamily: 'CREATOR_DERIVED'
  },
  confidence: 0.7,
  noveltyRationale: 'fixture'
});

function assignment(country: string, arm: AdaptivePilotArm): AdaptivePilotAssignment {
  return {
    assignmentKey: `key-${country}-${arm}`,
    country,
    quotaDay: '2026-10-23',
    arm,
    treatmentPercent: arm === 'TREATMENT' ? 100 : 0,
    assignmentSeed: 'test-seed',
    policyVersion: ADAPTIVE_PILOT_POLICY_VERSION,
    windowStart: '2026-10-23T07:00:00.000Z',
    windowEnd: '2026-10-24T07:00:00.000Z'
  };
}

test('adaptive pilot config is opt-in, bounded and fail-closed', () => {
  assert.deepEqual(resolveAdaptivePilotConfig({}), {
    enabled: false,
    treatmentPercent: 50,
    seed: ADAPTIVE_PILOT_DEFAULT_SEED
  });
  assert.equal(resolveAdaptivePilotConfig({ enabled: 'TRUE' }).enabled, false);
  assert.equal(resolveAdaptivePilotConfig({ enabled: 'true', treatmentPercent: '101' }).treatmentPercent, 100);
  assert.equal(resolveAdaptivePilotConfig({ enabled: 'true', treatmentPercent: '-4' }).treatmentPercent, 0);
  assert.equal(resolveAdaptivePilotConfig({ enabled: 'true', treatmentPercent: 'not-a-number' }).treatmentPercent, 50);
  assert.equal(resolveAdaptivePilotConfig({ seed: '   ' }).seed, ADAPTIVE_PILOT_DEFAULT_SEED);
});

test('adaptive arm is deterministic by country-day and respects 0/100 boundaries', () => {
  const input = { country: 'US', quotaDay: '2026-10-23', treatmentPercent: 50, seed: 'seed-v1' };
  assert.equal(assignAdaptivePilotArm(input), assignAdaptivePilotArm({ ...input, country: 'us' }));
  assert.equal(assignAdaptivePilotArm({ ...input, treatmentPercent: 0 }), 'CONTROL');
  assert.equal(assignAdaptivePilotArm({ ...input, treatmentPercent: 100 }), 'TREATMENT');

  const countries = ['US', 'GB', 'DE', 'JP', 'BR', 'IN', 'FR', 'AU', 'CA', 'NL', 'ES', 'IT', 'MX', 'ZA', 'SG', 'AE'];
  const treatment = countries.filter(country => assignAdaptivePilotArm({ ...input, country }) === 'TREATMENT').length;
  assert.ok(treatment >= 4 && treatment <= 12, `50% assignment should not collapse: ${treatment}/${countries.length}`);
});

test('creator-derived concept extraction uses governed evidence, not arbitrary title tokens', () => {
  assert.deepEqual(
    extractCreatorDerivedConcept({ channel_name: 'Macro Trader', vocabulary_terms: ['ES', 'price action'], trading_category: 'General Trading' }),
    { term: 'price action', method: 'VOCABULARY' }
  );
  assert.deepEqual(
    extractCreatorDerivedConcept({ channel_name: 'DAX Mastery', trading_category: 'Futures' }),
    { term: 'DAX', method: 'CHANNEL_NAME' }
  );
  assert.deepEqual(
    extractCreatorDerivedConcept({ channel_name: 'The Futures Desk', trading_category: 'General Trading' }),
    null
  );
  assert.equal(extractCreatorDerivedConcept({ channel_name: 'Welcome To My Channel', trading_category: 'General Trading' }), null);
  assert.equal(extractCreatorDerivedConcept({ channel_name: 'Daily Vlog', vocabulary_terms: ['too many words in one concept'] }), null);
});

test('disabled pilot follows the exact baseline path and records no assignment', async () => {
  let baselineCalls = 0;
  let assignmentCalls = 0;
  const proposal = nativeProposal();
  const result = await materializeAdaptiveDiscoveryPilotProposals(['US'], { now: new Date('2026-10-23T15:00:00Z') }, {
    readConfig: async () => ({ enabled: false, treatmentPercent: 50, seed: 'test' }),
    baseline: async () => {
      baselineCalls++;
      return { generated: 1, persisted: 1, proposals: [proposal] };
    },
    recordAssignment: async () => {
      assignmentCalls++;
      throw new Error('must not record when disabled');
    }
  });
  assert.equal(baselineCalls, 1);
  assert.equal(assignmentCalls, 0);
  assert.equal(result.enabled, false);
  assert.equal(result.persisted, 1);
  assert.deepEqual(result.assignments, []);
});

test('treatment materializes native plus creator-derived proposals and records the arm', async () => {
  let persisted: DiscoveryFrontierProposal[] = [];
  let derivedCalls = 0;
  const result = await materializeAdaptiveDiscoveryPilotProposals(['US'], {
    globalCap: 10,
    perCountryCap: 5,
    now: new Date('2026-10-23T15:00:00Z')
  }, {
    readConfig: async () => ({ enabled: true, treatmentPercent: 100, seed: 'test' }),
    recordAssignment: async input => {
      assert.equal(input.arm, 'TREATMENT');
      assert.equal(input.quotaDay, '2026-10-23');
      assert.equal(input.windowStart, '2026-10-23T07:00:00.000Z');
      return assignment(input.country, input.arm);
    },
    generateNative: async () => [nativeProposal()],
    generateDerived: async (_country, _limit, options) => {
      derivedCalls++;
      assert.equal(options?.pilotPolicyVersion, ADAPTIVE_PILOT_POLICY_VERSION);
      assert.equal(options?.pilotQuotaDay, '2026-10-23');
      assert.equal(options?.pilotArm, 'TREATMENT');
      return [derivedProposal()];
    },
    persist: async proposals => {
      persisted = proposals;
      return proposals.length;
    }
  });
  assert.equal(derivedCalls, 1);
  assert.equal(result.enabled, true);
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].arm, 'TREATMENT');
  assert.deepEqual(persisted.map(p => p.proposalFamily), ['COUNTRY_NATIVE', 'CREATOR_DERIVED']);
});

test('control materializes only the existing native proposals', async () => {
  let derivedCalls = 0;
  const result = await materializeAdaptiveDiscoveryPilotProposals(['US'], {
    globalCap: 10,
    now: new Date('2026-10-23T15:00:00Z')
  }, {
    readConfig: async () => ({ enabled: true, treatmentPercent: 0, seed: 'test' }),
    recordAssignment: async input => assignment(input.country, input.arm),
    generateNative: async () => [nativeProposal()],
    generateDerived: async () => {
      derivedCalls++;
      return [derivedProposal()];
    },
    persist: async proposals => proposals.length
  });
  assert.equal(derivedCalls, 0);
  assert.equal(result.assignments[0].arm, 'CONTROL');
  assert.deepEqual(result.proposals.map(p => p.proposalFamily), ['COUNTRY_NATIVE']);
});

test('fair selection rotates countries and deduplicates stable proposal keys', async () => {
  const usNative = nativeProposal('US');
  const gbNative = nativeProposal('GB');
  const result = await materializeAdaptiveDiscoveryPilotProposals(['US', 'GB'], {
    globalCap: 2,
    perCountryCap: 5,
    fairnessCursor: 0,
    now: new Date('2026-10-23T15:00:00Z')
  }, {
    readConfig: async () => ({ enabled: true, treatmentPercent: 100, seed: 'test' }),
    recordAssignment: async input => assignment(input.country, input.arm),
    generateNative: async country => [country === 'US' ? usNative : gbNative],
    generateDerived: async () => [usNative],
    persist: async proposals => proposals.length
  });
  assert.equal(result.proposals.length, 2);
  assert.deepEqual(new Set(result.proposals.map(p => p.country)), new Set(['US', 'GB']));
});

test('pilot metrics expose net-new, relevance, duplicate, reliability and resource use', () => {
  const metrics = summarizeAdaptivePilotMetrics({
    windowStart: '2026-10-23T07:00:00.000Z',
    windowEnd: '2026-10-24T07:00:00.000Z',
    rows: [
      {
        arm: 'TREATMENT', assignments: 5, countries: 5, runs: 10, rawResults: 500,
        distinctCreators: 100, knownCreators: 40, newCreators: 20, relevantNewCreators: 12,
        qualityNewCreators: 8, confirmedNewCreators: 5, quotaConsumed: 1000, providerFailures: 1
      },
      {
        arm: 'CONTROL', assignments: 5, countries: 5, runs: 10, rawResults: 500,
        distinctCreators: 100, knownCreators: 60, newCreators: 10, relevantNewCreators: 4,
        qualityNewCreators: 2, confirmedNewCreators: 1, quotaConsumed: 1000, providerFailures: 2
      }
    ]
  });
  assert.equal(metrics.arms.TREATMENT.yieldPerRun, 2);
  assert.equal(metrics.arms.TREATMENT.relevantYieldPerRun, 1.2);
  assert.equal(metrics.arms.TREATMENT.duplicateRate, 0.4);
  assert.equal(metrics.arms.TREATMENT.reliability, 0.9);
  assert.equal(metrics.arms.TREATMENT.quotaPerRelevantCreator, 1000 / 12);
  assert.ok(metrics.uplift.treatmentVsControl.newCreatorsPerRun > 0.99);
  assert.ok(metrics.uplift.treatmentVsControl.duplicateRate < 0);
  assert.ok(metrics.uplift.treatmentVsControl.reliability > 0);
});

test('metrics absent for an arm produce safe zeros rather than NaN', () => {
  const arms = aggregateAdaptivePilotMetrics([{
    arm: 'CONTROL', assignments: 1, countries: 1, runs: 0, rawResults: 0,
    distinctCreators: 0, knownCreators: 0, newCreators: 0, relevantNewCreators: 0,
    qualityNewCreators: 0, confirmedNewCreators: 0, quotaConsumed: 0, providerFailures: 0
  }]);
  const treatment = arms.find(arm => arm.arm === 'TREATMENT')!;
  assert.equal(treatment.yieldPerRun, 0);
  assert.equal(treatment.reliability, 0);
  assert.equal(treatment.quotaPerRelevantCreator, null);
  assert.ok(Number.isFinite(treatment.duplicateRate));
});


test('execution follows the recorded arm, not a recomputed config arm', async () => {
  let derivedCalls = 0;
  const result = await materializeAdaptiveDiscoveryPilotProposals(['US'], {
    globalCap: 10,
    perCountryCap: 5,
    now: new Date('2026-10-23T15:00:00Z')
  }, {
    readConfig: async () => ({ enabled: true, treatmentPercent: 100, seed: 'test' }),
    recordAssignment: async input => assignment(input.country, 'CONTROL'),
    generateNative: async () => [nativeProposal()],
    generateDerived: async () => {
      derivedCalls++;
      return [derivedProposal()];
    },
    persist: async proposals => proposals.length
  });
  assert.equal(derivedCalls, 0);
  assert.equal(result.assignments[0].arm, 'CONTROL');
  assert.deepEqual(result.proposals.map(p => p.proposalFamily), ['COUNTRY_NATIVE']);
});

test('treatment groups never exceed the shared per-country cap', async () => {
  const nativeA = nativeProposal('US');
  const nativeB = buildFrontierProposal({
    proposalFamily: 'COUNTRY_NATIVE',
    country: 'US',
    concept: 'Nasdaq futures',
    sourceProvenance: 'test:native-b',
    supportingEvidence: { nativeTerm: 'Nasdaq futures', sourceProvenanceFamily: 'COUNTRY_VOCABULARY' },
    confidence: 0.8,
    noveltyRationale: 'fixture'
  });
  const derivedA = derivedProposal('US');
  const derivedB = buildFrontierProposal({
    proposalFamily: 'CREATOR_DERIVED',
    country: 'US',
    concept: 'gold',
    sourceProvenance: 'creator_metadata:test:gold',
    supportingEvidence: { channelId: 'creator-2', channelTitle: 'Creator Two', nativeTerm: 'gold', sourceProvenanceFamily: 'CREATOR_DERIVED' },
    confidence: 0.7,
    noveltyRationale: 'fixture'
  });
  const result = await materializeAdaptiveDiscoveryPilotProposals(['US'], {
    globalCap: 10,
    perCountryCap: 2,
    now: new Date('2026-10-23T15:00:00Z')
  }, {
    readConfig: async () => ({ enabled: true, treatmentPercent: 100, seed: 'test' }),
    recordAssignment: async input => assignment(input.country, 'TREATMENT'),
    generateNative: async () => [nativeA, nativeB],
    generateDerived: async () => [derivedA, derivedB],
    persist: async proposals => proposals.length
  });
  assert.equal(result.proposals.length, 2);
  assert.deepEqual(result.proposals.map(p => p.proposalFamily), ['COUNTRY_NATIVE', 'CREATOR_DERIVED']);
});

test('country assignments are recorded concurrently under one cycle', async () => {
  const countries = ['US', 'GB', 'DE'];
  let started = 0;
  let maxConcurrent = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('assignments did not run concurrently')), 2000);
    timer.unref?.();
  });
  const work = materializeAdaptiveDiscoveryPilotProposals(countries, {
    globalCap: 10,
    perCountryCap: 2,
    now: new Date('2026-10-23T15:00:00Z')
  }, {
    readConfig: async () => ({ enabled: true, treatmentPercent: 100, seed: 'test' }),
    recordAssignment: async input => {
      started++;
      maxConcurrent = Math.max(maxConcurrent, started);
      if (started === countries.length) release();
      await gate;
      started--;
      return assignment(input.country, input.arm);
    },
    generateNative: async () => [nativeProposal()],
    generateDerived: async () => [derivedProposal()],
    persist: async proposals => proposals.length
  });
  const result = await Promise.race([work, timeout]);
  assert.ok(maxConcurrent > 1, `expected concurrent assignment calls, saw ${maxConcurrent}`);
  assert.equal(result.assignments.length, countries.length);
});

test('allocator fails closed for creator-derived proposals outside an active treatment day', async () => {
  const candidate = {
    proposalFamily: 'CREATOR_DERIVED',
    proposalEvidenceSnapshot: {
      proposalFamily: 'CREATOR_DERIVED',
      supportingEvidence: { pilotArm: 'TREATMENT', pilotQuotaDay: '2026-10-23', pilotPolicyVersion: ADAPTIVE_PILOT_POLICY_VERSION }
    }
  } as any;
  const enabled = { query: async () => ({ rows: [{ setting_value: 'true' }] }) };
  const disabled = { query: async () => ({ rows: [{ setting_value: 'false' }] }) };

  assert.equal((await filterAdaptivePilotCandidates([candidate], '2026-10-23', enabled)).length, 1);
  assert.equal((await filterAdaptivePilotCandidates([candidate], '2026-10-22', enabled)).length, 0);
  assert.equal((await filterAdaptivePilotCandidates([candidate], '2026-10-23', disabled)).length, 0);
  assert.equal((await filterAdaptivePilotCandidates([candidate], '2026-10-23', null)).length, 0);
  assert.equal((await filterAdaptivePilotCandidates([{ ...candidate, proposalEvidenceSnapshot: { supportingEvidence: { pilotArm: 'CONTROL', pilotQuotaDay: '2026-10-23', pilotPolicyVersion: ADAPTIVE_PILOT_POLICY_VERSION } } }], '2026-10-23', enabled)).length, 0);
  assert.equal((await filterAdaptivePilotCandidates([{ ...candidate, proposalEvidenceSnapshot: { supportingEvidence: { pilotArm: 'TREATMENT', pilotQuotaDay: '2026-10-23', pilotPolicyVersion: 'older-policy' } } }], '2026-10-23', enabled)).length, 0);
});

test('day-two creator-derived evidence remains allocatable after the day-one proposal expires', async () => {
  const build = (quotaDay: string, expiresAt: string, assignmentKey: string) => buildFrontierProposal({
    proposalFamily: 'CREATOR_DERIVED',
    country: 'US',
    concept: 'price action',
    retrievalLane: 'VIDEO',
    sourceFamily: 'creator_derived',
    sourceProvenance: 'creator_metadata:test:price action',
    expiresAt,
    dedupDiscriminator: assignmentKey,
    supportingEvidence: {
      channelId: 'creator-1',
      nativeTerm: 'price action',
      sourceProvenanceFamily: 'CREATOR_DERIVED',
      pilotArm: 'TREATMENT',
      pilotQuotaDay: quotaDay,
      pilotAssignmentKey: assignmentKey,
      pilotPolicyVersion: ADAPTIVE_PILOT_POLICY_VERSION
    },
    noveltyRationale: 'fixture'
  });
  const dayOne = build('2026-10-23', '2026-10-24T07:00:00.000Z', 'assignment-day-one');
  const dayTwo = build('2026-10-24', '2026-10-25T07:00:00.000Z', 'assignment-day-two');
  const candidate = (proposal: DiscoveryFrontierProposal) => ({
    proposalFamily: proposal.proposalFamily,
    proposalEvidenceSnapshot: {
      proposalFamily: proposal.proposalFamily,
      supportingEvidence: proposal.supportingEvidence
    }
  }) as any;
  const enabled = { query: async () => ({ rows: [{ setting_value: 'true' }] }) };

  assert.notEqual(dayOne.dedupKey, dayTwo.dedupKey);
  assert.equal((await filterAdaptivePilotCandidates([candidate(dayTwo)], '2026-10-24', enabled)).length, 1);
  assert.equal((await filterAdaptivePilotCandidates([candidate(dayOne)], '2026-10-24', enabled)).length, 0);
});

test('metrics are bounded by the report window and isolated by policy version', async () => {
  let captured: { sql: string; params: unknown[] } | null = null;
  const client = {
    query: async (sql: string, params: unknown[]) => {
      captured = { sql, params };
      return { rows: [] };
    }
  };
  const metrics = await computeAdaptivePilotMetrics({
    windowStart: '2026-10-23T07:00:00.000Z',
    windowEnd: '2026-10-24T07:00:00.000Z',
    policyVersion: 'adaptive-country-pilot-v2',
    client
  });
  assert.ok(captured);
  assert.match(captured!.sql, /allocation_at >= \$1::timestamptz - interval '1 day'/);
  assert.match(captured!.sql, /o\.allocation_at >= GREATEST\(a\.window_start, \$1::timestamptz\)/);
  assert.match(captured!.sql, /o\.allocation_at < LEAST\(a\.window_end, \$2::timestamptz\)/);
  assert.match(captured!.sql, /a\.window_start < \$2\s+AND a\.window_end > \$1/);
  assert.match(captured!.sql, /a\.policy_version = \$3/);
  assert.deepEqual(captured!.params, [
    '2026-10-23T07:00:00.000Z',
    '2026-10-24T07:00:00.000Z',
    'adaptive-country-pilot-v2'
  ]);
  assert.equal(metrics.policyVersion, 'adaptive-country-pilot-v2');
});

test('creator-derived proposal expiry is bound to the pilot day window', () => {
  const expiry = '2026-10-24T07:00:00.000Z';
  const proposal = buildFrontierProposal({
    proposalFamily: 'CREATOR_DERIVED',
    country: 'US',
    concept: 'price action',
    sourceProvenance: 'creator_metadata:test:price action',
    retrievalLane: 'VIDEO',
    supportingEvidence: {
      nativeTerm: 'price action',
      pilotArm: 'TREATMENT',
      pilotQuotaDay: '2026-10-23',
      pilotAssignmentKey: 'assignment-key'
    },
    confidence: 0.7,
    noveltyRationale: 'fixture',
    expiresAt: expiry
  });
  assert.equal(proposal.expiresAt, expiry);
  assert.equal(proposal.targetDimensions.retrievalLane, 'VIDEO');
});
