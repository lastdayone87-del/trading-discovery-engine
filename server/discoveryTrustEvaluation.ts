import { createHash } from 'node:crypto';
import { getDb } from './db';

export const EVALUATION_VERSION = 'phase12-v1';
export const MIN_TRUST_SAMPLE = 20;
export type EvaluationStatus='INSUFFICIENT_EVIDENCE'|'HEALTHY'|'WATCH'|'DEGRADED';
export interface RunObservation { queryRunId:string; allocationOrigin:string; proposalFamily:string; country:string; language?:string|null; sourceFamilies?:string[]; canonicalConcept?:string|null; quotaConsumed:number; providerRequests:number; executionMs:number; rawResults:number; distinctCreators:number; knownCreators:number; newCreators:number; relevantNewCreators:number; qualityNewCreators:number; confirmedNewCreators:number; wrongCountryResults:number; irrelevantResults:number; providerFailed:boolean; invalidQuery:boolean; }
export interface EvaluationMetrics { sampleCount:number; denominatorQueries:number; allocationVolume:number; quotaConsumed:number; providerRequests:number; rawResults:number; distinctCreators:number; knownCreators:number; newCreators:number; relevantNewCreators:number; qualityNewCreators:number; confirmedNewCreators:number; yield:{newPerQuery:number;relevantPerQuery:number;qualityPerQuery:number;confirmedPerQuery:number}; precision:{relevant:number;quality:number;confirmed:number}; noveltyRate:number; redundancyRate:number; costPerUsefulDiscovery:number|null; providerFailureRate:number; wrongCountryRate:number; irrelevantRate:number; averageExecutionMs:number; coverage:{countries:number;languages:number;concepts:number;sourceFamilies:number}; status:EvaluationStatus; uncertainty:{insufficientSample:boolean;minimumSample:number;wilson95Relevant:[number,number]|null}; }

const ratio=(n:number,d:number)=>d>0?n/d:0;
function wilson(successes:number,total:number):[number,number]|null { if(total<=0)return null; const z=1.96,p=successes/total,den=1+z*z/total,centre=(p+z*z/(2*total))/den,margin=z*Math.sqrt((p*(1-p)+z*z/(4*total))/total)/den; return [Math.max(0,centre-margin),Math.min(1,centre+margin)]; }
export function evaluateRuns(rows:RunObservation[]):EvaluationMetrics {
  const sum=(key:keyof RunObservation)=>rows.reduce((n,r)=>n+Number(r[key]||0),0);
  const q=rows.length, raw=sum('rawResults'), distinct=sum('distinctCreators'), known=sum('knownCreators'), fresh=sum('newCreators'), relevant=sum('relevantNewCreators'), quality=sum('qualityNewCreators'), confirmed=sum('confirmedNewCreators'), quota=sum('quotaConsumed');
  const failures=rows.filter(r=>r.providerFailed||r.invalidQuery).length;
  const insufficient=q<MIN_TRUST_SAMPLE;
  const usefulYield=ratio(relevant,q), failureRate=ratio(failures,q), precision=ratio(relevant,fresh);
  const status:EvaluationStatus=insufficient?'INSUFFICIENT_EVIDENCE':failureRate>=.2||precision<.1?'DEGRADED':failureRate>=.1||usefulYield<.2?'WATCH':'HEALTHY';
  return {sampleCount:q,denominatorQueries:q,allocationVolume:q,quotaConsumed:quota,providerRequests:sum('providerRequests'),rawResults:raw,distinctCreators:distinct,knownCreators:known,newCreators:fresh,relevantNewCreators:relevant,qualityNewCreators:quality,confirmedNewCreators:confirmed,yield:{newPerQuery:ratio(fresh,q),relevantPerQuery:usefulYield,qualityPerQuery:ratio(quality,q),confirmedPerQuery:ratio(confirmed,q)},precision:{relevant:precision,quality:ratio(quality,fresh),confirmed:ratio(confirmed,fresh)},noveltyRate:ratio(fresh,distinct),redundancyRate:ratio(known,distinct),costPerUsefulDiscovery:relevant>0?quota/relevant:null,providerFailureRate:failureRate,wrongCountryRate:ratio(sum('wrongCountryResults'),raw),irrelevantRate:ratio(sum('irrelevantResults'),raw),averageExecutionMs:ratio(sum('executionMs'),q),coverage:{countries:new Set(rows.map(r=>r.country).filter(Boolean)).size,languages:new Set(rows.map(r=>r.language).filter(Boolean)).size,concepts:new Set(rows.map(r=>r.canonicalConcept).filter(Boolean)).size,sourceFamilies:new Set(rows.flatMap(r=>r.sourceFamilies||[])).size},status,uncertainty:{insufficientSample:insufficient,minimumSample:MIN_TRUST_SAMPLE,wilson95Relevant:wilson(relevant,fresh)}};
}

