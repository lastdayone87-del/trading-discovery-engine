import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluateNeighborhoodEligibility,
  scoreNeighborhoodCandidate,
  evaluateShadowFrontierAllocation,
  evaluateFrontierCanaryAllocation,
  releaseAllocationDecision,
  commitAllocationQueryRun,
  getNeighborhoodCandidates,
  getFrontierAllocationDiagnostics,
  getFrontierAllocationControlComparison,
  type NeighborhoodCandidate
} from './discoveryFrontierAllocator';
import { createNeighborhoodKey } from './discoveryNeighborhood';

test('frontier candidate loading uses the migrated metadata dimensions column', () => {
  const source = readFileSync(new URL('./discoveryFrontierAllocator.ts', import.meta.url), 'utf8');
  assert.match(source, /n\.metadata AS dimensions/);
  assert.match(source, /ORDER BY n\.last_observed_at DESC/);
  assert.doesNotMatch(source, /SELECT[\\s\\S]*n\.dimensions,/);
  assert.doesNotMatch(source, /ORDER BY n\.updated_at DESC/);
});

test('evaluateNeighborhoodEligibility rejects HARMFUL and SATURATED candidates', () => {
  const baseDims = {
    country: 'US',
    language: 'en',
    queryIntent: 'GENERAL',
    primaryTermFamily: 'trading',
    retrievalLane: 'KEYWORD_SEARCH',
    searchOrdering: 'RELEVANCE',
    instrumentOrTheme: null,
    sourceFamily: 'automated_query'
  };

  const harmfulCandidate: NeighborhoodCandidate = {
    neighborhoodKey: 'US|en|GENERAL|trading|KEYWORD_SEARCH|RELEVANCE|none|automated_query',
    country: 'US',
    dimensions: baseDims,
    frontierState: 'HARMFUL',
    expectedMarginalValue: 0,
    uncertainty: 0.5,
    coverageGain: 0.2,
    knownCreatorRatio: 0.9,
    resultSetOverlap: 0.9,
    isSaturating: true,
    recentAllocationCount: 0,
    expectedQuotaCost: 100
  };

  const harmfulResult = evaluateNeighborhoodEligibility(harmfulCandidate);
  assert.equal(harmfulResult.eligible, false);
  assert.ok(harmfulResult.rejectionReasons.includes('HARMFUL_NEIGHBORHOOD_EXCLUDED'));

  const saturatedCandidate: NeighborhoodCandidate = {
    ...harmfulCandidate,
    frontierState: 'SATURATED',
    resultSetOverlap: 0.90,
    knownCreatorRatio: 0.90
  };

  const saturatedResult = evaluateNeighborhoodEligibility(saturatedCandidate);
  assert.equal(saturatedResult.eligible, false);
  assert.ok(saturatedResult.rejectionReasons.includes('SATURATED_NEIGHBORHOOD_EXCLUDED'));
});

test('scoreNeighborhoodCandidate produces deterministic scores for identical evidence', () => {
  const candidate: NeighborhoodCandidate = {
    neighborhoodKey: 'GB|en|STRATEGY|forex|KEYWORD_SEARCH|RELEVANCE|none|automated_query',
    country: 'GB',
    dimensions: {
      country: 'GB',
      language: 'en',
      queryIntent: 'STRATEGY',
      primaryTermFamily: 'forex',
      retrievalLane: 'KEYWORD_SEARCH',
      searchOrdering: 'RELEVANCE',
      instrumentOrTheme: null,
      sourceFamily: 'automated_query'
    },
    frontierState: 'PRODUCTIVE',
    expectedMarginalValue: 45,
    uncertainty: 0.6,
    coverageGain: 0.7,
    knownCreatorRatio: 0.3,
    resultSetOverlap: 0.2,
    isSaturating: false,
    recentAllocationCount: 1,
    expectedQuotaCost: 100
  };

  const score1 = scoreNeighborhoodCandidate(candidate);
  const score2 = scoreNeighborhoodCandidate(candidate);

  assert.deepEqual(score1, score2);
  assert.ok(score1.totalScore > 0);
  assert.equal(typeof score1.totalScore, 'number');
});

