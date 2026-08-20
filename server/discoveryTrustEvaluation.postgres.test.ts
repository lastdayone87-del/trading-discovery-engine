import test from 'node:test'; import assert from 'node:assert/strict';
import { getDb } from './db'; import { captureCompletedRunObservation,materializeEvaluationWindow } from './discoveryTrustEvaluation';
const databaseUrl=process.env.PHASE12_POSTGRES_URL;
test('Phase 12 PostgreSQL: completion capture and snapshot replay are immutable and idempotent',{skip:databaseUrl?false:'PHASE12_POSTGRES_URL is required'},async()=>{
  process.env.DATABASE_URL=databaseUrl!;process.env.PGSSL='disable';const db=await getDb();const suffix=`p12-${Date.now()}-${process.pid}`;let queryId:number|undefined,runId:string|undefined;
  const start=new Date(Date.now()-60_000).toISOString(),end=new Date(Date.now()+60_000).toISOString();
  try { const q=await db.query(`INSERT INTO query_library(query,country,collection,intent,normalized_query) VALUES($1,'BR','EXPERIMENTAL','GENERAL',$1) RETURNING id`,[suffix]);queryId=q.rows[0].id;
    const r=await db.query(`INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,retrieval_lane,search_ordering,allocation_origin,raw_results,distinct_results,known_channels,new_channels,quality_channels,trading_confirmed,quota_reserved,quota_used,started_at,completed_at) VALUES($1,'BR','automated_query','COMPLETED','BASELINE','test','VIDEO','RELEVANCE','LEGACY',2,2,1,1,1,1,100,100,now()-interval '1 second',now()) RETURNING id`,[queryId]);runId=r.rows[0].id;
    assert.equal(await captureCompletedRunObservation(runId!),true);assert.equal(await captureCompletedRunObservation(runId!),false);
    assert.equal((await db.query('SELECT count(*)::int n FROM discovery_evaluation_run_observations WHERE query_run_id=$1',[runId])).rows[0].n,1);
    await assert.rejects(db.query('UPDATE discovery_evaluation_run_observations SET quota_consumed=0 WHERE query_run_id=$1',[runId]),/immutable/);
    const a=await materializeEvaluationWindow({windowStart:start,windowEnd:end,dimension:'allocationOrigin',value:'LEGACY'});const b=await materializeEvaluationWindow({windowStart:start,windowEnd:end,dimension:'allocationOrigin',value:'LEGACY'});assert.equal(a.snapshot_id,b.snapshot_id);
  } finally {if(runId)await db.query('DELETE FROM discovery_evaluation_snapshots WHERE window_start=$1 AND window_end=$2',[start,end]).catch(()=>undefined);if(runId)await db.query('DELETE FROM discovery_evaluation_run_observations WHERE query_run_id=$1',[runId]).catch(()=>undefined);if(runId)await db.query('DELETE FROM query_runs WHERE id=$1',[runId]).catch(()=>undefined);if(queryId)await db.query('DELETE FROM query_library WHERE id=$1',[queryId]).catch(()=>undefined);}
});
