import { getDb } from '../db';
import { evaluateCounterfactualPolicy, type PolicySample } from '../persistentResearchPhase6';
import {
  CREATOR_GUARDRAIL_METRICS,
  creatorIntelligenceChecksum,
  type CreatorDiscoveryObjective,
  type CreatorGuardrailMetric,
  type CreatorGuardrailSnapshot,
  type CreatorProgramAllocation,
  type CreatorReadinessRecord,
  type CreatorReadinessResult
} from './contracts';
import { projectShadowCreatorOutcomes } from './shadowProjection';
import { projectShadowCreatorProgramState } from './shadowState';
import { reconcilePlaylistLineage } from './playlistLineage';

export const CREATOR_READINESS_POLICY_VERSION = 'creator-readiness-shadow-v1';
export const CREATOR_ALLOCATION_PROJECTION_VERSION = 'creator-program-allocation-shadow-v1';
export const CREATOR_GUARDRAIL_MATURITY_POLICY = 'terminal-or-reviewed-outcomes-v1';

export interface ShadowAllocationCandidate {
  programId: string;
  programKey: string;
  objective: CreatorDiscoveryObjective;
  hypothesisId: string;
  hypothesisKey: string;
  hypothesisConfidence: number;
  frontierUncertainty: number;
  evidenceKeys: string[];
}

export interface ShadowSchedulingOpportunity {
  opportunityKey: string;
  queryRunId: string;
  country: string;
  occurredAt: string;
}

export interface GuardrailOutcomeInput {
  outcomeKey: string;
  allocationKey: string;
  countryStatus?: string;
  tradingStatus?: string;
  outcomeType: string;
  maturity: string;
  verifiedCreatorCredit: boolean;
  activeCreatorCredit: boolean;
  activityStatus?: string;
  providerUnits: number;
  effectiveAt: string;
  behaviorPropensityBasisPoints: number;
  targetPropensityBasisPoints: number;
  country: string;
}

export interface GuardrailPolicy {
  minimumSampleSize: number;
  minimumAttributionCompleteness: number;
  thresholds: Record<CreatorGuardrailMetric, { direction: 'MIN' | 'MAX'; value: number }>;
}

export const DEFAULT_CREATOR_GUARDRAIL_POLICY: GuardrailPolicy = {
  minimumSampleSize: 30,
  minimumAttributionCompleteness: 1,
  thresholds: {
    COUNTRY_PRECISION: { direction: 'MIN', value: .7 },
    TRADING_PRECISION: { direction: 'MIN', value: .7 },
    VERIFIED_CREATOR_YIELD: { direction: 'MIN', value: .05 },
    ACTIVE_VERIFIED_CREATOR_YIELD: { direction: 'MIN', value: .02 },
    REVIEW_BURDEN: { direction: 'MAX', value: .5 },
    INACTIVE_CREATOR_RATE: { direction: 'MAX', value: .5 },
    PROVIDER_COST: { direction: 'MAX', value: 100 },
    QUOTA_CONSUMPTION: { direction: 'MAX', value: 100 }
  }
};

