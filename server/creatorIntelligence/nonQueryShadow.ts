import { getDb } from '../db';
import {
  CREATOR_NON_QUERY_SHADOW_ACTIONS,
  creatorIntelligenceChecksum,
  type CreatorDiscoveryObjective,
  type CreatorNonQueryShadowActionType,
  type CreatorNonQueryShadowProposal
} from './contracts';
import { CREATOR_READINESS_POLICY_VERSION } from './readiness';

export const CREATOR_NON_QUERY_SHADOW_POLICY_VERSION = 'creator-non-query-shadow-v1';
export const CREATOR_NON_QUERY_SHADOW_PROJECTION_VERSION = 'creator-non-query-projection-v1';

export interface NonQueryProposalEvidence {
  programId: string;
  objective: CreatorDiscoveryObjective;
  hypothesisId: string;
  hypothesisConfidence: number;
  sourceFamilyIds: string[];
  targetAccountId: string;
  unresolvedIdentity: boolean;
  frontierTargetKey: string;
  frontierUncertainty: number;
  estimatedUnexploredCoverage: number | null;
  sourceEventKeys: string[];
  creatorOutcomeIds: string[];
  coverageSnapshotIds: string[];
  proposedAt: string;
}

const policy: Record<CreatorNonQueryShadowActionType, { providerKey: string; creatorValue: number; coverage: number; information: number; cost: number; review: number }> = {
  INSPECT_PLAYLIST: { providerKey: 'youtube-playlist-shadow', creatorValue: .45, coverage: .35, information: .45, cost: 1, review: .1 },
  INSPECT_FEATURED_CHANNELS: { providerKey: 'youtube-featured-shadow', creatorValue: .55, coverage: .5, information: .5, cost: 1, review: .1 },
  INSPECT_COLLABORATOR: { providerKey: 'youtube-collaborator-shadow', creatorValue: .6, coverage: .55, information: .6, cost: 1, review: .2 },
  INSPECT_WEBSITE_AUTHOR: { providerKey: 'website-author-shadow', creatorValue: .35, coverage: .25, information: .7, cost: 2, review: .3 },
  RESOLVE_EXTERNAL_ENTITY: { providerKey: 'structured-identity-shadow', creatorValue: .3, coverage: .2, information: .8, cost: 2, review: .4 }
};

export function proposeShadowNonQueryActions(evidence: NonQueryProposalEvidence): CreatorNonQueryShadowProposal[] {
  if (!evidence.sourceFamilyIds.length || !evidence.sourceEventKeys.length || !evidence.targetAccountId.trim()) throw new Error('NON_QUERY_PROPOSAL_EVIDENCE_REQUIRED');
  const types = CREATOR_NON_QUERY_SHADOW_ACTIONS.filter(type => type !== 'RESOLVE_EXTERNAL_ENTITY' || evidence.unresolvedIdentity);
  return types.map(actionType => {
    const parameters = policy[actionType];
    const expectedCoverageGain = parameters.coverage * Math.max(evidence.frontierUncertainty, evidence.estimatedUnexploredCoverage === null ? 0 : Math.min(1, evidence.estimatedUnexploredCoverage / 10));
    const expectedInformationGain = parameters.information * evidence.frontierUncertainty;
    const expectedUncertaintyReduction = Math.min(evidence.frontierUncertainty, expectedInformationGain * evidence.hypothesisConfidence);
    const supportingEvidence = [...new Set([...evidence.sourceEventKeys, ...evidence.creatorOutcomeIds.map(id => `creator-outcome:${id}`), ...evidence.coverageSnapshotIds.map(id => `coverage-snapshot:${id}`), `frontier:${evidence.frontierTargetKey}`])].sort();
    const actionId = creatorIntelligenceChecksum({ programId: evidence.programId, objectiveKey: evidence.objective.objectiveKey, objectiveVersion: evidence.objective.version, hypothesisId: evidence.hypothesisId, actionType, target: evidence.targetAccountId, proposedAt: evidence.proposedAt, policyVersion: CREATOR_NON_QUERY_SHADOW_POLICY_VERSION });
    return {
      actionId, programId: evidence.programId, objectiveKey: evidence.objective.objectiveKey, actionType,
      providerKey: parameters.providerKey, target: evidence.targetAccountId, coordinates: evidence.objective.coordinates,
      sourceFamilyIds: [...new Set(evidence.sourceFamilyIds)].sort(), hypothesisId: evidence.hypothesisId,
      expectedIncrementalCreators: parameters.creatorValue * evidence.hypothesisConfidence,
      expectedInformationGain, expectedCoverageGain, expectedUncertaintyReduction,
      uncertainty: evidence.frontierUncertainty, expectedCost: { providerUnits: parameters.cost, reviewUnits: parameters.review },
      confidence: Math.max(0, Math.min(1, evidence.hypothesisConfidence * (1 - evidence.frontierUncertainty * .25))),
      supportingEvidence, executionPropensityBasisPoints: 0 as const,
      provenance: { projectionVersion: CREATOR_NON_QUERY_SHADOW_PROJECTION_VERSION, counterfactualOnly: true, noMaterialization: true, frontierTargetKey: evidence.frontierTargetKey },
      proposedAt: new Date(evidence.proposedAt).toISOString(), policyVersion: CREATOR_NON_QUERY_SHADOW_POLICY_VERSION, servingAuthority: false as const
    };
  }).sort((a, b) => a.actionType.localeCompare(b.actionType));
}

