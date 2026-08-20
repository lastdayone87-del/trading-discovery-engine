import test from 'node:test';
import assert from 'node:assert/strict';
import { failQueryRun,getDb } from './db';
import { captureCompletedRunObservation,getDiscoveryTrustDiagnostics,materializeEvaluationWindow } from './discoveryTrustEvaluation';

const databaseUrl=process.env.PHASE12_POSTGRES_URL;
test('Phase 12 PostgreSQL: persisted lineage, late outcomes, concurrency, windows and replay',{skip:databaseUrl?false:'PHASE12_POSTGRES_URL is required'},async()=>{
  process.env.DATABASE_URL=databaseUrl!; process.env.PGSSL='disable';
  const db=await getDb(),suffix=`p12-${Date.now()}-${process.pid}`;
  const start=new Date(Date.now()-60_000).toISOString(),end=new Date(Date.now()+60_000).toISOString();
  let queryId:number|undefined,runId:string|undefined; const decisionId=`decision-${suffix}`,channelId=`channel-${suffix}`;
  try {
    const q=await db.query(`INSERT INTO query_library(query,country,collection,intent,normalized_query) VALUES($1,'BR','EXPERIMENTAL','GENERAL',$1) RETURNING id`,[suffix]); queryId=q.rows[0].id;
    const r=await db.query(`INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,retrieval_lane,search_ordering,allocation_origin,raw_results,distinct_results,known_channels,new_channels,quality_channels,trading_confirmed,quota_reserved,quota_used,started_at,completed_at) VALUES($1,'BR','automated_query','COMPLETED','BASELINE','test','VIDEO','RELEVANCE','FRONTIER_CANARY',1,1,0,1,0,0,100,200,now()-interval '1 second',now()) RETURNING id`,[queryId]); runId=r.rows[0].id;
    const allocation={proposalFamily:'EXTERNAL_OSINT',supportingEvidence:{canonicalConcept:suffix,language:'pt',locale:'pt-BR',script:'Latn',sourceFamilies:['PUBLICATION'],independentSourceCount:1,correlationKeys:['independent-a']}};
    await db.query(`INSERT INTO frontier_allocation_decisions(decision_id,opportunity_key,allocation_origin,decision_status,selected_country,frontier_state,query_run_id,quota_day,policy_version,proposal_evidence_snapshot,proposal_evidence_checksum) VALUES($1,$2,'FRONTIER_CANARY','COMMITTED','BR','PROBING',$3,'2026-08-20','phase12-test',$4,'frozen')`,[decisionId,suffix,runId,allocation]);
    const captures=await Promise.all(Array.from({length:8},()=>captureCompletedRunObservation(runId!)));assert.equal(captures.filter(Boolean).length,1); assert.equal(await captureCompletedRunObservation(runId),false);
    let observation=(await db.query('SELECT * FROM discovery_evaluation_run_observations WHERE query_run_id=$1',[runId])).rows[0];
    assert.equal(observation.proposal_family,'EXTERNAL_OSINT'); assert.deepEqual(observation.source_families,['PUBLICATION']); assert.equal(observation.provider_requests,2);
    assert.deepEqual(observation.allocation_snapshot,allocation);

    // A current classification arriving later creates a new immutable revision;
    // it never mutates the frozen allocation-time evidence.
    await db.query(`INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status) VALUES($1,$1,'https://youtube.test','BR','CONFIRMED','UNKNOWN','COMPLETE','YOUTUBE',now(),90,'TRADING_CONFIRMED')`,[channelId]);
    await db.query(`INSERT INTO channel_sightings(query_run_id,query_id,channel_id,result_rank,was_known,persisted,country_outcome,trading_outcome,funnel_outcome,page_number) VALUES($1,$2,$3,1,false,true,'ACCEPTED','TRADING_CONFIRMED','TRADING_CONFIRMED',2)`,[runId,queryId,channelId]);
    assert.equal(await captureCompletedRunObservation(runId),true);
    const revisions=await db.query('SELECT observation_revision,quality_new_creators,confirmed_new_creators,allocation_snapshot FROM discovery_evaluation_run_observations WHERE query_run_id=$1 ORDER BY observation_revision',[runId]);
    assert.equal(revisions.rowCount,2); assert.deepEqual(revisions.rows.map(x=>x.quality_new_creators),[0,1]); revisions.rows.forEach(x=>assert.deepEqual(x.allocation_snapshot,allocation));
    await assert.rejects(db.query('UPDATE discovery_evaluation_run_observations SET quota_consumed=0 WHERE query_run_id=$1',[runId]),/immutable/);

    const concurrent=await Promise.all(Array.from({length:8},()=>materializeEvaluationWindow({windowStart:start,windowEnd:end,dimension:'concept',value:suffix})));
    assert.equal(new Set(concurrent.map(x=>x.snapshot_id)).size,1); assert.equal(concurrent[0].metrics.sampleCount,1); assert.equal(concurrent[0].metrics.qualityNewCreators,1);
    const replay=await materializeEvaluationWindow({windowStart:start,windowEnd:end,dimension:'concept',value:suffix}); assert.equal(replay.snapshot_id,concurrent[0].snapshot_id);
    const reclassified=await db.query(`UPDATE channels SET trading_status='UNCERTAIN',quality_score=0 WHERE channel_id=$1 RETURNING trading_status,quality_score`,[channelId]);assert.deepEqual(reclassified.rows[0],{trading_status:'UNCERTAIN',quality_score:0});assert.equal(await captureCompletedRunObservation(runId),true);
    await assert.rejects(materializeEvaluationWindow({windowStart:start,windowEnd:end,dimension:'concept',value:suffix}),/EVALUATION_REVISION_CONFLICT/);
    const revised=await materializeEvaluationWindow({windowStart:start,windowEnd:end,dimension:'concept',value:suffix,revision:2});assert.equal(revised.metrics.qualityNewCreators,0);
    await assert.rejects(db.query('DELETE FROM discovery_evaluation_snapshots WHERE snapshot_id=$1',[replay.snapshot_id]),/immutable/);
    await assert.rejects(materializeEvaluationWindow({windowStart:start,windowEnd:new Date(Date.now()+91*86400_000).toISOString(),dimension:'overall'}),/INVALID_EVALUATION_WINDOW/);
    const excluded=await materializeEvaluationWindow({windowStart:start,windowEnd:new Date(new Date(observation.completed_at).getTime()).toISOString(),dimension:'concept',value:suffix,revision:3}); assert.equal(excluded.metrics.sampleCount,0,'window end is exclusive');
    const diagnostics=await getDiscoveryTrustDiagnostics({windowStart:start,windowEnd:end}); assert.ok(diagnostics.snapshots.length<=500);
  } finally {
    await db.query(`SELECT set_config('app.phase12_maintenance','on',false)`);
    await db.query('DELETE FROM discovery_evaluation_snapshots WHERE window_start >= $1',[start]).catch(()=>undefined);
    if(runId)await db.query('DELETE FROM discovery_evaluation_run_observations WHERE query_run_id=$1',[runId]).catch(()=>undefined);
    await db.query(`SELECT set_config('app.phase12_maintenance','off',false)`);
    await db.query('DELETE FROM frontier_allocation_decisions WHERE decision_id=$1',[decisionId]).catch(()=>undefined);
    if(runId)await db.query('DELETE FROM channel_sightings WHERE query_run_id=$1',[runId]).catch(()=>undefined);
    await db.query('DELETE FROM channels WHERE channel_id=$1',[channelId]).catch(()=>undefined);
    if(runId)await db.query('DELETE FROM query_runs WHERE id=$1',[runId]).catch(()=>undefined);
    if(queryId)await db.query('DELETE FROM query_library WHERE id=$1',[queryId]).catch(()=>undefined);
  }
});