function validDate(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function allocationScore(candidate: ShadowAllocationCandidate): number {
  return candidate.frontierUncertainty * .6 + candidate.hypothesisConfidence * .4;
}

/** Pure Phase 3.5 policy: selects context only and cannot represent a query. */
export function allocateShadowCreatorProgram(
  opportunity: ShadowSchedulingOpportunity,
  candidates: ShadowAllocationCandidate[]
): CreatorProgramAllocation {
  if (!opportunity.opportunityKey.trim() || !opportunity.queryRunId.trim() || !opportunity.country.trim() || !validDate(opportunity.occurredAt)) {
    throw new Error('INVALID_SHADOW_SCHEDULING_OPPORTUNITY');
  }
  const eligible = [...candidates]
    .filter(candidate => candidate.objective.coordinates.country?.toLocaleLowerCase('en') === opportunity.country.toLocaleLowerCase('en'))
    .sort((a, b) => allocationScore(b) - allocationScore(a)
      || b.frontierUncertainty - a.frontierUncertainty
      || b.hypothesisConfidence - a.hypothesisConfidence
      || a.programKey.localeCompare(b.programKey)
      || a.hypothesisKey.localeCompare(b.hypothesisKey));
  const selected = eligible[0];
  const randomizationValue = Number.parseInt(creatorIntelligenceChecksum({
    opportunityKey: opportunity.opportunityKey,
    policyVersion: CREATOR_READINESS_POLICY_VERSION
  }).slice(0, 8), 16) % 10000;
  const common = {
    schedulingOpportunityKey: opportunity.opportunityKey,
    actualQueryRunId: opportunity.queryRunId,
    country: opportunity.country,
    eligibleProgramKeys: [...new Set(eligible.map(candidate => candidate.programKey))].sort(),
    behaviorPropensityBasisPoints: 10000,
    randomizationValue,
    policyVersion: CREATOR_READINESS_POLICY_VERSION,
    decidedAt: new Date(opportunity.occurredAt).toISOString(),
    servingAuthority: false as const
  };
  if (!selected) {
    const unsigned = { ...common, disposition: 'ABSTAIN' as const, reasonCodes: ['NO_ELIGIBLE_PROGRAM'], supportingEvidence: [opportunity.opportunityKey], targetPropensityBasisPoints: 0 };
    return { ...unsigned, allocationKey: creatorIntelligenceChecksum(unsigned) };
  }
  const unsigned = {
    ...common,
    programId: selected.programId,
    objectiveKey: selected.objective.objectiveKey,
    objectiveVersion: selected.objective.version,
    hypothesisId: selected.hypothesisId,
    disposition: 'ALLOCATED' as const,
    reasonCodes: ['DETERMINISTIC_SHADOW_PROGRAM_ALLOCATION', 'QUERY_INTELLIGENCE_QUERY_PRESERVED'],
    supportingEvidence: [...new Set([opportunity.opportunityKey, ...selected.evidenceKeys])].sort(),
    targetPropensityBasisPoints: 10000
  };
  return { ...unsigned, allocationKey: creatorIntelligenceChecksum(unsigned) };
}

function effectiveSampleSize(outcomes: GuardrailOutcomeInput[]): number {
  if (!outcomes.length) return 0;
  const samples: PolicySample[] = outcomes.map(outcome => ({
    actionId: `${outcome.allocationKey}:${outcome.outcomeKey}`,
    supported: true,
    targetSelected: true,
    targetPropensityBasisPoints: outcome.targetPropensityBasisPoints,
    behaviorPropensityBasisPoints: outcome.behaviorPropensityBasisPoints,
    reward: outcome.verifiedCreatorCredit ? 1 : 0,
    providerCost: outcome.providerUnits,
    reviewCost: outcome.outcomeType === 'NEEDS_REVIEW' ? 1 : 0,
    overlapPenalty: 0,
    country: outcome.country,
    language: undefined
  }));
  return evaluateCounterfactualPolicy(samples, samples, 1).candidate.effectiveSampleSize;
}

function wilson(successes: number, total: number): { lower: number; upper: number } | null {
  if (!total) return null;
  const z = 1.96, p = successes / total, denominator = 1 + z * z / total;
  const centre = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { lower: Math.max(0, centre - margin), upper: Math.min(1, centre + margin) };
}

function metricParts(metric: CreatorGuardrailMetric, outcomes: GuardrailOutcomeInput[]): { numerator: number; denominator: number; confidence: boolean } {
  const terminal = outcomes.filter(outcome => ['TERMINAL', 'REVIEWED'].includes(outcome.maturity));
  switch (metric) {
    case 'COUNTRY_PRECISION': {
      const eligible = terminal.filter(outcome => ['CONFIRMED', 'LIKELY', 'REJECTED'].includes(outcome.countryStatus || ''));
      return { numerator: eligible.filter(outcome => outcome.countryStatus !== 'REJECTED').length, denominator: eligible.length, confidence: true };
    }
    case 'TRADING_PRECISION': {
      const eligible = terminal.filter(outcome => ['TRADING_CONFIRMED', 'NON_TRADING', 'HUMAN_REJECTED'].includes(outcome.tradingStatus || ''));
      return { numerator: eligible.filter(outcome => outcome.tradingStatus === 'TRADING_CONFIRMED').length, denominator: eligible.length, confidence: true };
    }
    case 'VERIFIED_CREATOR_YIELD': return { numerator: terminal.filter(outcome => outcome.verifiedCreatorCredit).length, denominator: terminal.length, confidence: true };
    case 'ACTIVE_VERIFIED_CREATOR_YIELD': return { numerator: terminal.filter(outcome => outcome.activeCreatorCredit).length, denominator: terminal.length, confidence: true };
    case 'REVIEW_BURDEN': return { numerator: outcomes.filter(outcome => outcome.outcomeType === 'NEEDS_REVIEW').length, denominator: outcomes.length, confidence: true };
    case 'INACTIVE_CREATOR_RATE': {
      const eligible = outcomes.filter(outcome => ['ACTIVE', 'RECENTLY_ACTIVE', 'DORMANT', 'INACTIVE'].includes(outcome.activityStatus || ''));
      return { numerator: eligible.filter(outcome => ['DORMANT', 'INACTIVE'].includes(outcome.activityStatus || '')).length, denominator: eligible.length, confidence: true };
    }
    case 'PROVIDER_COST':
    case 'QUOTA_CONSUMPTION': return { numerator: outcomes.reduce((sum, outcome) => sum + outcome.providerUnits, 0), denominator: new Set(outcomes.map(outcome => outcome.allocationKey)).size, confidence: false };
  }
}

export function projectCreatorGuardrails(input: {
  allocationRunKey: string;
  outcomes: GuardrailOutcomeInput[];
  attributionCompleteness: number;
  observationWindow: { from: string; to: string };
  maximumEvidenceAgeHours?: number;
  policy?: GuardrailPolicy;
}): CreatorGuardrailSnapshot[] {
  const policy = input.policy || DEFAULT_CREATOR_GUARDRAIL_POLICY;
  if (!validDate(input.observationWindow.from) || !validDate(input.observationWindow.to) || new Date(input.observationWindow.to) < new Date(input.observationWindow.from)) {
    throw new Error('INVALID_GUARDRAIL_OBSERVATION_WINDOW');
  }
  const windowedOutcomes = input.outcomes.filter(outcome => validDate(outcome.effectiveAt) && new Date(outcome.effectiveAt) >= new Date(input.observationWindow.from) && new Date(outcome.effectiveAt) <= new Date(input.observationWindow.to));
  const latestEvidenceAt = windowedOutcomes.length ? [...windowedOutcomes].sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt))[0].effectiveAt : null;
  const stale = !latestEvidenceAt || new Date(input.observationWindow.to).getTime() - new Date(latestEvidenceAt).getTime() > (input.maximumEvidenceAgeHours ?? 48) * 3600000;
  const ess = effectiveSampleSize(windowedOutcomes);
  return CREATOR_GUARDRAIL_METRICS.map(metric => {
    const parts = metricParts(metric, windowedOutcomes);
    const value = parts.denominator ? parts.numerator / parts.denominator : null;
    const confidence = parts.confidence ? wilson(parts.numerator, parts.denominator) : null;
    const reasons: string[] = [];
    let result: CreatorReadinessResult;
    if (input.attributionCompleteness < policy.minimumAttributionCompleteness) reasons.push('INCOMPLETE_ATTRIBUTION');
    if (!parts.denominator) reasons.push('MISSING_EVIDENCE');
    if (stale) reasons.push('STALE_EVIDENCE');
    if (ess < policy.minimumSampleSize) reasons.push('INSUFFICIENT_EFFECTIVE_SAMPLE_SIZE');
    if (reasons.length) result = 'ABSTAIN';
    else {
      const threshold = policy.thresholds[metric];
      const comparisonValue = confidence ? (threshold.direction === 'MIN' ? confidence.lower : confidence.upper) : value!;
      result = threshold.direction === 'MIN' ? (comparisonValue >= threshold.value ? 'PASS' : 'FAIL') : (comparisonValue <= threshold.value ? 'PASS' : 'FAIL');
      reasons.push(result === 'PASS' ? 'GUARDRAIL_THRESHOLD_MET' : 'GUARDRAIL_THRESHOLD_VIOLATED');
    }
    const unsigned = {
      allocationRunKey: input.allocationRunKey, metric, numerator: parts.numerator, denominator: parts.denominator,
      value, attributionCompleteness: input.attributionCompleteness, maturityPolicy: CREATOR_GUARDRAIL_MATURITY_POLICY,
      observationWindow: input.observationWindow, latestEvidenceAt, sampleSize: windowedOutcomes.length, effectiveSampleSize: ess,
      confidence, result, reasonCodes: reasons, policyVersion: CREATOR_READINESS_POLICY_VERSION, servingAuthority: false as const
    };
    return { ...unsigned, snapshotKey: creatorIntelligenceChecksum(unsigned) };
  });
}

