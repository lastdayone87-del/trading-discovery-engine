import { getDb } from '../db';
import { creatorIntelligenceChecksum } from './contracts';

export const CREATOR_PLAYLIST_LINEAGE_RECONCILIATION_POLICY_VERSION = 'creator-playlist-lineage-reconciliation-v1';
const CREATOR_PLAYLIST_CANARY_POLICY_VERSION = 'creator-playlist-canary-v1';

export interface PlaylistLineageCandidate {
  frontierActionId: string;
  semanticActionKey: string;
  jobId: string;
  jobIdempotencyKey: string;
  adapterRunId?: string;
}

export interface PlaylistLineageResolution {
  result: 'PASS' | 'ABSTAIN';
  reasonCodes: string[];
  candidate?: PlaylistLineageCandidate;
  evidenceChecksum: string;
}

/** Pure conservative resolver: a link is recoverable only from one fully matching durable path. */
export function resolvePlaylistLineage(candidates: PlaylistLineageCandidate[]): PlaylistLineageResolution {
  const normalized = [...candidates].sort((a, b) => a.frontierActionId.localeCompare(b.frontierActionId) || a.jobId.localeCompare(b.jobId));
  const evidenceChecksum = creatorIntelligenceChecksum(normalized);
  if (!normalized.length) return { result: 'ABSTAIN', reasonCodes: ['PLAYLIST_LINEAGE_EVIDENCE_INCOMPLETE'], evidenceChecksum };
  if (normalized.length !== 1) return { result: 'ABSTAIN', reasonCodes: ['PLAYLIST_LINEAGE_EVIDENCE_AMBIGUOUS'], evidenceChecksum };
  const candidate = normalized[0];
  if (!candidate.frontierActionId || !candidate.semanticActionKey || !candidate.jobId || candidate.jobIdempotencyKey !== `playlist:${candidate.semanticActionKey}`) {
    return { result: 'ABSTAIN', reasonCodes: ['PLAYLIST_LINEAGE_EVIDENCE_INCONSISTENT'], evidenceChecksum };
  }
  return { result: 'PASS', reasonCodes: ['PLAYLIST_LINEAGE_DETERMINISTICALLY_RECONSTRUCTED'], candidate, evidenceChecksum };
}

export interface PlaylistLineageReconciliationRun {
  enabled: boolean;
  considered: number;
  reconciled: number;
  abstained: number;
  result: 'PASS' | 'ABSTAIN';
  eventKeys: string[];
  sourceChecksums: string[];
}

