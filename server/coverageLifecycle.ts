import { createHash } from 'node:crypto';
import { getDb } from './db';

export const COVERAGE_POLICY_VERSION = 'coverage-lifecycle-v1';
export const COVERAGE_DECISION_VERSION = 'sleep-decision-v1';
const PROGRAM_KEY = 'price-action-trading';

export type ReactivationTrigger = 'TERMINOLOGY_BURST'|'NEW_CREATOR_CONTENT'|'STALE_COVERAGE'|'PROVIDER_CAPABILITY'|'HUMAN_NOMINATION'|'SCHEDULED_PROBE';
const REACTIVATION_TRIGGERS = new Set<ReactivationTrigger>(['TERMINOLOGY_BURST','NEW_CREATOR_CONTENT','STALE_COVERAGE','PROVIDER_CAPABILITY','HUMAN_NOMINATION','SCHEDULED_PROBE']);
export interface CoverageObservation { outcomeKey:string; cellKey:string; observedAt:string; distinctResults:number; newCreators:number; duplicateResults:number; verifiedCreators:number; providerCost:number; delayedBacklog:number }
export interface CoverageStats { evidenceCount:number; distinctResults:number; newCreators:number; duplicateResults:number; verifiedCreators:number; totalProviderCost:number; delayedBacklog:number; firstObservedAt:string|null; lastObservedAt:string|null }
export interface SleepEvidence { evidenceCount:number; minimumEvidence:number; bestFrontierUpperBound:number; costAwareThreshold:number; rediscoveryRate:number; minimumRediscoveryRate:number; uncoveredReachableCells:number; highInformationActions:number; delayedBacklog:number; maximumDelayedBacklog:number }

const nonnegative=(value:number,name:string) => { if(!Number.isSafeInteger(value)||value<0)throw new Error(`${name} must be a non-negative integer.`); return value; };
export function emptyCoverageStats():CoverageStats{return {evidenceCount:0,distinctResults:0,newCreators:0,duplicateResults:0,verifiedCreators:0,totalProviderCost:0,delayedBacklog:0,firstObservedAt:null,lastObservedAt:null};}
export function reduceCoverage(stats:CoverageStats, observation:CoverageObservation):CoverageStats {
  const time=new Date(observation.observedAt);if(!Number.isFinite(time.getTime()))throw new Error('observedAt must be an ISO timestamp.');
  return {evidenceCount:stats.evidenceCount+1,distinctResults:stats.distinctResults+nonnegative(observation.distinctResults,'distinctResults'),newCreators:stats.newCreators+nonnegative(observation.newCreators,'newCreators'),duplicateResults:stats.duplicateResults+nonnegative(observation.duplicateResults,'duplicateResults'),verifiedCreators:stats.verifiedCreators+nonnegative(observation.verifiedCreators,'verifiedCreators'),totalProviderCost:stats.totalProviderCost+nonnegative(observation.providerCost,'providerCost'),delayedBacklog:stats.delayedBacklog+nonnegative(observation.delayedBacklog,'delayedBacklog'),firstObservedAt:!stats.firstObservedAt||time<new Date(stats.firstObservedAt)?time.toISOString():stats.firstObservedAt,lastObservedAt:!stats.lastObservedAt||time>new Date(stats.lastObservedAt)?time.toISOString():stats.lastObservedAt};
}
export function replayCoverage(observations:CoverageObservation[]):Map<string,CoverageStats>{
  const unique=new Map(observations.map(o=>[o.outcomeKey,o]));const result=new Map<string,CoverageStats>();
  for(const o of [...unique.values()].sort((a,b)=>a.outcomeKey.localeCompare(b.outcomeKey))){result.set(o.cellKey,reduceCoverage(result.get(o.cellKey)||emptyCoverageStats(),o));}return result;
}
export function frontierScore(input:{expectedCoverage:number;informationGain:number;freshnessValue:number;expectedCost:number}):number{
  if(!Number.isFinite(input.expectedCost)||input.expectedCost<=0)return 0;
  return (Math.max(0,input.expectedCoverage)+Math.max(0,input.informationGain)+Math.max(0,input.freshnessValue))/input.expectedCost;
}
export function evaluateSleep(e:SleepEvidence):{shouldSleep:boolean;predicates:Record<string,boolean>}{
  const predicates={minimumEvidence:e.evidenceCount>=e.minimumEvidence,frontierBelowThreshold:e.bestFrontierUpperBound<e.costAwareThreshold,rediscoveryStable:e.rediscoveryRate>=e.minimumRediscoveryRate,cellsAccountedFor:e.uncoveredReachableCells===0,noHighInformationActions:e.highInformationActions===0,backlogStable:e.delayedBacklog<=e.maximumDelayedBacklog};
  return {shouldSleep:Object.values(predicates).every(Boolean),predicates};
}
export function lifecycleDecisionKey(input:{from:string;to:string;reason:string;trigger?:string;evidenceEnd?:string}):string{return createHash('sha256').update([COVERAGE_DECISION_VERSION,input.from,input.to,input.trigger||'',input.reason.normalize('NFKC').trim(),input.evidenceEnd||''].join('|')).digest('hex');}