export function evaluateCreatorReadiness(input: {
  cutoffAt: string;
  checks: Record<string, CreatorReadinessResult>;
  guardrails: CreatorGuardrailSnapshot[];
  sourceChecksums: string[];
}): CreatorReadinessRecord {
  if (!validDate(input.cutoffAt)) throw new Error('INVALID_READINESS_CUTOFF');
  const completeMetrics = CREATOR_GUARDRAIL_METRICS.every(metric => input.guardrails.some(snapshot => snapshot.metric === metric));
  const checks = { ...input.checks, guardrailsComplete: completeMetrics ? 'PASS' as const : 'ABSTAIN' as const };
  const values = [...Object.values(checks), ...input.guardrails.map(snapshot => snapshot.result)];
  const result: CreatorReadinessResult = values.includes('FAIL') ? 'FAIL' : values.includes('ABSTAIN') ? 'ABSTAIN' : 'PASS';
  const reasonCodes = result === 'PASS' ? ['ALL_SHADOW_READINESS_CHECKS_PASS']
    : [...new Set([
      ...Object.entries(checks).filter(([, value]) => value !== 'PASS').map(([key, value]) => `${key.toUpperCase()}_${value}`),
      ...input.guardrails.filter(snapshot => snapshot.result !== 'PASS').flatMap(snapshot => snapshot.reasonCodes.map(reason => `${snapshot.metric}_${reason}`))
    ])].sort();
  const inputChecksum = creatorIntelligenceChecksum({ cutoffAt: input.cutoffAt, checks, guardrails: input.guardrails, sourceChecksums: [...input.sourceChecksums].sort() });
  const unsigned = { cutoffAt: new Date(input.cutoffAt).toISOString(), result, reasonCodes, checks, inputChecksum, policyVersion: CREATOR_READINESS_POLICY_VERSION, servingAuthority: false as const };
  const outputChecksum = creatorIntelligenceChecksum(unsigned);
  return { ...unsigned, outputChecksum, readinessKey: creatorIntelligenceChecksum({ inputChecksum, outputChecksum }) };
}