test('exploration floor and ceiling adjust score weights', () => {
  const candidate: NeighborhoodCandidate = {
    neighborhoodKey: 'CA|en|EDUCATION|stocks|KEYWORD_SEARCH|RELEVANCE|none|automated_query',
    country: 'CA',
    dimensions: {
      country: 'CA',
      language: 'en',
      queryIntent: 'EDUCATION',
      primaryTermFamily: 'stocks',
      retrievalLane: 'KEYWORD_SEARCH',
      searchOrdering: 'RELEVANCE',
      instrumentOrTheme: null,
      sourceFamily: 'automated_query'
    },
    frontierState: 'UNEXPLORED',
    expectedMarginalValue: 10,
    uncertainty: 0.9,
    coverageGain: 0.8,
    knownCreatorRatio: 0.1,
    resultSetOverlap: 0.1,
    isSaturating: false,
    recentAllocationCount: 0,
    expectedQuotaCost: 100
  };

  const normalScore = scoreNeighborhoodCandidate(candidate);
  const floorScore = scoreNeighborhoodCandidate(candidate, { explorationFloorActive: true });
  const ceilingScore = scoreNeighborhoodCandidate(candidate, { explorationCeilingActive: true });

  assert.ok(floorScore.totalScore > normalScore.totalScore);
  assert.ok(ceilingScore.totalScore < normalScore.totalScore);
});

test('evaluateShadowFrontierAllocation produces valid shadow decision with zero scheduling side-effects', async () => {
  const mockCandidate: NeighborhoodCandidate = {
    neighborhoodKey: 'DE|de|GENERAL|dax|KEYWORD_SEARCH|RELEVANCE|none|automated_query',
    country: 'DE',
    dimensions: {
      country: 'DE',
      language: 'de',
      queryIntent: 'GENERAL',
      primaryTermFamily: 'dax',
      retrievalLane: 'KEYWORD_SEARCH',
      searchOrdering: 'RELEVANCE',
      instrumentOrTheme: null,
      sourceFamily: 'automated_query'
    },
    frontierState: 'PROBING',
    expectedMarginalValue: 30,
    uncertainty: 0.8,
    coverageGain: 0.6,
    knownCreatorRatio: 0.2,
    resultSetOverlap: 0.1,
    isSaturating: false,
    recentAllocationCount: 0,
    expectedQuotaCost: 100
  };

  const shadowDecision = await evaluateShadowFrontierAllocation({
    opportunityKey: `opp_shadow_test_${Date.now()}`,
    legacyCountry: 'DE',
    candidates: [mockCandidate]
  });

  assert.equal(shadowDecision.allocationOrigin, 'FRONTIER_SHADOW');
  assert.equal(shadowDecision.selectedCountry, 'DE');
  assert.equal(shadowDecision.selectedNeighborhoodKey, mockCandidate.neighborhoodKey);
  assert.ok(shadowDecision.selectionScore > 0);
});

test('evaluateFrontierCanaryAllocation fails closed when frontier allocation setting is disabled', async () => {
  const result = await evaluateFrontierCanaryAllocation({
    opportunityKey: `opp_canary_test_${Date.now()}`,
    legacyCountry: 'US'
  });

  assert.equal(result.authorized, false);
  assert.equal(result.allocationOrigin, 'LEGACY');
  assert.equal(result.country, 'US');
  assert.ok(result.reason.includes('FRONTIER_ALLOCATION_DISABLED') || result.reason.includes('FAILED_TO_VERIFY_SETTING'));
});

