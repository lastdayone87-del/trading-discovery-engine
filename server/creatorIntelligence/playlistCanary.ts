import { getDb } from '../db';
import { enqueuePlaylistCanary, PLAYLIST_ADAPTER_POLICY_VERSION, PLAYLIST_PROVIDER_COST } from '../evidenceGraphAdapters';
import { creatorIntelligenceChecksum } from './contracts';
import { allocateCreatorSearchCanary, CREATOR_SEARCH_CANARY_POLICY_VERSION } from './canary';

export const CREATOR_PLAYLIST_CANARY_POLICY_VERSION = 'creator-playlist-canary-v1';

export async function materializeCreatorPlaylistCanary(cutoffAt: string): Promise<{ considered: number; treatment: number; control: number; queued: number; fallback: number }> {
  if (!Number.isFinite(new Date(cutoffAt).getTime())) throw new Error('INVALID_PLAYLIST_CANARY_CUTOFF');
  const db = await getDb();
  const [controlResult, adapterResult] = await Promise.all([
    db.query(`SELECT * FROM creator_search_canary_control WHERE singleton=true`),
    db.query(`SELECT * FROM acquisition_adapter_controls WHERE adapter_type='INSPECT_PLAYLIST'`)
  ]);
  const control = controlResult.rows[0], adapter = adapterResult.rows[0];
  if (!control?.playlist_authority_enabled || Number(control.playlist_rollout_basis_points) <= 0) return { considered: 0, treatment: 0, control: 0, queued: 0, fallback: 0 };
  const rows = await db.query(`SELECT p.id proposal_id,p.proposal_key,p.program_id,p.objective_key,p.objective_version,p.hypothesis_id,p.normalized_target,r.readiness_run_id,l.source_allocation_run_id,cv.objective,f.id frontier_action_id,f.semantic_action_key FROM creator_non_query_shadow_proposals p JOIN creator_non_query_shadow_runs r ON r.id=p.projection_run_id AND r.disposition='COMPLETED' JOIN creator_non_query_shadow_lineage l ON l.proposal_id=p.id JOIN creator_program_contract_versions cv ON cv.program_id=p.program_id AND cv.objective_key=p.objective_key AND cv.objective_version=p.objective_version JOIN LATERAL(SELECT action.* FROM frontier_actions action WHERE action.program_id=p.program_id AND action.action_type='INSPECT_PLAYLIST' AND action.lifecycle='PROPOSED' AND action.validity_start<=$1 AND action.validity_end>$1 AND NOT EXISTS(SELECT 1 FROM creator_playlist_canary_execution_links prior WHERE prior.frontier_action_id=action.id) AND (action.source_query_run_id IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(l.creator_outcome_ids) ids(outcome_id) JOIN creator_outcome_records outcome ON outcome.id=ids.outcome_id::uuid WHERE outcome.query_run_id=action.source_query_run_id)) ORDER BY action.validity_start,action.semantic_action_key LIMIT 1)f ON true WHERE p.acquisition_type='INSPECT_PLAYLIST' AND p.serving_authority=false AND p.execution_propensity_basis_points=0 AND p.proposed_at<=$1 AND NOT EXISTS(SELECT 1 FROM creator_playlist_canary_execution_links prior WHERE prior.proposal_id=p.id) ORDER BY p.proposed_at,p.proposal_key LIMIT 1`, [cutoffAt]);
  if (!rows.rowCount) return { considered: 0, treatment: 0, control: 0, queued: 0, fallback: 0 };
  const proposal = rows.rows[0], objective = typeof proposal.objective === 'string' ? JSON.parse(proposal.objective) : proposal.objective;
  const country = String(objective?.coordinates?.country || '');
  const safetyReasons: string[] = [];
  if (!country) safetyReasons.push('PLAYLIST_COUNTRY_MISSING');
  if (!adapter || adapter.mode !== 'CANARY' || adapter.paused || adapter.kill_switch) safetyReasons.push('PLAYLIST_ADAPTER_DISABLED');
  if (adapter?.policy_version !== PLAYLIST_ADAPTER_POLICY_VERSION) safetyReasons.push('PLAYLIST_ADAPTER_POLICY_MISMATCH');
  const daily = await db.query(`SELECT COUNT(*)::int count FROM acquisition_adapter_runs WHERE adapter_type='INSPECT_PLAYLIST' AND created_at>=date_trunc('day',$1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [cutoffAt]);
  if (adapter && Number(daily.rows[0]?.count) + PLAYLIST_PROVIDER_COST > Number(adapter.daily_quota_cap)) safetyReasons.push('PLAYLIST_ADAPTER_DAILY_CAP');
  if (adapter && Number(adapter.consumed_quota) + PLAYLIST_PROVIDER_COST > Number(adapter.total_quota_cap)) safetyReasons.push('PLAYLIST_ADAPTER_TOTAL_CAP');
  const opportunityKey = creatorIntelligenceChecksum({ proposalKey: proposal.proposal_key, frontierActionId: proposal.frontier_action_id, validityDay: new Date(cutoffAt).toISOString().slice(0, 10), policyVersion: CREATOR_PLAYLIST_CANARY_POLICY_VERSION });
  const assignment = await allocateCreatorSearchCanary({ opportunityKey, country: country || 'UNKNOWN', assignedAt: cutoffAt, estimatedQuotaUnits: PLAYLIST_PROVIDER_COST, requiredProgramId: proposal.program_id, requiredHypothesisId: proposal.hypothesis_id, additionalSafetyReasons: safetyReasons, actionType: 'INSPECT_PLAYLIST', nonQueryProposalId: proposal.proposal_id, rolloutBasisPointsOverride: Number(control.playlist_rollout_basis_points) });
  let disposition: 'CONTROL' | 'QUEUED' | 'ADAPTER_FALLBACK' = 'CONTROL', reasonCodes = assignment.reasonCodes, jobId: string | undefined;
  if (assignment.assignmentStatus === 'CANARY_ALLOCATED') {
    const result = await enqueuePlaylistCanary(proposal.frontier_action_id, country);
    if (result.queued) { disposition = 'QUEUED'; jobId = result.jobId; reasonCodes = ['PLAYLIST_CANARY_QUEUED']; }
    else { disposition = 'ADAPTER_FALLBACK'; reasonCodes = [result.reason || 'PLAYLIST_ADAPTER_FALLBACK']; }
  }
  const lineageReadinessId = assignment.readinessRunId || proposal.readiness_run_id;
  if (!assignment.assignmentId || !lineageReadinessId) throw new Error('PLAYLIST_CANARY_ASSIGNMENT_LINEAGE_MISSING');
  const lineage = { assignmentKey: assignment.assignmentKey, proposalKey: proposal.proposal_key, frontierActionId: proposal.frontier_action_id, readinessRunId: lineageReadinessId, sourceAllocationRunId: proposal.source_allocation_run_id, disposition, reasonCodes, jobId: jobId || null };
  const linkKey = creatorIntelligenceChecksum({ ...lineage, policyVersion: CREATOR_PLAYLIST_CANARY_POLICY_VERSION });
  await db.query(`INSERT INTO creator_playlist_canary_execution_links(link_key,assignment_id,proposal_id,frontier_action_id,job_id,disposition,reason_codes,readiness_run_id,lineage_checksum,policy_version,linked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(link_key) DO NOTHING`, [linkKey, assignment.assignmentId, proposal.proposal_id, proposal.frontier_action_id, jobId || null, disposition, JSON.stringify(reasonCodes), lineageReadinessId, creatorIntelligenceChecksum(lineage), CREATOR_PLAYLIST_CANARY_POLICY_VERSION, cutoffAt]);
  return { considered: 1, treatment: assignment.assignmentStatus === 'CANARY_ALLOCATED' ? 1 : 0, control: assignment.arm === 'CONTROL' ? 1 : 0, queued: disposition === 'QUEUED' ? 1 : 0, fallback: disposition === 'ADAPTER_FALLBACK' ? 1 : 0 };
}
