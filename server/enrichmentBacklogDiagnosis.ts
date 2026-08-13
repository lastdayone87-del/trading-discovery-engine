export type EnrichmentBacklogDiagnosis = 'RUNNABLE_WAITING'|'PROVIDER_BACKOFF'|'ACTIVE_LEASE'|'OPERATIONAL_RETRY'|'INVESTIGATION_DEADLINE_RISK'|'UNKNOWN';

export interface EnrichmentBacklogEvidence {
  status:string;
  runAfter:string;
  runnable:boolean;
  lockedBy?:string|null;
  lockedAt?:string|null;
  investigationState?:string|null;
  investigationDeadlineAt?:string|null;
  stepState?:string|null;
  failureClass?:string|null;
  lastError?:string|null;
}

const operationalPattern=/(provider|timeout|rate.?limit|quota|cooldown|transient|temporar|econn|eai_again|429|503|502|504|credentials|cancel)/i;

export function diagnoseEnrichmentBacklog(evidence:EnrichmentBacklogEvidence,now=Date.now()):EnrichmentBacklogDiagnosis{
  if(evidence.status==='RUNNING'||Boolean(evidence.lockedBy&&evidence.lockedAt))return 'ACTIVE_LEASE';
  if(evidence.investigationState==='ACTIVE'&&evidence.investigationDeadlineAt&&new Date(evidence.investigationDeadlineAt).getTime()<=now)return 'INVESTIGATION_DEADLINE_RISK';
  if(evidence.stepState==='RETRYING'&&operationalPattern.test(evidence.failureClass||evidence.lastError||''))return 'OPERATIONAL_RETRY';
  if(evidence.status==='PENDING'&&new Date(evidence.runAfter).getTime()>now)return 'PROVIDER_BACKOFF';
  if(evidence.status==='PENDING'&&evidence.runnable)return 'RUNNABLE_WAITING';
  return 'UNKNOWN';
}