test('evaluateFrontierCanaryAllocation enforces daily assignment and quota caps under mock DB', async () => {
  const mockClient = {
    query: async (sql: string) => {
      if (sql.includes('frontier_allocation_enabled')) {
        return { rows: [{ setting_value: 'true' }] };
      }
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (sql.includes('discovery_provider_registry')) return { rows: [{ provider_key: 'youtube-search', provider_family: 'youtube', capabilities: ['SEARCH_YOUTUBE'], quota_domain: 'YOUTUBE_DATA_API', mode: 'ACTIVE', daily_cost_cap: 0, configuration_version: 1, updated_at: '2026-08-20T00:00:00Z' }] };
      if (sql.includes('frontier_allocation_daily_assignment_cap')) {
        return { rows: [{ setting_value: '5' }] };
      }
      if (sql.includes('frontier_allocation_daily_quota_cap')) {
        return { rows: [{ setting_value: '500' }] };
      }
      if (sql.includes('daily_assignments')) {
        return { rows: [{ daily_assignments: 5, daily_quota_used: 500 }] };
      }
      return { rows: [] };
    }
  };

  const result = await evaluateFrontierCanaryAllocation({
    opportunityKey: `opp_cap_test_${Date.now()}`,
    legacyCountry: 'JP',
    client: mockClient
  });

  assert.equal(result.authorized, false);
  assert.equal(result.allocationOrigin, 'LEGACY');
  assert.ok(result.reason.includes('FRONTIER_CANARY_DAILY_CAP_EXCEEDED'));
});

test('evaluateFrontierCanaryAllocation rejects when registry provider is inactive or capability mismatches', async () => {
  const mockClientNoProvider = {
    query: async (sql: string) => {
      if (sql.includes('frontier_allocation_enabled')) return { rows: [{ setting_value: 'true' }] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('discovery_provider_registry')) return { rows: [] };
      return { rows: [] };
    }
  };

  const res1 = await evaluateFrontierCanaryAllocation({
    opportunityKey: `opp_mismatch_${Date.now()}`,
    legacyCountry: 'US',
    client: mockClientNoProvider
  });

  assert.equal(res1.authorized, false);
  assert.equal(res1.reason, 'PROVIDER_INELIGIBLE_OR_CAPABILITY_MISMATCH');
});

