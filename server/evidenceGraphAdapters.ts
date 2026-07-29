import { createHash } from 'node:crypto';
import { getDb } from './db';
import type { PlaylistChannelObservation } from './youtube';

export const PLAYLIST_ADAPTER_POLICY_VERSION='playlist-adapter-v1';
export const ACQUISITION_PAYLOAD_VERSION=1;
export const PLAYLIST_PROVIDER_COST=1;
export type EvidenceNodeType='CHANNEL'|'PLAYLIST'|'VIDEO'|'WEBSITE'|'COMMUNITY'|'CONCEPT'|'ARTIFACT';

export function canonicalEvidenceKey(type:EvidenceNodeType,target:string):string {
  const normalized=target.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en');
  if(!normalized)throw new Error('Evidence target is required.');
  return `${type.toLocaleLowerCase('en')}:${normalized}`;
}

export function playlistActionKey(input:{programKey:string;playlistId:string;validityStart:string;policyVersion?:string}):string {
  const start=new Date(input.validityStart);if(!Number.isFinite(start.getTime()))throw new Error('validityStart must be an ISO timestamp.');
  const canonical=[input.programKey,canonicalEvidenceKey('PLAYLIST',input.playlistId),start.toISOString(),input.policyVersion||PLAYLIST_ADAPTER_POLICY_VERSION].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

export function boundedChildren<T extends {canonicalKey:string;confidenceBasisPoints:number}>(children:T[],limit:number):T[]{
  const cap=Math.min(50,Math.max(0,Math.trunc(limit)));
  const unique=new Map<string,T>();
  for(const child of children)if(child.confidenceBasisPoints>=0&&child.confidenceBasisPoints<=10000&&(!unique.has(child.canonicalKey)||unique.get(child.canonicalKey)!.confidenceBasisPoints<child.confidenceBasisPoints))unique.set(child.canonicalKey,child);
  return [...unique.values()]
    .sort((a,b)=>b.confidenceBasisPoints-a.confidenceBasisPoints||a.canonicalKey.localeCompare(b.canonicalKey)).slice(0,cap);
}

export function normalizePlaylistObservations(items:PlaylistChannelObservation[],limit:number){
  return boundedChildren(items.map(item=>({canonicalKey:canonicalEvidenceKey('CHANNEL',item.channelId),confidenceBasisPoints:9000,...item})),limit);
}

/** Materialize a canary job only after an administrator has explicitly enabled a non-zero, bounded control. */
export async function enqueuePlaylistCanary(actionId:string,targetCountry:string):Promise<{queued:boolean;reason?:string;jobId?:string}>{
  if(!targetCountry.trim())throw new Error('TARGET_COUNTRY_REQUIRED');
  const db=await getDb();const client=await db.connect();
  try{await client.query('BEGIN');const c=await client.query(`SELECT * FROM acquisition_adapter_controls WHERE adapter_type='INSPECT_PLAYLIST' FOR UPDATE`);
    const control=c.rows[0];if(!control||control.mode!=='CANARY'||control.paused||control.kill_switch)return await rollbackResult(client,'ADAPTER_DISABLED');
    const a=await client.query(`SELECT f.*,p.program_key FROM frontier_actions f JOIN research_programs p ON p.id=f.program_id WHERE f.id=$1 AND f.action_type='INSPECT_PLAYLIST' AND f.lifecycle='PROPOSED' FOR UPDATE`,[actionId]);
    if(!a.rowCount)return await rollbackResult(client,'ACTION_NOT_FOUND');
    const used=await client.query(`SELECT COUNT(*)::int daily FROM jobs WHERE type='INSPECT_PLAYLIST' AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC')`);
    if(Number(control.consumed_quota)+PLAYLIST_PROVIDER_COST>control.total_quota_cap||Number(used.rows[0].daily)+PLAYLIST_PROVIDER_COST>control.daily_quota_cap)return await rollbackResult(client,'ADAPTER_QUOTA_EXHAUSTED');
    const payload={payloadSchemaVersion:1,actionId,programKey:a.rows[0].program_key,targetCountry:targetCountry.trim(),playlistId:String(a.rows[0].normalized_target).replace(/^playlist:/,''),policyVersion:control.policy_version};
    const job=await client.query(`INSERT INTO jobs(type,payload,priority,max_attempts,idempotency_key) VALUES('INSPECT_PLAYLIST',$1,2,3,$2) ON CONFLICT(idempotency_key) DO UPDATE SET payload=jobs.payload RETURNING id`,[JSON.stringify(payload),`playlist:${a.rows[0].semantic_action_key}`]);
    await client.query(`UPDATE frontier_actions SET lifecycle='QUEUED' WHERE id=$1`,[actionId]);await client.query(`UPDATE acquisition_adapter_controls SET consumed_quota=consumed_quota+$1 WHERE adapter_type='INSPECT_PLAYLIST'`,[PLAYLIST_PROVIDER_COST]);await client.query('COMMIT');
    return {queued:true,jobId:job.rows[0].id};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function rollbackResult(client:any,reason:string){await client.query('ROLLBACK');return {queued:false,reason};}

export async function proposePlaylistInspection(input:{programKey:string;playlistId:string;sourceNodeId:string;parentActionId:string;depth:number;observedAt:string}):Promise<unknown>{
  if(!Number.isInteger(input.depth)||input.depth<1||input.depth>3)throw new Error('ADAPTER_DEPTH_EXCEEDED');
  const db=await getDb();const client=await db.connect();
  try{await client.query('BEGIN');
    const control=await client.query(`SELECT * FROM acquisition_adapter_controls WHERE adapter_type='INSPECT_PLAYLIST' FOR UPDATE`);
    if(!control.rowCount)throw new Error('PLAYLIST_ADAPTER_NOT_INSTALLED');const c=control.rows[0];
    if(c.mode!=='SHADOW'||!c.paused||!c.kill_switch)throw new Error('PROPOSAL_ONLY_CONTROL_VIOLATION');
    if(input.depth>c.max_depth)throw new Error('ADAPTER_DEPTH_EXCEEDED');
    const program=await client.query('SELECT id FROM research_programs WHERE program_key=$1',[input.programKey]);if(!program.rowCount)throw new Error('RESEARCH_PROGRAM_NOT_FOUND');
    const observed=new Date(input.observedAt);if(!Number.isFinite(observed.getTime()))throw new Error('observedAt must be an ISO timestamp.');
    const start=new Date(Date.UTC(observed.getUTCFullYear(),observed.getUTCMonth(),observed.getUTCDate()));const end=new Date(start.getTime()+86400000);
    const key=playlistActionKey({programKey:input.programKey,playlistId:input.playlistId,validityStart:start.toISOString()});
    const result=await client.query(`INSERT INTO frontier_actions(program_id,action_type,semantic_action_key,normalized_target,validity_start,validity_end,lifecycle,mode,policy_version,parent_action_id,estimated_cost,payload_schema_version)
      VALUES($1,'INSPECT_PLAYLIST',$2,$3,$4,$5,'PROPOSED','SHADOW',$6,$7,$8,1)
      ON CONFLICT(program_id,semantic_action_key,validity_start,validity_end) DO UPDATE SET semantic_action_key=excluded.semantic_action_key RETURNING id,semantic_action_key,lifecycle,mode`,
      [program.rows[0].id,key,canonicalEvidenceKey('PLAYLIST',input.playlistId),start.toISOString(),end.toISOString(),PLAYLIST_ADAPTER_POLICY_VERSION,input.parentActionId,JSON.stringify({youtubeUnits:0,proposalOnly:true})]);
    await client.query(`INSERT INTO evidence_program_visits(program_id,node_id,action_id,visit_key,depth,attribution_path,status,policy_version)
      VALUES($1,$2,$3,$4,$5,$6,'PROPOSED',$7) ON CONFLICT(program_id,visit_key) DO NOTHING`,[program.rows[0].id,input.sourceNodeId,result.rows[0].id,key,input.depth,JSON.stringify([input.parentActionId,result.rows[0].id]),PLAYLIST_ADAPTER_POLICY_VERSION]);
    await client.query('COMMIT');return {...result.rows[0],executionEnqueued:false,payloadVersion:ACQUISITION_PAYLOAD_VERSION};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function inspectEvidenceGraph(limit=100):Promise<unknown>{const db=await getDb();const bounded=Math.min(500,Math.max(1,Math.trunc(limit)));const [counts,controls,visits]=await Promise.all([db.query(`SELECT node_type,COUNT(*)::int count FROM evidence_nodes GROUP BY node_type ORDER BY node_type`),db.query(`SELECT adapter_type,mode,paused,kill_switch,daily_quota_cap,total_quota_cap,consumed_quota,max_depth,max_fanout,policy_version,configuration_version,updated_by,updated_at FROM acquisition_adapter_controls ORDER BY adapter_type`),db.query(`SELECT v.visit_key,v.depth,v.status,v.policy_version,v.visited_at,p.program_key,n.node_type,n.canonical_key FROM evidence_program_visits v JOIN research_programs p ON p.id=v.program_id JOIN evidence_nodes n ON n.id=v.node_id ORDER BY v.visited_at DESC LIMIT $1`,[bounded])]);return {onlinePlannerDependency:false,searchFallback:true,payloadVersion:ACQUISITION_PAYLOAD_VERSION,nodeCounts:counts.rows,adapters:controls.rows,visits:visits.rows};}

export async function configurePlaylistCanary(input:{expectedVersion:number;mode:'SHADOW'|'CANARY';paused:boolean;killSwitch:boolean;dailyQuotaCap:number;totalQuotaCap:number;maxFanout:number;actor:string}){
  if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)throw new Error('INVALID_CONFIGURATION_VERSION');
  if(input.mode==='CANARY'&&(!input.paused||!input.killSwitch)&&(!Number.isInteger(input.dailyQuotaCap)||input.dailyQuotaCap<1||input.dailyQuotaCap>10||!Number.isInteger(input.totalQuotaCap)||input.totalQuotaCap<1||input.totalQuotaCap>100))throw new Error('CANARY_CAP_OUT_OF_RANGE');
  const db=await getDb();const r=await db.query(`UPDATE acquisition_adapter_controls SET mode=$1,paused=$2,kill_switch=$3,daily_quota_cap=$4,total_quota_cap=$5,max_fanout=LEAST(10,$6),configuration_version=configuration_version+1,updated_by=$7,updated_at=now() WHERE adapter_type='INSPECT_PLAYLIST' AND configuration_version=$8 RETURNING *`,[input.mode,input.paused,input.killSwitch,input.dailyQuotaCap,input.totalQuotaCap,input.maxFanout,input.actor,input.expectedVersion]);if(!r.rowCount)throw new Error('ADAPTER_CONFIGURATION_CONFLICT');return r.rows[0];
}
