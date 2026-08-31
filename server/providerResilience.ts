import { randomUUID } from 'node:crypto';

export type ProviderStatus = 'SUCCESS'|'TIMEOUT'|'CANCELLED'|'RATE_LIMITED'|'TRANSIENT_ERROR'|'PERMANENT_ERROR';
export type ProviderErrorClass = 'TIMEOUT'|'CANCELLED'|'RATE_LIMIT'|'TRANSIENT'|'PERMANENT_INPUT'|'CREDENTIALS_EXHAUSTED';

export interface ProviderCallContext {
  provider: string; operation: string; requestId?: string; runId?: string; jobId?: string;
  requestMetadata?: Record<string, string | null>;
  attempt?: number; reservedCost?: number; actualCost?: number; policyVersion?: string;
}
export interface ProviderCallEvent extends Required<Pick<ProviderCallContext,'provider'|'operation'>> {
  id: string; requestId?: string; runId?: string; jobId?: string; requestMetadata?: Record<string, string | null>; attempt: number;
  status: ProviderStatus; latencyMs: number; reservedCost: number; actualCost: number;
  errorClass?: ProviderErrorClass; policyVersion: string; occurredAt: string;
}

export class ProviderCallError extends Error {
  readonly status?: number;
  readonly quotaExceeded?: boolean;
  readonly providerReasons?: string[];
  constructor(message: string, public readonly errorClass: ProviderErrorClass, public readonly retryable: boolean, options?: { cause?: unknown; status?: number; quotaExceeded?: boolean; providerReasons?: string[] }) {
    super(message, options); this.name='ProviderCallError';
    this.status=options?.status; this.quotaExceeded=options?.quotaExceeded; this.providerReasons=options?.providerReasons;
  }
}

export function classifyProviderError(error: unknown): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  const value=error as any; const message=String(value?.message||value||'Provider call failed');
  if (value?.name==='AbortError') return new ProviderCallError('Provider call was cancelled.','CANCELLED',true,{cause:error});
  if (value?.status===429 || value?.code===429 || /429|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(message)) return new ProviderCallError('Provider rate limit reached.','RATE_LIMIT',true,{cause:error,status:Number(value?.status||value?.code)||undefined,quotaExceeded:value?.quotaExceeded,providerReasons:value?.providerReasons});
  if ([408,500,502,503,504].includes(Number(value?.status||value?.code)) || /ECONNRESET|ETIMEDOUT|high demand|temporar/i.test(message)) return new ProviderCallError('Transient provider failure.','TRANSIENT',true,{cause:error});
  if ([400,404,422].includes(Number(value?.status||value?.code))) return new ProviderCallError('Permanent provider input failure.','PERMANENT_INPUT',false,{cause:error,status:Number(value?.status||value?.code)||undefined,providerReasons:value?.providerReasons});
  return new ProviderCallError('Provider call failed.','TRANSIENT',true,{cause:error});
}

const statusFor=(e:ProviderCallError):ProviderStatus => e.errorClass==='TIMEOUT'?'TIMEOUT':e.errorClass==='CANCELLED'?'CANCELLED':e.errorClass==='RATE_LIMIT'?'RATE_LIMITED':e.retryable?'TRANSIENT_ERROR':'PERMANENT_ERROR';
export type ProviderEventSink=(event:ProviderCallEvent)=>Promise<void>;

const GEMINI_CAPACITY_LOCK = 741963285;
const GEMINI_SEMANTIC_OPERATION = 'multilingual-semantic-classification';
const GEMINI_VOCABULARY_OPERATION = 'vocabulary-extraction';
const GEMINI_LOCK_POLL_MS = 100;
const GEMINI_OUTCOME_CLEANUP_TIMEOUT_MS = 1000;

export const DEFAULT_GEMINI_ROUTE_ID = 'gemini-1';