export async function projectCoverageOutcome(observation:CoverageObservation,coordinates:Record<string,string>):Promise<boolean>{
  // Validate before beginning the transaction. The immutable outcome is the source
  // fact; the projection marker makes retries no-ops and supports full rebuilds.
  reduceCoverage(emptyCoverageStats(),observation);
  const db=await getDb();const client=await db.connect();
  try{await client.query('BEGIN');
    const context=await client.query(`SELECT p.id program_id,v.id dimension_version_id FROM research_programs p JOIN research_coverage_dimension_versions v ON v.program_id=p.id WHERE p.program_key=$1 AND v.version='coverage-v1'`,[PROGRAM_KEY]);if(!context.rowCount)throw new Error('Phase 7 coverage model is not installed.');const row=context.rows[0];
    const cell=await client.query(`INSERT INTO research_coverage_cells(dimension_version_id,cell_key,coordinates) VALUES($1,$2,$3) ON CONFLICT(dimension_version_id,cell_key) DO UPDATE SET cell_key=excluded.cell_key RETURNING id`,[row.dimension_version_id,observation.cellKey,JSON.stringify(coordinates)]);
    const marker=await client.query(`INSERT INTO research_coverage_projection_events(outcome_key,program_id,cell_id,projector_version) VALUES($1,$2,$3,$4) ON CONFLICT(outcome_key) DO NOTHING RETURNING outcome_key`,[observation.outcomeKey,row.program_id,cell.rows[0].id,COVERAGE_POLICY_VERSION]);
    if(marker.rowCount)await client.query(`INSERT INTO research_coverage_statistics(program_id,cell_id,evidence_count,distinct_results,new_creators,duplicate_results,verified_creators,total_provider_cost,delayed_backlog,first_observed_at,last_observed_at,projection_version) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$9,1) ON CONFLICT(program_id,cell_id) DO UPDATE SET evidence_count=research_coverage_statistics.evidence_count+1,distinct_results=research_coverage_statistics.distinct_results+excluded.distinct_results,new_creators=research_coverage_statistics.new_creators+excluded.new_creators,duplicate_results=research_coverage_statistics.duplicate_results+excluded.duplicate_results,verified_creators=research_coverage_statistics.verified_creators+excluded.verified_creators,total_provider_cost=research_coverage_statistics.total_provider_cost+excluded.total_provider_cost,delayed_backlog=research_coverage_statistics.delayed_backlog+excluded.delayed_backlog,first_observed_at=LEAST(research_coverage_statistics.first_observed_at,excluded.first_observed_at),last_observed_at=GREATEST(research_coverage_statistics.last_observed_at,excluded.last_observed_at),projection_version=research_coverage_statistics.projection_version+1,updated_at=now()`,[row.program_id,cell.rows[0].id,observation.distinctResults,observation.newCreators,observation.duplicateResults,observation.verifiedCreators,observation.providerCost,observation.delayedBacklog,observation.observedAt]);
    await client.query('COMMIT');return !!marker.rowCount;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function inspectCoverageLifecycle():Promise<unknown>{
  const db=await getDb();const result=await db.query(`SELECT p.program_key,p.lifecycle,v.version dimension_version,v.dimensions,
    COALESCE(jsonb_agg(jsonb_build_object('cellKey',c.cell_key,'coordinates',c.coordinates,'target',c.target,'unreachableReason',c.unreachable_reason,'statistics',CASE WHEN s.cell_id IS NULL THEN NULL ELSE jsonb_build_object('evidenceCount',s.evidence_count,'distinctResults',s.distinct_results,'newCreators',s.new_creators,'duplicateResults',s.duplicate_results,'verifiedCreators',s.verified_creators,'totalProviderCost',s.total_provider_cost,'delayedBacklog',s.delayed_backlog,'firstObservedAt',s.first_observed_at,'lastObservedAt',s.last_observed_at,'projectionVersion',s.projection_version) END) ORDER BY c.cell_key) FILTER (WHERE c.id IS NOT NULL),'[]'::jsonb) cells
    FROM research_programs p JOIN research_coverage_dimension_versions v ON v.program_id=p.id LEFT JOIN research_coverage_cells c ON c.dimension_version_id=v.id LEFT JOIN research_coverage_statistics s ON s.cell_id=c.id AND s.program_id=p.id WHERE p.program_key=$1 GROUP BY p.program_key,p.lifecycle,v.version,v.dimensions`,[PROGRAM_KEY]);
  if(!result.rowCount)throw new Error('Phase 7 coverage model is not installed.');
  const decisions=await db.query(`SELECT e.event_type,e.from_lifecycle,e.to_lifecycle,e.trigger_type,e.reason,e.predicates,e.evidence_window_start,e.evidence_window_end,e.policy_version,e.decision_version,e.actor,e.created_at FROM research_lifecycle_events e JOIN research_programs p ON p.id=e.program_id WHERE p.program_key=$1 ORDER BY e.created_at DESC LIMIT 100`,[PROGRAM_KEY]);
  return {...result.rows[0],coverageLabel:'estimate-with-uncertainty; absolute ecosystem recall is unknown',policyVersion:COVERAGE_POLICY_VERSION,decisionVersion:COVERAGE_DECISION_VERSION,decisions:decisions.rows};
}

export async function recordLifecycleEvent(input:{to:'ACTIVE'|'SLEEPING'|'PAUSED';reason:string;idempotencyKey:string;actor:string;trigger?:ReactivationTrigger;providerCostCap?:number}):Promise<unknown>{
  if(!input.reason?.trim())throw new Error('reason is required.');if(!input.idempotencyKey?.trim())throw new Error('idempotencyKey is required.');
  const cap=nonnegative(input.providerCostCap||0,'providerCostCap');const db=await getDb();const client=await db.connect();
  try{await client.query('BEGIN');const p=await client.query(`SELECT id,lifecycle FROM research_programs WHERE program_key=$1 FOR UPDATE`,[PROGRAM_KEY]);if(!p.rowCount)throw new Error('Topic pilot is not installed.');const from=p.rows[0].lifecycle;
    if(input.to==='ACTIVE'&&(!input.trigger||!REACTIVATION_TRIGGERS.has(input.trigger)))throw new Error('A valid reactivation trigger is required.');
    const inserted=await client.query(`INSERT INTO research_lifecycle_events(program_id,idempotency_key,event_type,from_lifecycle,to_lifecycle,trigger_type,reason,policy_version,decision_version,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(program_id,idempotency_key) DO NOTHING RETURNING id`,[p.rows[0].id,input.idempotencyKey,input.to==='ACTIVE'?'REACTIVATED':input.to==='SLEEPING'?'SLEPT':'PAUSED',from,input.to,input.trigger||null,input.reason.trim(),COVERAGE_POLICY_VERSION,COVERAGE_DECISION_VERSION,input.actor]);
    if(inserted.rowCount){await client.query(`UPDATE research_programs SET lifecycle=$2,activation_enabled=CASE WHEN $2='ACTIVE' THEN activation_enabled ELSE false END WHERE id=$1`,[p.rows[0].id,input.to]);if(input.to==='ACTIVE')await client.query(`INSERT INTO research_reactivation_events(lifecycle_event_id,trigger_key,eligible_at,freshness_probe,provider_cost_cap) VALUES($1,$2,now(),$3,$4)`,[inserted.rows[0].id,`${PROGRAM_KEY}:${input.idempotencyKey}`,input.trigger==='SCHEDULED_PROBE',cap]);}
    await client.query('COMMIT');return inspectCoverageLifecycle();
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
