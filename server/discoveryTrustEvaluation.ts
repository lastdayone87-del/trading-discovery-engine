import { createHash } from 'node:crypto';
import { getDb } from './db';
import { QUALITY_CREATOR_SCORE_THRESHOLD } from './queryPerformance';

export const EVALUATION_VERSION = 'phase12-v1';
export const MIN_TRUST_SAMPLE = 20;
export type EvaluationStatus='INSUFFICIENT_EVIDENCE'|'HEALTHY'|'WATCH'|'DEGRADED';
export interface RunObservation { queryRunId:string; observationRevision?:number; outcomeChecksum?:string; allocationOrigin:string; proposalFamily:string; country:string; language?:string|null; sourceFamilies?:string[]; canonicalConcept?:string|null; countryCoverageExpanded?:boolean;languageCoverageExpanded?:boolean;conceptCoverageExpanded?:boolean;sourceCoverageExpansionCount?:number; quotaConsumed:number; providerRequests:number; executionMs:number|null; rawResults:number; distinctCreators:number; knownCreators:number; newCreators:number; relevantNewCreators:number; qualityNewCreators:number; confirmedNewCreators:number; wrongCountryResults:number; irrelevantResults:number; providerFailed:boolean; invalidQuery:boolean; }
export interface EvaluationMetrics { sampleCount:number; denominatorQueries:number; allocationVolume:number; quotaConsumed:number; providerRequests:number; rawResults:number; distinctCreators:number; knownCreators:number; newCreators:number; relevantNewCreators:number; qualityNewCreators:number; confirmedNewCreators:number; denominators:{yieldCompletedRuns:number;precisionNewCreators:number;noveltyDistinctCreators:number;redundancyDistinctCreators:number;efficiencyRelevantNewCreators:number;failureTerminalRuns:number;wrongCountryDistinctCreators:number;irrelevantDistinctCreators:number;latencyObservedRuns:number}; yield:{newPerQuery:number;relevantPerQuery:number;qualityPerQuery:number;confirmedPerQuery:number}; precision:{relevant:number;quality:number;confirmed:number}; noveltyRate:number; redundancyRate:number; costPerUsefulDiscovery:number|null; providerFailureRate:number; wrongCountryRate:number; irrelevantRate:number; averageExecutionMs:number|null; coverage:{countries:number;languages:number;concepts:number;sourceFamilies:number};coverageExpansion:{countries:number;languages:number;concepts:number;sourceFamilies:number}; status:EvaluationStatus; uncertainty:{insufficientSample:boolean;minimumSample:number;wilson95Relevant:[number,number]|null}; }

