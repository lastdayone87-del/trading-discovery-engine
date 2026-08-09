import { getDb } from '../db';
import { creatorIntelligenceChecksum, type CreatorDiscoveryObjective } from './contracts';
import { allocateShadowCreatorProgram, CREATOR_READINESS_POLICY_VERSION, type ShadowAllocationCandidate } from './readiness';

export const CREATOR_SEARCH_CANARY_POLICY_VERSION = 'creator-search-allocation-canary-v1';
export const CREATOR_SEARCH_CANARY_ACTION_TYPE = 'SEARCH_YOUTUBE' as const;
export type CreatorCanaryActionType = typeof CREATOR_SEARCH_CANARY_ACTION_TYPE | 'INSPECT_PLAYLIST';

export interface CreatorCanaryControl {
  enabled: boolean;
  killSwitch: boolean;
  servingAuthorityEnabled: boolean;
  topLevelAuthorityEnabled: boolean;
  playlistAuthorityEnabled: boolean;
  playlistRolloutBasisPoints: number;
  rolloutBasisPoints: number;
  globalDailyAllocationCap: number;
  globalDailyQuotaCap: number;
  maximumReadinessAgeHours: number;
  minimumAttributionCompleteness: number;
  readinessPolicyVersion: string;
  policyVersion: string;
  configurationVersion: number;
}

export interface CreatorCanaryAssignment {
  assignmentId?: string;
  assignmentKey: string;
  opportunityKey: string;
  country: string;
  arm: 'CONTROL' | 'TREATMENT';
  assignmentStatus: 'LEGACY_FALLBACK' | 'CANARY_ALLOCATED';
  programId?: string;
  objectiveKey?: string;
  objectiveVersion?: number;
  hypothesisId?: string;
  readinessRunId?: string;
  nonQueryProposalId?: string;
  actionType: CreatorCanaryActionType;
  rolloutBasisPoints: number;
  behaviorPropensityBasisPoints: number;
  treatmentPropensityBasisPoints: number;
  randomizationValue: number;
  estimatedQuotaUnits: number;
  eligibilityChecksum: string;
  reasonCodes: string[];
  provenance: Record<string, unknown>;
  policyVersion: string;
  configurationVersion: number;
  servingAuthority: boolean;
  assignedAt: string;
}

export function creatorCanaryBucket(opportunityKey: string, policyVersion = CREATOR_SEARCH_CANARY_POLICY_VERSION): number {
  if (!opportunityKey.trim()) throw new Error('CREATOR_CANARY_OPPORTUNITY_REQUIRED');
  return Number.parseInt(creatorIntelligenceChecksum({ opportunityKey, policyVersion }).slice(0, 8), 16) % 10000;
}

