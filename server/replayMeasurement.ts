import { createHash } from 'node:crypto';

export const OUTCOME_EVENT_VERSION = 1;
export const REPLAY_POLICY_VERSION = 'current-query-policy-v1';
export const REPLAY_FEATURE_VERSION = 'query-funnel-v1';
export type VerificationStatus = 'PROVISIONAL'|'VERIFIED'|'CORRECTIVE';
export type OutcomeEventType = 'QUERY_FUNNEL_RECORDED'|'PAGE_FUNNEL_RECORDED'|'CHANNEL_OBSERVED'|'REVIEW_VERIFIED'|'REVIEW_CORRECTED'|'QUOTA_FINALIZED';

export interface ReplayEvent { eventKey:string; subjectId:string; eventType:OutcomeEventType; verificationStatus:VerificationStatus; eventTime:string; recordedAt:string; country?:string|null; retrievalLane?:string|null; payload:Record<string,unknown> }
export interface FunnelMetrics { rawResults:number; distinctResults:number; duplicateResults:number; knownChannels:number; newChannels:number; countryRejected:number; nonTrading:number; uncertain:number; needsReview:number; tradingConfirmed:number; uniqueChannels:number; qualityChannels:number; communitiesDiscovered:number; quotaUsed:number }
const metricKeys:(keyof FunnelMetrics)[]=['rawResults','distinctResults','duplicateResults','knownChannels','newChannels','countryRejected','nonTrading','uncertain','needsReview','tradingConfirmed','uniqueChannels','qualityChannels','communitiesDiscovered','quotaUsed'];

export function stableChecksum(value:unknown):string {
  const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/** Replay is deliberately pure and no-network: it consumes retained events only. */
export function replayFunnel(events:ReplayEvent[]) {
  const queryEvents=events.filter(e=>e.eventType==='QUERY_FUNNEL_RECORDED').sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.eventKey.localeCompare(b.eventKey));
  const totals=Object.fromEntries(metricKeys.map(k=>[k,0])) as unknown as FunnelMetrics;
  const segments:Record<string,FunnelMetrics>={};
  for(const event of queryEvents){
    const segment=`${event.country||'UNKNOWN'}|${event.retrievalLane||'UNKNOWN'}`;
    const target=segments[segment] ||= Object.fromEntries(metricKeys.map(k=>[k,0])) as unknown as FunnelMetrics;
    for(const key of metricKeys){const value=Number(event.payload[key]||0);if(!Number.isFinite(value)||value<0)throw new Error(`Invalid replay metric ${key}.`);totals[key]+=value;target[key]+=value;}
  }
  const corrections=events.filter(e=>e.verificationStatus==='CORRECTIVE').length;
  return {eventCount:events.length,queryRunCount:queryEvents.length,totals,segments,corrections,checksum:stableChecksum({totals,segments,corrections})};
}

export function compareMetrics(replayed:FunnelMetrics,legacy:Partial<FunnelMetrics>,tolerance=0) {
  if(!Number.isFinite(tolerance)||tolerance<0) throw new Error('Tolerance must be non-negative.');
  const residuals=Object.fromEntries(metricKeys.map(key=>{const expected=Number(legacy[key]||0),actual=replayed[key],delta=actual-expected;return [key,{actual,expected,delta,withinTolerance:Math.abs(delta)<=tolerance*Math.max(1,Math.abs(expected))}];}));
  return {pass:Object.values(residuals).every(r=>r.withinTolerance),tolerance,residuals};
}

export function assertMinimalPayload(payload:Record<string,unknown>):void {
  const serialized=JSON.stringify(payload);
  if(serialized.length>20_000) throw new Error('Event payload exceeds the 20KB measurement limit.');
  if(/(?:token|secret|authorization|email|providerPayload)/i.test(Object.keys(payload).join(','))) throw new Error('Event payload contains a prohibited sensitive field.');
}