/** Return configured Gemini route IDs from environment (no credentials exposed). */
export function configuredGeminiRouteIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = Object.keys(env).filter(name => name === 'GEMINI_API_KEY' || /^GEMINI_API_KEY_[2-9][0-9]*$/.test(name));
  names.sort((a, b) => {
    const routeNumber = (name: string) => name === 'GEMINI_API_KEY' ? 1 : Number(name.slice('GEMINI_API_KEY_'.length));
    return routeNumber(a) - routeNumber(b);
  });
  const seen = new Set<string>();
  return names.flatMap(name => {
    const key = String(env[name] || '').trim();
    if (!key || seen.has(key)) return [];
    seen.add(key);
    const numeric = name === 'GEMINI_API_KEY' ? 1 : Number(name.slice('GEMINI_API_KEY_'.length));
    return [resolveGeminiRouteId(`gemini-${numeric}`)];
  });
}

/** Resolve only machine-owned route identifiers; never expose or persist credentials. */
export function resolveGeminiRouteId(value: unknown): string {
  const candidate = String(value || '').trim();
  return /^gemini-[1-9][0-9]*$/.test(candidate) ? candidate : DEFAULT_GEMINI_ROUTE_ID;
}

type GeminiCapacitySnapshot = {
  nowMs: number;
  lastGeminiAtMs?: number;
  lastRateLimitAtMs?: number;
  lastSemanticAtMs?: number;
  lastVocabularyAtMs?: number;
};

type GeminiCapacityConfig = {
  globalMinIntervalMs: number;
  semanticRateLimitCooldownMs: number;
  vocabularyRateLimitSuppressionMs: number;
  vocabularySemanticQuietMs: number;
  vocabularyMinIntervalMs: number;
  maxInlineWaitMs?: number;
  semanticMaxInlineWaitMs?: number;
};

export type GeminiCapacityDecision = { action:'RUN'|'WAIT'|'DEFER'; waitMs:number; reasonCode?:string };

function envMs(name:string, fallback:number):number {
  const parsed=Number(process.env[name]);
  return Number.isFinite(parsed)&&parsed>=0?parsed:fallback;
}

function geminiCapacityConfig():GeminiCapacityConfig {
  return {
    globalMinIntervalMs: envMs('GEMINI_GLOBAL_MIN_INTERVAL_MS', 6000),
    semanticRateLimitCooldownMs: envMs('GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS', 90000),
    vocabularyRateLimitSuppressionMs: envMs('GEMINI_VOCABULARY_RATE_LIMIT_SUPPRESSION_MS', 15*60*1000),
    vocabularySemanticQuietMs: envMs('GEMINI_VOCABULARY_SEMANTIC_QUIET_MS', 2*60*1000),
    vocabularyMinIntervalMs: envMs('GEMINI_VOCABULARY_MIN_INTERVAL_MS', 30000),
    maxInlineWaitMs: envMs('GEMINI_CAPACITY_MAX_INLINE_WAIT_MS', 8000),
    semanticMaxInlineWaitMs: envMs('GEMINI_SEMANTIC_MAX_INLINE_WAIT_MS', 8000)
  };
}

export function decideGeminiCapacity(operation:string, snapshot:GeminiCapacitySnapshot, config:GeminiCapacityConfig=geminiCapacityConfig()):GeminiCapacityDecision {
  const age=(value?:number)=>value==null?Number.POSITIVE_INFINITY:Math.max(0,snapshot.nowMs-value);
  const maxInlineWaitMs=config.maxInlineWaitMs??8000;
  const semanticMaxInlineWaitMs=config.semanticMaxInlineWaitMs??maxInlineWaitMs;
  const globalWait=Math.max(0,config.globalMinIntervalMs-age(snapshot.lastGeminiAtMs));
  if(operation===GEMINI_VOCABULARY_OPERATION){
    if(age(snapshot.lastRateLimitAtMs)<config.vocabularyRateLimitSuppressionMs) return {action:'DEFER',waitMs:0,reasonCode:'VOCABULARY_DEFERRED_RATE_PRESSURE'};
    if(age(snapshot.lastSemanticAtMs)<config.vocabularySemanticQuietMs) return {action:'DEFER',waitMs:0,reasonCode:'VOCABULARY_DEFERRED_SEMANTIC_PRIORITY'};
    const vocabularyWait=Math.max(0,config.vocabularyMinIntervalMs-age(snapshot.lastVocabularyAtMs));
    const waitMs=Math.max(globalWait,vocabularyWait);
    if(waitMs>maxInlineWaitMs) return {action:'DEFER',waitMs:0,reasonCode:'VOCABULARY_DEFERRED_CAPACITY_WAIT'};
    return {action:waitMs>0?'WAIT':'RUN',waitMs};
  }
  const rateLimitWait=age(snapshot.lastRateLimitAtMs)<config.semanticRateLimitCooldownMs?config.semanticRateLimitCooldownMs-age(snapshot.lastRateLimitAtMs):0;
  const waitMs=Math.max(globalWait,rateLimitWait);
  const isSemantic=operation===GEMINI_SEMANTIC_OPERATION;
  const waitCeiling=isSemantic?semanticMaxInlineWaitMs:maxInlineWaitMs;
  if(waitMs>waitCeiling) return {action:'DEFER',waitMs:0,reasonCode:isSemantic?'SEMANTIC_DEFERRED_RATE_PRESSURE':'GEMINI_OPERATION_DEFERRED_RATE_PRESSURE'};
  return {action:waitMs>0?'WAIT':'RUN',waitMs};
}