const ratio=(n:number,d:number)=>d>0?n/d:0;
function wilson(successes:number,total:number):[number,number]|null { if(total<=0)return null; const z=1.96,p=successes/total,den=1+z*z/total,centre=(p+z*z/(2*total))/den,margin=z*Math.sqrt((p*(1-p)+z*z/(4*total))/total)/den; return [Math.max(0,centre-margin),Math.min(1,centre+margin)]; }
export function evaluateRuns(rows:RunObservation[]):EvaluationMetrics {
  const sum=(key:keyof RunObservation)=>rows.reduce((n,r)=>n+Number(r[key]||0),0);
  const q=rows.length, raw=sum('rawResults'), distinct=sum('distinctCreators'), known=sum('knownCreators'), fresh=sum('newCreators'), relevant=sum('relevantNewCreators'), quality=sum('qualityNewCreators'), confirmed=sum('confirmedNewCreators'), quota=sum('quotaConsumed');
  const latencyRows=rows.filter(r=>r.executionMs!==null&&Number.isFinite(r.executionMs));
  const failures=rows.filter(r=>r.providerFailed||r.invalidQuery).length;
  const insufficient=q<MIN_TRUST_SAMPLE;
  const usefulYield=ratio(relevant,q), failureRate=ratio(failures,q), precision=ratio(relevant,fresh);
  const status:EvaluationStatus=insufficient?'INSUFFICIENT_EVIDENCE':failureRate>=.2||precision<.1?'DEGRADED':failureRate>=.1||usefulYield<.2?'WATCH':'HEALTHY';
  return {sampleCount:q,denominatorQueries:q,allocationVolume:q,quotaConsumed:quota,providerRequests:sum('providerRequests'),rawResults:raw,distinctCreators:distinct,knownCreators:known,newCreators:fresh,relevantNewCreators:relevant,qualityNewCreators:quality,confirmedNewCreators:confirmed,denominators:{yieldCompletedRuns:q,precisionNewCreators:fresh,noveltyDistinctCreators:distinct,redundancyDistinctCreators:distinct,efficiencyRelevantNewCreators:relevant,failureTerminalRuns:q,wrongCountryDistinctCreators:distinct,irrelevantDistinctCreators:distinct,latencyObservedRuns:latencyRows.length},yield:{newPerQuery:ratio(fresh,q),relevantPerQuery:usefulYield,qualityPerQuery:ratio(quality,q),confirmedPerQuery:ratio(confirmed,q)},precision:{relevant:precision,quality:ratio(quality,fresh),confirmed:ratio(confirmed,fresh)},noveltyRate:ratio(fresh,distinct),redundancyRate:ratio(known,distinct),costPerUsefulDiscovery:relevant>0?quota/relevant:null,providerFailureRate:failureRate,wrongCountryRate:ratio(sum('wrongCountryResults'),distinct),irrelevantRate:ratio(sum('irrelevantResults'),distinct),averageExecutionMs:latencyRows.length?latencyRows.reduce((n,r)=>n+Number(r.executionMs),0)/latencyRows.length:null,coverage:{countries:new Set(rows.map(r=>r.country).filter(Boolean)).size,languages:new Set(rows.map(r=>r.language).filter(Boolean)).size,concepts:new Set(rows.map(r=>r.canonicalConcept).filter(Boolean)).size,sourceFamilies:new Set(rows.flatMap(r=>r.sourceFamilies||[])).size},coverageExpansion:{countries:rows.filter(r=>r.countryCoverageExpanded).length,languages:rows.filter(r=>r.languageCoverageExpanded).length,concepts:rows.filter(r=>r.conceptCoverageExpanded).length,sourceFamilies:sum('sourceCoverageExpansionCount')},status,uncertainty:{insufficientSample:insufficient,minimumSample:MIN_TRUST_SAMPLE,wilson95Relevant:wilson(relevant,fresh)}};
}

