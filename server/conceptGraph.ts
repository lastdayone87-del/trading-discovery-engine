import { createHash, randomUUID } from 'node:crypto';
import { completeJob, enqueueJob, getDb } from './db';

export type ConceptEvent={type:'MERGED'|'SPLIT'|'CORRECTION';source:string;target?:string;splitFrom?:string};
export function projectConcept(initial:string,events:ConceptEvent[]):string {
  let current=initial;
  for(const event of events){
    if(event.type==='MERGED'&&event.source===current&&event.target)current=event.target;
    if(event.type==='SPLIT'&&event.splitFrom===current&&event.target===initial)current=initial;
    if(event.type==='CORRECTION'&&event.source===current&&event.target)current=event.target;
  }
  return current;
}

export function relationWouldCycle(edges:Array<{source:string;target:string;type:string}>,source:string,target:string,type:string):boolean {
  if(!['BROADER','NARROWER'].includes(type))return false;
  const graph=new Map<string,string[]>();
  for(const edge of [...edges,{source,target,type}])if(edge.type===type)graph.set(edge.source,[...(graph.get(edge.source)||[]),edge.target]);
  const seen=new Set<string>();const visit=(node:string):boolean=>{if(node===source&&seen.size)return true;if(seen.has(node))return false;seen.add(node);return (graph.get(node)||[]).some(visit);};
  return visit(target);
}

const required=(value:unknown,name:string)=>{const out=String(value||'').trim();if(!out)throw new Error(`${name} is required.`);return out;};
export async function inspectConceptGraph(limit=100):Promise<unknown>{
  const db=await getDb();const bounded=Math.min(500,Math.max(1,limit));
  const [concepts,reconciliation]=await Promise.all([
    db.query(`SELECT c.id,c.concept_class,c.status,c.version,c.created_at,COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id',s.id,'literal',s.literal,'normalized',s.normalized,'language',s.language,'script',s.script,'locale',s.locale,'ambiguous',s.ambiguity,'senseStatus',cs.sense_status)) FILTER(WHERE s.id IS NOT NULL),'[]') surfaces FROM concepts c LEFT JOIN concept_surface_senses cs ON cs.concept_id=c.id LEFT JOIN term_surfaces s ON s.id=cs.surface_id GROUP BY c.id ORDER BY c.created_at DESC LIMIT $1`,[bounded]),
    db.query(`SELECT (SELECT count(*) FROM canonical_trading_terms)::int legacy_terms,(SELECT count(*) FROM canonical_trading_terms WHERE concept_id IS NOT NULL AND surface_id IS NOT NULL)::int mapped_terms,(SELECT count(*) FROM trading_term_aliases)::int legacy_aliases,(SELECT count(*) FROM trading_term_aliases WHERE surface_id IS NOT NULL)::int mapped_aliases`)
  ]);return {mode:'SHADOW_DUAL_READ',plannerSource:'PHASE_F',publicationEnabled:false,concepts:concepts.rows,reconciliation:reconciliation.rows[0]};
}