/**
 * Returns the timestamp (ms since epoch) at which the Gemini semantic provider
 * cooldown will expire, based on the last RATE_LIMITED event persisted in
 * provider_call_events. Returns undefined if no rate limit has been recorded
 * or if the cooldown has already elapsed.
 *
 * When configuredRouteIds is provided, checks that ALL configured routes
 * are rate-limited (returns undefined if any route is available).
 * When not provided, uses global scope (any route's rate limit blocks).
 *
 * This is the single authoritative source of Gemini semantic cooldown state.
 * It queries the same provider_call_events table used by acquireGeminiCapacity,
 * so there are no independent clocks or parallel rate limiters.
 */
export async function getGeminiSemanticCooldownExpiry(nowMs: number = Date.now(), configuredRouteIds?: string[]): Promise<number | undefined> {
  const config = geminiCapacityConfig();
  try {
    const { getDb } = await import('./db');
    const db = await getDb();
    if (configuredRouteIds && configuredRouteIds.length > 0) {
      const cutoff = new Date(nowMs - config.semanticRateLimitCooldownMs).toISOString();
      const res = await db.query(
        `SELECT COALESCE(request_metadata->>'geminiRoute','gemini-1') as route, MAX(occurred_at) as last_rate_limit
         FROM provider_call_events
         WHERE provider='gemini' AND status='RATE_LIMITED' AND occurred_at >= $1
         GROUP BY route`, [cutoff]
      );
      const routeLatestExpiry = new Map<string, number>();
      for (const row of res.rows) {
        const route = String(row.route);
        const lastAt = new Date(row.last_rate_limit).getTime();
        routeLatestExpiry.set(route, lastAt + config.semanticRateLimitCooldownMs);
      }
      let latestExpiry = 0;
      for (const routeId of configuredRouteIds) {
        const expiry = routeLatestExpiry.get(routeId);
        if (expiry === undefined || expiry <= nowMs) return undefined;
        if (expiry > latestExpiry) latestExpiry = expiry;
      }
      return latestExpiry;
    } else {
      const res = await db.query(
        `SELECT occurred_at FROM provider_call_events
         WHERE provider='gemini' AND status='RATE_LIMITED'
         ORDER BY occurred_at DESC LIMIT 1`
      );
      if (!res.rows[0]?.occurred_at) return undefined;
      const lastRateLimitMs = new Date(res.rows[0].occurred_at).getTime();
      const elapsed = nowMs - lastRateLimitMs;
      if (elapsed >= config.semanticRateLimitCooldownMs) return undefined;
      return lastRateLimitMs + config.semanticRateLimitCooldownMs;
    }
  } catch {
    return undefined;
  }
}

/**
 * Returns true when the Gemini semantic provider is in an active cooldown
 * that would cause a semantic classification call to DEFER.
 *
 * Route-aware: returns true only when ALL configured routes are rate-limited.
 * If any configured route is available, returns false so ENRICH_CHANNEL work
 * can proceed through the healthy route.
 *
 * Uses the same authoritative provider_call_events state as acquireGeminiCapacity.
 */