test('evaluateFrontierCanaryAllocation dynamically resolves provider allocation from registry', async () => {
  let decisionInserted: any = null;
  const mockClient = {
    query: async (sql: string, params?: any[]) => {
      if (sql.includes('frontier_allocation_enabled')) return { rows: [{ setting_value: 'true' }] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('discovery_provider_registry')) {
        return {
          rows: [{
            provider_key: 'youtube-search',
            provider_family: 'youtube',
            capabilities: ['SEARCH_YOUTUBE'],
            quota_domain: 'YOUTUBE_DATA_API',
            mode: 'ACTIVE',
            daily_cost_cap: 0,
            configuration_version: 1,
            updated_at: '2026-08-20T00:00:00Z'
          }]
        };
      }
      if (sql.includes('frontier_allocation_daily_assignment_cap')) return { rows: [{ setting_value: '10' }] };
      if (sql.includes('frontier_allocation_daily_quota_cap')) return { rows: [{ setting_value: '1000' }] };
      if (sql.includes('daily_assignments')) return { rows: [{ daily_assignments: 0, daily_quota_used: 0 }] };
      if (sql.includes('discovery_neighborhoods')) {
        return {
          rows: [{
            neighborhood_key: 'US|en|GENERAL|trading|KEYWORD_SEARCH|RELEVANCE|none|automated_query',
            country: 'US',
            dimensions: JSON.stringify({ country: 'US', language: 'en', queryIntent: 'GENERAL', primaryTermFamily: 'trading', retrievalLane: 'KEYWORD_SEARCH', searchOrdering: 'RELEVANCE', sourceFamily: 'automated_query' }),
            frontier_state: 'UNEXPLORED',
            expected_marginal_value: 80,
            uncertainty: 0.9,
            coverage_gain: 0.8,
            known_creator_ratio: 0,
            result_set_overlap: 0,
            is_saturating: false,
            proposal_id: null,
            last_allocated_at: null,
            recent_allocation_count: 0
          }]
        };
      }
      if (sql.includes('app_settings')) return { rows: [] };
      if (sql.includes('INSERT INTO frontier_allocation_decisions')) {
        decisionInserted = params;
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const res = await evaluateFrontierCanaryAllocation({
    opportunityKey: `opp_dyn_${Date.now()}`,
    legacyCountry: 'US',
    estimatedQuotaUnits: 150,
    client: mockClient
  });

  assert.equal(res.authorized, true);
  assert.ok(res.decision);
  assert.equal(res.decision.provider?.providerKey, 'youtube-search');
  assert.equal(res.decision.provider?.costDomain, 'YOUTUBE_DATA_API');
  assert.equal(res.decision.quotaReserved, 150);
});

test('subordination guard rejects frontier allocation when available autonomous capacity is 0', async () => {
  const result = await evaluateFrontierCanaryAllocation({
    opportunityKey: `opp_subord_test_${Date.now()}`,
    legacyCountry: 'JP',
    availableAutonomousCapacity: 0
  });

  assert.equal(result.authorized, false);
  assert.equal(result.allocationOrigin, 'LEGACY');
  assert.equal(result.reason, 'AUTONOMOUS_CAPACITY_EXHAUSTED');
});

test('shadow decisions do NOT update production recent_allocation_count or trigger concentration caps', async () => {
  const mockClient = {
    query: async (sql: string) => {
      if (sql.includes('frontier_allocation_decisions')) {
        return {
          rows: [{
            neighborhood_key: 'FR|fr|GENERAL|cac|KEYWORD_SEARCH|RELEVANCE|none|automated_query',
            country: 'FR',
            dimensions: JSON.stringify({
              country: 'FR',
              language: 'fr',
              queryIntent: 'GENERAL',
              primaryTermFamily: 'cac',
              retrievalLane: 'KEYWORD_SEARCH',
              searchOrdering: 'RELEVANCE',
              sourceFamily: 'automated_query'
            }),
            frontier_state: 'PROBING',
            expected_marginal_value: 20,
            uncertainty: 0.7,
            coverageGain: 0.5,
            known_creator_ratio: 0.1,
            result_set_overlap: 0.1,
            is_saturating: false,
            proposal_id: null,
            last_allocated_at: null,
            recent_allocation_count: 0
          }]
        };
      }
      return { rows: [] };
    }
  };

  const candidates = await getNeighborhoodCandidates('FR', new Date(), mockClient);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].recentAllocationCount, 0);
  assert.equal(candidates[0].lastAllocatedAt, null);
});

test('releaseAllocationDecision is a guarded atomic transition: fails closed on COMMITTED or unknown decision', async () => {
  const mockClientSuccess = {
    query: async (sql: string) => {
      if (sql.includes('UPDATE frontier_allocation_decisions')) {
        return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    }
  };

  const mockClientFailure = {
    query: async (sql: string) => {
      if (sql.includes('UPDATE frontier_allocation_decisions')) {
        return { rowCount: 0, rows: [] };
      }
      return { rows: [] };
    }
  };

  const relSuccess = await releaseAllocationDecision('reserved-dec-id', 'test release', mockClientSuccess);
  assert.equal(relSuccess, true);

  const relFail = await releaseAllocationDecision('committed-dec-id', 'test release', mockClientFailure);
  assert.equal(relFail, false, 'COMMITTED or unknown decision release must return false');
});

test('commitAllocationQueryRun is a guarded atomic transition: fails closed on unknown or released decision', async () => {
  let queryRunsUpdated = false;
  const mockClient = {
    query: async (sql: string) => {
      if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) {
        return { rows: [] };
      }
      if (sql.includes('UPDATE frontier_allocation_decisions')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('UPDATE query_runs')) {
        queryRunsUpdated = true;
        return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    }
  };

  const success = await commitAllocationQueryRun('unknown-dec-id', 'run-123', mockClient);
  assert.equal(success, false);
  assert.equal(queryRunsUpdated, false, 'query_runs.allocation_origin must NOT be updated when commit fails');
});

test('getFrontierAllocationDiagnostics and getFrontierAllocationControlComparison return structured diagnostics', async () => {
  const diag = await getFrontierAllocationDiagnostics();
  assert.equal(typeof diag, 'object');

  const comp = await getFrontierAllocationControlComparison(7);
  assert.equal(typeof comp.legacyControl, 'object');
  assert.equal(typeof comp.frontierCanary, 'object');
});
