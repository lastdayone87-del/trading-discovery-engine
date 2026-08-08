import { getDb } from './db';
import { REPLAY_FEATURE_VERSION, REPLAY_POLICY_VERSION } from './replayMeasurement';
import { recordAdaptiveShadowLabel } from './adaptiveTradingClassifier';
import { recordEvaluationGroundTruth, type CreatorType } from './decisionEvaluation';
import { recordFalseNegativeIncident } from './governedAdaptation';
import {recordAdmissionShadow} from './candidateAdmission/shadowEvaluator';
import {resolveReviewReason, type ReviewReasonAction} from './reviewReasons';

export type ReviewState = 'NOT_REQUIRED'|'PENDING'|'APPROVED'|'REJECTED'|'SUPERSEDED';
export type ReviewAction = 'APPROVE'|'REJECT'|'FORCE_RESCAN';
export class ReviewConflictError extends Error { status = 409; }
export class ReviewNotFoundError extends Error { status = 404; }
export function resolveReviewTransition(state:ReviewState,action:ReviewAction):ReviewState {
  if(action==='FORCE_RESCAN') { if(state!=='REJECTED') throw new ReviewConflictError('Force rescan is only permitted for a rejected review.'); return 'PENDING'; }
  if(state!=='PENDING') throw new ReviewConflictError(`Review is already ${state}.`);
  return action==='APPROVE'?'APPROVED':'REJECTED';
}

const map = (r:any) => ({
  channelId:r.channel_id, channelName:r.channel_name, youtubeUrl:r.youtube_url, country:r.country,
  state:r.state as ReviewState, reviewVersion:r.review_version, evidenceSnapshot:r.evidence_snapshot,
  pendingSince:r.pending_since, decidedAt:r.decided_at, tradingStatus:r.trading_status,
  scanStatus:r.scan_status, qualityScore:r.quality_score, discordStatus:r.discord_status
});

export async function listReviewQueue(filters:{country?:string;search?:string;limit?:number;offset?:number}={}) {
  const db=await getDb(); const limit=Math.min(100,Math.max(1,filters.limit||50)); const offset=Math.max(0,filters.offset||0);
  const r=await db.query(`SELECT r.*,c.channel_name,c.youtube_url,c.country,c.trading_status,c.scan_status,c.quality_score,c.discord_status
    FROM channel_reviews r JOIN channels c USING(channel_id) WHERE r.state='PENDING'
      AND ($1::text IS NULL OR c.country=$1) AND ($2::text IS NULL OR c.channel_name ILIKE '%'||$2||'%' OR c.channel_id ILIKE '%'||$2||'%')
    ORDER BY r.pending_since ASC,r.channel_id LIMIT $3 OFFSET $4`,[filters.country||null,filters.search||null,limit,offset]);
  return r.rows.map(map);
}

export async function getReviewDetails(channelId:string) {
  const db=await getDb(); const [item,history]=await Promise.all([
    db.query(`SELECT r.*,c.channel_name,c.youtube_url,c.country,c.trading_status,c.scan_status,c.quality_score,c.discord_status FROM channel_reviews r JOIN channels c USING(channel_id) WHERE r.channel_id=$1`,[channelId]),
    db.query(`SELECT id,decision,previous_status,resulting_status,reviewer,decided_at,reason,reason_code,reason_catalog_version,reason_other_text,notes,review_version,evidence_snapshot,idempotency_key FROM channel_review_decisions WHERE channel_id=$1 ORDER BY review_version DESC`,[channelId])
  ]); if(!item.rowCount) throw new ReviewNotFoundError('Review item not found.');
  return {...map(item.rows[0]),history:history.rows};
}

