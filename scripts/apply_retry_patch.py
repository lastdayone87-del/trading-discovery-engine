from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'{label} anchor not found')
    file.write_text(text.replace(old, new, 1))


replace_once(
    'server/db.ts',
    "export type JobFailureDisposition='RETRYING_WITHOUT_ATTEMPT'|'RETRYING'|'FAILED';\nexport function decideJobFailure(error:any,attempts:number,maxAttempts:number,now=Date.now()):{disposition:JobFailureDisposition;runAfter?:number}{if(String(error?.code||'')==='INVESTIGATION_DEADLINE_EXCEEDED')return {disposition:'FAILED'};const retryAt=Number(error?.retryAt);const retryCode=['QUOTA_ALLOCATION_EXHAUSTED','YOUTUBE_PROVIDERS_COOLING_DOWN','YOUTUBE_PROVIDER_POOL_EXHAUSTED'].includes(String(error?.code||''));if(Number.isFinite(retryAt)&&(retryAt>now||retryCode))return {disposition:'RETRYING_WITHOUT_ATTEMPT',runAfter:Math.max(now,retryAt)};return {disposition:attempts>=maxAttempts?'FAILED':'RETRYING'};}\n",
    """export type JobFailureDisposition='RETRYING_WITHOUT_ATTEMPT'|'RETRYING'|'FAILED';
const TRANSIENT_PROVIDER_CODES=new Set(['QUOTA_ALLOCATION_EXHAUSTED','YOUTUBE_PROVIDERS_COOLING_DOWN','YOUTUBE_PROVIDER_POOL_EXHAUSTED','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
const TRANSIENT_HTTP_STATUS=new Set([408,425,429,500,502,503,504]);
export function isRetryableInfrastructureFailure(error:any):boolean{
  const code=String(error?.code||error?.cause?.code||'').toUpperCase();
  const status=Number(error?.status||error?.statusCode||error?.response?.status);
  const name=String(error?.name||'');
  if(TRANSIENT_PROVIDER_CODES.has(code)||TRANSIENT_HTTP_STATUS.has(status))return true;
  if(name==='TimeoutError')return true;
  return false;
}
export function decideJobFailure(error:any,attempts:number,maxAttempts:number,now=Date.now()):{disposition:JobFailureDisposition;runAfter?:number}{
  if(String(error?.code||'')==='INVESTIGATION_DEADLINE_EXCEEDED')return {disposition:'FAILED'};
  if(isRetryableInfrastructureFailure(error)){
    const retryAt=Number(error?.retryAt);
    const retryAfterMs=Number(error?.retryAfterMs);
    const scheduled=Number.isFinite(retryAt)&&retryAt>now?retryAt:Number.isFinite(retryAfterMs)&&retryAfterMs>0?now+retryAfterMs:now+5*60_000;
    return {disposition:'RETRYING_WITHOUT_ATTEMPT',runAfter:scheduled};
  }
  return {disposition:attempts>=maxAttempts?'FAILED':'RETRYING'};
}
""",
    'db.ts retry policy',
)

replace_once(
    'server/queueManager.ts',
    "      const refreshed=await getChannelById(channel.channel_id);\n      if(refreshed?.scan_status==='FAILED')throw new Error('Retryable community acquisition remains unresolved');\n      await completeJob(job.id);return true;\n",
    "      const refreshed=await getChannelById(channel.channel_id);\n      if(refreshed?.scan_status==='FAILED'||refreshed?.scan_status==='FAILED_PERMANENT')throw new Error('Retryable community acquisition remains unresolved');\n      await completeJob(job.id);return true;\n",
    'queueManager retry dispatcher',
)

replace_once(
    'server/queueManager.ts',
    "    channel.scan_attempts++;\n    if (channel.scan_attempts >= 3) {\n      channel.scan_status = 'FAILED_PERMANENT';\n    } else {\n      channel.scan_status = 'FAILED';\n    }\n    if(scheduleRetry)await enqueueCommunityAcquisitionRetry(channel.channel_id).catch(error=>console.warn(`[CommunityAcquisition] retry scheduling failed for ${channel.channel_id}:`,error instanceof Error?error.message:error));\n",
    "    channel.scan_attempts++;\n    // Durable RETRY_COMMUNITY_ACQUISITION owns the retry budget. Keep channel\n    // state retryable here so an internal scan counter cannot prematurely stop\n    // a job that still has durable attempts remaining.\n    channel.scan_status = 'FAILED';\n    if(scheduleRetry)await enqueueCommunityAcquisitionRetry(channel.channel_id).catch(error=>console.warn(`[CommunityAcquisition] retry scheduling failed for ${channel.channel_id}:`,error instanceof Error?error.message:error));\n",
    'queueManager channel permanence',
)

