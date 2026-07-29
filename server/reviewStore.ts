import { getDb } from './db';

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
    db.query(`SELECT id,decision,previous_status,resulting_status,reviewer,decided_at,reason,notes,review_version,evidence_snapshot,idempotency_key FROM channel_review_decisions WHERE channel_id=$1 ORDER BY review_version DESC`,[channelId])
  ]); if(!item.rowCount) throw new ReviewNotFoundError('Review item not found.');
  return {...map(item.rows[0]),history:history.rows};
}

export interface DecideInput { channelId:string; action:ReviewAction; expectedVersion:number; reviewer:string; reason:string; notes?:string; idempotencyKey:string; }
export async function decideReview(input:DecideInput) {
  if(!input.reviewer.trim()||!input.reason.trim()||!input.idempotencyKey.trim()) throw new Error('reviewer, reason, and idempotencyKey are required.');
  const db=await getDb(); const client=await db.connect();
  try {
    await client.query('BEGIN');
    const prior=await client.query('SELECT * FROM channel_review_decisions WHERE idempotency_key=$1',[input.idempotencyKey]);
    if(prior.rowCount){ await client.query('COMMIT'); return {decision:prior.rows[0],idempotent:true}; }
    const locked=await client.query(`SELECT r.*,to_jsonb(c) channel_snapshot FROM channel_reviews r JOIN channels c USING(channel_id) WHERE r.channel_id=$1 FOR UPDATE OF r,c`,[input.channelId]);
    if(!locked.rowCount) throw new ReviewNotFoundError('Review item not found.');
    const row=locked.rows[0];
    if(row.review_version!==input.expectedVersion) throw new ReviewConflictError(`Review version is ${row.review_version}; received ${input.expectedVersion}.`);
    const resulting=resolveReviewTransition(row.state,input.action);
    const nextVersion=row.review_version+1;
    const evidence={...row.evidence_snapshot,decision_channel:row.channel_snapshot,decided_at:new Date().toISOString()};
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
    const inserted=await client.query(`INSERT INTO channel_review_decisions(channel_id,decision,previous_status,resulting_status,reviewer,reason,notes,review_version,evidence_snapshot,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[input.channelId,input.action,row.state,resulting,input.reviewer.trim(),input.reason.trim(),input.notes?.trim()||null,nextVersion,JSON.stringify(evidence),input.idempotencyKey]);
    await client.query(`UPDATE channel_reviews SET state=$2,review_version=$3,evidence_snapshot=$4,decided_at=CASE WHEN $2='PENDING' THEN NULL ELSE now() END,pending_since=CASE WHEN $2='PENDING' THEN now() ELSE pending_since END,updated_at=now() WHERE channel_id=$1`,[input.channelId,resulting,nextVersion,JSON.stringify(evidence)]);
    await client.query('COMMIT'); return {decision:inserted.rows[0],idempotent:false};
  } catch(e){await client.query('ROLLBACK'); throw e;} finally {client.release();}
}