export async function projectShadowProgramAllocations(cutoffAt: string): Promise<{ runId: string; runKey: string; opportunities: number; decisions: number; idempotent: boolean }> {
  if (!validDate(cutoffAt)) throw new Error('INVALID_CREATOR_ALLOCATION_CUTOFF');
  const db = await getDb();
  const control = await db.query(`SELECT enabled FROM creator_readiness_shadow_control WHERE singleton=true`);
  if (!control.rows[0]?.enabled) throw new Error('CREATOR_READINESS_SHADOW_DISABLED');
  const opportunities = await db.query(`SELECT event_key,query_run_id,country,event_time FROM decision_events d JOIN query_runs q ON q.id=d.query_run_id WHERE d.event_type='QUERY_SELECTED' AND q.source='automated_query' AND d.event_time<=$1 ORDER BY d.event_time,d.event_key`, [cutoffAt]);
  const candidates = await db.query(`SELECT p.id program_id,p.program_key,cv.objective,h.id hypothesis_id,h.hypothesis_key,h.confidence_basis_points,COALESCE(f.uncertainty,1) frontier_uncertainty,COALESCE(f.frontier_key,'frontier:missing') frontier_key FROM research_programs p JOIN LATERAL(SELECT objective FROM creator_program_contract_versions WHERE program_id=p.id AND effective_at<=$1 ORDER BY objective_version DESC,effective_at DESC LIMIT 1)cv ON true JOIN LATERAL(SELECT id,hypothesis_key,confidence_basis_points FROM discovery_hypotheses WHERE program_id=p.id AND lifecycle IN('PROPOSED','VALIDATED','TRIAL','PROVEN') AND created_at<=$1 ORDER BY confidence_basis_points DESC,hypothesis_key LIMIT 1)h ON true LEFT JOIN LATERAL(SELECT uncertainty,frontier_key FROM creator_frontier_shadow_snapshots WHERE program_id=p.id AND as_of<=$1 ORDER BY as_of DESC,uncertainty DESC,target_key LIMIT 1)f ON true WHERE p.creator_shadow_only=true AND p.mode='SHADOW' AND p.activation_enabled=false ORDER BY p.program_key`, [cutoffAt]);
  const mappedCandidates: ShadowAllocationCandidate[] = candidates.rows.map((row: any) => ({
    programId: row.program_id, programKey: row.program_key, objective: typeof row.objective === 'string' ? JSON.parse(row.objective) : row.objective,
    hypothesisId: row.hypothesis_id, hypothesisKey: row.hypothesis_key,
    hypothesisConfidence: Number(row.confidence_basis_points) / 10000,
    frontierUncertainty: Number(row.frontier_uncertainty), evidenceKeys: [row.frontier_key, `hypothesis:${row.hypothesis_key}`]
  }));
  const decisions = opportunities.rows.map((row: any) => allocateShadowCreatorProgram({
    opportunityKey: row.event_key, queryRunId: row.query_run_id, country: row.country,
    occurredAt: new Date(row.event_time).toISOString()
  }, mappedCandidates));
  const inputChecksum = creatorIntelligenceChecksum({ cutoffAt, opportunities: opportunities.rows, candidates: mappedCandidates });
  const outputChecksum = creatorIntelligenceChecksum(decisions);
  const runKey = creatorIntelligenceChecksum({ cutoffAt, inputChecksum, outputChecksum, version: CREATOR_ALLOCATION_PROJECTION_VERSION });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(`INSERT INTO creator_program_allocation_shadow_runs(run_key,cutoff_at,projection_version,policy_version,input_checksum,output_checksum,opportunity_count,decision_count) VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(run_key) DO NOTHING RETURNING id`, [runKey, cutoffAt, CREATOR_ALLOCATION_PROJECTION_VERSION, CREATOR_READINESS_POLICY_VERSION, inputChecksum, outputChecksum, decisions.length]);
    const runId = inserted.rows[0]?.id || (await client.query(`SELECT id FROM creator_program_allocation_shadow_runs WHERE run_key=$1`, [runKey])).rows[0].id;
    if (inserted.rowCount) {
      for (const decision of decisions) await client.query(`INSERT INTO creator_program_allocation_shadow_decisions(allocation_key,allocation_run_id,scheduling_opportunity_key,actual_query_run_id,country,program_id,objective_key,objective_version,hypothesis_id,disposition,reason_codes,supporting_evidence,eligible_program_keys,behavior_propensity_basis_points,target_propensity_basis_points,randomization_value,policy_version,decided_at,serving_authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,false)`, [decision.allocationKey, runId, decision.schedulingOpportunityKey, decision.actualQueryRunId, decision.country, decision.programId || null, decision.objectiveKey || null, decision.objectiveVersion || null, decision.hypothesisId || null, decision.disposition, JSON.stringify(decision.reasonCodes), JSON.stringify(decision.supportingEvidence), JSON.stringify(decision.eligibleProgramKeys), decision.behaviorPropensityBasisPoints, decision.targetPropensityBasisPoints, decision.randomizationValue, decision.policyVersion, decision.decidedAt]);
    }
    await client.query('COMMIT');
    return { runId, runKey, opportunities: decisions.length, decisions: decisions.length, idempotent: !inserted.rowCount };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
        }
