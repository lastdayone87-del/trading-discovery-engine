import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb } from './db';

export type ExecutionStage = 'HTTP_HANDLER'|'JOB_CREATION'|'QUEUE_PERSISTENCE'|'WORKER_POLLING'|'QUEUE_CLAIM'|'DISPATCHER'|'PROVIDER_ACQUISITION'|'FIRST_YOUTUBE_REQUEST';
interface TraceContext { traceId: string; firstRequestRecorded?: boolean }
interface QueryClient { query:(sql:string,values?:unknown[])=>Promise<{rows:any[]}> }
const context = new AsyncLocalStorage<TraceContext>();

export function isMissingTraceTable(error:unknown):boolean {
  return typeof error==='object'&&error!==null&&'code' in error&&(error as {code?:string}).code==='42P01';
}

export async function persistExecutionStage(client:QueryClient,traceId:string,stage:ExecutionStage,outcome:string,detail:Record<string,unknown>):Promise<boolean> {
  try {
    await client.query('INSERT INTO discovery_execution_trace(trace_id,stage,outcome,detail) VALUES($1,$2,$3,$4)',[traceId,stage,outcome,JSON.stringify(detail)]);
    return true;
  } catch(error) {
    if(!isMissingTraceTable(error))throw error;
    console.warn('[Execution Trace] Table unavailable; continuing without trace persistence.');
    return false;
  }
}

export function withExecutionTrace<T>(traceId:string, run:()=>Promise<T>):Promise<T> {
  return context.run({traceId},run);
}

export async function recordExecutionStage(stage:ExecutionStage,outcome='REACHED',detail:Record<string,unknown>={},traceId=context.getStore()?.traceId):Promise<void> {
  if(!traceId)return;
  const db=await getDb();
  // Tracing is diagnostic and must never become a prerequisite for discovery.
  await persistExecutionStage(db as QueryClient,traceId,stage,outcome,detail);
}

export async function recordFirstYouTubeRequest(operation:string):Promise<void> {
  const current=context.getStore();if(!current||current.firstRequestRecorded)return;
  current.firstRequestRecorded=true;
  await recordExecutionStage('FIRST_YOUTUBE_REQUEST','REACHED',{operation});
}

export async function inspectExecutionTrace(traceId:string):Promise<unknown> {
  const db=await getDb();
  let traceAvailable=true;
  let events:{rows:any[]};
  try {
    events=await (db as QueryClient).query('SELECT stage,outcome,detail,occurred_at FROM discovery_execution_trace WHERE trace_id=$1 ORDER BY occurred_at,id',[traceId]);
  } catch(error) {
    if(!isMissingTraceTable(error))throw error;
    traceAvailable=false;
    events={rows:[]};
  }
  const [jobs,controls]=await Promise.all([
    db.query("SELECT id,type,status,attempts,max_attempts,run_after,locked_by,locked_at,last_error,created_at,updated_at FROM jobs WHERE payload->>'traceId'=$1 ORDER BY created_at",[traceId]),
    db.query("SELECT queue_name,is_paused FROM queue_controls WHERE queue_name IN ('search_jobs','channel_processing') ORDER BY queue_name")
  ]);
  const reached=new Set(events.rows.filter(row=>row.outcome==='REACHED').map(row=>row.stage));
  const stages:ExecutionStage[]=['HTTP_HANDLER','JOB_CREATION','QUEUE_PERSISTENCE','WORKER_POLLING','QUEUE_CLAIM','DISPATCHER','PROVIDER_ACQUISITION','FIRST_YOUTUBE_REQUEST'];
  const functions:Record<ExecutionStage,string>={HTTP_HANDLER:'POST /api/search/manual or /api/search/automated',JOB_CREATION:'executeFullManualSearch/addSearchJob',QUEUE_PERSISTENCE:'createManualSearchSession/enqueueJob',WORKER_POLLING:'processNextSearchJob',QUEUE_CLAIM:'claimNextJob',DISPATCHER:'processNextSearchJob dispatcher',PROVIDER_ACQUISITION:'searchYouTubeChannelPage',FIRST_YOUTUBE_REQUEST:'youtubeFetch'};
  const evidence=stages.map(stage=>({stage,implementationFunction:functions[stage],reached:reached.has(stage)}));
  const firstUnreached=evidence.find(stage=>!stage.reached)?.implementationFunction||null;
  return {traceId,traceAvailable,stages:evidence,firstUnreached,events:events.rows,jobs:jobs.rows,queueControls:controls.rows};
}