export type CohortDimension='overall'|'allocationOrigin'|'proposalFamily'|'country'|'language'|'sourceFamily'|'concept';
export function cohortKey(dimension:CohortDimension,value?:string):string { return `${dimension}:${value??'ALL'}`; }
export function filterCohort(rows:RunObservation[],dimension:CohortDimension,value?:string):RunObservation[]{ const sorted=[...rows].sort((a,b)=>a.queryRunId.localeCompare(b.queryRunId)); if(dimension==='overall')return sorted; if(dimension==='sourceFamily')return sorted.filter(r=>(r.sourceFamilies||[]).includes(value||'')); const key=dimension as keyof RunObservation; return sorted.filter(r=>String(r[key]??'')===String(value??'')); }
const stable=(value:unknown):string=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export const checksum=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');

/** Capture once after completion. This is deliberately best-effort and idempotent;
 * the completion transaction and scheduler never depend on evaluation availability. */
export async function captureCompletedRunObservation(queryRunId:string):Promise<boolean>{
  const db=await getDb();
  const result=await db.query(`WITH lineage AS (
    SELECT r.*,d.decision_id,d.created_at allocation_at,d.proposal_evidence_snapshot,
      COALESCE(d.proposal_evidence_snapshot->>'proposalFamily',CASE WHEN r.allocation_origin='LEGACY' THEN 'LEGACY' ELSE 'UNKNOWN' END) proposal_family,
      COALESCE(d.proposal_evidence_snapshot->'supportingEvidence','{}'::jsonb) evidence
    FROM query_runs r LEFT JOIN frontier_allocation_decisions d ON d.query_run_id=r.id
    WHERE r.id=$1 AND r.status='COMPLETED' ORDER BY d.created_at,d.decision_id LIMIT 1
  ), exact AS (
    SELECT COUNT(DISTINCT channel_id) FILTER(WHERE persisted AND NOT was_known AND funnel_outcome IN('TRADING_CONFIRMED','NEEDS_REVIEW'))::int relevant,
      COUNT(DISTINCT channel_id) FILTER(WHERE persisted AND NOT was_known AND funnel_outcome='TRADING_CONFIRMED')::int confirmed
    FROM channel_sightings WHERE query_run_id=$1
  ) INSERT INTO discovery_evaluation_run_observations(query_run_id,allocation_decision_id,allocation_origin,proposal_family,evidence_family,source_families,country,language,locale,script,canonical_concept,provider,rollout_cohort,allocation_snapshot,allocation_at,completed_at,classification_observed_at,quota_reserved,quota_consumed,provider_requests,execution_ms,raw_results,distinct_creators,known_creators,new_creators,relevant_new_creators,quality_new_creators,confirmed_new_creators,wrong_country_results,irrelevant_results,provider_failed,invalid_query,outcome_checksum)
  SELECT l.id,l.decision_id,COALESCE(l.allocation_origin,'LEGACY'),l.proposal_family,
    COALESCE(l.evidence->>'sourceProvenanceFamily',l.evidence->>'evidenceFamily'),
    CASE WHEN jsonb_typeof(l.evidence->'sourceFamilies')='array' THEN l.evidence->'sourceFamilies' ELSE '[]'::jsonb END,
    l.country,l.evidence->>'language',l.evidence->>'locale',l.evidence->>'script',COALESCE(l.evidence->>'canonicalConcept',l.evidence->>'canonicalTerm'),
    'youtube-search',COALESCE(l.retrieval_treatment_origin,'CONTROL'),COALESCE(l.proposal_evidence_snapshot,'{}'::jsonb),COALESCE(l.allocation_at,l.scheduled_at),l.completed_at,now(),l.quota_reserved,l.quota_used,CASE WHEN l.quota_used>0 THEN 1 ELSE 0 END,
    GREATEST(0,COALESCE(EXTRACT(EPOCH FROM (l.completed_at-l.started_at))*1000,0)::bigint),l.raw_results,l.distinct_results,l.known_channels,l.new_channels,COALESCE(e.relevant,0),
    LEAST(l.quality_channels,l.new_channels),COALESCE(e.confirmed,0),l.country_rejected,l.non_trading,(l.error IS NOT NULL),false,
    encode(digest(concat_ws(':',l.id::text,l.completed_at::text,l.raw_results::text,l.distinct_results::text,l.new_channels::text,l.quota_used::text),'sha256'),'hex')
  FROM lineage l CROSS JOIN exact e ON CONFLICT(query_run_id) DO NOTHING RETURNING query_run_id`,[queryRunId]);
  return Boolean(result.rowCount);
}