export async function projectShadowAssignmentLineage(allocationRunId: string, cutoffAt: string): Promise<{ records: number; completeness: number }> {
  const db = await getDb();
  const allocations = await db.query(`SELECT * FROM creator_program_allocation_shadow_decisions WHERE allocation_run_id=$1 ORDER BY scheduling_opportunity_key`, [allocationRunId]);
  let complete = 0;
  for (const allocation of allocations.rows) {
    const outcomeRun = await db.query(`SELECT id FROM creator_outcome_projection_runs WHERE cutoff_at<=$1 AND status='COMPLETED' ORDER BY cutoff_at DESC,created_at DESC LIMIT 1`, [cutoffAt]);
    const outcomes = outcomeRun.rowCount ? await db.query(`SELECT id FROM creator_outcome_records WHERE projection_run_id=$1 AND query_run_id=$2 ORDER BY outcome_key`, [outcomeRun.rows[0].id, allocation.actual_query_run_id]) : { rows: [], rowCount: 0 };
    const expected = await db.query(`SELECT COUNT(DISTINCT channel_id)::int count FROM channel_sightings WHERE query_run_id=$1 AND observed_at<=$2`, [allocation.actual_query_run_id, cutoffAt]);
    const coverage = allocation.program_id ? await db.query(`SELECT r.id run_id,s.id snapshot_id,s.target_key FROM creator_coverage_projection_runs r LEFT JOIN creator_coverage_shadow_snapshots s ON s.projection_run_id=r.id WHERE r.id=(SELECT id FROM creator_coverage_projection_runs WHERE program_id=$1 AND cutoff_at<=$2 ORDER BY cutoff_at DESC,created_at DESC LIMIT 1) ORDER BY s.target_key`, [allocation.program_id, cutoffAt]) : { rows: [] };
    const expectedCount = Number(expected.rows[0]?.count || 0), attributedCount = outcomes.rows.length;
    const completeness = expectedCount === 0 ? 1 : attributedCount / expectedCount;
    if (completeness === 1) complete++;
    const outcomeIds = outcomes.rows.map((row: any) => row.id), coverageRunIds = [...new Set(coverage.rows.map((row: any) => row.run_id).filter(Boolean))], coverageSnapshotIds = coverage.rows.map((row: any) => row.snapshot_id).filter(Boolean);
    const credited = outcomeRun.rowCount ? await db.query(`SELECT COUNT(*) FILTER(WHERE verified_creator_credit)::int verified,COUNT(*) FILTER(WHERE active_creator_credit)::int active FROM creator_outcome_records WHERE projection_run_id=$1 AND query_run_id=$2`, [outcomeRun.rows[0].id, allocation.actual_query_run_id]) : { rows: [{ verified: 0, active: 0 }] };
    const coverageChanges = coverage.rows.filter((row: any) => row.snapshot_id).map((row: any) => ({ snapshotId: row.snapshot_id, targetKey: row.target_key, attributedOutcomeIds: outcomeIds, verifiedCreatorDelta: Number(credited.rows[0]?.verified || 0), activeVerifiedCreatorDelta: Number(credited.rows[0]?.active || 0), counterfactual: true }));
    const sourceChecksum = creatorIntelligenceChecksum({ allocationKey: allocation.allocation_key, outcomeIds, coverageRunIds, coverageSnapshotIds, coverageChanges, expectedCount, cutoffAt });
    const lineageKey = creatorIntelligenceChecksum({ allocationKey: allocation.allocation_key, sourceChecksum, policyVersion: CREATOR_READINESS_POLICY_VERSION });
    await db.query(`INSERT INTO creator_assignment_shadow_lineage(lineage_key,allocation_id,actual_query_run_id,outcome_projection_run_id,outcome_ids,coverage_projection_run_ids,coverage_snapshot_ids,coverage_changes,expected_outcome_count,attributed_outcome_count,attribution_completeness,source_checksum,policy_version,as_of,serving_authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false) ON CONFLICT(lineage_key) DO NOTHING`, [lineageKey, allocation.id, allocation.actual_query_run_id, outcomeRun.rows[0]?.id || null, JSON.stringify(outcomeIds), JSON.stringify(coverageRunIds), JSON.stringify(coverageSnapshotIds), JSON.stringify(coverageChanges), expectedCount, attributedCount, completeness, sourceChecksum, CREATOR_READINESS_POLICY_VERSION, cutoffAt]);
  }
  return { records: allocations.rows.length, completeness: allocations.rowCount ? complete / allocations.rowCount : 0 };
}