export interface DecideInput { channelId:string; action:ReviewAction; expectedVersion:number; reviewer:string; reason?:string; reviewReasonCode?:string; reviewReasonVersion?:string; reviewReasonOther?:string; notes?:string; idempotencyKey:string; creatorType?:CreatorType; reasonCodes?:string[]; }
export async function decideReview(input:DecideInput) {
  if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<1) throw new Error('reviewVersion must be a positive integer.');
  if(!input.reviewer.trim()||!input.idempotencyKey.trim()) throw new Error('reviewer and idempotencyKey are required.');
  const structured=input.action==='FORCE_RESCAN'?null:resolveReviewReason(input.action as ReviewReasonAction,String(input.reviewReasonCode||''),String(input.reviewReasonVersion||''),input.reviewReasonOther);
  const reason=structured?.display||input.reason?.trim();if(!reason)throw new Error('reason is required.');
  const db=await getDb(); const client=await db.connect();
  try {
    await client.query('BEGIN');
    const prior=await client.query(`SELECT d.*,r.state,r.review_version current_review_version,c.trading_status,c.scan_status,c.discord_status
      FROM channel_review_decisions d JOIN channel_reviews r USING(channel_id) JOIN channels c USING(channel_id)
      WHERE d.idempotency_key=$1`,[input.idempotencyKey]);
    if(prior.rowCount){const saved=prior.rows[0];await client.query('COMMIT');return {decision:saved,review:{state:saved.state,reviewVersion:saved.current_review_version},channel:{channelId:saved.channel_id,tradingStatus:saved.trading_status,scanStatus:saved.scan_status,discordStatus:saved.discord_status},queuePending:saved.state==='PENDING',idempotent:true};}
    const locked=await client.query(`SELECT r.*,to_jsonb(c) channel_snapshot FROM channel_reviews r JOIN channels c USING(channel_id) WHERE r.channel_id=$1 FOR UPDATE OF r,c`,[input.channelId]);
    if(!locked.rowCount) throw new ReviewNotFoundError('Review item not found.');
    const row=locked.rows[0];
    if(row.review_version!==input.expectedVersion) throw new ReviewConflictError(`Review version is ${row.review_version}; received ${input.expectedVersion}.`);
    const resulting=resolveReviewTransition(row.state,input.action);
    const nextVersion=row.review_version+1;
    const evidence={...row.evidence_snapshot,decision_channel:row.channel_snapshot,decided_at:new Date().toISOString(),review_reason:structured};
    if(input.action==='APPROVE') {
      await client.query(`UPDATE channels SET trading_status='TRADING_CONFIRMED',scan_status='ENRICHMENT_PENDING',updated_at=now() WHERE channel_id=$1`,[input.channelId]);
      await client.query(`INSERT INTO jobs(type,payload,priority,max_attempts,idempotency_key) VALUES('POST_APPROVAL_ENRICH',$1,1000,4,$2) ON CONFLICT(idempotency_key) DO NOTHING`,[JSON.stringify({channelId:input.channelId,reviewVersion:nextVersion}),`post-approval:${input.channelId}:${nextVersion}`]);
    } else if(input.action==='REJECT') {
      await client.query(`UPDATE channels SET trading_status='HUMAN_REJECTED',scan_status='SKIPPED_NON_TRADING',discord_status='NON_TRADING',updated_at=now() WHERE channel_id=$1`,[input.channelId]);
      await client.query(`UPDATE jobs SET status='FAILED',last_error='Cancelled by human rejection',locked_by=NULL,locked_at=NULL,updated_at=now() WHERE status IN ('PENDING','PROCESSING') AND payload->>'channelId'=$1`,[input.channelId]);
    } else {
      await client.query(`SET LOCAL app.force_review_rescan='on'`);
      await client.query(`UPDATE channel_reviews SET state='SUPERSEDED',updated_at=now() WHERE channel_id=$1`,[input.channelId]);
      await client.query(`UPDATE channels SET trading_status='UNCERTAIN',scan_status='ENRICHMENT_PENDING',discord_status='UNCERTAIN',updated_at=now() WHERE channel_id=$1`,[input.channelId]);
      await client.query(`INSERT INTO jobs(type,payload,priority,max_attempts,idempotency_key) VALUES('FORCE_REVIEW_RESCAN',$1,1000,4,$2) ON CONFLICT(idempotency_key) DO NOTHING`,[JSON.stringify({channelId:input.channelId,reviewVersion:nextVersion}),`force-review-rescan:${input.channelId}:${nextVersion}`]);
    }
    const inserted=await client.query(`INSERT INTO channel_review_decisions(channel_id,decision,previous_status,resulting_status,reviewer,reason,notes,review_version,evidence_snapshot,idempotency_key,reason_code,reason_catalog_version,reason_other_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[input.channelId,input.action,row.state,resulting,input.reviewer.trim(),reason,input.notes?.trim()||null,nextVersion,JSON.stringify(evidence),input.idempotencyKey,structured?.code||'LEGACY_FREE_TEXT',structured?.version||'legacy',structured?.otherText||null]);
    const lineage=await client.query(`SELECT s.query_run_id,s.query_id,r.job_id,r.country,r.retrieval_lane FROM channel_sightings s JOIN query_runs r ON r.id=s.query_run_id WHERE s.channel_id=$1 ORDER BY s.observed_at DESC LIMIT 1`,[input.channelId]);
    const origin=lineage.rows[0];
    await client.query(`INSERT INTO outcome_events(event_key,subject_type,subject_id,event_type,event_version,source_event_key,query_id,query_run_id,job_id,country,retrieval_lane,verification_status,policy_version,feature_version,event_time,payload) VALUES($1,'CHANNEL',$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13) ON CONFLICT(event_key) DO NOTHING`,[`review:${input.channelId}:version:${nextVersion}:v1`,input.channelId,input.action==='FORCE_RESCAN'?'REVIEW_CORRECTED':'REVIEW_VERIFIED',origin?`query-run:${origin.query_run_id}:selected:v1`:null,origin?.query_id||null,origin?.query_run_id||null,origin?.job_id||null,origin?.country||row.channel_snapshot?.country||null,origin?.retrieval_lane||null,input.action==='FORCE_RESCAN'?'CORRECTIVE':'VERIFIED',REPLAY_POLICY_VERSION,REPLAY_FEATURE_VERSION,JSON.stringify({action:input.action,previousStatus:row.state,resultingStatus:resulting,reviewVersion:nextVersion,reasonCode:structured?.code||'LEGACY_FREE_TEXT'})]);
    const updatedReview=await client.query(`UPDATE channel_reviews SET state=$2,review_version=$3,evidence_snapshot=$4,decided_at=CASE WHEN $2='PENDING' THEN NULL ELSE now() END,pending_since=CASE WHEN $2='PENDING' THEN now() ELSE pending_since END,updated_at=now() WHERE channel_id=$1 RETURNING state,review_version`,[input.channelId,resulting,nextVersion,JSON.stringify(evidence)]);
    const updatedChannel=await client.query(`SELECT channel_id,trading_status,scan_status,discord_status FROM channels WHERE channel_id=$1`,[input.channelId]);
    if(updatedReview.rowCount!==1||updatedChannel.rowCount!==1)throw new Error('Review decision persistence verification failed.');
    await client.query('COMMIT');
    // Labels are observational: schedule only after the authoritative review
    // commits, never await them, and contain all failures at this boundary.
    if(input.action==='APPROVE'||input.action==='REJECT')void recordAdaptiveShadowLabel(input.channelId,inserted.rows[0].id,input.action==='APPROVE'?'TRADING_CONFIRMED':'NON_TRADING')
      .catch(error=>console.warn(`[AdaptiveClassifier] Shadow label failed for ${input.channelId}:`,error instanceof Error?error.message:error));
    if(input.action==='APPROVE'||input.action==='REJECT')void recordEvaluationGroundTruth({channelId:input.channelId,reviewDecisionId:inserted.rows[0].id,label:input.action==='APPROVE'?'TRADING_CONFIRMED':'NON_TRADING',provenance:'HUMAN_REVIEW',evidenceSnapshot:evidence,creatorType:input.creatorType,reasonCodes:input.reasonCodes})
      .catch(error=>console.warn(`[DecisionEvaluation] Ground-truth label failed for ${input.channelId}:`,error instanceof Error?error.message:error));
    if(input.action==='APPROVE'&&row.channel_snapshot?.trading_status!=='TRADING_CONFIRMED')void recordFalseNegativeIncident({channelId:input.channelId,reviewDecisionId:inserted.rows[0].id,priorStatus:row.channel_snapshot?.trading_status||'UNKNOWN',evidenceSnapshot:evidence})
      .catch(error=>console.warn(`[CorrectiveLearning] False-negative diagnosis failed for ${input.channelId}:`,error instanceof Error?error.message:error));
    if(input.action!=='FORCE_RESCAN')void recordAdmissionShadow({channelId:input.channelId,priorState:'NOT_EVALUATED',classificationStatus:input.action==='APPROVE'?'TRADING_CONFIRMED':'HUMAN_REJECTED',investigationState:'COMPLETED',reviewId:inserted.rows[0].id,candidateHypothesis:{humanDecision:input.action},evidenceCoverage:{reviewVersion:nextVersion}})
      .catch(error=>console.warn(`[CandidateAdmission] review shadow write failed for ${input.channelId}:`,error instanceof Error?error.message:error));
    const channel=updatedChannel.rows[0];
    return {decision:inserted.rows[0],review:{state:updatedReview.rows[0].state,reviewVersion:updatedReview.rows[0].review_version},channel:{channelId:channel.channel_id,tradingStatus:channel.trading_status,scanStatus:channel.scan_status,discordStatus:channel.discord_status},queuePending:updatedReview.rows[0].state==='PENDING',idempotent:false};
  } catch(e){await client.query('ROLLBACK'); throw e;} finally {client.release();}
}