export async function materializeEvaluationWindow(input:{windowStart:string;windowEnd:string;dimension:CohortDimension;value?:string;revision?:number}) {
  const db=await getDb(), revision=input.revision??1;
  const bounded=await db.query(`SELECT query_run_id::text "queryRunId",allocation_origin "allocationOrigin",proposal_family "proposalFamily",country,language,source_families "sourceFamilies",canonical_concept "canonicalConcept",quota_consumed "quotaConsumed",provider_requests "providerRequests",execution_ms "executionMs",raw_results "rawResults",distinct_creators "distinctCreators",known_creators "knownCreators",new_creators "newCreators",relevant_new_creators "relevantNewCreators",quality_new_creators "qualityNewCreators",confirmed_new_creators "confirmedNewCreators",wrong_country_results "wrongCountryResults",irrelevant_results "irrelevantResults",provider_failed "providerFailed",invalid_query "invalidQuery" FROM discovery_evaluation_run_observations WHERE completed_at >= $1 AND completed_at < $2 ORDER BY completed_at,query_run_id LIMIT 10000`,[input.windowStart,input.windowEnd]);
  const cohort=filterCohort(bounded.rows,input.dimension,input.value), metrics=evaluateRuns(cohort), definition={dimension:input.dimension,value:input.value??null,frontierDefinition:'allocationOrigin != LEGACY',lineage:'allocation_snapshot',limit:10000};
  const sourceChecksum=checksum(cohort.map(r=>r.queryRunId));
  const saved=await db.query(`INSERT INTO discovery_evaluation_snapshots(cohort_key,window_start,window_end,evaluation_version,revision,source_watermark,source_checksum,cohort_definition,metrics,evaluation_status) VALUES($1,$2,$3,$4,$5,$3,$6,$7,$8,$9) ON CONFLICT(cohort_key,window_start,window_end,evaluation_version,revision) DO UPDATE SET source_checksum=discovery_evaluation_snapshots.source_checksum WHERE discovery_evaluation_snapshots.source_checksum=EXCLUDED.source_checksum RETURNING *`,[cohortKey(input.dimension,input.value),input.windowStart,input.windowEnd,EVALUATION_VERSION,revision,sourceChecksum,definition,metrics,metrics.status]);
  if(!saved.rowCount)throw new Error('EVALUATION_REVISION_CONFLICT'); return saved.rows[0];
}

export async function getDiscoveryTrustDiagnostics(input:{windowStart:string;windowEnd:string}) { const db=await getDb(); const rows=await db.query(`SELECT cohort_key,window_start,window_end,evaluation_version,revision,metrics,evaluation_status,generated_at FROM discovery_evaluation_snapshots WHERE window_start=$1 AND window_end=$2 ORDER BY cohort_key,revision DESC LIMIT 500`,[input.windowStart,input.windowEnd]); return {authority:'OBSERVATION_ONLY',qualityPolicy:'authoritative creator classification',historicalProvenance:'allocation_snapshot',snapshots:rows.rows}; }