export async function projectShadowGuardrails(allocationRunId: string, from: string, to: string): Promise<CreatorGuardrailSnapshot[]> {
  const db = await getDb();
  const run = await db.query(`SELECT run_key FROM creator_program_allocation_shadow_runs WHERE id=$1`, [allocationRunId]);
  if (!run.rowCount) throw new Error('SHADOW_ALLOCATION_RUN_NOT_FOUND');
  const lineage = await db.query(`SELECT l.attribution_completeness,d.allocation_key,d.country,d.behavior_propensity_basis_points,d.target_propensity_basis_points,o.* FROM creator_assignment_shadow_lineage l JOIN creator_program_allocation_shadow_decisions d ON d.id=l.allocation_id LEFT JOIN LATERAL jsonb_array_elements_text(l.outcome_ids) ids(outcome_id) ON true LEFT JOIN creator_outcome_records o ON o.id=ids.outcome_id::uuid WHERE d.allocation_run_id=$1 AND d.decided_at BETWEEN $2 AND $3 ORDER BY d.scheduling_opportunity_key,o.outcome_key`, [allocationRunId, from, to]);
  const outcomes: GuardrailOutcomeInput[] = lineage.rows.filter((row: any) => row.outcome_key).map((row: any) => {
    const evidence = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence;
    return {
      outcomeKey: row.outcome_key, allocationKey: row.allocation_key, countryStatus: evidence?.countryStatus,
      tradingStatus: evidence?.tradingStatus, outcomeType: row.outcome_type, maturity: row.maturity,
      verifiedCreatorCredit: row.verified_creator_credit, activeCreatorCredit: row.active_creator_credit,
      activityStatus: evidence?.activity?.status, providerUnits: Number(row.provider_units), effectiveAt: new Date(row.effective_at).toISOString(),
      behaviorPropensityBasisPoints: row.behavior_propensity_basis_points,
      targetPropensityBasisPoints: row.target_propensity_basis_points, country: row.country
    };
  });
  const completeness = lineage.rowCount ? Math.min(...lineage.rows.map((row: any) => Number(row.attribution_completeness))) : 0;
  const control = await db.query(`SELECT minimum_sample_size,maximum_evidence_age_hours FROM creator_readiness_shadow_control WHERE singleton=true`);
  const policy = { ...DEFAULT_CREATOR_GUARDRAIL_POLICY, minimumSampleSize: Number(control.rows[0]?.minimum_sample_size || 30) };
  const snapshots = projectCreatorGuardrails({ allocationRunKey: run.rows[0].run_key, outcomes, attributionCompleteness: completeness, observationWindow: { from, to }, maximumEvidenceAgeHours: Number(control.rows[0]?.maximum_evidence_age_hours || 48), policy });
  for (const snapshot of snapshots) await db.query(`INSERT INTO creator_guardrail_shadow_snapshots(snapshot_key,allocation_run_id,metric,numerator,denominator,metric_value,attribution_completeness,maturity_policy,observation_from,observation_to,latest_evidence_at,sample_size,effective_sample_size,confidence_lower,confidence_upper,result,reason_codes,policy_version,serving_authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,false) ON CONFLICT(snapshot_key) DO NOTHING`, [snapshot.snapshotKey, allocationRunId, snapshot.metric, snapshot.numerator, snapshot.denominator, snapshot.value, snapshot.attributionCompleteness, snapshot.maturityPolicy, snapshot.observationWindow.from, snapshot.observationWindow.to, snapshot.latestEvidenceAt, snapshot.sampleSize, snapshot.effectiveSampleSize, snapshot.confidence?.lower ?? null, snapshot.confidence?.upper ?? null, snapshot.result, JSON.stringify(snapshot.reasonCodes), snapshot.policyVersion]);
  return snapshots;
}