test('Phase 12 PostgreSQL: terminal provider and invalid-query failures are observed',{skip:databaseUrl?false:'PHASE12_POSTGRES_URL is required'},async()=>{
  process.env.DATABASE_URL=databaseUrl!;process.env.PGSSL='disable';const db=await getDb();const suffix=`p12-failure-${Date.now()}`;const ids:string[]=[];let queryId:number|undefined;
  try{const q=await db.query(`INSERT INTO query_library(query,country,collection,intent,normalized_query) VALUES($1,'BR','EXPERIMENTAL','GENERAL',$1) RETURNING id`,[suffix]);queryId=q.rows[0].id;
    for(const error of [Object.assign(new Error('outage'),{code:'ETIMEDOUT'}),Object.assign(new Error('bad query'),{code:'INVALID_QUERY'})]){const run=await db.query(`INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,retrieval_lane,search_ordering) VALUES($1,'BR','automated_query','RUNNING','BASELINE','test','VIDEO','RELEVANCE') RETURNING id`,[queryId]);ids.push(run.rows[0].id);await failQueryRun(run.rows[0].id,error,true);}
    const observed=await db.query('SELECT provider_failed,invalid_query FROM discovery_evaluation_run_observations WHERE query_run_id=ANY($1::uuid[]) ORDER BY query_run_id',[ids]);assert.equal(observed.rowCount,2);assert.deepEqual(observed.rows.map(x=>[x.provider_failed,x.invalid_query]).sort(),[[false,true],[true,false]].sort());
  }finally{await db.query(`SELECT set_config('app.phase12_maintenance','on',false)`);await db.query('DELETE FROM discovery_evaluation_run_observations WHERE query_run_id=ANY($1::uuid[])',[ids]).catch(()=>undefined);await db.query(`SELECT set_config('app.phase12_maintenance','off',false)`);await db.query('DELETE FROM query_runs WHERE id=ANY($1::uuid[])',[ids]).catch(()=>undefined);if(queryId)await db.query('DELETE FROM query_library WHERE id=$1',[queryId]).catch(()=>undefined);}
});