export async function isGeminiSemanticCooldownActive(nowMs: number = Date.now(), configuredRouteIds?: string[]): Promise<boolean> {
  const routes = configuredRouteIds ?? configuredGeminiRouteIds();
  if (routes.length === 0) return false;
  const expiry = await getGeminiSemanticCooldownExpiry(nowMs, routes);
  return expiry !== undefined && expiry > nowMs;
}

/**
 * Returns the authoritative Gemini semantic cooldown duration in milliseconds.
 * Used by retry scheduling to ensure run_after respects the provider cooldown.
 */
export function geminiSemanticCooldownMs(): number {
  return geminiCapacityConfig().semanticRateLimitCooldownMs;
}

function abortError():Error{const error=new Error('aborted');error.name='AbortError';return error;}

function waitForCapacity(ms:number,signal?:AbortSignal):Promise<void>{
  if(ms<=0)return signal?.aborted?Promise.reject(abortError()):Promise.resolve();
  return new Promise((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>;
    const onAbort=()=>{clearTimeout(timer);reject(abortError())};
    if(signal?.aborted)return onAbort();
    timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve()},ms);
    signal?.addEventListener('abort',onAbort,{once:true});
  });
}

async function queryWithDeadline(client:any,text:string,values:any[],signal?:AbortSignal,deadlineAtMs?:number):Promise<any>{
  if(signal?.aborted)throw abortError();
  const remainingMs=deadlineAtMs==null?undefined:deadlineAtMs-Date.now();
  if(remainingMs!=null&&remainingMs<=0)throw abortError();
  const query:any={text,values};
  if(remainingMs!=null)query.query_timeout=Math.max(1,remainingMs);
  const result=await client.query(query);
  if(signal?.aborted)throw abortError();
  return result;
}

type GeminiPersistenceContext={signal?:AbortSignal;deadlineAtMs?:number};
type GeminiCapacityLease={
  persistOutcome:(event:ProviderCallEvent,persistenceContext?:GeminiPersistenceContext)=>Promise<void>;
  release:()=>Promise<void>;
};

export function geminiCapacityDeferralError(operation:string, reasonCode?:string):ProviderCallError {
  const isVocabulary=operation===GEMINI_VOCABULARY_OPERATION;
  const isSemantic=operation===GEMINI_SEMANTIC_OPERATION;
  const message=isVocabulary
    ? 'Gemini vocabulary extraction deferred to protect semantic classification capacity.'
    : isSemantic
      ? 'Gemini semantic classification deferred during provider rate pressure.'
      : 'Gemini operation deferred during provider rate pressure.';
  return new ProviderCallError(message,'TRANSIENT',true,{providerReasons:[reasonCode||'GEMINI_CAPACITY_DEFERRED']});
}

async function connectWithAbort(db:any,signal?:AbortSignal):Promise<any>{
  if(!signal)return db.connect();
  if(signal.aborted)throw abortError();
  return new Promise((resolve,reject)=>{
    let settled=false;
    const onAbort=()=>{if(settled)return;settled=true;signal.removeEventListener('abort',onAbort);reject(abortError())};
    signal.addEventListener('abort',onAbort,{once:true});
    db.connect().then((client:any)=>{
      if(settled){client.release();return;}
      settled=true;signal.removeEventListener('abort',onAbort);resolve(client);
    },(error:unknown)=>{
      if(settled)return;
      settled=true;signal.removeEventListener('abort',onAbort);reject(error);
    });
  });
}

