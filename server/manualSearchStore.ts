import { getDb } from './db';
import type { RetrievalLane } from './retrievalLanes';

export type ManualSearchStatus = 'RUNNING' | 'COMPLETED' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'FAILED';

export interface ManualSearchSession {
  id: string; originalQuery: string; country: string; generatedQueryVariants: string[]; retrievalLane: RetrievalLane;
  pageTokens: Array<string | null>; pagesProcessed: number; rawChannelIds: string[]; uniqueChannelIds: string[];
  knownChannelIds: string[]; acceptedChannelIds: string[]; quotaConsumed: number; progress: number;
  currentPage: number | null; estimatedCompletion: string | null; consecutiveLowYieldPages: number;
  stopReason: string | null; status: ManualSearchStatus; error: string | null; createdAt: string; updatedAt: string; completedAt: string | null;
}

const json = <T>(value: any, fallback: T): T => typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return fallback; } })() : (value ?? fallback);
const date = (value: any): string | null => value ? new Date(value).toISOString() : null;
function mapSession(row: any): ManualSearchSession {
  return { id: row.id, originalQuery: row.original_query, country: row.country, generatedQueryVariants: json(row.generated_query_variants, []),
    retrievalLane: row.retrieval_lane, pageTokens: json(row.page_tokens, []), pagesProcessed: row.pages_processed,
    rawChannelIds: json(row.raw_channel_ids, []), uniqueChannelIds: json(row.unique_channel_ids, []), knownChannelIds: json(row.known_channel_ids, []),
    acceptedChannelIds: json(row.accepted_channel_ids, []), quotaConsumed: row.quota_consumed, progress: Number(row.progress), currentPage: row.current_page,
    estimatedCompletion: date(row.estimated_completion), consecutiveLowYieldPages: row.consecutive_low_yield_pages, stopReason: row.stop_reason,
    status: row.status, error: row.error, createdAt: date(row.created_at)!, updatedAt: date(row.updated_at)!, completedAt: date(row.completed_at) };
}

