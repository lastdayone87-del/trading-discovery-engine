import { getDb } from '../db';
import { creatorIntelligenceChecksum, type CreatorDiscoveryObjective, type CreatorProgramLifecycle } from './contracts';
import { allocateCreatorSearchCanary, CREATOR_SEARCH_CANARY_POLICY_VERSION, type CreatorCanaryAssignment } from './canary';
import { evaluateFrontierCanaryAllocation, type AllocationDecision, type GeographicAllocationIntent } from '../discoveryFrontierAllocator';
import type { DiscoveryNeighborhoodDimensions } from '../discoveryNeighborhood';

export const CREATOR_SEARCH_AUTHORITY_POLICY_VERSION = 'creator-search-allocation-authority-v1';

export interface CreatorAuthorityCandidate {
  programId: string;
  programKey: string;
  objective: CreatorDiscoveryObjective;
  hypothesisId: string;
  hypothesisConfidence: number;
  country: string;
  lifecycle: CreatorProgramLifecycle;
  frontierSnapshotId: string;
  frontierState: string;
  frontierUncertainty: number;
  estimatedUnexploredCoverage: number | null;
  marginalVerifiedYield: number;
  providerBudgetRemaining: number;
  dailyAllocationRemaining: number;
  evidenceKeys: string[];
}

export interface CreatorAuthorityPriority {
  candidate: CreatorAuthorityCandidate;
  lifecycleDecision: 'ACTIVE' | 'SLEEP' | 'STOP' | 'REACTIVATE';
  priority: number;
  eligible: boolean;
  reasonCodes: string[];
}

