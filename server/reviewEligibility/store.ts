import {getAppSetting,getDb} from '../db';
import {materializeEligibleReviewInTransaction} from '../release5/reviewMaterializer';
import {admissionChecksum} from '../candidateAdmission/versioning';
import {assignAdmissionCanary} from '../candidateAdmission/policy';
import {evaluateReviewEligibilityV2,REVIEW_ELIGIBILITY_POLICY_VERSION,type ReviewEligibilityInput} from './policy';

async function reconcileMachineOwnedReview(client:any,channelId:string){
  await client.query(`UPDATE channel_reviews SET state='SUPERSEDED',pending_since=NULL,updated_at=now() WHERE channel_id=$1 AND state='PENDING'`,[channelId]);
  await client.query(`UPDATE channels SET trading_status=CASE WHEN trading_status='NEEDS_REVIEW' THEN 'UNCERTAIN' ELSE trading_status END,scan_status=CASE WHEN scan_status='NEEDS_REVIEW' THEN 'COMPLETED' ELSE scan_status END,last_checked=now() WHERE channel_id=$1`,[channelId]);
}

export async function recordReviewEligibilityShadow(input:ReviewEligibilityInput&{channelId:string;classificationDiagnosticId?:string;investigationId?:string;creatorFocusSnapshotId?:string}){
  const evaluation=evaluateReviewEligibilityV2(input),configured=String(await getAppSetting('review_eligibility_v2_mode','OFF')).toUpperCase(),mode:'SHADOW'|'CANARY'=configured==='CANARY'?'CANARY':'SHADOW',basis=Math.min(10000,Math.max(0,Number(await getAppSetting('review_eligibility_v2_canary_basis_points','0'))||0)),assignment=assignAdmissionCanary(`${input.channelId}|${input.classificationDiagnosticId||input.investigationId||'none'}|${REVIEW_ELIGIBILITY_POLICY_VERSION}`,basis),snapshot={...input,configuredMode:configured,mode,basis,randomizationValue:assignment.randomizationValue,reasonFamily:evaluation.reasonFamily},checksum=admissionChecksum(snapshot),key=admissionChecksum({checksum,evaluation}),db=await getDb(),client=await db.connect();
  let decisionId:string|undefined;
  try{
    await client.query('BEGIN');
    const prior=await client.query('SELECT version,decision_id,status FROM review_eligibility_projection WHERE channel_id=$1 FOR UPDATE',[input.channelId]),version=Number(prior.rows[0]?.version||0);
    const decision=await client.query(`INSERT INTO review_eligibility_decisions(decision_key,channel_id,classification_diagnostic_id,investigation_id,creator_focus_snapshot_id,status,reason_codes,input_snapshot,input_checksum,policy_version,mode,assignment_basis_points,randomization_value,assigned,serving_authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true) ON CONFLICT(decision_key) DO NOTHING RETURNING id,decided_at`,[key,input.channelId,input.classificationDiagnosticId||null,input.investigationId||null,input.creatorFocusSnapshotId||null,evaluation.status,JSON.stringify(evaluation.reasonCodes),JSON.stringify(snapshot),checksum,REVIEW_ELIGIBILITY_POLICY_VERSION,mode,basis,assignment.randomizationValue,configured==='CANARY'&&assignment.assigned]);
    if(!decision.rowCount){
      const existing=await client.query('SELECT id FROM review_eligibility_decisions WHERE decision_key=$1',[key]);
      decisionId=existing.rows[0]?.id;
      const isCurrent=!!decisionId&&prior.rows[0]?.decision_id===decisionId;
      if(isCurrent&&evaluation.status==='ELIGIBLE')await materializeEligibleReviewInTransaction(client,{channelId:input.channelId,eligibilityDecisionId:decisionId!});
      else if(isCurrent)await reconcileMachineOwnedReview(client,input.channelId);
      await client.query('COMMIT');
      return {...evaluation,mode,configuredMode:configured,recorded:false,idempotent:true,decisionId};
    }
    decisionId=decision.rows[0].id;
    await client.query(`INSERT INTO review_eligibility_events(event_key,channel_id,decision_id,expected_projection_version,payload,policy_version) VALUES($1,$2,$3,$4,$5,$6)`,[admissionChecksum({key,event:'ELIGIBILITY_EVALUATED'}),input.channelId,decisionId,version,JSON.stringify({status:evaluation.status,reasonCodes:evaluation.reasonCodes,reasonFamily:evaluation.reasonFamily,evidenceChecksum:checksum}),REVIEW_ELIGIBILITY_POLICY_VERSION]);
    await client.query(`INSERT INTO review_eligibility_projection(channel_id,status,version,decision_id,reason_codes,evidence_checksum,policy_version,decided_at) VALUES($1,$2,1,$3,$4,$5,$6,$7) ON CONFLICT(channel_id) DO UPDATE SET status=excluded.status,version=review_eligibility_projection.version+1,decision_id=excluded.decision_id,reason_codes=excluded.reason_codes,evidence_checksum=excluded.evidence_checksum,policy_version=excluded.policy_version,decided_at=excluded.decided_at,updated_at=now()`,[input.channelId,evaluation.status,decisionId,JSON.stringify(evaluation.reasonCodes),checksum,REVIEW_ELIGIBILITY_POLICY_VERSION,decision.rows[0].decided_at]);
    if(evaluation.status==='ELIGIBLE')await materializeEligibleReviewInTransaction(client,{channelId:input.channelId,eligibilityDecisionId:decisionId!});
    else await reconcileMachineOwnedReview(client,input.channelId);
    await client.query('COMMIT');
    return {...evaluation,mode,configuredMode:configured,recorded:true,decisionId};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function inspectReviewEligibility(limit=100){const db=await getDb();const rows=await db.query(`SELECT p.*,c.channel_name,c.country,c.trading_status,c.scan_status FROM review_eligibility_projection p JOIN channels c USING(channel_id) ORDER BY p.updated_at DESC LIMIT $1`,[Math.min(500,Math.max(1,limit))]);return {mode:await getAppSetting('review_eligibility_v2_mode','OFF'),servingAuthority:true,createsReviewRows:true,items:rows.rows};}