export function decideCreatorCanaryArm(input: {
  opportunityKey: string;
  country: string;
  assignedAt: string;
  estimatedQuotaUnits: number;
  control: CreatorCanaryControl;
  safetyReasons: string[];
  candidate?: ShadowAllocationCandidate;
  readinessRunId?: string;
  eligibilityChecksum: string;
  actionType?: CreatorCanaryActionType;
  nonQueryProposalId?: string;
}): CreatorCanaryAssignment {
  const { control } = input;
  const randomizationValue = creatorCanaryBucket(input.opportunityKey, control.policyVersion);
  const safe = input.safetyReasons.length === 0 && !!input.candidate && !!input.readinessRunId;
  const assignedTreatment = safe && randomizationValue < control.rolloutBasisPoints;
  const common = {
    opportunityKey: input.opportunityKey, country: input.country, actionType: input.actionType || CREATOR_SEARCH_CANARY_ACTION_TYPE,
    rolloutBasisPoints: safe ? control.rolloutBasisPoints : 0, randomizationValue,
    estimatedQuotaUnits: input.estimatedQuotaUnits, eligibilityChecksum: input.eligibilityChecksum,
    readinessRunId: input.readinessRunId,
    nonQueryProposalId: input.nonQueryProposalId,
    policyVersion: control.policyVersion, configurationVersion: control.configurationVersion,
    assignedAt: new Date(input.assignedAt).toISOString()
  };
  if (!assignedTreatment) {
    const reasonCodes = input.safetyReasons.length ? [...new Set(input.safetyReasons)].sort() : ['RANDOMIZED_LEGACY_CONTROL'];
    const treatmentPropensityBasisPoints = safe ? control.rolloutBasisPoints : 0;
    const unsigned = { ...common, arm: 'CONTROL' as const, assignmentStatus: 'LEGACY_FALLBACK' as const,
      behaviorPropensityBasisPoints: safe ? 10000 - control.rolloutBasisPoints : 10000,
      treatmentPropensityBasisPoints, reasonCodes,
      provenance: { queryAuthority: 'QUERY_INTELLIGENCE', fallback: 'LEGACY_QUERY_INTELLIGENCE' }, servingAuthority: false };
    return { ...unsigned, assignmentKey: creatorIntelligenceChecksum(unsigned) };
  }
  const candidate = input.candidate!;
  const unsigned = { ...common, arm: 'TREATMENT' as const, assignmentStatus: 'CANARY_ALLOCATED' as const,
    programId: candidate.programId, objectiveKey: candidate.objective.objectiveKey,
    objectiveVersion: candidate.objective.version, hypothesisId: candidate.hypothesisId,
    readinessRunId: input.readinessRunId, behaviorPropensityBasisPoints: control.rolloutBasisPoints,
    treatmentPropensityBasisPoints: control.rolloutBasisPoints,
    reasonCodes: ['BOUNDED_CREATOR_PROGRAM_ALLOCATION', 'QUERY_INTELLIGENCE_QUERY_AUTHORITY_PRESERVED'],
    provenance: { queryAuthority: 'QUERY_INTELLIGENCE', allocationAuthority: 'CREATOR_INTELLIGENCE', candidateEvidence: candidate.evidenceKeys }, servingAuthority: true };
  return { ...unsigned, assignmentKey: creatorIntelligenceChecksum(unsigned) };
}

function rowControl(row: any): CreatorCanaryControl {
  return { enabled: row.enabled, killSwitch: row.kill_switch, servingAuthorityEnabled: row.serving_authority_enabled, topLevelAuthorityEnabled: row.top_level_authority_enabled || false, playlistAuthorityEnabled: row.playlist_authority_enabled || false, playlistRolloutBasisPoints: Number(row.playlist_rollout_basis_points || 0),
    rolloutBasisPoints: Number(row.rollout_basis_points), globalDailyAllocationCap: Number(row.global_daily_allocation_cap),
    globalDailyQuotaCap: Number(row.global_daily_quota_cap), maximumReadinessAgeHours: Number(row.maximum_readiness_age_hours),
    minimumAttributionCompleteness: Number(row.minimum_attribution_completeness), readinessPolicyVersion: row.readiness_policy_version,
    policyVersion: row.policy_version, configurationVersion: Number(row.configuration_version) };
}