export async function projectShadowNonQueryActions(cutoffAt: string): Promise<{ runId: string; disposition: 'COMPLETED' | 'ABSTAIN'; proposals: number; idempotent: boolean; servingAuthority: false }> {
  if (!Number.isFinite(new Date(cutoffAt).getTime())) throw new Error('INVALID_NON_QUERY_SHADOW_CUTOFF');
  const db = await getDb();
  const controlResult = await db.query(`SELECT * FROM creator_non_query_shadow_control WHERE singleton=true`), control = controlResult.rows[0];
  if (!control?.enabled || control.mode !== 'SHADOW') throw new Error('CREATOR_NON_QUERY_SHADOW_DISABLED');
  const readiness = await db.query(`SELECT * FROM creator_readiness_shadow_runs WHERE cutoff_at<=$1 ORDER BY cutoff_at DESC,created_at DESC LIMIT 1`, [cutoffAt]), readinessRow = readiness.rows[0];
  const guards = readinessRow?.allocation_run_id ? await db.query(`SELECT id,metric,result,attribution_completeness,policy_version FROM creator_guardrail_shadow_snapshots WHERE allocation_run_id=$1 ORDER BY metric`, [readinessRow.allocation_run_id]) : { rows: [], rowCount: 0 };
  const reasons: string[] = [];
  if (control.policy_version !== CREATOR_NON_QUERY_SHADOW_POLICY_VERSION) reasons.push('PROJECTION_POLICY_MISMATCH');
  if (!readinessRow || readinessRow.result !== 'PASS') reasons.push('READINESS_NOT_PASS');
  if (readinessRow?.policy_version !== CREATOR_READINESS_POLICY_VERSION) reasons.push('READINESS_POLICY_MISMATCH');
  if (readinessRow && !readinessRow.allocation_run_id) reasons.push('ALLOCATION_LINEAGE_MISSING');
  if (readinessRow && new Date(cutoffAt).getTime() - new Date(readinessRow.cutoff_at).getTime() > Number(control.maximum_readiness_age_hours) * 3600000) reasons.push('READINESS_STALE');
  if (guards.rowCount !== 8 || guards.rows.some((row: any) => row.result !== 'PASS')) reasons.push('GUARDRAILS_NOT_PASS');
  if (guards.rows.some((row: any) => Number(row.attribution_completeness) < 1)) reasons.push('ATTRIBUTION_INCOMPLETE');
  if (guards.rows.some((row: any) => row.policy_version !== CREATOR_READINESS_POLICY_VERSION)) reasons.push('GUARDRAIL_POLICY_MISMATCH');
  const programs = reasons.length ? { rows: [], rowCount: 0 } : await db.query(`SELECT p.id program_id,cv.objective,h.id hypothesis_id,h.confidence_basis_points,h.source_family_ids,f.target_key,f.uncertainty,f.estimated_unexplored,c.id coverage_snapshot_id FROM research_programs p JOIN LATERAL(SELECT objective FROM creator_program_contract_versions WHERE program_id=p.id AND effective_at<=$1 ORDER BY objective_version DESC,effective_at DESC LIMIT 1)cv ON true JOIN LATERAL(SELECT id,confidence_basis_points,source_family_ids FROM discovery_hypotheses WHERE program_id=p.id AND lifecycle IN('PROPOSED','VALIDATED','TRIAL','PROVEN') AND created_at<=$1 ORDER BY confidence_basis_points DESC,hypothesis_key LIMIT 1)h ON true JOIN LATERAL(SELECT target_key,uncertainty,estimated_unexplored FROM creator_frontier_shadow_snapshots WHERE program_id=p.id AND as_of<=$1 ORDER BY uncertainty DESC,target_key LIMIT 1)f ON true JOIN LATERAL(SELECT id FROM creator_coverage_shadow_snapshots WHERE program_id=p.id AND target_key=f.target_key AND as_of<=$1 ORDER BY as_of DESC,id DESC LIMIT 1)c ON true WHERE p.creator_shadow_only=true ORDER BY p.program_key`, [cutoffAt]);
  const inputs: NonQueryProposalEvidence[] = [];
  for (const program of programs.rows) {
    const outcomes = await db.query(`SELECT o.id,o.channel_id,o.identity_confidence,o.evidence FROM creator_program_query_run_links l JOIN creator_outcome_records o ON o.query_run_id=l.query_run_id WHERE l.program_id=$1 AND l.attribution_basis='EXPLICIT' AND l.observed_at<=$2 AND o.effective_at<=$2 ORDER BY CASE o.identity_confidence WHEN 'UNRESOLVED' THEN 0 ELSE 1 END,o.effective_at DESC,o.outcome_key LIMIT 2`, [program.program_id, cutoffAt]);
    const resolved = outcomes.rows.find((row: any) => row.identity_confidence === 'CONFIRMED') || outcomes.rows[0];
    const unresolved = outcomes.rows.find((row: any) => row.identity_confidence !== 'CONFIRMED');
    for (const subject of [resolved, ...(unresolved && unresolved.id !== resolved?.id ? [unresolved] : [])].filter(Boolean)) {
      const evidence = typeof subject.evidence === 'string' ? JSON.parse(subject.evidence) : subject.evidence;
      inputs.push({ programId: program.program_id, objective: typeof program.objective === 'string' ? JSON.parse(program.objective) : program.objective, hypothesisId: program.hypothesis_id, hypothesisConfidence: Number(program.confidence_basis_points) / 10000, sourceFamilyIds: Array.isArray(program.source_family_ids) ? program.source_family_ids.map(String) : [], targetAccountId: subject.channel_id, unresolvedIdentity: subject.identity_confidence !== 'CONFIRMED', frontierTargetKey: program.target_key, frontierUncertainty: Number(program.uncertainty), estimatedUnexploredCoverage: program.estimated_unexplored === null ? null : Number(program.estimated_unexplored), sourceEventKeys: Array.isArray(evidence?.sourceEventKeys) ? evidence.sourceEventKeys.map(String) : [], creatorOutcomeIds: outcomes.rows.map((row: any) => row.id), coverageSnapshotIds: [program.coverage_snapshot_id], proposedAt: new Date(cutoffAt).toISOString() });
    }
  }
  const proposals = inputs.flatMap(input => proposeShadowNonQueryActions(input));
  if (!proposals.length && !reasons.length) reasons.push('NO_ATTRIBUTABLE_CREATOR_EVIDENCE');
  const disposition: 'COMPLETED' | 'ABSTAIN' = reasons.length ? 'ABSTAIN' : 'COMPLETED';
  const inputChecksum = creatorIntelligenceChecksum({ cutoffAt, readiness: readinessRow || null, guardrails: guards.rows, inputs, projectionVersion: CREATOR_NON_QUERY_SHADOW_PROJECTION_VERSION });
  const outputChecksum = creatorIntelligenceChecksum({ disposition, reasons: [...new Set(reasons)].sort(), proposals });
  const runKey = creatorIntelligenceChecksum({ cutoffAt, inputChecksum, outputChecksum, policyVersion: CREATOR_NON_QUERY_SHADOW_POLICY_VERSION });
  const existing = await db.query(`SELECT id FROM creator_non_query_shadow_runs WHERE run_key=$1`, [runKey]);
  if (existing.rowCount) return { runId: existing.rows[0].id, disposition, proposals: proposals.length, idempotent: true, servingAuthority: false };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(`INSERT INTO creator_non_query_shadow_runs(run_key,cutoff_at,readiness_run_id,source_allocation_run_id,disposition,reason_codes,input_checksum,output_checksum,input_count,proposal_count,policy_version,serving_authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false) ON CONFLICT(run_key) DO NOTHING RETURNING id`, [runKey, cutoffAt, readinessRow?.id || null, readinessRow?.allocation_run_id || null, disposition, JSON.stringify([...new Set(reasons)].sort()), inputChecksum, outputChecksum, inputs.length, disposition === 'COMPLETED' ? proposals.length : 0, CREATOR_NON_QUERY_SHADOW_POLICY_VERSION]);
    const runId = run.rows[0]?.id || (await client.query(`SELECT id FROM creator_non_query_shadow_runs WHERE run_key=$1`, [runKey])).rows[0].id;
    if (run.rowCount && disposition === 'COMPLETED') {
      for (const proposal of proposals) {
        const proposalKey = creatorIntelligenceChecksum({ actionId: proposal.actionId, runKey, policyVersion: proposal.policyVersion });
        const saved = await client.query(`INSERT INTO creator_non_query_shadow_proposals(proposal_key,projection_run_id,program_id,objective_key,objective_version,hypothesis_id,acquisition_type,provider_key,normalized_target,expected_creator_value,expected_coverage_gain,expected_information_gain,expected_uncertainty_reduction,estimated_provider_cost,estimated_review_cost,confidence,supporting_evidence,provenance,execution_propensity_basis_points,policy_version,serving_authority,proposed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,0,$19,false,$20) RETURNING id`, [proposalKey, runId, proposal.programId, proposal.objectiveKey, inputs.find(input => input.programId === proposal.programId)?.objective.version, proposal.hypothesisId, proposal.actionType, proposal.providerKey, proposal.target, proposal.expectedIncrementalCreators, proposal.expectedCoverageGain, proposal.expectedInformationGain, proposal.expectedUncertaintyReduction, proposal.expectedCost.providerUnits, proposal.expectedCost.reviewUnits, proposal.confidence, JSON.stringify(proposal.supportingEvidence), JSON.stringify(proposal.provenance), proposal.policyVersion, proposal.proposedAt]);
        const source = inputs.find(input => input.programId === proposal.programId && input.targetAccountId === proposal.target)!;
        const sourceAssignments = await client.query(`SELECT a.id FROM creator_search_canary_assignments a JOIN creator_search_canary_query_run_bindings b ON b.assignment_id=a.id JOIN creator_program_query_run_links l ON l.query_run_id=b.query_run_id AND l.program_id=$1 WHERE a.assigned_at<=$2 ORDER BY a.assigned_at,a.assignment_key`, [proposal.programId, cutoffAt]);
        const lineage = { readinessRunId: readinessRow.id, allocationRunId: readinessRow.allocation_run_id, guardrailSnapshotIds: guards.rows.map((row: any) => row.id), sourceAssignmentIds: sourceAssignments.rows.map((row: any) => row.id), creatorOutcomeIds: source.creatorOutcomeIds, coverageSnapshotIds: source.coverageSnapshotIds, sourceEventKeys: source.sourceEventKeys, proposalKey };
        await client.query(`INSERT INTO creator_non_query_shadow_lineage(proposal_id,readiness_run_id,source_allocation_run_id,guardrail_snapshot_ids,source_assignment_ids,creator_outcome_ids,coverage_snapshot_ids,source_event_keys,lineage_checksum,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [saved.rows[0].id, readinessRow.id, readinessRow.allocation_run_id, JSON.stringify(lineage.guardrailSnapshotIds), JSON.stringify(lineage.sourceAssignmentIds), JSON.stringify(lineage.creatorOutcomeIds), JSON.stringify(lineage.coverageSnapshotIds), JSON.stringify(lineage.sourceEventKeys), creatorIntelligenceChecksum(lineage), CREATOR_NON_QUERY_SHADOW_POLICY_VERSION]);
      }
    }
    await client.query('COMMIT');
    return { runId, disposition, proposals: disposition === 'COMPLETED' ? proposals.length : 0, idempotent: !run.rowCount, servingAuthority: false };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
