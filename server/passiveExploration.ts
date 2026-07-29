import { createHash } from 'node:crypto';
import { getDb } from './db';
import type { AutonomousPageObservation } from './autonomousPageStore';

export const PASSIVE_EXPLORATION_POLICY_VERSION = 'passive-exploration-v1';
const PROGRAM_KEY = 'price-action-trading';

export function normalizeActionTarget(value:string):string {
  return value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en');
}

export function semanticActionKey(input:{queryRunId:string;query:string;pageNumber:number}):string {
  const type=input.pageNumber===1?'SEARCH_TERM':'CONTINUE_RESULT_PAGE';
  const canonical=`${PASSIVE_EXPLORATION_POLICY_VERSION}|${type}|${input.queryRunId}|${input.pageNumber}|${normalizeActionTarget(input.query)}`;
  return createHash('sha256').update(canonical).digest('hex');
}

function validityWindow(now=new Date()):{start:string;end:string}{
  const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
  return {start:start.toISOString(),end:new Date(start.getTime()+86400000).toISOString()};
}

export async function recordPassivePage(input:{query:string;jobId:string;observation:AutonomousPageObservation}):Promise<void>{
  if(process.env.PHASE5_SHADOW_WRITES!=='true')return;
  const db=await getDb();const client=await db.connect();const p=input.observation;
  try{
    await client.query('BEGIN');
    const program=await client.query(`SELECT id FROM research_programs WHERE program_key=$1 AND mode='SHADOW' AND activation_enabled=false`,[PROGRAM_KEY]);
    if(!program.rowCount)throw new Error('PASSIVE_PROGRAM_UNAVAILABLE');
    const run=await client.query(`SELECT scheduled_at,started_at,completed_at FROM query_runs WHERE id=$1`,[p.queryRunId]);
    if(!run.rowCount)throw new Error('SOURCE_RUN_UNAVAILABLE');
    const window=validityWindow(new Date(run.rows[0].scheduled_at));
    let parentId:null|string=null;
    if(p.pageNumber>1){const parent=await client.query(`SELECT a.id FROM frontier_actions a JOIN frontier_action_attempts x ON x.action_id=a.id WHERE a.source_query_run_id=$1 AND x.page_number=$2`,[p.queryRunId,p.pageNumber-1]);if(!parent.rowCount)throw new Error('PARENT_ACTION_UNAVAILABLE');parentId=parent.rows[0].id;}
    const actionKey=semanticActionKey({queryRunId:p.queryRunId,query:input.query,pageNumber:p.pageNumber});
    const action=await client.query(`INSERT INTO frontier_actions(program_id,action_type,semantic_action_key,normalized_target,validity_start,validity_end,lifecycle,policy_version,source_query_run_id,source_job_id,parent_action_id,estimated_cost) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED',$7,$8,$9,$10,$11) ON CONFLICT(program_id,semantic_action_key,validity_start,validity_end) DO UPDATE SET semantic_action_key=excluded.semantic_action_key RETURNING id`,[program.rows[0].id,p.pageNumber===1?'SEARCH_TERM':'CONTINUE_RESULT_PAGE',actionKey,normalizeActionTarget(input.query),window.start,window.end,PASSIVE_EXPLORATION_POLICY_VERSION,p.queryRunId,input.jobId,parentId,JSON.stringify({youtubeUnits:p.quotaUnits,webUnits:0,aiUnits:0,computeUnits:0,reviewUnits:0})]);
    const actionId=action.rows[0].id;
    await client.query(`INSERT INTO frontier_action_lineage(ancestor_action_id,descendant_action_id,depth) VALUES($1,$1,0) ON CONFLICT DO NOTHING`,[actionId]);
    if(parentId)await client.query(`INSERT INTO frontier_action_lineage(ancestor_action_id,descendant_action_id,depth) SELECT ancestor_action_id,$1,depth+1 FROM frontier_action_lineage WHERE descendant_action_id=$2 ON CONFLICT DO NOTHING`,[actionId,parentId]);
    const attemptKey=`query-run:${p.queryRunId}:page:${p.pageNumber}:attempt:v1`;
    const attempt=await client.query(`INSERT INTO frontier_action_attempts(action_id,attempt_key,source_job_id,source_query_run_id,page_number,status,started_at,completed_at,policy_version) VALUES($1,$2,$3,$4,$5,'COMPLETED',$6,$7,$8) ON CONFLICT(attempt_key) DO UPDATE SET attempt_key=excluded.attempt_key RETURNING id`,[actionId,attemptKey,input.jobId,p.queryRunId,p.pageNumber,run.rows[0].started_at,run.rows[0].completed_at||new Date().toISOString(),PASSIVE_EXPLORATION_POLICY_VERSION]);
    const metrics={rawResults:p.pageMetrics.rawResults,distinctResults:p.pageMetrics.distinctResults,duplicateResults:p.pageMetrics.duplicateResults,knownChannels:p.pageMetrics.knownChannels,newChannels:p.pageMetrics.newChannels,countryRejected:p.pageMetrics.countryRejected,nonTrading:p.pageMetrics.nonTrading,uncertain:p.pageMetrics.uncertain,needsReview:p.pageMetrics.needsReview,tradingConfirmed:p.pageMetrics.tradingConfirmed,qualityChannels:p.pageMetrics.qualityChannels,communitiesDiscovered:p.pageMetrics.communitiesDiscovered,quotaUsed:p.quotaUnits,shouldContinue:p.decision.shouldContinue,stoppingReason:p.stoppingReason};
    await client.query(`INSERT INTO frontier_action_outcomes(action_id,attempt_id,outcome_key,source_outcome_event_key,status,observed_at,metrics,policy_version) VALUES($1,$2,$3,$4,'PROVISIONAL',$5,$6,$7) ON CONFLICT(outcome_key) DO NOTHING`,[actionId,attempt.rows[0].id,`query-run:${p.queryRunId}:page:${p.pageNumber}:outcome:v1`,`query-run:${p.queryRunId}:page:${p.pageNumber}:funnel:v1`,new Date().toISOString(),JSON.stringify(metrics),PASSIVE_EXPLORATION_POLICY_VERSION]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function recordShadowFailure(input:{queryRunId:string;jobId:string;stage:string;error:unknown}):Promise<void>{
  const name=input.error instanceof Error?input.error.name:'UnknownError';const key=`${input.queryRunId}:${input.jobId}:${input.stage}`;
  const db=await getDb();await db.query(`INSERT INTO research_shadow_write_failures(failure_key,source_query_run_id,source_job_id,stage,safe_error_class) VALUES($1,$2,$3,$4,$5) ON CONFLICT(failure_key) DO NOTHING`,[key,input.queryRunId,input.jobId,input.stage,name.slice(0,100)]);
}

export async function inspectPassivePrograms(limit=100):Promise<unknown>{const db=await getDb();const bounded=Math.min(Math.max(limit,1),500);const [programs,actions,failures,reconciliation]=await Promise.all([db.query(`SELECT program_key,name,root_concept,mode,lifecycle,policy_version,scope,activation_enabled,created_at FROM research_programs ORDER BY created_at LIMIT $1`,[bounded]),db.query(`SELECT a.id,p.program_key,a.action_type,a.semantic_action_key,a.normalized_target,a.lifecycle,a.mode,a.policy_version,a.source_query_run_id,a.source_job_id,a.parent_action_id,a.created_at FROM frontier_actions a JOIN research_programs p ON p.id=a.program_id ORDER BY a.created_at DESC LIMIT $1`,[bounded]),db.query(`SELECT failure_key,source_query_run_id,source_job_id,stage,safe_error_class,occurred_at FROM research_shadow_write_failures ORDER BY occurred_at DESC LIMIT $1`,[bounded]),db.query(`SELECT (SELECT COUNT(*)::int FROM outcome_events WHERE event_type='PAGE_FUNNEL_RECORDED') source_pages,(SELECT COUNT(*)::int FROM frontier_action_outcomes) shadow_outcomes,(SELECT COALESCE(SUM((payload->>'quotaUsed')::int),0)::int FROM outcome_events WHERE event_type='PAGE_FUNNEL_RECORDED') source_cost,(SELECT COALESCE(SUM((metrics->>'quotaUsed')::int),0)::int FROM frontier_action_outcomes) shadow_cost`)]);const r=reconciliation.rows[0];return {mode:'SHADOW',authoritativeSource:'legacy-query-aggregates-and-phase4-ledgers',executionEnabled:false,policyVersion:PASSIVE_EXPLORATION_POLICY_VERSION,programs:programs.rows,actions:actions.rows,failures:failures.rows,reconciliation:{...r,pass:r.source_pages===r.shadow_outcomes&&r.source_cost===r.shadow_cost}};}
