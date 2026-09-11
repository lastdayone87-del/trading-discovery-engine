// Public database facade. The long-lived PostgreSQL implementation remains in
// dbCore; retry lifecycle policy is kept here so its clock semantics are explicit
// and independently testable without changing the rest of the database surface.
export * from './dbCore';

import { getDb, isRetryableInfrastructureFailure, resolveGeminiSemanticCooldownExpiryMs, resolveGeminiRouteSemanticCooldownExpiryMs, resolveGroqSemanticCooldownExpiryMs, resolveGroqOrgCooldownExpiryMs, resolveGeminiFreeSemanticCooldownExpiryMs } from './dbCore';

export type JobFailureDisposition='RETRYING_WITHOUT_ATTEMPT'|'RETRYING'|'FAILED';

export function parseTransientRetryAgeMs(value:unknown,fallback=6*60*60_000):number{
  const parsed=Number(value);
  return Number.isFinite(parsed)&&parsed>=60_000?parsed:fallback;
}

const MAX_TRANSIENT_RETRY_AGE_MS=parseTransientRetryAgeMs(process.env.MAX_TRANSIENT_RETRY_AGE_MS);

export function resolveTransientFailureAnchor(error:any,persistedFirstTransientFailureAt:unknown,now=Date.now()):number{
  if(!isRetryableInfrastructureFailure(error))return now;
  const persisted=persistedFirstTransientFailureAt instanceof Date
    ? persistedFirstTransientFailureAt.getTime()
    : new Date(String(persistedFirstTransientFailureAt||'')).getTime();
  return Number.isFinite(persisted)?persisted:now;
}

export async function failJob(jobId:string,error:any):Promise<JobFailureDisposition|null>{
  const db=await getDb();
  const res=await db.query('SELECT attempts,max_attempts,first_transient_failure_at FROM jobs WHERE id=$1',[jobId]);
  if(!res.rowCount)return null;
  const {attempts,max_attempts,first_transient_failure_at}=res.rows[0];
  const now=Date.now();
  const retryableInfrastructure=isRetryableInfrastructureFailure(error);
  const firstFailureAt=resolveTransientFailureAnchor(error,first_transient_failure_at,now);
  const msg=String(error?.message||error).slice(0,2000);

  // Query the authoritative Gemini semantic cooldown from provider_call_events.
  // Each account cools independently: when the deferring error carries its
  // route, retry aligns with that account's window; otherwise the pool-wide
  // window applies as before.
  let geminiSemanticCooldownExpiryMs: number|undefined=undefined;
  let groqSemanticCooldownExpiryMs: number|undefined=undefined;
  let geminiFreeSemanticCooldownExpiryMs: number|undefined=undefined;
  const providerReasons=Array.isArray(error?.providerReasons)?error.providerReasons.map(String):[];
  if(providerReasons.includes('SEMANTIC_DEFERRED_RATE_PRESSURE')||providerReasons.includes('GEMINI_CAPACITY_DEFERRED')){
    const failedGeminiRoute=(error as any)?.geminiRoute;
    geminiSemanticCooldownExpiryMs=typeof failedGeminiRoute==='string'&&failedGeminiRoute?await resolveGeminiRouteSemanticCooldownExpiryMs(failedGeminiRoute,now):await resolveGeminiSemanticCooldownExpiryMs(now);
  }
  // Groq cooldown from the same persisted ledger (provider='groq'), scoped to
  // the failed organization when the error carries one: a Groq 429 defers the
  // retry past that org's window instead of ticking, and never penalizes
  // healthy orgs. Without an org tag, the pool-wide window applies as before.
  if(providerReasons.includes('GROQ_RATE_LIMITED')){
    const failedGroqOrg=(error as any)?.groqOrg;
    groqSemanticCooldownExpiryMs=typeof failedGroqOrg==='string'&&failedGroqOrg?await resolveGroqOrgCooldownExpiryMs(failedGroqOrg,now):await resolveGroqSemanticCooldownExpiryMs(now);
  }
  // Free-Gemini pool cooldown from its own persisted ledger
  // (provider='gemini-free'): a free-tier 429 defers the retry past the free
  // pool's shared window instead of ticking. Never touches the paid 'gemini'
  // window above.
  if(providerReasons.includes('GEMINI_FREE_RATE_LIMITED')){
    geminiFreeSemanticCooldownExpiryMs=await resolveGeminiFreeSemanticCooldownExpiryMs(now);
  }

  const decision=(await import('./dbCore')).decideJobFailure(error,attempts,max_attempts,now,firstFailureAt,geminiSemanticCooldownExpiryMs,groqSemanticCooldownExpiryMs,geminiFreeSemanticCooldownExpiryMs);
  const persistedMessage=decision.operationallyBlocked?`OPERATIONALLY_BLOCKED_RETRY_REQUIRED: ${msg}`:msg;
  const transientAnchor=retryableInfrastructure?new Date(firstFailureAt).toISOString():null;

  if(decision.disposition==='RETRYING_WITHOUT_ATTEMPT'){
    await db.query(`UPDATE jobs SET status='PENDING',attempts=GREATEST(0,attempts-1),last_error=$2,locked_by=NULL,locked_at=NULL,run_after=$3,first_transient_failure_at=COALESCE(first_transient_failure_at,$4::timestamptz),updated_at=now() WHERE id=$1`,[jobId,persistedMessage,new Date(decision.runAfter!).toISOString(),transientAnchor]);
  }else if(decision.disposition==='FAILED'){
    await db.query(`UPDATE jobs SET status='FAILED',last_error=$2,locked_by=NULL,locked_at=NULL,first_transient_failure_at=CASE WHEN $3::boolean THEN COALESCE(first_transient_failure_at,$4::timestamptz) ELSE first_transient_failure_at END,updated_at=now() WHERE id=$1`,[jobId,persistedMessage,retryableInfrastructure,transientAnchor]);
  }else{
    const seconds=Math.min(900,30*Math.pow(2,Math.max(0,attempts-1)));
    await db.query(`UPDATE jobs SET status='PENDING',last_error=$2,locked_by=NULL,locked_at=NULL,run_after=now()+($3||' seconds')::interval,first_transient_failure_at=NULL,updated_at=now() WHERE id=$1`,[jobId,persistedMessage,String(seconds)]);
  }

  await db.query(`UPDATE job_attempts SET status='FAILED',finished_at=now(),error=$2 WHERE job_id=$1 AND finished_at IS NULL`,[jobId,persistedMessage]);
  return decision.disposition;
}
