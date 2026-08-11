import {getAppSetting,getDb} from '../db';
import {observeRetrievalAssignmentReliably} from '../phaseBObservationOutbox';
import {admissionChecksum,deterministicUuid} from './versioning';
import {NOMINATION_FEATURE_VERSION,NOMINATION_POLICY_VERSION,type NominationInput,type NominationState} from './types';
import {buildStage1ProspectiveRetrievalAssignment,stage1ProspectiveNominationEligible} from './stage1ProspectiveSampling';

const normalize=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en');
export function nominationIdentity(input:NominationInput){const observedAt=new Date(input.observedAt||new Date().toISOString()).toISOString();const matchedDocumentChecksum=admissionChecksum(input.matchedDocument),normalizedQuery=normalize(input.query);const key=admissionChecksum({sourceType:input.sourceType,sourceActionId:input.sourceActionId,queryRunId:input.queryRunId,queryCatalogVersion:input.queryCatalogVersion,normalizedQuery,pageNumber:input.pageNumber,resultRank:input.resultRank,channelId:input.channelId,matchedDocumentChecksum});return {key,observedAt,matchedDocumentChecksum};}

/** Production search sources classify immediately after nomination, so Stage 1 assignment persistence is a hard ordering barrier for them. */
export function requiresStage1AssignmentBeforeClassification(sourceType:string):boolean{
 return sourceType==='manual_search'||sourceType==='automated_query'||sourceType==='automated_search';
}