export async function createManualSearchSession(args: { id: string; query: string; country: string; variants: string[]; lane: RetrievalLane; traceId?: string }): Promise<ManualSearchSession> {
  const db = await getDb(); const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`INSERT INTO manual_search_sessions(id,original_query,country,generated_query_variants,retrieval_lane,status,current_page)
      VALUES($1,$2,$3,$4,$5,'RUNNING',1) RETURNING *`, [args.id, args.query, args.country, JSON.stringify(args.variants), args.lane]);
    // Session and first-page work share one commit. The stable key makes a
    // replay/restart unable to materialize a duplicate page-one job.
    await client.query(`INSERT INTO jobs(type,payload,priority,max_attempts,idempotency_key)
      VALUES('MANUAL_SEARCH_PAGE',$1,200,3,$2) ON CONFLICT(idempotency_key) DO NOTHING`,
      [JSON.stringify({sessionId:args.id,pageNumber:1,pageToken:null,variantIndex:0,traceId:args.traceId}),`manual-page:${args.id}:1`]);
    await client.query('COMMIT');
    return mapSession(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
export async function getManualSearchSession(id: string): Promise<ManualSearchSession | null> { const db = await getDb(); const r = await db.query('SELECT * FROM manual_search_sessions WHERE id=$1',[id]); return r.rows[0] ? mapSession(r.rows[0]) : null; }
export async function listManualSearchSessions(limit = 20): Promise<ManualSearchSession[]> { const db = await getDb(); const r = await db.query('SELECT * FROM manual_search_sessions ORDER BY created_at DESC LIMIT $1',[Math.min(100,Math.max(1,limit))]); return r.rows.map(mapSession); }
export async function requestManualSearchCancellation(id: string): Promise<ManualSearchSession | null> { const db=await getDb(); const r=await db.query(`UPDATE manual_search_sessions SET status=CASE WHEN status='RUNNING' THEN 'CANCEL_REQUESTED' ELSE status END,updated_at=now() WHERE id=$1 RETURNING *`,[id]); return r.rows[0]?mapSession(r.rows[0]):null; }
export async function failManualSearch(id: string, error: unknown): Promise<void> { const db=await getDb(); await db.query(`UPDATE manual_search_sessions SET status='FAILED',stop_reason='ERROR',error=$2,completed_at=now(),updated_at=now(),current_page=NULL WHERE id=$1 AND status NOT IN ('COMPLETED','CANCELLED')`,[id,String((error as any)?.message||error).slice(0,2000)]); }
export async function cancelManualSearch(id: string): Promise<void> { const db=await getDb(); await db.query(`UPDATE manual_search_sessions SET status='CANCELLED',stop_reason='USER_CANCELLED',completed_at=now(),updated_at=now(),current_page=NULL WHERE id=$1 AND status='CANCEL_REQUESTED'`,[id]); }

export interface PageObservation { pageNumber:number; queryVariant:string; lane:RetrievalLane; inputPageToken:string|null; nextPageToken:string|null; rawResultCount:number; rawIds:string[]; uniqueIds:string[]; knownIds:string[]; acceptedIds:string[]; confirmedIds:string[]; qualityConfirmedIds:string[]; averageQualityScore:number; countryPrecision:number; communityDiversity:number; noveltyRatio:number; duplicateRatio:number; quotaUnits:number; quotaEfficiency:number; creatorYield:number; lowYield:boolean; marginalUtility:number; shouldContinue:boolean; primaryReason:string; reasonCodes:string[]; maxPages:number; stopReason:string|null; }
export async function recordManualSearchPage(id: string, p: PageObservation): Promise<ManualSearchSession> {
  const db=await getDb(); const client=await db.connect();
  try { await client.query('BEGIN'); const inserted=await client.query(`INSERT INTO manual_search_page_observations(session_id,page_number,query_variant,retrieval_lane,input_page_token,next_page_token,raw_channel_ids,unique_channel_ids,known_channel_ids,accepted_channel_ids,novelty_ratio,duplicate_ratio,quota_units,quota_efficiency,creator_yield,raw_result_count,distinct_creator_count,confirmed_creator_ids,quality_confirmed_creator_ids,average_quality_score,country_precision,community_diversity,marginal_utility,should_continue,decision_reason_codes,primary_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) ON CONFLICT(session_id,page_number) DO NOTHING RETURNING id`,[id,p.pageNumber,p.queryVariant,p.lane,p.inputPageToken,p.nextPageToken,JSON.stringify(p.rawIds),JSON.stringify(p.uniqueIds),JSON.stringify(p.knownIds),JSON.stringify(p.acceptedIds),p.noveltyRatio,p.duplicateRatio,p.quotaUnits,p.quotaEfficiency,p.creatorYield,p.rawResultCount,p.uniqueIds.length,JSON.stringify(p.confirmedIds),JSON.stringify(p.qualityConfirmedIds),p.averageQualityScore,p.countryPrecision,p.communityDiversity,p.marginalUtility,p.shouldContinue,JSON.stringify(p.reasonCodes),p.primaryReason]);
    if (!inserted.rowCount) { const existing=await client.query('SELECT * FROM manual_search_sessions WHERE id=$1',[id]); await client.query('COMMIT'); if(!existing.rows[0]) throw new Error(`Manual search session ${id} no longer exists.`); return mapSession(existing.rows[0]); }
    const done=!!p.stopReason; const r=await client.query(`UPDATE manual_search_sessions SET pages_processed=GREATEST(pages_processed,$2),page_tokens=page_tokens||$3::jsonb,raw_channel_ids=COALESCE((SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(raw_channel_ids||$4::jsonb) x),'[]'::jsonb),unique_channel_ids=COALESCE((SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(unique_channel_ids||$5::jsonb) x),'[]'::jsonb),known_channel_ids=COALESCE((SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(known_channel_ids||$6::jsonb) x),'[]'::jsonb),accepted_channel_ids=COALESCE((SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(accepted_channel_ids||$7::jsonb) x),'[]'::jsonb),quota_consumed=quota_consumed+$8,consecutive_low_yield_pages=CASE WHEN $9 THEN consecutive_low_yield_pages+1 ELSE 0 END,progress=CASE WHEN $10 THEN 100 ELSE LEAST(99,ROUND(($2::numeric/$11)*100,2)) END,status=CASE WHEN $10 THEN 'COMPLETED' ELSE status END,stop_reason=$12,current_page=CASE WHEN $10 THEN NULL ELSE $2+1 END,estimated_completion=CASE WHEN $10 THEN NULL ELSE now()+(GREATEST(1,$11-$2)*interval '20 seconds') END,completed_at=CASE WHEN $10 THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *`,[id,p.pageNumber,JSON.stringify([p.nextPageToken]),JSON.stringify(p.rawIds),JSON.stringify(p.uniqueIds),JSON.stringify(p.knownIds),JSON.stringify(p.acceptedIds),p.quotaUnits,p.lowYield,done,p.maxPages,p.stopReason]); await client.query('COMMIT'); return mapSession(r.rows[0]);
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}
