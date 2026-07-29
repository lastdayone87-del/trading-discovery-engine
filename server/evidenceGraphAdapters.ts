import { createHash } from 'node:crypto';
import { getDb } from './db';

export const PLAYLIST_ADAPTER_POLICY_VERSION='playlist-adapter-v1';
export const ACQUISITION_PAYLOAD_VERSION=1;
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