export async function recordNomination(input:NominationInput,initialState:NominationState='OBSERVED'):Promise<{id:string;nominationKey:string;created:boolean;ledgerEnabled:boolean}>{
 const identity=nominationIdentity(input),db=await getDb();
 // Stage 1 prospective evaluation capture must correspond to a channel that will
 // actually cross the automated classification boundary. Stable/terminal
 // duplicates are short-circuited by ingestion and therefore must not receive a
 // fresh assignment that can never acquire a post-assignment diagnostic.
 const existingChannel=await db.query('SELECT country_status,trading_status,scan_status FROM channels WHERE channel_id=$1',[input.channelId]);
 if(stage1ProspectiveNominationEligible(existingChannel.rows[0])){
  const assignmentCapture=()=>observeRetrievalAssignmentReliably(buildStage1ProspectiveRetrievalAssignment(input,identity.observedAt));
  // Normal/manual production discovery classifies immediately after this call.
  // It must retry/fail before classification if the prospective assignment cannot
  // be persisted; nomination-only sources retain the historical fail-contained path.
  if(requiresStage1AssignmentBeforeClassification(input.sourceType))await assignmentCapture();
  else await assignmentCapture().catch(error=>console.warn(`[Stage1Prospective] Retrieval assignment capture failed for ${input.channelId}:`,error instanceof Error?error.message:error));
 }
 const ledgerEnabled=await getAppSetting('nomination_ledger_enabled','false')==='true';
 // OFF controls nomination materialization for rollback. Prospective evaluation
 // capture above is measurement-only and remains independent of this serving flag.
 if(!ledgerEnabled)return {id:'',nominationKey:identity.key,created:false,ledgerEnabled:false};
 const client=await db.connect();
 try{await client.query('BEGIN');
  const existingSubject=await client.query('SELECT 1 FROM candidate_subjects WHERE channel_id=$1',[input.channelId]);const effectiveInitialState:NominationState=existingSubject.rowCount?'DUPLICATE_ENTITY':initialState;
  const inserted=await client.query(`INSERT INTO discovery_nominations(nomination_key,channel_id,channel_entity_id,source_type,source_action_id,query_id,query_run_id,job_id,query_catalog_version,normalized_query,query_semantic_classes,query_generation_mode,country,declared_language,retrieval_lane,search_ordering,page_number,result_rank,matched_document_locator,matched_document_checksum,raw_observation,observed_at,policy_version,feature_version)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) ON CONFLICT(nomination_key) DO NOTHING RETURNING id`,[
   identity.key,input.channelId,input.channelEntityId||null,input.sourceType,input.sourceActionId||null,input.queryId||null,input.queryRunId||null,input.jobId||null,input.queryCatalogVersion||null,normalize(input.query),JSON.stringify(input.querySemanticClasses||[]),input.queryGenerationMode||null,input.country,input.declaredLanguage||null,input.retrievalLane||null,input.searchOrdering||null,input.pageNumber||null,input.resultRank||null,JSON.stringify(input.matchedDocument),identity.matchedDocumentChecksum,JSON.stringify(input.rawObservation),identity.observedAt,NOMINATION_POLICY_VERSION,NOMINATION_FEATURE_VERSION]);
  const row=inserted.rowCount?inserted:await client.query('SELECT id FROM discovery_nominations WHERE nomination_key=$1',[identity.key]);const nominationId=row.rows[0].id;
  if(inserted.rowCount){const eventKey=admissionChecksum({nominationKey:identity.key,event:'NOMINATION_OBSERVED'}),observed=await client.query(`INSERT INTO nomination_events(event_key,nomination_id,channel_id,event_type,payload,policy_version,occurred_at) VALUES($1,$2,$3,'NOMINATION_OBSERVED',$4,$5,$6) RETURNING id`,[eventKey,nominationId,input.channelId,JSON.stringify({queryRunId:input.queryRunId||null,resultRank:input.resultRank||null,sourceType:input.sourceType}),NOMINATION_POLICY_VERSION,identity.observedAt]);
   let lastEventId=observed.rows[0].id;if(effectiveInitialState!=='OBSERVED'){const queued=await client.query(`INSERT INTO nomination_events(event_key,nomination_id,channel_id,event_type,payload,policy_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[admissionChecksum({nominationKey:identity.key,event:effectiveInitialState}),nominationId,input.channelId,effectiveInitialState,JSON.stringify({atomicWithNomination:true,reusesCandidateSubject:effectiveInitialState==='DUPLICATE_ENTITY'}),NOMINATION_POLICY_VERSION,identity.observedAt]);lastEventId=queued.rows[0].id;}
   await client.query(`INSERT INTO candidate_subjects(channel_id,channel_entity_id,first_nomination_id,latest_nomination_id,nomination_count,nomination_state,last_event_id) VALUES($1,$2,$3,$3,1,'OBSERVED',$4)
    ON CONFLICT(channel_id) DO UPDATE SET channel_entity_id=COALESCE(candidate_subjects.channel_entity_id,excluded.channel_entity_id),latest_nomination_id=excluded.latest_nomination_id,nomination_count=candidate_subjects.nomination_count+1,nomination_state=$5,projection_version=candidate_subjects.projection_version+1,last_event_id=excluded.last_event_id,updated_at=now()`,[input.channelId,input.channelEntityId||null,nominationId,lastEventId,effectiveInitialState]);if(effectiveInitialState!=='OBSERVED')await client.query('UPDATE candidate_subjects SET nomination_state=$2 WHERE channel_id=$1',[input.channelId,effectiveInitialState]);}
  await client.query('COMMIT');return {id:nominationId,nominationKey:identity.key,created:!!inserted.rowCount,ledgerEnabled:true};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function transitionNomination(input:{nominationId:string;channelId:string;state:Exclude<NominationState,'OBSERVED'>;payload?:Record<string,unknown>}):Promise<void>{const db=await getDb(),client=await db.connect();try{await client.query('BEGIN');const eventKey=admissionChecksum({...input,policy:NOMINATION_POLICY_VERSION}),event=await client.query(`INSERT INTO nomination_events(event_key,nomination_id,channel_id,event_type,payload,policy_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key) DO NOTHING RETURNING id`,[eventKey,input.nominationId,input.channelId,input.state,JSON.stringify(input.payload||{}),NOMINATION_POLICY_VERSION]);if(event.rowCount)await client.query(`UPDATE candidate_subjects SET nomination_state=$2,projection_version=projection_version+1,last_event_id=$3,updated_at=now() WHERE channel_id=$1`,[input.channelId,input.state,event.rows[0].id]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}

export async function listNominations(input:{limit?:number;offset?:number;channelId?:string;sourceType?:string;country?:string;cutoff?:string}={}){const db=await getDb(),limit=Math.min(250,Math.max(1,input.limit||100)),offset=Math.max(0,input.offset||0);const result=await db.query(`SELECT * FROM discovery_nominations WHERE ($1::text IS NULL OR channel_id=$1) AND ($2::text IS NULL OR source_type=$2) AND ($3::text IS NULL OR country=$3) AND ($4::timestamptz IS NULL OR observed_at<=$4) ORDER BY observed_at DESC,id LIMIT $5 OFFSET $6`,[input.channelId||null,input.sourceType||null,input.country||null,input.cutoff||null,limit,offset]);return result.rows;}
export async function getNomination(id:string){const db=await getDb();const [n,e]=await Promise.all([db.query('SELECT * FROM discovery_nominations WHERE id=$1',[id]),db.query('SELECT * FROM nomination_events WHERE nomination_id=$1 ORDER BY occurred_at,id',[id])]);if(!n.rowCount)throw Object.assign(new Error('NOMINATION_NOT_FOUND'),{status:404});return {...n.rows[0],events:e.rows};}
export async function inspectNominationAttribution(dimension:'QUERY'|'PATH',cutoff=new Date().toISOString()){const at=new Date(cutoff);if(!Number.isFinite(at.getTime()))throw new Error('VALID_CUTOFF_REQUIRED');const db=await getDb();const grouping=dimension==='QUERY'?'normalized_query,query_catalog_version,country,retrieval_lane':'source_type,country,retrieval_lane';const result=await db.query(`SELECT ${grouping},COUNT(*)::int nominations,COUNT(DISTINCT channel_id)::int distinct_channels,MIN(observed_at) first_observed_at,MAX(observed_at) last_observed_at FROM discovery_nominations WHERE observed_at<=$1 GROUP BY ${grouping} ORDER BY nominations DESC`,[at.toISOString()]);return {dimension,cutoff:at.toISOString(),servingAuthority:false,rows:result.rows};}
