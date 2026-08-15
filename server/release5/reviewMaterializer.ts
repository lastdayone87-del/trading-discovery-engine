import {getDb} from '../db';
import {recordDashboardCorpusShadow} from '../dashboardCorpus/store';
import {REVIEW_ELIGIBILITY_POLICY_VERSION} from '../reviewEligibility/policy';

type QueryClient={query:(text:string,values?:unknown[])=>Promise<any>};

export async function materializeEligibleReviewInTransaction(client:QueryClient,input:{channelId:string;eligibilityDecisionId:string}){
  const projection=await client.query(`SELECT * FROM review_eligibility_projection WHERE channel_id=$1 FOR UPDATE`,[input.channelId]);
  if(!projection.rowCount||projection.rows[0].decision_id!==input.eligibilityDecisionId||projection.rows[0].status!=='ELIGIBLE')return {materialized:false,reason:'STALE_OR_NON_ELIGIBLE_PROJECTION'};
  const eligibility=await client.query(`SELECT * FROM review_eligibility_decisions WHERE id=$1 AND channel_id=$2 FOR SHARE`,[input.eligibilityDecisionId,input.channelId]);
  if(!eligibility.rowCount||eligibility.rows[0].status!=='ELIGIBLE'||eligibility.rows[0].policy_version!==REVIEW_ELIGIBILITY_POLICY_VERSION||eligibility.rows[0].serving_authority!==true)throw new Error('ELIGIBLE_SERVING_DECISION_REQUIRED');
  const channel=await client.query('SELECT * FROM channels WHERE channel_id=$1 FOR UPDATE',[input.channelId]);
  if(!channel.rowCount)throw new Error('CHANNEL_NOT_FOUND');
  const existing=await client.query('SELECT * FROM channel_reviews WHERE channel_id=$1 FOR UPDATE',[input.channelId]);
  const prior=existing.rows[0];
  const priorDecisionId=prior?.evidence_snapshot?.eligibilityDecisionId;
  if(prior?.state==='PENDING'&&priorDecisionId===input.eligibilityDecisionId){
    await client.query(`UPDATE channels SET trading_status='NEEDS_REVIEW',scan_status='NEEDS_REVIEW',last_checked=now() WHERE channel_id=$1 AND trading_status='UNCERTAIN'`,[input.channelId]);
    return {materialized:false,reason:'CURRENT_PENDING_REVIEW_PRESERVED',state:'PENDING',reviewVersion:Number(prior.review_version)};
  }
  const snapshot={source:'review-eligibility-v2-serving',eligibilityDecisionId:input.eligibilityDecisionId,eligibilityInputChecksum:eligibility.rows[0].input_checksum,eligibilityReasonCodes:eligibility.rows[0].reason_codes,channel:{channel_id:channel.rows[0].channel_id,channel_name:channel.rows[0].channel_name,country:channel.rows[0].country,trading_status:channel.rows[0].trading_status,scan_status:channel.rows[0].scan_status},capturedAt:new Date().toISOString()};
  const nextVersion=prior?Number(prior.review_version)+1:1;
  await client.query(`INSERT INTO channel_reviews(channel_id,state,review_version,evidence_snapshot,pending_since,decided_at,updated_at) VALUES($1,'PENDING',$2,$3,now(),NULL,now()) ON CONFLICT(channel_id) DO UPDATE SET state='PENDING',review_version=$2,evidence_snapshot=$3,pending_since=now(),decided_at=NULL,updated_at=now()`,[input.channelId,nextVersion,JSON.stringify(snapshot)]);
  await client.query(`UPDATE channels SET trading_status='NEEDS_REVIEW',scan_status='NEEDS_REVIEW',last_checked=now() WHERE channel_id=$1 AND trading_status='UNCERTAIN'`,[input.channelId]);
  return {materialized:true,reviewVersion:nextVersion};
}

export async function materializeEligibleReview(input:{channelId:string;eligibilityDecisionId:string}){
  const db=await getDb(),client=await db.connect();
  try{
    await client.query('BEGIN');
    const result=await materializeEligibleReviewInTransaction(client,input);
    await client.query('COMMIT');
    if(result.materialized||result.reason==='CURRENT_PENDING_REVIEW_PRESERVED')await recordDashboardCorpusShadow({channelId:input.channelId,admissionState:'ADMITTED_REVIEW'}).catch(error=>console.warn(`[ReviewEligibility] review corpus observation failed for ${input.channelId}:`,error instanceof Error?error.message:error));
    return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
