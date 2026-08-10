import { randomUUID } from 'node:crypto';

export type ProviderStatus = 'SUCCESS'|'TIMEOUT'|'CANCELLED'|'RATE_LIMITED'|'TRANSIENT_ERROR'|'PERMANENT_ERROR';
export type ProviderErrorClass = 'TIMEOUT'|'CANCELLED'|'RATE_LIMIT'|'TRANSIENT'|'PERMANENT_INPUT'|'CREDENTIALS_EXHAUSTED';

export interface ProviderCallContext {
  provider: string; operation: string; requestId?: string; runId?: string; jobId?: string;
  attempt?: number; reservedCost?: number; actualCost?: number; policyVersion?: string;
}
export interface ProviderCallEvent extends Required<Pick<ProviderCallContext,'provider'|'operation'>> {
  id: string; requestId?: string; runId?: string; jobId?: string; attempt: number;
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
    maxInlineWaitMs: envMs('GEMINI_CAPACITY_MAX_INLINE_WAIT_MS', 8000)
  };
}

export function decideGeminiCapacity(operation:string, snapshot:GeminiCapacitySnapshot, config:GeminiCapacityConfig=geminiCapacityConfig()):GeminiCapacityDecision {
  const age=(value?:number)=>value==null?Number.POSITIVE_INFINITY:Math.max(0,snapshot.nowMs-value);
  const maxInlineWaitMs=config.maxInlineWaitMs??8000;
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
  if(waitMs>maxInlineWaitMs) return {action:'DEFER',waitMs:0,reasonCode:'SEMANTIC_DEFERRED_RATE_PRESSURE'};
  return {action:waitMs>0?'WAIT':'RUN',waitMs};
}

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

type GeminiCapacityLease={release:()=>Promise<void>};

async function acquireGeminiCapacity(context:ProviderCallContext):Promise<GeminiCapacityLease|undefined>{
  if(context.provider!=='gemini') return undefined;
  let client:any;
  try{
    const { getDb }=await import('./db');
    const db=await getDb();
    client=await db.connect();
    await client.query('SELECT pg_advisory_lock($1)',[GEMINI_CAPACITY_LOCK]);
    const [lastAny,lastRate,lastSemantic,lastVocabulary]=await Promise.all([
      client.query(`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' ORDER BY occurred_at DESC LIMIT 1`),
      client.query(`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND status='RATE_LIMITED' ORDER BY occurred_at DESC LIMIT 1`),
      client.query(`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND operation=$1 ORDER BY occurred_at DESC LIMIT 1`,[GEMINI_SEMANTIC_OPERATION]),
      client.query(`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND operation=$1 ORDER BY occurred_at DESC LIMIT 1`,[GEMINI_VOCABULARY_OPERATION])
    ]);
    const at=(row:any)=>row?.occurred_at?new Date(row.occurred_at).getTime():undefined;
    const decision=decideGeminiCapacity(context.operation,{
      nowMs:Date.now(),
      lastGeminiAtMs:at(lastAny.rows[0]),
      lastRateLimitAtMs:at(lastRate.rows[0]),
      lastSemanticAtMs:at(lastSemantic.rows[0]),
      lastVocabularyAtMs:at(lastVocabulary.rows[0])
    });
    if(decision.action==='DEFER'){
      await client.query('SELECT pg_advisory_unlock($1)',[GEMINI_CAPACITY_LOCK]).catch(()=>undefined);
      client.release(); client=undefined;
      const isVocabulary=context.operation===GEMINI_VOCABULARY_OPERATION;
      throw new ProviderCallError(
        isVocabulary?'Gemini vocabulary extraction deferred to protect semantic classification capacity.':'Gemini semantic classification deferred during provider rate pressure.',
        'RATE_LIMIT',true,{status:429,providerReasons:[decision.reasonCode||'GEMINI_CAPACITY_DEFERRED']}
      );
    }
    if(decision.waitMs>0) await sleep(decision.waitMs);
    return {release:async()=>{
      if(!client)return;
      await client.query('SELECT pg_advisory_unlock($1)',[GEMINI_CAPACITY_LOCK]).catch(()=>undefined);
      client.release(); client=undefined;
    }};
  }catch(error){
    if(client){await client.query('SELECT pg_advisory_unlock($1)',[GEMINI_CAPACITY_LOCK]).catch(()=>undefined);client.release();}
    if(error instanceof ProviderCallError) throw error;
    if(context.operation===GEMINI_VOCABULARY_OPERATION) throw new ProviderCallError('Gemini vocabulary extraction deferred because capacity state is unavailable.','TRANSIENT',true,{cause:error,providerReasons:['VOCABULARY_CAPACITY_STATE_UNAVAILABLE']});
    return undefined;
  }
}

function safeProviderReasons(values?:string[]):string[]{
  return Array.isArray(values)?values.map(String).filter(value=>/^[A-Z0-9_.:-]{1,80}$/.test(value)).slice(0,6):[];
}

/** Bounds the caller, propagates cancellation, and emits metadata only (never payloads). */
export async function executeProviderCall<T>(args:{context:ProviderCallContext; timeoutMs:number; enabled?:boolean; signal?:AbortSignal; call:(signal:AbortSignal)=>Promise<T>; emit:ProviderEventSink; trace?:(stage:string)=>void}):Promise<T>{
  const capacityLease=await acquireGeminiCapacity(args.context);
  const started=Date.now(), id=randomUUID(), controller=new AbortController();
  const abort=()=>controller.abort(args.signal?.reason); args.signal?.addEventListener('abort',abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined; let timedOut=false;
  if(args.enabled!==false && args.timeoutMs>0) timer=setTimeout(()=>{timedOut=true;controller.abort();},args.timeoutMs);
  const base={id,provider:args.context.provider,operation:args.context.operation,requestId:args.context.requestId,runId:args.context.runId,jobId:args.context.jobId,attempt:args.context.attempt||1,reservedCost:args.context.reservedCost||0,policyVersion:args.context.policyVersion||'provider-resilience-v1',occurredAt:new Date().toISOString()};
  try{
    args.trace?.('before provider-call at server/providerResilience.ts');
    const value=await args.call(controller.signal);
    args.trace?.('after provider-call at server/providerResilience.ts');
    await args.emit({...base,status:'SUCCESS',latencyMs:Date.now()-started,actualCost:args.context.actualCost||0}).catch(()=>undefined);
    return value;
  }catch(error){
    const typed=timedOut?new ProviderCallError(`Provider call exceeded ${args.timeoutMs}ms deadline.`,'TIMEOUT',true,{cause:error}):classifyProviderError(error);
    args.trace?.(`provider-call-caught (${typed.errorClass})`);
    if(args.context.provider==='gemini'){
      console.warn('[Gemini Provider Diagnostic]',JSON.stringify({
        operation:args.context.operation,
        errorClass:typed.errorClass,
        status:typed.status??null,
        retryable:typed.retryable,
        providerReasons:safeProviderReasons(typed.providerReasons)
      }));
    }
    await args.emit({...base,status:statusFor(typed),latencyMs:Date.now()-started,actualCost:0,errorClass:typed.errorClass}).catch(()=>undefined);
    throw typed;
  }finally{
    if(timer)clearTimeout(timer); args.signal?.removeEventListener('abort',abort);
    await capacityLease?.release();
  }
}
