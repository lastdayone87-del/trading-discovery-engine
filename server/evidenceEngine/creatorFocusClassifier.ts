import {createHash} from 'node:crypto';
import {getAppSetting,getDb} from '../db';
import {classifyEvidenceDocuments} from './documentSemanticProvider';
import {aggregateCreatorFocus} from './creatorFocusAggregation';
import {evaluateCreatorFocusV4} from './classifierV4';
import type {EvidenceAssertionObservation,EvidenceCoverageSnapshot,EvidenceDocumentObservation} from './documentTypes';
import {recordCreatorFocusAdvisory} from '../release5/creatorFocusAdvisory';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function assignCreatorFocusCanary(subject:string,basisPoints:number){if(!subject||basisPoints<0||basisPoints>10000)throw new Error('INVALID_CANARY_ASSIGNMENT');const randomizationValue=parseInt(hash(subject).slice(0,8),16)%10000;return {randomizationValue,assigned:randomizationValue<basisPoints};}

/** Runs only over the persisted Phase-3 plane and never changes the production decision. */
export async function runCreatorFocusShadow(input:{channelId:string;subjectEntityId:string;diagnosticId:string;productionStatus:string;documents:EvidenceDocumentObservation[];assertions:EvidenceAssertionObservation[];coverage:EvidenceCoverageSnapshot;coverageSnapshotId?:string;calibrationArtifactId?:string;calibrationApproved?:boolean;forceShadowObservation?:boolean}){
  const configured=String(await getAppSetting('creator_focus_classifier_mode','OFF')).toUpperCase();
  if(configured==='OFF'&&!input.forceShadowObservation)return {enabled:false,servingAuthority:false};
  // A forced observation is always SHADOW, even if the production rollout setting
  // is OFF or CANARY. This is evaluation lineage only and can never assign serving authority.
  const mode:'SHADOW'|'CANARY'=input.forceShadowObservation?'SHADOW':configured==='CANARY'?'CANARY':'SHADOW',basis=input.forceShadowObservation?0:Math.min(10000,Math.max(0,Number(await getAppSetting('creator_focus_classifier_canary_basis_points','0'))||0));
  const assignment=assignCreatorFocusCanary(`${input.channelId}|${input.diagnosticId}|creator-focus-v4`,basis);
  const documentAssertions=classifyEvidenceDocuments(input.documents,input.assertions),aggregate=aggregateCreatorFocus(documentAssertions,input.coverage.observedAt);
  const decision=evaluateCreatorFocusV4({channelId:input.channelId,identityResolved:!!input.subjectEntityId,coverage:input.coverage,aggregate,calibrationApproved:!!input.calibrationApproved});
  const snapshotKey=hash({diagnosticId:input.diagnosticId,classifierVersion:decision.classifierVersion,policyVersion:decision.policyVersion});
  const db=await getDb();
  const inserted=await db.query(`INSERT INTO creator_focus_classification_snapshots(snapshot_key,channel_id,subject_entity_id,classification_diagnostic_id,evidence_coverage_snapshot_id,input_checksum,document_keys,assertion_keys,document_assertions,creator_focus_distribution,stage_report,proposed_status,effective_status,probability,lower_confidence_bound,admission_recommendation,reason_codes,classifier_version,policy_version,calibration_artifact_id,mode,assignment_basis_points,randomization_value,assigned,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'UNCERTAIN',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) ON CONFLICT(snapshot_key) DO NOTHING RETURNING id`,[snapshotKey,input.channelId,input.subjectEntityId,input.diagnosticId,input.coverageSnapshotId||null,input.coverage.inputChecksum,JSON.stringify(input.documents.map(d=>d.documentKey).sort()),JSON.stringify(input.assertions.map(a=>a.assertionKey).sort()),JSON.stringify(documentAssertions),JSON.stringify(aggregate.distribution),JSON.stringify({stages:decision.stages}),decision.proposedStatus,decision.probability,decision.lowerConfidenceBound,JSON.stringify(decision.admissionRecommendation),JSON.stringify(decision.reasonCodes),decision.classifierVersion,decision.policyVersion,input.calibrationArtifactId||null,mode,basis,assignment.randomizationValue,mode==='CANARY'&&assignment.assigned,input.coverage.observedAt]);
  const snapshotId=inserted.rows[0]?.id||(await db.query('SELECT id FROM creator_focus_classification_snapshots WHERE snapshot_key=$1',[snapshotKey])).rows[0].id;
  const advisory=await recordCreatorFocusAdvisory({channelId:input.channelId,diagnosticId:input.diagnosticId,snapshotId,productionStatus:input.productionStatus,creatorFocusStatus:decision.proposedStatus}).catch(error=>({enabled:false,assigned:false,servingAuthority:false,error:error instanceof Error?error.message:String(error)}));
  return {enabled:true,snapshotId:String(snapshotId),snapshotKey,decision,advisory,assigned:mode==='CANARY'&&assignment.assigned,servingAuthority:false,terminalAuthority:false,coverageSnapshotId:input.coverageSnapshotId||null};
}

export async function inspectCreatorFocusShadow(limit=100){const db=await getDb();const rows=await db.query('SELECT * FROM creator_focus_classification_snapshots ORDER BY observed_at DESC,id LIMIT $1',[Math.min(500,Math.max(1,limit))]);return {automaticTerminalAuthority:false,rows:rows.rows};}