export async function reconcileCreatorPlaylistLineage(cutoffAt: string): Promise<PlaylistLineageReconciliationRun> {
  if (!Number.isFinite(new Date(cutoffAt).getTime())) throw new Error('INVALID_PLAYLIST_LINEAGE_RECONCILIATION_CUTOFF');
  const cutoff = new Date(cutoffAt).toISOString(), db = await getDb();
  const control = (await db.query(`SELECT * FROM creator_playlist_lineage_reconciliation_control WHERE singleton=true`)).rows[0];
  if (!control?.enabled || control.policy_version !== CREATOR_PLAYLIST_LINEAGE_RECONCILIATION_POLICY_VERSION) {
    const reasons = !control?.enabled ? ['PLAYLIST_LINEAGE_RECONCILIATION_DISABLED'] : ['PLAYLIST_LINEAGE_RECONCILIATION_POLICY_MISMATCH'];
    const evidenceChecksum = creatorIntelligenceChecksum({ control: control || null, cutoff });
    const eventKey = creatorIntelligenceChecksum({ cutoff, reasons, evidenceChecksum, policyVersion: CREATOR_PLAYLIST_LINEAGE_RECONCILIATION_POLICY_VERSION });
    await db.query(`INSERT INTO creator_playlist_lineage_reconciliation_events(event_key,result,reason_codes,candidate_count,evidence_checksum,detail,cutoff_at,policy_version,serving_authority) VALUES($1,'ABSTAIN',$2,0,$3,$4,$5,$6,false) ON CONFLICT(event_key) DO NOTHING`, [eventKey, JSON.stringify(reasons), evidenceChecksum, JSON.stringify({ enabled: !!control?.enabled }), cutoff, CREATOR_PLAYLIST_LINEAGE_RECONCILIATION_POLICY_VERSION]);
    return { enabled: false, considered: 0, reconciled: 0, abstained: 1, result: 'ABSTAIN', eventKeys: [eventKey], sourceChecksums: [evidenceChecksum] };
  }
  const assignments = await db.query(`SELECT a.*,p.proposal_key,p.program_id proposal_program_id,p.objective_key proposal_objective_key,p.objective_version proposal_objective_version,p.hypothesis_id proposal_hypothesis_id,l.source_allocation_run_id FROM creator_search_canary_assignments a JOIN creator_non_query_shadow_proposals p ON p.id=a.non_query_proposal_id AND p.acquisition_type='INSPECT_PLAYLIST' JOIN creator_non_query_shadow_lineage l ON l.proposal_id=p.id WHERE a.action_type='INSPECT_PLAYLIST' AND a.arm='TREATMENT' AND a.assignment_status='CANARY_ALLOCATED' AND a.serving_authority=true AND a.assigned_at<=$1 AND NOT EXISTS(SELECT 1 FROM creator_playlist_canary_execution_links link WHERE link.assignment_id=a.id) ORDER BY a.assigned_at,a.assignment_key`, [cutoff]);
  let reconciled = 0, abstained = 0;
  const eventKeys: string[] = [], sourceChecksums: string[] = [];
  for (const assignment of assignments.rows) {
    const candidatesResult = await db.query(`SELECT f.id frontier_action_id,f.semantic_action_key,j.id job_id,j.idempotency_key job_idempotency_key,r.id adapter_run_id FROM frontier_actions f JOIN research_programs program ON program.id=f.program_id JOIN jobs j ON j.type='INSPECT_PLAYLIST' AND j.payload->>'actionId'=f.id::text AND j.payload->>'programKey'=program.program_key AND lower(j.payload->>'targetCountry')=lower($5) AND j.payload->>'playlistId'=regexp_replace(f.normalized_target,'^playlist:','') AND j.payload->>'policyVersion'=f.policy_version LEFT JOIN acquisition_adapter_runs r ON r.adapter_type='INSPECT_PLAYLIST' AND r.action_id=f.id AND r.job_id=j.id WHERE f.program_id=$1 AND f.action_type='INSPECT_PLAYLIST' AND f.lifecycle IN('QUEUED','RUNNING','COMPLETED') AND f.validity_start<=$2 AND j.created_at>=$2 AND j.created_at<=$3 AND (f.source_query_run_id IS NULL OR EXISTS(SELECT 1 FROM creator_non_query_shadow_lineage lineage JOIN LATERAL jsonb_array_elements_text(lineage.creator_outcome_ids) ids(outcome_id) ON true JOIN creator_outcome_records outcome ON outcome.id=ids.outcome_id::uuid WHERE lineage.proposal_id=$4 AND outcome.query_run_id=f.source_query_run_id)) ORDER BY f.id,j.id`, [assignment.program_id, assignment.assigned_at, cutoff, assignment.non_query_proposal_id, assignment.country]);
    const candidates: PlaylistLineageCandidate[] = candidatesResult.rows.map((row: any) => ({ frontierActionId: row.frontier_action_id, semanticActionKey: row.semantic_action_key, jobId: row.job_id, jobIdempotencyKey: row.job_idempotency_key, adapterRunId: row.adapter_run_id || undefined }));
    const identityConsistent = assignment.program_id === assignment.proposal_program_id && assignment.objective_key === assignment.proposal_objective_key && Number(assignment.objective_version) === Number(assignment.proposal_objective_version) && assignment.hypothesis_id === assignment.proposal_hypothesis_id;
    const resolution = identityConsistent ? resolvePlaylistLineage(candidates) : { result: 'ABSTAIN' as const, reasonCodes: ['PLAYLIST_LINEAGE_IDENTITY_MISMATCH'], evidenceChecksum: creatorIntelligenceChecksum(candidates) };
    const eventIdentity = { assignmentKey: assignment.assignment_key, proposalKey: assignment.proposal_key, cutoff, evidenceChecksum: resolution.evidenceChecksum, policyVersion: CREATOR_PLAYLIST_LINEAGE_RECONCILIATION_POLICY_VERSION };
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const alreadyLinked = await client.query(`SELECT link_key,lineage_checksum FROM creator_playlist_canary_execution_links WHERE assignment_id=$1 FOR SHARE`, [assignment.id]);
      if (alreadyLinked.rowCount) { await client.query('COMMIT'); continue; }
      let linkKey: string | null = null;
      if (resolution.result === 'PASS' && resolution.candidate) {
        const lineage = { assignmentKey: assignment.assignment_key, proposalKey: assignment.proposal_key, frontierActionId: resolution.candidate.frontierActionId, readinessRunId: assignment.readiness_run_id, sourceAllocationRunId: assignment.source_allocation_run_id, disposition: 'QUEUED', reasonCodes: ['PLAYLIST_CANARY_QUEUED'], jobId: resolution.candidate.jobId };
        linkKey = creatorIntelligenceChecksum({ ...lineage, policyVersion: CREATOR_PLAYLIST_CANARY_POLICY_VERSION });
        await client.query(`INSERT INTO creator_playlist_canary_execution_links(link_key,assignment_id,proposal_id,frontier_action_id,job_id,disposition,reason_codes,readiness_run_id,lineage_checksum,policy_version,linked_at) VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7,$8,$9,$10) ON CONFLICT(link_key) DO NOTHING`, [linkKey, assignment.id, assignment.non_query_proposal_id, resolution.candidate.frontierActionId, resolution.candidate.jobId, JSON.stringify(['PLAYLIST_CANARY_QUEUED']), assignment.readiness_run_id, creatorIntelligenceChecksum(lineage), CREATOR_PLAYLIST_CANARY_POLICY_VERSION, assignment.assigned_at]);
      }
      const eventKey = creatorIntelligenceChecksum({ ...eventIdentity, result: resolution.result, linkKey });
      await client.query(`INSERT INTO creator_playlist_lineage_reconciliation_events(event_key,assignment_id,proposal_id,result,reason_codes,candidate_count,reconstructed_link_key,evidence_checksum,detail,cutoff_at,policy_version,serving_authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false) ON CONFLICT(event_key) DO NOTHING`, [eventKey, assignment.id, assignment.non_query_proposal_id, resolution.result, JSON.stringify(resolution.reasonCodes), candidates.length, linkKey, resolution.evidenceChecksum, JSON.stringify({ candidateFrontierActionIds: candidates.map(item => item.frontierActionId), candidateJobIds: candidates.map(item => item.jobId), adapterRunIds: candidates.map(item => item.adapterRunId).filter(Boolean) }), cutoff, CREATOR_PLAYLIST_LINEAGE_RECONCILIATION_POLICY_VERSION]);
      await client.query('COMMIT');
      eventKeys.push(eventKey); sourceChecksums.push(resolution.evidenceChecksum);
      if (resolution.result === 'PASS') reconciled++; else abstained++;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  return { enabled: true, considered: assignments.rowCount, reconciled, abstained, result: abstained ? 'ABSTAIN' : 'PASS', eventKeys, sourceChecksums };
}
