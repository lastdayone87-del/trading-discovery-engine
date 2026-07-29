import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db';

export const TOPIC_PILOT_POLICY_VERSION = 'topic-pilot-v1';
export const TOPIC_PILOT_PAYLOAD_VERSION = 1;
const PROGRAM_KEY = 'price-action-trading';

export type PilotMode = 'SHADOW'|'CANARY';
export interface PilotControlPatch { mode?: PilotMode; paused?: boolean; killSwitch?: boolean; dailyYoutubeCap?: number; totalYoutubeCap?: number }

export function pilotProposalKey(input:{queryId:number;country:string;blockStart:string;policyVersion?:string}):string {
  const block=new Date(input.blockStart);
  if (!Number.isFinite(block.getTime())) throw new Error('blockStart must be an ISO timestamp.');
  const canonical=[input.queryId,input.country.normalize('NFKC').trim().toLocaleLowerCase('en'),block.toISOString(),input.policyVersion||TOPIC_PILOT_POLICY_VERSION].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

export function validatePilotControl(patch:PilotControlPatch):PilotControlPatch {
  const result={...patch};
  for (const key of ['dailyYoutubeCap','totalYoutubeCap'] as const) {
    const value=result[key];
    if (value!==undefined && (!Number.isSafeInteger(value)||value<0)) throw new Error(`${key} must be a non-negative integer.`);
  }
  if (result.mode==='CANARY' && result.killSwitch===false && (!result.dailyYoutubeCap || !result.totalYoutubeCap)) {
    throw new Error('Canary execution requires non-zero daily and total hard caps.');
  }
  return result;
}

export async function acquirePilotLease(owner:string,seconds=30):Promise<string|null>{
  const db=await getDb(); const token=randomUUID();
  const result=await db.query(`UPDATE research_controller_checkpoints c SET lease_owner=$2,lease_token=$3,leased_until=now()+($4||' seconds')::interval,updated_at=now()
    FROM research_programs p WHERE c.program_id=p.id AND p.program_key=$1 AND (c.leased_until IS NULL OR c.leased_until<=now()) RETURNING c.lease_token`,[PROGRAM_KEY,owner,token,String(Math.min(120,Math.max(5,seconds)))]);
  return result.rowCount?token:null;
}

export async function releasePilotLease(token:string,checkpoint:Record<string,unknown>={}):Promise<boolean>{
  const db=await getDb(); const result=await db.query(`UPDATE research_controller_checkpoints c SET checkpoint_version=checkpoint_version+1,cursor=$2,lease_owner=NULL,lease_token=NULL,leased_until=NULL,last_completed_at=now(),updated_at=now()
    FROM research_programs p WHERE c.program_id=p.id AND p.program_key=$1 AND c.lease_token=$3`,[PROGRAM_KEY,JSON.stringify(checkpoint),token]);
  return !!result.rowCount;
}

export async function updatePilotControl(patch:PilotControlPatch,actor:string):Promise<unknown>{
  const value=validatePilotControl(patch); const db=await getDb(); const client=await db.connect();
  try { await client.query('BEGIN');
    const current=await client.query(`SELECT p.id,p.mode,p.lifecycle,c.* FROM research_programs p JOIN research_pilot_controls c ON c.program_id=p.id WHERE p.program_key=$1 FOR UPDATE`,[PROGRAM_KEY]);
    if (!current.rowCount) throw new Error('Topic pilot is not installed.'); const row=current.rows[0];
    const mode=value.mode??row.mode, lifecycle=value.paused===undefined?row.lifecycle:(value.paused?'PAUSED':'ACTIVE');
    const kill=value.killSwitch??row.kill_switch,daily=value.dailyYoutubeCap??row.daily_youtube_cap,total=value.totalYoutubeCap??row.total_youtube_cap;
    validatePilotControl({mode,killSwitch:kill,dailyYoutubeCap:daily,totalYoutubeCap:total});
    await client.query(`UPDATE research_programs SET mode=$2,lifecycle=$3,activation_enabled=$4,policy_version=$5 WHERE id=$1`,[row.id,mode,lifecycle,mode==='CANARY'&&lifecycle==='ACTIVE'&&!kill,TOPIC_PILOT_POLICY_VERSION]);
    await client.query(`UPDATE research_pilot_controls SET kill_switch=$2,daily_youtube_cap=$3,total_youtube_cap=$4,configuration_version=configuration_version+1,updated_by=$5,updated_at=now() WHERE program_id=$1`,[row.id,kill,daily,total,actor]);
    await client.query('COMMIT'); return inspectTopicPilot();
  } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
}

export async function inspectTopicPilot():Promise<unknown>{
  const db=await getDb(); const result=await db.query(`SELECT p.program_key,p.mode,p.lifecycle,p.policy_version,p.activation_enabled,c.kill_switch,c.daily_youtube_cap,c.total_youtube_cap,c.consumed_youtube_units,c.configuration_version,c.updated_by,c.updated_at,k.checkpoint_version,k.lease_owner,k.leased_until,k.last_completed_at
    FROM research_programs p JOIN research_pilot_controls c ON c.program_id=p.id JOIN research_controller_checkpoints k ON k.program_id=p.id WHERE p.program_key=$1`,[PROGRAM_KEY]);
  if (!result.rowCount) throw new Error('Topic pilot is not installed.'); const row=result.rows[0];
  return {...row,executionEnabled:row.mode==='CANARY'&&row.lifecycle==='ACTIVE'&&row.activation_enabled&&!row.kill_switch,payloadSchemaVersion:TOPIC_PILOT_PAYLOAD_VERSION,authoritativeExecutor:'SEARCH_YOUTUBE workers',fallback:'autonomous_discovery'};
}
