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
  if ([400,404,422].includes(Number(value?.status||value?.code))) return new ProviderCallError('Permanent provider input failure.','PERMANENT_INPUT',false,{cause:error});
  return new ProviderCallError('Provider call failed.','TRANSIENT',true,{cause:error});
}

const statusFor=(e:ProviderCallError):ProviderStatus => e.errorClass==='TIMEOUT'?'TIMEOUT':e.errorClass==='CANCELLED'?'CANCELLED':e.errorClass==='RATE_LIMIT'?'RATE_LIMITED':e.retryable?'TRANSIENT_ERROR':'PERMANENT_ERROR';
export type ProviderEventSink=(event:ProviderCallEvent)=>Promise<void>;

/** Bounds the caller, propagates cancellation, and emits metadata only (never payloads). */
export async function executeProviderCall<T>(args:{context:ProviderCallContext; timeoutMs:number; enabled?:boolean; signal?:AbortSignal; call:(signal:AbortSignal)=>Promise<T>; emit:ProviderEventSink}):Promise<T>{
  const started=Date.now(), id=randomUUID(), controller=new AbortController();
  const abort=()=>controller.abort(args.signal?.reason); args.signal?.addEventListener('abort',abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined; let timedOut=false;
  if(args.enabled!==false && args.timeoutMs>0) timer=setTimeout(()=>{timedOut=true;controller.abort();},args.timeoutMs);
  const base={id,provider:args.context.provider,operation:args.context.operation,requestId:args.context.requestId,runId:args.context.runId,jobId:args.context.jobId,attempt:args.context.attempt||1,reservedCost:args.context.reservedCost||0,policyVersion:args.context.policyVersion||'provider-resilience-v1',occurredAt:new Date().toISOString()};
  try{
    const value=await args.call(controller.signal);
    await args.emit({...base,status:'SUCCESS',latencyMs:Date.now()-started,actualCost:args.context.actualCost||0}); return value;
  }catch(error){
    const typed=timedOut?new ProviderCallError(`Provider call exceeded ${args.timeoutMs}ms deadline.`,'TIMEOUT',true,{cause:error}):classifyProviderError(error);
    await args.emit({...base,status:statusFor(typed),latencyMs:Date.now()-started,actualCost:0,errorClass:typed.errorClass}).catch(()=>undefined); throw typed;
  }finally{ if(timer)clearTimeout(timer); args.signal?.removeEventListener('abort',abort); }
}