export function prioritizeCreatorSearchPrograms(candidates: CreatorAuthorityCandidate[]): CreatorAuthorityPriority[] {
  return [...candidates].map(candidate => {
    const reasons: string[] = [];
    let lifecycleDecision: CreatorAuthorityPriority['lifecycleDecision'];
    if (candidate.providerBudgetRemaining <= 0 || candidate.dailyAllocationRemaining <= 0) {
      lifecycleDecision = 'STOP'; reasons.push('PROGRAM_BUDGET_EXHAUSTED');
    } else if (['COMPLETE', 'SATURATED', 'PAUSED', 'DRAFT'].includes(candidate.lifecycle)) {
      lifecycleDecision = 'STOP'; reasons.push(`PROGRAM_${candidate.lifecycle}`);
    } else if (candidate.lifecycle === 'SLEEPING') {
      const changed = ['UNEXPLORED', 'PARTIALLY_OBSERVED', 'UNKNOWN'].includes(candidate.frontierState) && candidate.frontierUncertainty >= .5;
      lifecycleDecision = changed ? 'REACTIVATE' : 'SLEEP'; reasons.push(changed ? 'FRONTIER_UNCERTAINTY_REACTIVATED' : 'SLEEP_CONDITIONS_RETAINED');
    } else if (candidate.frontierState === 'SLEEPING' || (candidate.frontierState === 'OBSERVED' && candidate.frontierUncertainty < .2 && candidate.estimatedUnexploredCoverage === 0)) {
      lifecycleDecision = 'SLEEP'; reasons.push('COVERAGE_SATURATED_OR_SLEEPING');
    } else {
      lifecycleDecision = 'ACTIVE'; reasons.push('PROGRAM_FRONTIER_ELIGIBLE');
    }
    const unexplored = candidate.estimatedUnexploredCoverage === null ? candidate.frontierUncertainty : Math.min(1, candidate.estimatedUnexploredCoverage / 10);
    const priority = Number((candidate.frontierUncertainty * .4 + unexplored * .25 + (1 - Math.min(1, candidate.marginalVerifiedYield)) * .15 + candidate.hypothesisConfidence * .2).toFixed(6));
    return { candidate, lifecycleDecision, priority, eligible: lifecycleDecision === 'ACTIVE' || lifecycleDecision === 'REACTIVATE', reasonCodes: reasons };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.priority - a.priority || a.candidate.programKey.localeCompare(b.candidate.programKey) || a.candidate.hypothesisId.localeCompare(b.candidate.hypothesisId));
}

export async function allocateCreatorSearchAuthority(input: {
  opportunityKey: string;
  legacyCountry: string;
  allowedCountries: string[];
  assignedAt: string;
  estimatedQuotaUnits?: number;
  availableAutonomousCapacity?: number;
  targetProviderKey?: string;
  requiredCapability?: string;
  allowShadowProvider?: boolean;
  geographicAllocationIntent: GeographicAllocationIntent;
}): Promise<{
  country: string;
  assignment?: CreatorCanaryAssignment;
  authorityDecisionKey?: string;
  legacyFallback: boolean;
  frontierAllocation?: {
    authorized: boolean;
    allocationOrigin: 'FRONTIER_CANARY' | 'LEGACY';
    targetNeighborhoodDimensions?: DiscoveryNeighborhoodDimensions;
    decision?: AllocationDecision;
  };
}> {
  // 1. Evaluate Bounded Frontier Neighborhood Canary Authority
  const frontierResult = await evaluateFrontierCanaryAllocation({
    opportunityKey: input.opportunityKey,
    legacyCountry: input.legacyCountry,
    allowedCountries: input.allowedCountries,
    estimatedQuotaUnits: input.estimatedQuotaUnits,
    availableAutonomousCapacity: input.availableAutonomousCapacity,
    targetProviderKey: input.targetProviderKey,
    requiredCapability: input.requiredCapability,
    allowShadowProvider: input.allowShadowProvider,
    geographicAllocationIntent: input.geographicAllocationIntent,
    now: input.assignedAt ? new Date(input.assignedAt) : new Date()
  }).catch(error => ({
    authorized: false,
    allocationOrigin: 'LEGACY' as const,
    country: input.legacyCountry,
    reason: `FRONTIER_CANARY_EVALUATION_ERROR: ${error instanceof Error ? error.message : String(error)}`
  }));

  if (frontierResult.authorized && 'targetNeighborhoodDimensions' in frontierResult && frontierResult.targetNeighborhoodDimensions) {
    const decision = 'decision' in frontierResult ? frontierResult.decision : undefined;
    return {
      country: frontierResult.country,
      assignment: undefined,
      legacyFallback: false,
      frontierAllocation: {
        authorized: true,
        allocationOrigin: 'FRONTIER_CANARY',
        targetNeighborhoodDimensions: frontierResult.targetNeighborhoodDimensions,
        decision
      }
    };
  }

  // 2. Creator Intelligence Top-Level Search Authority Fallback / Control Path
  const db = await getDb();
  const controlResult = await db.query(`SELECT * FROM creator_search_canary_control WHERE singleton=true`);
  const control = controlResult.rows[0];
  if (!control?.top_level_authority_enabled) {
    const assignment = await allocateCreatorSearchCanary({ opportunityKey: input.opportunityKey, country: input.legacyCountry, assignedAt: input.assignedAt, estimatedQuotaUnits: input.estimatedQuotaUnits });
    return { country: input.legacyCountry, assignment, legacyFallback: assignment.assignmentStatus !== 'CANARY_ALLOCATED' };
  }
  const allowed = [...new Set(input.allowedCountries.map(country => country.normalize('NFKC').trim().toLocaleLowerCase('en')).filter(Boolean))].sort();
  const readiness = await db.query(`SELECT * FROM creator_readiness_shadow_runs WHERE cutoff_at<=$1 AND result='PASS' ORDER BY cutoff_at DESC,created_at DESC LIMIT 1`, [input.assignedAt]);
  const readinessRow = readiness.rows[0];
  const rows = await db.query(`SELECT p.id program_id,p.program_key,cv.objective,cv.budget,cv.creator_lifecycle,h.id hypothesis_id,h.confidence_basis_points,f.id frontier_snapshot_id,f.frontier_key,f.state frontier_state,f.uncertainty frontier_uncertainty,f.estimated_unexplored,c.marginal_verified_yield,l.daily_allocation_cap,l.daily_quota_cap,COALESCE(total_usage.quota,0)::int total_quota_used,COALESCE(daily_usage.allocations,0)::int daily_allocations FROM research_programs p JOIN creator_search_canary_program_limits l ON l.program_id=p.id AND l.enabled=true AND l.policy_version=$2 JOIN LATERAL(SELECT objective,budget,creator_lifecycle FROM creator_program_contract_versions WHERE program_id=p.id AND effective_at<=$1 ORDER BY objective_version DESC,effective_at DESC LIMIT 1)cv ON true JOIN LATERAL(SELECT id,confidence_basis_points FROM discovery_hypotheses WHERE program_id=p.id AND lifecycle IN('PROPOSED','VALIDATED','TRIAL','PROVEN') AND created_at<=$1 ORDER BY confidence_basis_points DESC,hypothesis_key LIMIT 1)h ON true JOIN LATERAL(SELECT id,frontier_key,target_key,state,uncertainty,estimated_unexplored FROM creator_frontier_shadow_snapshots WHERE program_id=p.id AND as_of<=$1 AND as_of>=$1::timestamptz-($3||' hours')::interval ORDER BY CASE state WHEN 'UNEXPLORED' THEN 0 WHEN 'PARTIALLY_OBSERVED' THEN 1 WHEN 'UNKNOWN' THEN 2 ELSE 3 END,uncertainty DESC,target_key LIMIT 1)f ON true LEFT JOIN LATERAL(SELECT marginal_verified_yield FROM creator_coverage_shadow_snapshots WHERE program_id=p.id AND target_key=f.target_key AND as_of<=$1 ORDER BY as_of DESC,id DESC LIMIT 1)c ON true LEFT JOIN LATERAL(SELECT COALESCE(SUM(estimated_quota_units),0)::int quota FROM creator_search_canary_assignments WHERE assignment_status='CANARY_ALLOCATED' AND program_id=p.id)total_usage ON true LEFT JOIN LATERAL(SELECT COUNT(*)::int allocations FROM creator_search_canary_assignments WHERE assignment_status='CANARY_ALLOCATED' AND program_id=p.id AND assigned_at>=date_trunc('day',$1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')daily_usage ON true WHERE p.creator_shadow_only=true AND p.mode='SHADOW' AND p.activation_enabled=false ORDER BY p.program_key`, [input.assignedAt, CREATOR_SEARCH_CANARY_POLICY_VERSION, String(Number(control.maximum_readiness_age_hours || 24))]);
  const candidates: CreatorAuthorityCandidate[] = rows.rows.map((row: any) => {
    const objective: CreatorDiscoveryObjective = typeof row.objective === 'string' ? JSON.parse(row.objective) : row.objective;
    const budget = typeof row.budget === 'string' ? JSON.parse(row.budget) : row.budget;
    return { programId: row.program_id, programKey: row.program_key, objective, hypothesisId: row.hypothesis_id, hypothesisConfidence: Number(row.confidence_basis_points) / 10000, country: String(objective.coordinates.country || ''), lifecycle: row.creator_lifecycle, frontierSnapshotId: row.frontier_snapshot_id, frontierState: row.frontier_state, frontierUncertainty: Number(row.frontier_uncertainty), estimatedUnexploredCoverage: row.estimated_unexplored === null ? null : Number(row.estimated_unexplored), marginalVerifiedYield: Number(row.marginal_verified_yield || 0), providerBudgetRemaining: Math.max(0, Number(budget?.providerUnits || row.daily_quota_cap) - Number(row.total_quota_used)), dailyAllocationRemaining: Math.max(0, Number(row.daily_allocation_cap) - Number(row.daily_allocations)), evidenceKeys: [row.frontier_key, `hypothesis:${row.hypothesis_id}`, `readiness:${readinessRow?.readiness_key || 'missing'}`] };
  }).filter(candidate => allowed.includes(candidate.country.normalize('NFKC').trim().toLocaleLowerCase('en')));
  const priorities = prioritizeCreatorSearchPrograms(candidates), selected = priorities.find(priority => priority.eligible);
  const client = await db.connect();
  let authorityDecisionId: string | undefined, authorityDecisionKey: string | undefined;
  try {
    await client.query('BEGIN');
    for (const priority of priorities) {
      if (!readinessRow) break;
      const evidenceChecksum = creatorIntelligenceChecksum({ candidate: priority.candidate, lifecycleDecision: priority.lifecycleDecision, priority: priority.priority, readinessKey: readinessRow.readiness_key, allowed });
      const decisionKey = creatorIntelligenceChecksum({ opportunityKey: input.opportunityKey, programId: priority.candidate.programId, evidenceChecksum, policyVersion: CREATOR_SEARCH_AUTHORITY_POLICY_VERSION });
      const saved = await client.query(`INSERT INTO creator_search_program_authority_decisions(decision_key,opportunity_key,program_id,objective_key,objective_version,hypothesis_id,country,lifecycle_decision,frontier_priority,provider_budget_remaining,daily_allocation_remaining,frontier_snapshot_id,readiness_run_id,evidence_checksum,reason_codes,policy_version,serving_authority,decided_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,false,$17) ON CONFLICT(decision_key) DO NOTHING RETURNING id`, [decisionKey, input.opportunityKey, priority.candidate.programId, priority.candidate.objective.objectiveKey, priority.candidate.objective.version, priority.candidate.hypothesisId, priority.candidate.country, priority.lifecycleDecision, priority.priority, priority.candidate.providerBudgetRemaining, priority.candidate.dailyAllocationRemaining, priority.candidate.frontierSnapshotId, readinessRow.id, evidenceChecksum, JSON.stringify(priority.reasonCodes), CREATOR_SEARCH_AUTHORITY_POLICY_VERSION, input.assignedAt]);
      if (selected?.candidate.programId === priority.candidate.programId && selected.candidate.hypothesisId === priority.candidate.hypothesisId) {
        authorityDecisionKey = decisionKey;
        authorityDecisionId = saved.rows[0]?.id || (await client.query(`SELECT id FROM creator_search_program_authority_decisions WHERE decision_key=$1`, [decisionKey])).rows[0]?.id;
      }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const safetyReasons = selected && readinessRow ? [] : ['NO_ELIGIBLE_TOP_LEVEL_PROGRAM'];
  const targetCountry = selected?.candidate.country || input.legacyCountry;
  const assignment = await allocateCreatorSearchCanary({ opportunityKey: input.opportunityKey, country: targetCountry, assignedAt: input.assignedAt, estimatedQuotaUnits: input.estimatedQuotaUnits, requiredProgramId: selected?.candidate.programId, additionalSafetyReasons: safetyReasons });
  if (assignment.assignmentId && authorityDecisionId) {
    const linkKey = creatorIntelligenceChecksum({ authorityDecisionKey, assignmentKey: assignment.assignmentKey, policyVersion: CREATOR_SEARCH_AUTHORITY_POLICY_VERSION });
    const executedCountry = assignment.assignmentStatus === 'CANARY_ALLOCATED' ? targetCountry : input.legacyCountry;
    await db.query(`INSERT INTO creator_search_authority_assignment_links(link_key,authority_decision_id,canary_assignment_id,legacy_country,treatment_country,executed_country,policy_version,linked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(link_key) DO NOTHING`, [linkKey, authorityDecisionId, assignment.assignmentId, input.legacyCountry, targetCountry, executedCountry, CREATOR_SEARCH_AUTHORITY_POLICY_VERSION, input.assignedAt]);
  }
  const treatment = assignment.assignmentStatus === 'CANARY_ALLOCATED';
  return { country: treatment ? targetCountry : input.legacyCountry, assignment, authorityDecisionKey, legacyFallback: !treatment };
}