async function persistReadiness(record: CreatorReadinessRecord, outcomeRunId?: string, allocationRunId?: string): Promise<void> {
  const db = await getDb();
  await db.query(`INSERT INTO creator_readiness_shadow_runs(readiness_key,cutoff_at,outcome_projection_run_id,allocation_run_id,result,reason_codes,checks,input_checksum,output_checksum,policy_version,serving_authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false) ON CONFLICT(readiness_key) DO NOTHING`, [record.readinessKey, record.cutoffAt, outcomeRunId || null, allocationRunId || null, record.result, JSON.stringify(record.reasonCodes), JSON.stringify(record.checks), record.inputChecksum, record.outputChecksum, record.policyVersion]);
}

export async function runCreatorReadinessShadow(cutoffAt: string, windowDays = 30): Promise<CreatorReadinessRecord> {
  if (!validDate(cutoffAt) || !Number.isInteger(windowDays) || windowDays < 1) throw new Error('INVALID_CREATOR_READINESS_RUN');
  const db = await getDb();
  const control = await db.query(`SELECT enabled FROM creator_readiness_shadow_control WHERE singleton=true`);
  if (!control.rows[0]?.enabled) throw new Error('CREATOR_READINESS_SHADOW_DISABLED');
  const from = new Date(new Date(cutoffAt).getTime() - windowDays * 86400000).toISOString();
  try {
    const outcomes = await projectShadowCreatorOutcomes(cutoffAt);
    const programs = await db.query(`SELECT id FROM research_programs WHERE creator_shadow_only=true AND mode='SHADOW' AND activation_enabled=false ORDER BY program_key`);
    const coverageRuns: string[] = [];
    for (const program of programs.rows) coverageRuns.push((await projectShadowCreatorProgramState(program.id, cutoffAt)).projectionRunId);
    const allocations = await projectShadowProgramAllocations(cutoffAt);
    const lineage = await projectShadowAssignmentLineage(allocations.runId, cutoffAt);
    const guardrails = await projectShadowGuardrails(allocations.runId, from, cutoffAt);
    const playlistLineage = await reconcilePlaylistLineage(allocations.runId, cutoffAt);
    const allocationRows = await db.query(`SELECT opportunity_count,decision_count,input_checksum,output_checksum FROM creator_program_allocation_shadow_runs WHERE id=$1`, [allocations.runId]);
    const outcomeRows = await db.query(`SELECT input_count,output_count,input_checksum,output_checksum FROM creator_outcome_projection_runs WHERE id=$1`, [outcomes.projectionRunId]);
    const replayVariants = await db.query(`SELECT COUNT(DISTINCT output_checksum)::int count FROM creator_program_allocation_shadow_runs WHERE cutoff_at=$1 AND projection_version=$2`, [cutoffAt, CREATOR_ALLOCATION_PROJECTION_VERSION]);
    const missingCoverage = await db.query(`SELECT COUNT(*)::int count FROM creator_assignment_shadow_lineage l JOIN creator_program_allocation_shadow_decisions d ON d.id=l.allocation_id WHERE d.allocation_run_id=$1 AND d.disposition='ALLOCATED' AND jsonb_array_length(l.coverage_projection_run_ids)=0`, [allocations.runId]);
    const checks: Record<string, CreatorReadinessResult> = {
      phase1OutcomesComplete: Number(outcomeRows.rows[0]?.input_count) === Number(outcomeRows.rows[0]?.output_count) ? 'PASS' : 'ABSTAIN',
      phase2CoverageConsistent: programs.rowCount === coverageRuns.length && Number(missingCoverage.rows[0]?.count) === 0 ? 'PASS' : 'ABSTAIN',
      phase3AllocationsComplete: Number(allocationRows.rows[0]?.opportunity_count) === Number(allocationRows.rows[0]?.decision_count) ? 'PASS' : 'ABSTAIN',
      lineageComplete: lineage.records === allocations.decisions ? 'PASS' : 'ABSTAIN',
      replayChecksumsStable: Number(replayVariants.rows[0]?.count) === 1 && [allocationRows.rows[0]?.input_checksum, allocationRows.rows[0]?.output_checksum, outcomeRows.rows[0]?.input_checksum, outcomeRows.rows[0]?.output_checksum].every(value => /^[a-f0-9]{64}$/.test(value || '')) ? 'PASS' : 'ABSTAIN',
      attributionComplete: lineage.completeness === 1 ? 'PASS' : 'ABSTAIN'
    };
    const record = evaluateCreatorReadiness({ cutoffAt, checks, guardrails, sourceChecksums: [allocations.runKey, ...coverageRuns, outcomeRows.rows[0]?.output_checksum, ...playlistLineage.sourceChecksums].filter(Boolean) });
    await persistReadiness(record, outcomes.projectionRunId, allocations.runId);
    await db.query(`INSERT INTO creator_readiness_shadow_events(event_key,cutoff_at,event_type,result,reason_codes,detail,policy_version,serving_authority) VALUES($1,$2,'RUN_COMPLETED',$3,$4,$5,$6,false) ON CONFLICT(event_key) DO NOTHING`, [creatorIntelligenceChecksum({ readinessKey: record.readinessKey, event: 'RUN_COMPLETED' }), cutoffAt, record.result, JSON.stringify(record.reasonCodes), JSON.stringify({ readinessKey: record.readinessKey, outcomeProjectionRunId: outcomes.projectionRunId, allocationRunId: allocations.runId, playlistLineage }), CREATOR_READINESS_POLICY_VERSION]);
    return record;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record = evaluateCreatorReadiness({ cutoffAt, checks: { operationalRunner: 'ABSTAIN' }, guardrails: [], sourceChecksums: [creatorIntelligenceChecksum(message)] });
    await persistReadiness(record);
    await db.query(`INSERT INTO creator_readiness_shadow_events(event_key,cutoff_at,event_type,result,reason_codes,detail,policy_version,serving_authority) VALUES($1,$2,'RUN_ABSTAINED','ABSTAIN',$3,$4,$5,false) ON CONFLICT(event_key) DO NOTHING`, [creatorIntelligenceChecksum({ readinessKey: record.readinessKey, event: 'RUN_ABSTAINED' }), cutoffAt, JSON.stringify([...record.reasonCodes, 'OPERATIONAL_SHADOW_FAILURE']), JSON.stringify({ error: message }), CREATOR_READINESS_POLICY_VERSION]);
    return record;
  }
                   }