export async function moderateConcept(input:{action:string;targetId:string;expectedVersion:number;idempotencyKey:string;actor:string;reason:string;payload?:Record<string,unknown>}):Promise<unknown>{
  const action=required(input.action,'action');const targetId=required(input.targetId,'targetId');const key=required(input.idempotencyKey,'idempotencyKey');required(input.reason,'reason');
  if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)throw new Error('expectedVersion must be a positive integer.');
  const db=await getDb();const client=await db.connect();try{await client.query('BEGIN');
    const duplicate=await client.query('SELECT * FROM concept_moderation_decisions WHERE idempotency_key=$1',[key]);if(duplicate.rowCount){await client.query('COMMIT');return duplicate.rows[0];}
    if(['APPROVE_SENSE','REJECT_SENSE'].includes(action)){const status=action==='APPROVE_SENSE'?'APPROVED':'REJECTED';const changed=await client.query('UPDATE concept_surface_senses SET sense_status=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING *',[status,targetId,input.expectedVersion]);if(!changed.rowCount)throw new Error('MODERATION_VERSION_CONFLICT');}
    else if(['APPROVE_RELATION','REJECT_RELATION'].includes(action)){const status=action==='APPROVE_RELATION'?'APPROVED':'REJECTED';const rel=await client.query('SELECT * FROM concept_relations WHERE id=$1 FOR UPDATE',[targetId]);if(!rel.rowCount)throw new Error('MODERATION_VERSION_CONFLICT');if(status==='APPROVED'){const edges=await client.query(`SELECT source_concept_id::text source,target_concept_id::text target,relation_type type FROM concept_relations WHERE status='APPROVED'`);if(relationWouldCycle(edges.rows,rel.rows[0].source_concept_id,rel.rows[0].target_concept_id,rel.rows[0].relation_type))throw new Error('RELATION_CYCLE');}await client.query('UPDATE concept_relations SET status=$1 WHERE id=$2',[status,targetId]);}
    else if(action==='MERGE'){const target=required(input.payload?.targetConceptId,'targetConceptId');const changed=await client.query(`UPDATE concepts SET status='MERGED',version=version+1 WHERE id=$1 AND version=$2 AND status='ACTIVE' RETURNING *`,[targetId,input.expectedVersion]);if(!changed.rowCount)throw new Error('MODERATION_VERSION_CONFLICT');await client.query(`INSERT INTO concept_projection_events(event_key,event_type,source_concept_id,target_concept_id,payload,actor) VALUES($1,'MERGED',$2,$3,$4,$5)`,[`merge:${key}`,targetId,target,JSON.stringify(input.payload||{}),input.actor]);}
    else if(action==='SPLIT'){const restored=required(input.payload?.restoredConceptId,'restoredConceptId');const changed=await client.query(`UPDATE concepts SET status='ACTIVE',version=version+1 WHERE id=$1 AND version=$2 RETURNING *`,[restored,input.expectedVersion]);if(!changed.rowCount)throw new Error('MODERATION_VERSION_CONFLICT');await client.query(`INSERT INTO concept_projection_events(event_key,event_type,source_concept_id,target_concept_id,payload,actor) VALUES($1,'SPLIT',$2,$3,$4,$5)`,[`split:${key}`,targetId,restored,JSON.stringify(input.payload||{}),input.actor]);}
    else throw new Error('Unsupported moderation action.');
    const saved=await client.query(`INSERT INTO concept_moderation_decisions(id,idempotency_key,action,target_id,expected_version,actor,reason,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),key,action,targetId,input.expectedVersion,input.actor,input.reason,JSON.stringify(input.payload||{})]);await client.query('COMMIT');return saved.rows[0];
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export function proposalKey(candidateKey:string,surfaceId:string,conceptId?:string):string{return createHash('sha256').update(`${candidateKey}|${surfaceId}|${conceptId||'unresolved'}|concept-resolution-v1`).digest('hex');}

export async function enqueueConceptResolution(candidateKey:string,literal:string,language='und',script='Zyyy',locale='und'):Promise<void>{
  await enqueueJob('PROPOSE_CONCEPT_RESOLUTION',{payloadSchemaVersion:1,candidateKey,literal,language,script,locale,resolverVersion:'concept-resolution-v1'},{priority:2,maxAttempts:3,idempotencyKey:`concept-resolution:${candidateKey}:concept-resolution-v1`});
}
export async function processConceptResolutionJob(job:{id:string;payload:any}):Promise<void>{
  const p=job.payload;if(p.payloadSchemaVersion!==1||p.resolverVersion!=='concept-resolution-v1')throw new Error('Unsupported PROPOSE_CONCEPT_RESOLUTION payload version.');
  const literal=required(p.literal,'literal').normalize('NFKC').trim();const normalized=literal.toLocaleLowerCase('und').replace(/\s+/gu,' ');const db=await getDb();
  const surface=await db.query(`INSERT INTO term_surfaces(literal,normalized,language,script,locale,ambiguity) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(normalized,language,script,locale) DO UPDATE SET literal=term_surfaces.literal RETURNING id`,[literal,normalized,p.language||'und',p.script||'Zyyy',p.locale||'und']);
  const key=proposalKey(p.candidateKey,surface.rows[0].id);await db.query(`INSERT INTO concept_resolution_proposals(proposal_key,candidate_key,surface_id,evidence) VALUES($1,$2,$3,$4) ON CONFLICT(proposal_key) DO NOTHING`,[key,p.candidateKey,surface.rows[0].id,JSON.stringify({resolverVersion:p.resolverVersion,literalHash:createHash('sha256').update(literal).digest('hex')})]);await completeJob(job.id);
}