export async function allocateCreatorSearchCanary(input: { opportunityKey: string; country: string; assignedAt: string; estimatedQuotaUnits?: number; requiredProgramId?: string; requiredHypothesisId?: string; additionalSafetyReasons?: string[]; actionType?: CreatorCanaryActionType; nonQueryProposalId?: string; rolloutBasisPointsOverride?: number }): Promise<CreatorCanaryAssignment> {
  const db = await getDb(), client = await db.connect(), estimatedQuotaUnits = input.estimatedQuotaUnits ?? 100;
  if (!input.opportunityKey.trim() || !input.country.trim() || !Number.isFinite(new Date(input.assignedAt).getTime()) || !Number.isSafeInteger(estimatedQuotaUnits) || estimatedQuotaUnits < 0) throw new Error('INVALID_CREATOR_CANARY_OPPORTUNITY');
  try {
    await client.query('BEGIN');
    const existing = await client.query(`SELECT * FROM creator_search_canary_assignments WHERE opportunity_key=$1`, [input.opportunityKey]);
    if (existing.rowCount) { await client.query('COMMIT'); return assignmentFromRow(existing.rows[0]); }
    const controlResult = await client.query(`SELECT * FROM creator_search_canary_control WHERE singleton=true FOR UPDATE`);
    if (!controlResult.rowCount) throw new Error('CREATOR_CANARY_CONTROL_MISSING');
    const control = rowControl(controlResult.rows[0]), reasons: string[] = [...(input.additionalSafetyReasons || [])];
    if (!control.enabled) reasons.push('CANARY_DISABLED');
    if (control.killSwitch) reasons.push('KILL_SWITCH_ACTIVE');
    if (!control.servingAuthorityEnabled) reasons.push('SERVING_AUTHORITY_DISABLED');
    if (control.rolloutBasisPoints <= 0) reasons.push('ROLLOUT_ZERO');
    if (control.policyVersion !== CREATOR_SEARCH_CANARY_POLICY_VERSION) reasons.push('CANARY_POLICY_VERSION_MISMATCH');
    if (control.readinessPolicyVersion !== CREATOR_READINESS_POLICY_VERSION) reasons.push('READINESS_POLICY_VERSION_MISMATCH');

    const readiness = await client.query(`SELECT * FROM creator_readiness_shadow_runs WHERE cutoff_at<=$1 ORDER BY cutoff_at DESC,created_at DESC LIMIT 1`, [input.assignedAt]);
    const readinessRow = readiness.rows[0];
    if (!readinessRow || readinessRow.result !== 'PASS') reasons.push('READINESS_NOT_PASS');
    if (readinessRow && readinessRow.policy_version !== control.readinessPolicyVersion) reasons.push('READINESS_POLICY_MISMATCH');
    if (readinessRow && new Date(input.assignedAt).getTime() - new Date(readinessRow.cutoff_at).getTime() > control.maximumReadinessAgeHours * 3600000) reasons.push('READINESS_STALE');
    if (readinessRow && Object.values(readinessRow.checks || {}).some(value => value !== 'PASS')) reasons.push('READINESS_CHECK_NOT_PASS');
    const guards = readinessRow?.allocation_run_id ? await client.query(`SELECT metric,result,attribution_completeness,policy_version FROM creator_guardrail_shadow_snapshots WHERE allocation_run_id=$1 ORDER BY metric`, [readinessRow.allocation_run_id]) : { rows: [], rowCount: 0 };
    if (guards.rowCount !== 8 || guards.rows.some((guard: any) => guard.result !== 'PASS')) reasons.push('GUARDRAILS_NOT_PASS');
    if (guards.rows.some((guard: any) => Number(guard.attribution_completeness) < control.minimumAttributionCompleteness)) reasons.push('ATTRIBUTION_INCOMPLETE');
    if (guards.rows.some((guard: any) => guard.policy_version !== control.readinessPolicyVersion)) reasons.push('GUARDRAIL_POLICY_MISMATCH');

    const countryLimit = await client.query(`SELECT * FROM creator_search_canary_country_limits WHERE lower(country)=lower($1) AND enabled=true AND policy_version=$2`, [input.country, control.policyVersion]);
    if (!countryLimit.rowCount) reasons.push('COUNTRY_CAP_NOT_CONFIGURED');
    const daily = await client.query(`SELECT COUNT(*)::int allocations,COALESCE(SUM(estimated_quota_units),0)::int quota FROM creator_search_canary_assignments WHERE assignment_status='CANARY_ALLOCATED' AND assigned_at>=date_trunc('day',$1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [input.assignedAt]);
    if (Number(daily.rows[0]?.allocations) >= control.globalDailyAllocationCap) reasons.push('GLOBAL_DAILY_ALLOCATION_CAP');
    if (Number(daily.rows[0]?.quota) + estimatedQuotaUnits > control.globalDailyQuotaCap) reasons.push('GLOBAL_DAILY_QUOTA_CAP');
    if (countryLimit.rowCount) {
      const countryDaily = await client.query(`SELECT COUNT(*)::int allocations,COALESCE(SUM(estimated_quota_units),0)::int quota FROM creator_search_canary_assignments WHERE assignment_status='CANARY_ALLOCATED' AND lower(country)=lower($1) AND assigned_at>=date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [input.country, input.assignedAt]);
      if (Number(countryDaily.rows[0]?.allocations) >= Number(countryLimit.rows[0].daily_allocation_cap)) reasons.push('COUNTRY_DAILY_ALLOCATION_CAP');
      if (Number(countryDaily.rows[0]?.quota) + estimatedQuotaUnits > Number(countryLimit.rows[0].daily_quota_cap)) reasons.push('COUNTRY_DAILY_QUOTA_CAP');
    }

    const candidateRows = await client.query(`SELECT p.id program_id,p.program_key,cv.objective,h.id hypothesis_id,h.hypothesis_key,h.confidence_basis_points,f.uncertainty frontier_uncertainty,f.frontier_key,l.daily_allocation_cap,l.daily_quota_cap FROM research_programs p JOIN creator_search_canary_program_limits l ON l.program_id=p.id AND l.enabled=true AND l.policy_version=$3 JOIN LATERAL(SELECT id,hypothesis_key,confidence_basis_points FROM discovery_hypotheses WHERE program_id=p.id AND lifecycle IN('PROPOSED','VALIDATED','TRIAL','PROVEN') AND policy_version IS NOT NULL AND created_at<=$1 AND ($6::uuid IS NULL OR id=$6) ORDER BY confidence_basis_points DESC,hypothesis_key LIMIT 1)h ON true JOIN LATERAL(SELECT objective FROM creator_program_contract_versions WHERE program_id=p.id AND effective_at<=$1 ORDER BY objective_version DESC,effective_at DESC LIMIT 1)cv ON true JOIN LATERAL(SELECT uncertainty,frontier_key,as_of FROM creator_frontier_shadow_snapshots WHERE program_id=p.id AND as_of<=$1 AND as_of>=$1::timestamptz-($4||' hours')::interval ORDER BY as_of DESC,uncertainty DESC,target_key LIMIT 1)f ON true WHERE p.creator_shadow_only=true AND p.mode='SHADOW' AND p.activation_enabled=false AND lower(cv.objective->'coordinates'->>'country')=lower($2) AND ($5::uuid IS NULL OR p.id=$5) ORDER BY p.program_key`, [input.assignedAt, input.country, control.policyVersion, String(control.maximumReadinessAgeHours), input.requiredProgramId || null, input.requiredHypothesisId || null]);
    const eligible: ShadowAllocationCandidate[] = [];
    for (const row of candidateRows.rows) {
      const usage = await client.query(`SELECT COUNT(*)::int allocations,COALESCE(SUM(estimated_quota_units),0)::int quota FROM creator_search_canary_assignments WHERE assignment_status='CANARY_ALLOCATED' AND program_id=$1 AND assigned_at>=date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [row.program_id, input.assignedAt]);
      if (Number(usage.rows[0]?.allocations) >= Number(row.daily_allocation_cap) || Number(usage.rows[0]?.quota) + estimatedQuotaUnits > Number(row.daily_quota_cap)) continue;
      const objective: CreatorDiscoveryObjective = typeof row.objective === 'string' ? JSON.parse(row.objective) : row.objective;
      eligible.push({ programId: row.program_id, programKey: row.program_key, objective, hypothesisId: row.hypothesis_id, hypothesisKey: row.hypothesis_key, hypothesisConfidence: Number(row.confidence_basis_points) / 10000, frontierUncertainty: Number(row.frontier_uncertainty), evidenceKeys: [row.frontier_key, `hypothesis:${row.hypothesis_key}`, `readiness:${readinessRow?.readiness_key || 'missing'}`] });
    }
    if (!eligible.length) reasons.push('NO_PROGRAM_WITH_REMAINING_CAPACITY');
    const shadow = allocateShadowCreatorProgram({ opportunityKey: input.opportunityKey, queryRunId: input.opportunityKey, country: input.country, occurredAt: input.assignedAt }, eligible);
    const candidate = shadow.disposition === 'ALLOCATED' ? eligible.find(item => item.programId === shadow.programId && item.hypothesisId === shadow.hypothesisId) : undefined;
    const eligibilityChecksum = creatorIntelligenceChecksum({ country: input.country, readinessKey: readinessRow?.readiness_key || null, guardrails: guards.rows, eligible, controlVersion: control.configurationVersion });
    const assignment = decideCreatorCanaryArm({ ...input, estimatedQuotaUnits, control, safetyReasons: reasons, candidate, readinessRunId: readinessRow?.id, eligibilityChecksum });
    const saved = await client.query(`INSERT INTO creator_search_canary_assignments(assignment_key,opportunity_key,country,arm,assignment_status,program_id,objective_key,objective_version,hypothesis_id,readiness_run_id,action_type,rollout_basis_points,behavior_propensity_basis_points,treatment_propensity_basis_points,randomization_value,estimated_quota_units,eligibility_checksum,reason_codes,provenance,policy_version,configuration_version,serving_authority,assigned_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SEARCH_YOUTUBE',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`, [assignment.assignmentKey, assignment.opportunityKey, assignment.country, assignment.arm, assignment.assignmentStatus, assignment.programId || null, assignment.objectiveKey || null, assignment.objectiveVersion || null, assignment.hypothesisId || null, assignment.readinessRunId || null, assignment.rolloutBasisPoints, assignment.behaviorPropensityBasisPoints, assignment.treatmentPropensityBasisPoints, assignment.randomizationValue, assignment.estimatedQuotaUnits, assignment.eligibilityChecksum, JSON.stringify(assignment.reasonCodes), JSON.stringify(assignment.provenance), assignment.policyVersion, assignment.configurationVersion, assignment.servingAuthority, assignment.assignedAt]);
    await client.query('COMMIT');
    return { ...assignment, assignmentId: saved.rows[0].id };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

function assignmentFromRow(row: any): CreatorCanaryAssignment {
  return { assignmentId: row.id, assignmentKey: row.assignment_key, opportunityKey: row.opportunity_key, country: row.country, arm: row.arm, assignmentStatus: row.assignment_status, programId: row.program_id || undefined, objectiveKey: row.objective_key || undefined, objectiveVersion: row.objective_version || undefined, hypothesisId: row.hypothesis_id || undefined, readinessRunId: row.readiness_run_id || undefined, nonQueryProposalId: row.non_query_proposal_id || undefined, actionType: row.action_type, rolloutBasisPoints: Number(row.rollout_basis_points), behaviorPropensityBasisPoints: Number(row.behavior_propensity_basis_points), treatmentPropensityBasisPoints: Number(row.treatment_propensity_basis_points), randomizationValue: Number(row.randomization_value), estimatedQuotaUnits: Number(row.estimated_quota_units), eligibilityChecksum: row.eligibility_checksum, reasonCodes: row.reason_codes, provenance: row.provenance, policyVersion: row.policy_version, configurationVersion: Number(row.configuration_version), servingAuthority: row.serving_authority, assignedAt: new Date(row.assigned_at).toISOString() };
}

export async function bindCreatorCanaryQueryRun(input: { assignmentId: string; assignmentKey: string; queryRunId: string; queryId: number; selectionStrategy: string; boundAt: string }): Promise<boolean> {
  const db = await getDb(), bindingKey = creatorIntelligenceChecksum({ assignmentKey: input.assignmentKey, queryRunId: input.queryRunId, policyVersion: CREATOR_SEARCH_CANARY_POLICY_VERSION });
  const result = await db.query(`INSERT INTO creator_search_canary_query_run_bindings(binding_key,assignment_id,query_run_id,query_id,selection_strategy,query_intelligence_authority,bound_at,policy_version) VALUES($1,$2,$3,$4,$5,true,$6,$7) ON CONFLICT(binding_key) DO NOTHING RETURNING binding_key`, [bindingKey, input.assignmentId, input.queryRunId, input.queryId, input.selectionStrategy, input.boundAt, CREATOR_SEARCH_CANARY_POLICY_VERSION]);
  return !!result.rowCount;
}

export async function updateCreatorCanaryControl(input: { rolloutBasisPoints?: number; playlistRolloutBasisPoints?: number; killSwitch?: boolean; enabled?: boolean; servingAuthorityEnabled?: boolean; topLevelAuthorityEnabled?: boolean; playlistAuthorityEnabled?: boolean; actor: string; reason: string }): Promise<void> {
  if (!input.actor.trim() || !input.reason.trim()) throw new Error('CANARY_CONTROL_AUDIT_REQUIRED');
  if (input.rolloutBasisPoints !== undefined && (!Number.isInteger(input.rolloutBasisPoints) || input.rolloutBasisPoints < 0 || input.rolloutBasisPoints > 10000)) throw new Error('INVALID_CANARY_ROLLOUT');
  if (input.playlistRolloutBasisPoints !== undefined && (!Number.isInteger(input.playlistRolloutBasisPoints) || input.playlistRolloutBasisPoints < 0 || input.playlistRolloutBasisPoints > 10000)) throw new Error('INVALID_PLAYLIST_CANARY_ROLLOUT');
  const db = await getDb(), client = await db.connect();
  try {
    await client.query('BEGIN');
    const prior = await client.query(`SELECT * FROM creator_search_canary_control WHERE singleton=true FOR UPDATE`);
    if (!prior.rowCount) throw new Error('CREATOR_CANARY_CONTROL_MISSING');
    const current = prior.rows[0], rollout = input.rolloutBasisPoints ?? current.rollout_basis_points, killSwitch = input.killSwitch ?? current.kill_switch, enabled = input.enabled ?? current.enabled;
    const requestedAuthority = input.servingAuthorityEnabled ?? current.serving_authority_enabled;
    const resultingAuthority = input.topLevelAuthorityEnabled ?? current.top_level_authority_enabled;
    const playlistRollout = input.playlistRolloutBasisPoints ?? current.playlist_rollout_basis_points;
    const requestedPlaylistAuthority = input.playlistAuthorityEnabled ?? current.playlist_authority_enabled;
    const authority = !enabled || killSwitch || rollout === 0 ? false : resultingAuthority;
    const playlistAuthority = !enabled || killSwitch || playlistRollout === 0 ? false : requestedPlaylistAuthority;
    const resulting = { ...current, rollout_basis_points: rollout, playlist_rollout_basis_points: playlistRollout, kill_switch: killSwitch, enabled, serving_authority_enabled: !enabled || killSwitch || rollout === 0 && playlistRollout === 0 ? false : requestedAuthority, top_level_authority_enabled: authority, playlist_authority_enabled: playlistAuthority, configuration_version: Number(current.configuration_version) + 1 };
    if (resulting.serving_authority_enabled && !resulting.enabled) throw new Error('CANARY_AUTHORITY_REQUIRES_ENABLED_CONTROL');
    await client.query(`UPDATE creator_search_canary_control SET rollout_basis_points=$1,playlist_rollout_basis_points=$2,kill_switch=$3,enabled=$4,serving_authority_enabled=$5,top_level_authority_enabled=$6,playlist_authority_enabled=$7,configuration_version=$8,updated_at=now(),updated_by=$9 WHERE singleton=true`, [resulting.rollout_basis_points, resulting.playlist_rollout_basis_points, resulting.kill_switch, resulting.enabled, resulting.serving_authority_enabled, resulting.top_level_authority_enabled, resulting.playlist_authority_enabled, resulting.configuration_version, input.actor]);
    const eventKey = creatorIntelligenceChecksum({ prior: current, resulting, actor: input.actor, reason: input.reason, policyVersion: CREATOR_SEARCH_CANARY_POLICY_VERSION });
    await client.query(`INSERT INTO creator_search_canary_control_events(event_key,prior_configuration,resulting_configuration,reason,changed_by,policy_version) VALUES($1,$2,$3,$4,$5,$6)`, [eventKey, JSON.stringify(current), JSON.stringify(resulting), input.reason, input.actor, CREATOR_SEARCH_CANARY_POLICY_VERSION]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