replace_once(
    'server/queueManager.ts',
    """    if (job.type === 'ENRICH_CHANNEL' && terminal) {
      const channelId = String(job.payload?.channelId || '');
      const channel = channelId ? await getChannelById(channelId) : null;
      if (channel && channel.trading_status === 'UNCERTAIN') {
        channel.scan_status = 'NEEDS_REVIEW';
        channel.trading_status = 'NEEDS_REVIEW';
        channel.scan_attempts = job.attempts;
        channel.last_checked = new Date().toISOString();
        await upsertChannel(channel);
        void recordAdmissionShadow({channelId,priorState:'NOT_EVALUATED',classificationStatus:'UNCERTAIN',investigationState:'OPERATIONALLY_BLOCKED',operationalFailure:true,candidateHypothesis:{},evidenceCoverage:{failureClass:String(err?.code||err?.name||'WORKER_FAILURE')}})
          .catch(error=>console.warn(`[CandidateAdmission] operational-failure shadow write failed for ${channelId}:`,error instanceof Error?error.message:error));
      }
    }
""",
    """    if (job.type === 'ENRICH_CHANNEL' && terminal) {
      const channelId = String(job.payload?.channelId || '');
      const channel = channelId ? await getChannelById(channelId) : null;
      if (channel && channel.trading_status === 'UNCERTAIN') {
        channel.scan_status = 'NEEDS_REVIEW';
        channel.trading_status = 'NEEDS_REVIEW';
        channel.scan_attempts = job.attempts;
        channel.last_checked = new Date().toISOString();
        await upsertChannel(channel);
        void recordAdmissionShadow({channelId,priorState:'NOT_EVALUATED',classificationStatus:'UNCERTAIN',investigationState:'OPERATIONALLY_BLOCKED',operationalFailure:true,candidateHypothesis:{},evidenceCoverage:{failureClass:String(err?.code||err?.name||'WORKER_FAILURE')}})
          .catch(error=>console.warn(`[CandidateAdmission] operational-failure shadow write failed for ${channelId}:`,error instanceof Error?error.message:error));
      }
    }
    if (job.type === 'RETRY_COMMUNITY_ACQUISITION' && terminal) {
      const channelId=String(job.payload?.channelId||'');
      const channel=channelId?await getChannelById(channelId):null;
      if(channel){channel.scan_status='FAILED_PERMANENT';channel.scan_attempts=Math.max(channel.scan_attempts||0,job.attempts);channel.last_checked=new Date().toISOString();await upsertChannel(channel);}
    }
""",
    'queueManager terminal community handling',
)

Path('server/retryLifecyclePolicy.test.ts').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import { decideJobFailure, isRetryableInfrastructureFailure } from './db';

const now=1_700_000_000_000;

test('quota/provider capacity waits without consuming an attempt even without retryAt',()=>{
  const result=decideJobFailure({code:'QUOTA_ALLOCATION_EXHAUSTED'},3,3,now);
  assert.equal(result.disposition,'RETRYING_WITHOUT_ATTEMPT');
  assert.ok((result.runAfter||0)>now);
});

test('provider cooldown honors retryAt without consuming an attempt',()=>{
  const retryAt=now+60_000;
  assert.deepEqual(decideJobFailure({code:'YOUTUBE_PROVIDERS_COOLING_DOWN',retryAt},2,3,now),{disposition:'RETRYING_WITHOUT_ATTEMPT',runAfter:retryAt});
});

test('common network/provider outages are retryable infrastructure failures',()=>{
  for(const error of [{code:'ETIMEDOUT'},{code:'ECONNRESET'},{code:'EAI_AGAIN'},{status:429},{statusCode:503},{name:'TimeoutError'}]){
    assert.equal(isRetryableInfrastructureFailure(error),true,JSON.stringify(error));
    assert.equal(decideJobFailure(error,3,3,now).disposition,'RETRYING_WITHOUT_ATTEMPT');
  }
});

test('application/logic failures still consume the bounded retry budget',()=>{
  assert.equal(decideJobFailure(new Error('classifier invariant failed'),1,3,now).disposition,'RETRYING');
  assert.equal(decideJobFailure(new Error('classifier invariant failed'),3,3,now).disposition,'FAILED');
});

test('investigation deadline remains terminal and cannot loop forever',()=>{
  assert.equal(decideJobFailure({code:'INVESTIGATION_DEADLINE_EXCEEDED'},1,5,now).disposition,'FAILED');
});
""")