async function acquireGeminiCapacity(context:ProviderCallContext,signal?:AbortSignal,deadlineAtMs?:number):Promise<GeminiCapacityLease|undefined>{
  if(context.provider!=='gemini') return undefined;
  const routeId = resolveGeminiRouteId(context.requestMetadata?.geminiRoute);
  let client:any;
  try{
    const { getDb }=await import('./db');
    const db=await getDb();
    while(true){
      if(signal?.aborted)throw abortError();
      client=await connectWithAbort(db,signal);
      const lock=await queryWithDeadline(client,'SELECT pg_try_advisory_lock($1) AS acquired',[GEMINI_CAPACITY_LOCK],signal,deadlineAtMs);
      if(lock.rows[0]?.acquired)break;
      client.release();client=undefined;
      await waitForCapacity(GEMINI_LOCK_POLL_MS,signal);
    }
    if(signal?.aborted)throw abortError();
    const [lastAny,lastRate,lastSemantic,lastVocabulary]=await Promise.all([
      queryWithDeadline(client,`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND COALESCE(request_metadata->>'geminiRoute',$1)=$1 ORDER BY occurred_at DESC LIMIT 1`,[routeId],signal,deadlineAtMs),
      // Gemini rate limits are project-level, not API-key-level. Query ALL routes
      // so a rate limit on any route correctly blocks the shared cooldown.
      queryWithDeadline(client,`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND status='RATE_LIMITED' ORDER BY occurred_at DESC LIMIT 1`,[],signal,deadlineAtMs),
      queryWithDeadline(client,`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND operation=$1 AND COALESCE(request_metadata->>'geminiRoute',$2)=$2 ORDER BY occurred_at DESC LIMIT 1`,[GEMINI_SEMANTIC_OPERATION,routeId],signal,deadlineAtMs),
      queryWithDeadline(client,`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND operation=$1 AND COALESCE(request_metadata->>'geminiRoute',$2)=$2 ORDER BY occurred_at DESC LIMIT 1`,[GEMINI_VOCABULARY_OPERATION,routeId],signal,deadlineAtMs)
    ]);
    const at=(row:any)=>row?.occurred_at?new Date(row.occurred_at).getTime():undefined;
    const decision=decideGeminiCapacity(context.operation,{nowMs:Date.now(),lastGeminiAtMs:at(lastAny.rows[0]),lastRateLimitAtMs:at(lastRate.rows[0]),lastSemanticAtMs:at(lastSemantic.rows[0]),lastVocabularyAtMs:at(lastVocabulary.rows[0])});
    if(decision.action==='DEFER'){
      await client.query({text:'SELECT pg_advisory_unlock($1)',values:[GEMINI_CAPACITY_LOCK],query_timeout:1000}).catch(()=>undefined);
      client.release(); client=undefined;
      throw geminiCapacityDeferralError(context.operation,decision.reasonCode);
    }
    if(decision.waitMs>0) await waitForCapacity(decision.waitMs,signal);
    if(signal?.aborted)throw abortError();
    return {
      persistOutcome:async(event:ProviderCallEvent,persistenceContext?:GeminiPersistenceContext)=>{
        if(!client)return;
        await queryWithDeadline(client,`INSERT INTO provider_call_events(id,provider,operation,request_id,run_id,job_id,request_metadata,attempt,status,latency_ms,reserved_cost,actual_cost,error_class,policy_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(id) DO NOTHING`,[event.id,event.provider,event.operation,event.requestId||null,event.runId||null,event.jobId||null,JSON.stringify(event.requestMetadata||{}),event.attempt,event.status,event.latencyMs,event.reservedCost,event.actualCost,event.errorClass||null,event.policyVersion,event.occurredAt],persistenceContext?.signal??signal,persistenceContext?.deadlineAtMs??deadlineAtMs);
      },
      release:async()=>{if(!client)return;const leasedClient=client;client=undefined;try{await leasedClient.query({text:'SELECT pg_advisory_unlock($1)',values:[GEMINI_CAPACITY_LOCK],query_timeout:1000});leasedClient.release();}catch{leasedClient.release(true);}}
    };
  }catch(error){
    if(client){const leasedClient=client;client=undefined;try{await leasedClient.query({text:'SELECT pg_advisory_unlock($1)',values:[GEMINI_CAPACITY_LOCK],query_timeout:1000});leasedClient.release();}catch{leasedClient.release(true);}}
    if(error instanceof ProviderCallError) throw error;
    if((error as any)?.name==='AbortError')throw error;
    if(context.operation===GEMINI_VOCABULARY_OPERATION) throw new ProviderCallError('Gemini vocabulary extraction deferred because capacity state is unavailable.','TRANSIENT',true,{cause:error,providerReasons:['VOCABULARY_CAPACITY_STATE_UNAVAILABLE']});
    return undefined;
  }
}

function safeProviderReasons(values?:string[]):string[]{
  return Array.isArray(values)?values.map(String).filter(value=>/^[A-Z0-9_.:-]{1,80}$/.test(value)).slice(0,6):[];
}

