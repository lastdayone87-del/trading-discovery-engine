import { getDb } from './db';
import type { RetrievalLane } from './retrievalLanes';
import type { SearchOrdering } from './searchOrdering';
import type { ContinuationDecision } from './continuationPolicy';
import type { QueryFunnelMetrics } from './queryPerformance';

export interface AutonomousPageObservation {
  queryRunId:string; pageNumber:number; inputPageToken:string|null; nextPageToken:string|null; retrievalLane:RetrievalLane; searchOrdering:SearchOrdering;
  rawResultCount:number; distinctCreatorCount:number; knownCreators:number; newCreators:number; confirmedCreators:number;
  qualityConfirmedCreators:number; averageQualityScore:number; countryPrecision:number; communityDiversity:number;
  noveltyRatio:number; duplicateRatio:number; quotaUnits:number; decision:ContinuationDecision; stoppingReason:string|null;
  pageMetrics: QueryFunnelMetrics;
}

export async function recordAutonomousPage(p:AutonomousPageObservation):Promise<boolean>{
  const db=await getDb(); const r=await db.query(`INSERT INTO autonomous_query_page_observations(query_run_id,page_number,input_page_token,next_page_token,retrieval_lane,search_ordering,raw_result_count,distinct_creator_count,known_creators,new_creators,confirmed_creators,quality_confirmed_creators,average_quality_score,country_precision,community_diversity,novelty_ratio,duplicate_ratio,quota_units,marginal_utility,should_continue,decision_reason_codes,primary_reason,stopping_reason,page_metrics) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) ON CONFLICT(query_run_id,page_number) DO NOTHING RETURNING id`,[p.queryRunId,p.pageNumber,p.inputPageToken,p.nextPageToken,p.retrievalLane,p.searchOrdering,p.rawResultCount,p.distinctCreatorCount,p.knownCreators,p.newCreators,p.confirmedCreators,p.qualityConfirmedCreators,p.averageQualityScore,p.countryPrecision,p.communityDiversity,p.noveltyRatio,p.duplicateRatio,p.quotaUnits,p.decision.marginalUtility,p.decision.shouldContinue,JSON.stringify(p.decision.reasonCodes),p.decision.primaryReason,p.stoppingReason,JSON.stringify(p.pageMetrics)]); return !!r.rowCount;
}

export async function autonomousPageExists(runId:string,pageNumber:number):Promise<boolean>{const db=await getDb();const r=await db.query('SELECT 1 FROM autonomous_query_page_observations WHERE query_run_id=$1 AND page_number=$2',[runId,pageNumber]);return !!r.rowCount;}
export async function getAutonomousContinuationState(runId:string):Promise<{consecutiveLowYieldPages:number;cumulativeDistinctCreators:number}>{const db=await getDb();const r=await db.query(`SELECT distinct_creator_count,marginal_utility,decision_reason_codes FROM autonomous_query_page_observations WHERE query_run_id=$1 ORDER BY page_number DESC`,[runId]);let consecutive=0;for(const row of r.rows){const codes=typeof row.decision_reason_codes==='string'?JSON.parse(row.decision_reason_codes):row.decision_reason_codes;const low=Number(row.marginal_utility)<.2||codes?.some((x:string)=>['ZERO_CONFIRMED_VALUE','DUPLICATE_HEAVY','WRONG_COUNTRY'].includes(x));if(!low)break;consecutive++;}return {consecutiveLowYieldPages:consecutive,cumulativeDistinctCreators:r.rows.reduce((n,row)=>n+Number(row.distinct_creator_count||0),0)};}
export async function getAutonomousRunMetrics(runId:string):Promise<QueryFunnelMetrics>{const db=await getDb();const r=await db.query('SELECT page_metrics FROM autonomous_query_page_observations WHERE query_run_id=$1 ORDER BY page_number',[runId]);return aggregatePageMetrics(r.rows.map(x=>typeof x.page_metrics==='string'?JSON.parse(x.page_metrics):x.page_metrics));}

export function aggregatePageMetrics(pages:QueryFunnelMetrics[]):QueryFunnelMetrics {
  const sum=(key:keyof QueryFunnelMetrics)=>pages.reduce((n,p)=>n+Number(p[key]||0),0);
  const distinct=sum('distinctResults'); const evaluated=sum('nonTrading')+sum('uncertain')+sum('needsReview')+sum('tradingConfirmed');
  const weighted=(key:keyof QueryFunnelMetrics)=>distinct?pages.reduce((n,p)=>n+p.distinctResults*Number(p[key]||0),0)/distinct:0;
  return {rawResults:sum('rawResults'),distinctResults:distinct,duplicateResults:sum('duplicateResults'),knownChannels:sum('knownChannels'),newChannels:sum('newChannels'),countryRejected:sum('countryRejected'),nonTrading:sum('nonTrading'),uncertain:sum('uncertain'),needsReview:sum('needsReview'),tradingConfirmed:sum('tradingConfirmed'),qualityChannels:sum('qualityChannels'),communitiesDiscovered:sum('communitiesDiscovered'),averageQualityScore:weighted('averageQualityScore'),noveltyRatio:distinct?sum('newChannels')/distinct:0,countryPrecision:distinct?(distinct-sum('countryRejected'))/distinct:0,tradingPrecision:evaluated?sum('tradingConfirmed')/evaluated:0,performanceScore:Math.round(weighted('performanceScore'))};
}