export type CohortDimension='overall'|'allocationOrigin'|'proposalFamily'|'country'|'language'|'sourceFamily'|'concept';
export function cohortKey(dimension:CohortDimension,value?:string):string { return `${dimension}:${value??'ALL'}`; }
export function filterCohort(rows:RunObservation[],dimension:CohortDimension,value?:string):RunObservation[]{ const sorted=[...rows].sort((a,b)=>a.queryRunId.localeCompare(b.queryRunId)); if(dimension==='overall')return sorted; if(dimension==='sourceFamily')return sorted.filter(r=>(r.sourceFamilies||[]).includes(value||'')); const key: keyof RunObservation=dimension==='concept'?'canonicalConcept':dimension; return sorted.filter(r=>String(r[key]??'')===String(value??'')); }
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
    WHERE r.id=$1 AND r.status IN('COMPLETED','FAILED') ORDER BY d.created_at,d.decision_id LIMIT 1
  ), exact AS (
    SELECT COUNT(DISTINCT s.channel_id) FILTER(WHERE s.persisted AND NOT s.was_known AND COALESCE(c.trading_status,s.funnel_outcome) IN('TRADING_CONFIRMED','NEEDS_REVIEW'))::int relevant,
      COUNT(DISTINCT s.channel_id) FILTER(WHERE s.persisted AND NOT s.was_known AND COALESCE(c.trading_status,s.funnel_outcome)='TRADING_CONFIRMED')::int confirmed,
      COUNT(DISTINCT s.channel_id) FILTER(WHERE s.persisted AND NOT s.was_known AND c.trading_status='TRADING_CONFIRMED' AND c.quality_score>=${QUALITY_CREATOR_SCORE_THRESHOLD})::int quality,
      COALESCE(MAX(s.page_number),0)::int sighting_pages,MAX(c.updated_at) classification_version
    FROM channel_sightings s LEFT JOIN channels c ON c.channel_id=s.channel_id WHERE s.query_run_id=$1
  ), prepared AS (SELECT l.*,e.*,
    encode(digest(concat_ws(':',l.id::text,l.completed_at::text,l.raw_results::text,l.distinct_results::text,l.known_channels::text,l.new_channels::text,l.quota_used::text,e.relevant::text,e.quality::text,e.confirmed::text,e.classification_version::text),'sha256'),'hex') checksum
    FROM lineage l CROSS JOIN exact e
  ) INSERT INTO discovery_evaluation_run_observations(query_run_id,observation_revision,allocation_decision_id,allocation_origin,proposal_family,evidence_family,source_families,country,language,locale,script,canonical_concept,provider,rollout_cohort,allocation_snapshot,allocation_at,completed_at,classification_observed_at,quota_reserved,quota_consumed,provider_requests,execution_ms,raw_results,distinct_creators,known_creators,new_creators,relevant_new_creators,quality_new_creators,confirmed_new_creators,wrong_country_results,irrelevant_results,provider_failed,invalid_query,outcome_checksum)
  SELECT l.id,COALESCE((SELECT MAX(o.observation_revision)+1 FROM discovery_evaluation_run_observations o WHERE o.query_run_id=l.id),1),l.decision_id,COALESCE(l.allocation_origin,'LEGACY'),l.proposal_family,
    COALESCE(l.evidence->>'sourceProvenanceFamily',l.evidence->>'evidenceFamily'),
    CASE WHEN jsonb_typeof(l.evidence->'sourceFamilies')='array' THEN l.evidence->'sourceFamilies' ELSE '[]'::jsonb END,
    l.country,l.evidence->>'language',l.evidence->>'locale',l.evidence->>'script',COALESCE(l.evidence->>'canonicalConcept',l.evidence->>'canonicalTerm',l.evidence->>'canonicalTermId'),
    'youtube-search',COALESCE(l.retrieval_treatment_origin,'CONTROL'),COALESCE(l.proposal_evidence_snapshot,'{}'::jsonb),COALESCE(l.allocation_at,l.scheduled_at),l.completed_at,now(),l.quota_reserved,l.quota_used,GREATEST(l.sighting_pages,CEIL(l.quota_used/100.0)::int),
    CASE WHEN l.started_at IS NULL THEN NULL ELSE GREATEST(0,(EXTRACT(EPOCH FROM (l.completed_at-l.started_at))*1000)::bigint) END,l.raw_results,l.distinct_results,l.known_channels,l.new_channels,COALESCE(l.relevant,0),
    COALESCE(l.quality,0),COALESCE(l.confirmed,0),l.country_rejected,l.non_trading,(l.status='FAILED' AND l.performance_details->>'failureKind' IS DISTINCT FROM 'INVALID_QUERY'),(l.status='FAILED' AND l.performance_details->>'failureKind'='INVALID_QUERY'),
    l.checksum
  FROM prepared l ON CONFLICT DO NOTHING RETURNING query_run_id`,[queryRunId]);
  return Boolean(result.rowCount);
}

export async function materializeEvaluationWindow(input:{windowStart:string;windowEnd:string;dimension:CohortDimension;value?:string;revision?:number}) {
  const start=Date.parse(input.windowStart),end=Date.parse(input.windowEnd);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>90*24*60*60*1000)throw new Error('INVALID_EVALUATION_WINDOW');
  const db=await getDb(), revision=input.revision??1,sourceWatermark=new Date().toISOString();
  const bounded=await db.query(`SELECT l.query_run_id::text "queryRunId",l.observation_revision "observationRevision",l.outcome_checksum "outcomeChecksum",l.allocation_origin "allocationOrigin",l.proposal_family "proposalFamily",l.country,l.language,l.source_families "sourceFamilies",l.canonical_concept "canonicalConcept",l.quota_consumed "quotaConsumed",l.provider_requests "providerRequests",l.execution_ms "executionMs",l.raw_results "rawResults",l.distinct_creators "distinctCreators",l.known_creators "knownCreators",l.new_creators "newCreators",l.relevant_new_creators "relevantNewCreators",l.quality_new_creators "qualityNewCreators",l.confirmed_new_creators "confirmedNewCreators",l.wrong_country_results "wrongCountryResults",l.irrelevant_results "irrelevantResults",l.provider_failed "providerFailed",l.invalid_query "invalidQuery",
    NOT EXISTS(SELECT 1 FROM discovery_evaluation_run_observations p WHERE p.country=l.country AND (p.completed_at,p.query_run_id)<(l.completed_at,l.query_run_id)) "countryCoverageExpanded",
    l.language IS NOT NULL AND NOT EXISTS(SELECT 1 FROM discovery_evaluation_run_observations p WHERE p.language=l.language AND (p.completed_at,p.query_run_id)<(l.completed_at,l.query_run_id)) "languageCoverageExpanded",
    l.canonical_concept IS NOT NULL AND NOT EXISTS(SELECT 1 FROM discovery_evaluation_run_observations p WHERE p.canonical_concept=l.canonical_concept AND (p.completed_at,p.query_run_id)<(l.completed_at,l.query_run_id)) "conceptCoverageExpanded",
    (SELECT COUNT(*)::int FROM jsonb_array_elements_text(l.source_families) sf(value) WHERE NOT EXISTS(SELECT 1 FROM discovery_evaluation_run_observations p WHERE p.source_families ? sf.value AND (p.completed_at,p.query_run_id)<(l.completed_at,l.query_run_id))) "sourceCoverageExpansionCount"
    FROM (SELECT DISTINCT ON(query_run_id) * FROM (SELECT * FROM discovery_evaluation_run_observations WHERE completed_at >= $1 AND completed_at < $2 AND classification_observed_at <= $3 ORDER BY completed_at,query_run_id,observation_revision DESC LIMIT 50000) bounded ORDER BY query_run_id,observation_revision DESC) l ORDER BY l.completed_at,l.query_run_id LIMIT 10000`,[input.windowStart,input.windowEnd,sourceWatermark]);
  const cohort=filterCohort(bounded.rows,input.dimension,input.value), metrics=evaluateRuns(cohort), definition={dimension:input.dimension,value:input.value??null,frontierDefinition:'allocationOrigin != LEGACY',lineage:'allocation_snapshot',observationScanLimit:50000,cohortLimit:10000};
  const sourceChecksum=checksum(cohort.map(r=>[r.queryRunId,r.observationRevision,r.outcomeChecksum]));
  const saved=await db.query(`INSERT INTO discovery_evaluation_snapshots(cohort_key,window_start,window_end,evaluation_version,revision,source_watermark,source_checksum,cohort_definition,metrics,evaluation_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(cohort_key,window_start,window_end,evaluation_version,revision) DO UPDATE SET source_checksum=discovery_evaluation_snapshots.source_checksum WHERE discovery_evaluation_snapshots.source_checksum=EXCLUDED.source_checksum RETURNING *`,[cohortKey(input.dimension,input.value),input.windowStart,input.windowEnd,EVALUATION_VERSION,revision,sourceWatermark,sourceChecksum,definition,metrics,metrics.status]);
  if(!saved.rowCount)throw new Error('EVALUATION_REVISION_CONFLICT'); return saved.rows[0];
}

export async function getDiscoveryTrustDiagnostics(input:{windowStart:string;windowEnd:string}) { const db=await getDb(); const rows=await db.query(`SELECT cohort_key,window_start,window_end,evaluation_version,revision,metrics,evaluation_status,generated_at FROM discovery_evaluation_snapshots WHERE window_start=$1 AND window_end=$2 ORDER BY cohort_key,revision DESC LIMIT 500`,[input.windowStart,input.windowEnd]); return {authority:'OBSERVATION_ONLY',qualityPolicy:'authoritative creator classification',historicalProvenance:'allocation_snapshot',snapshots:rows.rows}; }