export async function executeProviderCall<T>(args:{context:ProviderCallContext; timeoutMs:number; enabled?:boolean; signal?:AbortSignal; call:(signal:AbortSignal)=>Promise<T>; emit:ProviderEventSink; trace?:(stage:string)=>void}):Promise<T>{
  const started=Date.now(), id=randomUUID(), controller=new AbortController();
  const base={id,provider:args.context.provider,operation:args.context.operation,requestId:args.context.requestId,runId:args.context.runId,jobId:args.context.jobId,requestMetadata:args.context.requestMetadata,attempt:args.context.attempt||1,reservedCost:args.context.reservedCost||0,policyVersion:args.context.policyVersion||'provider-resilience-v1'};
  let capacityLease:GeminiCapacityLease|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined; let timedOut=false;
  const abort=()=>controller.abort(args.signal?.reason); args.signal?.addEventListener('abort',abort,{once:true});
  const deadlineAtMs=args.enabled!==false&&args.timeoutMs>0?started+args.timeoutMs:undefined;
  if(deadlineAtMs!=null) timer=setTimeout(()=>{timedOut=true;controller.abort();},Math.max(0,deadlineAtMs-Date.now()));
  const releaseCapacity=async()=>{if(!capacityLease)return;const lease=capacityLease;capacityLease=undefined;await lease.release();};
  const persistCapacityOutcome=async(event:ProviderCallEvent,persistenceContext?:GeminiPersistenceContext)=>{if(capacityLease)await capacityLease.persistOutcome(event,persistenceContext);};
  try{
    capacityLease=await acquireGeminiCapacity(args.context,controller.signal,deadlineAtMs);
    if(controller.signal.aborted)throw abortError();
    args.trace?.('before provider-call at server/providerResilience.ts');
    const value=await args.call(controller.signal);
    args.trace?.('after provider-call at server/providerResilience.ts');
    const event:ProviderCallEvent={...base,status:'SUCCESS',latencyMs:Date.now()-started,actualCost:args.context.actualCost||0,occurredAt:new Date().toISOString()};
    try { await persistCapacityOutcome(event); } catch (pacingStateError) { console.warn('[Gemini Capacity Diagnostic] Failed to persist successful pacing outcome before unlock.',String((pacingStateError as any)?.message||pacingStateError)); }
    await releaseCapacity();
    await args.emit(event).catch(()=>undefined);
    return value;
  }catch(error){
    const typed=timedOut?new ProviderCallError(`Provider call exceeded ${args.timeoutMs}ms deadline.`,'TIMEOUT',true,{cause:error}):classifyProviderError(error);
    args.trace?.(`provider-call-caught (${typed.errorClass})`);
    if(args.context.provider==='gemini')console.warn('[Gemini Provider Diagnostic]',JSON.stringify({operation:args.context.operation,errorClass:typed.errorClass,status:typed.status??null,retryable:typed.retryable,providerReasons:safeProviderReasons(typed.providerReasons)}));
    const event:ProviderCallEvent={...base,status:statusFor(typed),latencyMs:Date.now()-started,actualCost:0,errorClass:typed.errorClass,occurredAt:new Date().toISOString()};
    if(capacityLease&&(typed.errorClass==='TIMEOUT'||typed.errorClass==='CANCELLED')){
      const cleanupController=new AbortController();
      const cleanupDeadlineAtMs=Date.now()+GEMINI_OUTCOME_CLEANUP_TIMEOUT_MS;
      const cleanupTimer=setTimeout(()=>cleanupController.abort(),GEMINI_OUTCOME_CLEANUP_TIMEOUT_MS);
      try { await persistCapacityOutcome(event,{signal:cleanupController.signal,deadlineAtMs:cleanupDeadlineAtMs}); } catch {} finally { clearTimeout(cleanupTimer); }
    } else {
      await persistCapacityOutcome(event).catch(()=>undefined);
    }
    await releaseCapacity();
    await args.emit(event).catch(()=>undefined);
    throw typed;
  }finally{
    if(timer)clearTimeout(timer); args.signal?.removeEventListener('abort',abort);
    await releaseCapacity();
  }
}