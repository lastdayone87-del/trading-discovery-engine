import {getDb} from '../db';
import {admissionChecksum} from '../candidateAdmission/versioning';
import {assignRelease5Serving,RELEASE5_ROLLOUT_POLICY_VERSION} from './rollout';

export function deriveCreatorFocusAdvisory(productionStatus:string,creatorFocusStatus:string){const disagrees=productionStatus!==creatorFocusStatus;return {disagrees,investigationPriorityDelta:disagrees?10:0,reviewPriorityDelta:disagrees?10:0,reasonCodes:disagrees?['CREATOR_FOCUS_PRODUCTION_DISAGREEMENT','CANARY_PRIORITY_ELEVATED']:['CREATOR_FOCUS_PRODUCTION_AGREEMENT']};}

/** Canary-only prioritization advice. It cannot mutate a classification or serving projection. */
export async function recordCreatorFocusAdvisory(input:{channelId:string;diagnosticId:string;snapshotId:string;productionStatus:string;creatorFocusStatus:string}){
 const assignment=await assignRelease5Serving('CREATOR_FOCUS_ADVISORY',input.channelId);
 if(!assignment.assigned||assignment.mode!=='CANARY'||!assignment.activationId)return {enabled:false,assigned:false,servingAuthority:false,terminalAuthority:false};
 const {disagrees,reasonCodes,investigationPriorityDelta,reviewPriorityDelta}=deriveCreatorFocusAdvisory(input.productionStatus,input.creatorFocusStatus),eventKey=admissionChecksum({...input,activationId:assignment.activationId,policyVersion:RELEASE5_ROLLOUT_POLICY_VERSION});
 const db=await getDb();await db.query(`INSERT INTO creator_focus_advisory_events(event_key,channel_id,classification_diagnostic_id,creator_focus_snapshot_id,activation_id,production_status,creator_focus_status,disagrees,investigation_priority_delta,review_priority_delta,reason_codes,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(event_key) DO NOTHING`,[eventKey,input.channelId,input.diagnosticId,input.snapshotId,assignment.activationId,input.productionStatus,input.creatorFocusStatus,disagrees,investigationPriorityDelta,reviewPriorityDelta,JSON.stringify(reasonCodes),RELEASE5_ROLLOUT_POLICY_VERSION]);
 return {enabled:true,assigned:true,disagrees,investigationPriorityDelta,reviewPriorityDelta,reasonCodes,activationId:assignment.activationId,servingAuthority:false,terminalAuthority:false};
}
