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
  const db=await getDb();const client=await db.connect();try{await client.query('BEGIN');const r=await client.query(`INSERT INTO autonomous_query_page_observations(query_run_id,page_number,input_page_token,next_page_token,retrieval_lane,search_ordering,raw_result_count,distinct_creator_count,known_creators,new_creators,confirmed_creators,quality_confirmed_creators,average_quality_score,country_precision,community_diversity,novelty_ratio,duplicate_ratio,quota_units,marginal_utility,should_continue,decision_reason_codes,primary_reason,stopping_reason,page_metrics) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) ON CONFLICT(query_run_id,page_number) DO NOTHING RETURNING id`,[p.queryRunId,p.pageNumber,p.inputPageToken,p.nextPageToken,p.retrievalLane,p.searchOrdering,p.rawResultCount,p.distinctCreatorCount,p.knownCreators,p.newCreators,p.confirmedCreators,p.qualityConfirmedCreators,p.averageQualityScore,p.countryPrecision,p.communityDiversity,p.noveltyRatio,p.duplicateRatio,p.quotaUnits,p.decision.marginalUtility,p.decision.shouldContinue,JSON.stringify(p.decision.reasonCodes),p.decision.primaryReason,p.stoppingReason,JSON.stringify(p.pageMetrics)]);if(r.rowCount){const run=await client.query(`SELECT query_id,job_id,country FROM query_runs WHERE id=$1`,[p.queryRunId]);await client.query(`INSERT INTO outcome_events(event_key,subject_type,subject_id,event_type,event_version,source_event_key,query_id,query_run_id,job_id,country,retrieval_lane,verification_status,policy_version,feature_version,event_time,payload) VALUES($1,'QUERY_PAGE',$2,'PAGE_FUNNEL_RECORDED',1,$3,$4,$2,$5,$6,$7,'PROVISIONAL','passive-exploration-v1','query-page-funnel-v1',now(),$8) ON CONFLICT(event_key) DO NOTHING`,[`query-run:${p.queryRunId}:page:${p.pageNumber}:funnel:v1`,p.queryRunId,`query-run:${p.queryRunId}:selected:v1`,run.rows[0]?.query_id,run.rows[0]?.job_id,run.rows[0]?.country,p.retrievalLane,JSON.stringify({...p.pageMetrics,quotaUsed:p.quotaUnits,pageNumber:p.pageNumber})]);}await client.query('COMMIT');return !!r.rowCount;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function autonomousPageExists(runId:string,pageNumber:number):Promise<boolean>{const db=await getDb();const r=await db.query('SELECT 1 FROM autonomous_query_page_observations WHERE query_run_id=$1 AND page_number=$2',[runId,pageNumber]);return !!r.rowCount;}
export async function getAutonomousContinuationState(runId:string, pageNumber?: number):Promise<{
  consecutiveLowYieldPages:number;
  cumulativeDistinctCreators:number;
  delayedConfirmedCreators:number;
  delayedNonTradingCreators:number;
  delayedQualityCreators:number;
}>{
  const db=await getDb();
  const targetPage = Math.max(1, pageNumber || 1);
  const [pagesRes, delayedRes] = await Promise.all([
    db.query(`SELECT distinct_creator_count,marginal_utility,decision_reason_codes FROM autonomous_query_page_observations WHERE query_run_id=$1 ORDER BY page_number DESC`,[runId]),
    db.query(`SELECT
      COUNT(DISTINCT s.channel_id) FILTER(WHERE c.trading_status='TRADING_CONFIRMED')::int AS delayed_confirmed,
      COUNT(DISTINCT s.channel_id) FILTER(WHERE c.trading_status IN ('NON_TRADING','HUMAN_REJECTED'))::int AS delayed_non_trading,
      COUNT(DISTINCT s.channel_id) FILTER(WHERE c.trading_status='TRADING_CONFIRMED' AND COALESCE(c.quality_score,0)>=55)::int AS delayed_quality
      FROM channel_sightings s JOIN channels c ON c.channel_id=s.channel_id WHERE s.query_run_id=$1 AND s.page_number <= $2`,[runId, targetPage])
  ]);

  const delayed = delayedRes.rows[0] || { delayed_confirmed: 0, delayed_non_trading: 0, delayed_quality: 0 };
  let consecutive=0;
  for(const row of pagesRes.rows){
    const codes=typeof row.decision_reason_codes==='string'?JSON.parse(row.decision_reason_codes):row.decision_reason_codes;
    const low=Number(row.marginal_utility)<.2||codes?.some((x:string)=>['ZERO_CONFIRMED_VALUE','DUPLICATE_HEAVY','WRONG_COUNTRY'].includes(x));
    if(!low)break;
    consecutive++;
  }
  return {
    consecutiveLowYieldPages:consecutive,
    cumulativeDistinctCreators:pagesRes.rows.reduce((n,row)=>n+Number(row.distinct_creator_count||0),0),
    delayedConfirmedCreators: Number(delayed.delayed_confirmed || 0),
    delayedNonTradingCreators: Number(delayed.delayed_non_trading || 0),
    delayedQualityCreators: Number(delayed.delayed_quality || 0)
  };
}
export async function getAutonomousRunMetrics(runId:string):Promise<QueryFunnelMetrics>{const db=await getDb();const r=await db.query('SELECT page_metrics FROM autonomous_query_page_observations WHERE query_run_id=$1 ORDER BY page_number',[runId]);return aggregatePageMetrics(r.rows.map(x=>typeof x.page_metrics==='string'?JSON.parse(x.page_metrics):x.page_metrics));}

export function aggregatePageMetrics(pages:QueryFunnelMetrics[]):QueryFunnelMetrics {
  const sum=(key:keyof QueryFunnelMetrics)=>pages.reduce((n,p)=>n+Number(p[key]||0),0);
  const distinct=sum('distinctResults'); const evaluated=sum('nonTrading')+sum('uncertain')+sum('needsReview')+sum('tradingConfirmed');
  const weighted=(key:keyof QueryFunnelMetrics)=>distinct?pages.reduce((n,p)=>n+p.distinctResults*Number(p[key]||0),0)/distinct:0;
  return {rawResults:sum('rawResults'),distinctResults:distinct,duplicateResults:sum('duplicateResults'),knownChannels:sum('knownChannels'),newChannels:sum('newChannels'),countryRejected:sum('countryRejected'),nonTrading:sum('nonTrading'),uncertain:sum('uncertain'),needsReview:sum('needsReview'),tradingConfirmed:sum('tradingConfirmed'),qualityChannels:sum('qualityChannels'),communitiesDiscovered:sum('communitiesDiscovered'),averageQualityScore:weighted('averageQualityScore'),noveltyRatio:distinct?sum('newChannels')/distinct:0,countryPrecision:distinct?(distinct-sum('countryRejected'))/distinct:0,tradingPrecision:evaluated?sum('tradingConfirmed')/evaluated:0,performanceScore:Math.round(weighted('performanceScore'))};
}
