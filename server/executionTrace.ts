import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb } from './db';

export type ExecutionStage = 'HTTP_HANDLER'|'JOB_CREATION'|'QUEUE_PERSISTENCE'|'WORKER_POLLING'|'QUEUE_CLAIM'|'DISPATCHER'|'PROVIDER_ACQUISITION'|'FIRST_YOUTUBE_REQUEST';
interface TraceContext { traceId: string; firstRequestRecorded?: boolean }
const context = new AsyncLocalStorage<TraceContext>();

export function withExecutionTrace<T>(traceId:string, run:()=>Promise<T>):Promise<T> {
  return context.run({traceId},run);
}

export async function recordExecutionStage(stage:ExecutionStage,outcome='REACHED',detail:Record<string,unknown>={},traceId=context.getStore()?.traceId):Promise<void> {
  if(!traceId)return;
  const db=await getDb();
  await db.query('INSERT INTO discovery_execution_trace(trace_id,stage,outcome,detail) VALUES($1,$2,$3,$4)',[traceId,stage,outcome,JSON.stringify(detail)]);
}

export async function recordFirstYouTubeRequest(operation:string):Promise<void> {
  const current=context.getStore();if(!current||current.firstRequestRecorded)return;
  current.firstRequestRecorded=true;
  await recordExecutionStage('FIRST_YOUTUBE_REQUEST','REACHED',{operation});
}

export async function inspectExecutionTrace(traceId:string):Promise<unknown> {
  const db=await getDb();
  const [events,jobs,controls]=await Promise.all([
    db.query('SELECT stage,outcome,detail,occurred_at FROM discovery_execution_trace WHERE trace_id=$1 ORDER BY occurred_at,id',[traceId]),
    db.query("SELECT id,type,status,attempts,max_attempts,run_after,locked_by,locked_at,last_error,created_at,updated_at FROM jobs WHERE payload->>'traceId'=$1 ORDER BY created_at",[traceId]),
    db.query("SELECT queue_name,is_paused FROM queue_controls WHERE queue_name IN ('search_jobs','channel_processing') ORDER BY queue_name")
  ]);
  const reached=new Set(events.rows.filter(row=>row.outcome==='REACHED').map(row=>row.stage));
  const stages:ExecutionStage[]=['HTTP_HANDLER','JOB_CREATION','QUEUE_PERSISTENCE','WORKER_POLLING','QUEUE_CLAIM','DISPATCHER','PROVIDER_ACQUISITION','FIRST_YOUTUBE_REQUEST'];
  const functions:Record<ExecutionStage,string>={HTTP_HANDLER:'POST /api/search/manual or /api/search/automated',JOB_CREATION:'executeFullManualSearch/addSearchJob',QUEUE_PERSISTENCE:'createManualSearchSession/enqueueJob',WORKER_POLLING:'processNextSearchJob',QUEUE_CLAIM:'claimNextJob',DISPATCHER:'processNextSearchJob dispatcher',PROVIDER_ACQUISITION:'searchYouTubeChannelPage',FIRST_YOUTUBE_REQUEST:'youtubeFetch'};
  const evidence=stages.map(stage=>({stage,implementationFunction:functions[stage],reached:reached.has(stage)}));
  const firstUnreached=evidence.find(stage=>!stage.reached)?.implementationFunction||null;
  return {traceId,stages:evidence,firstUnreached,events:events.rows,jobs:jobs.rows,queueControls:controls.rows};
}
