import {getDb} from './db';
import {persistDecisionBenchmark,sealEvaluationDataset,type DatasetDefinition} from './decisionEvaluation';
import {CREATOR_FOCUS_CLASSIFIER_VERSION,CREATOR_FOCUS_POLICY_VERSION} from './evidenceEngine/classifierV4';

export async function buildPhaseBBenchmarks(input:{definition:DatasetDefinition;actor:string;minimumEffectiveSampleSize?:number}){
 const dataset=await sealEvaluationDataset({definition:input.definition,actor:input.actor}),db=await getDb(),examples=await db.query(`SELECT e.*,s.proposed_status,s.probability,s.classifier_version,s.policy_version FROM decision_evaluation_examples e LEFT JOIN creator_focus_classification_snapshots s ON s.classification_diagnostic_id=e.decision_diagnostic_id WHERE e.dataset_id=$1 AND e.split IN('CALIBRATION','TEST') ORDER BY e.split,e.example_key`,[dataset.id]);
 const missing=examples.rows.filter((row:any)=>!row.classifier_version);if(missing.length)throw new Error(`CREATOR_FOCUS_SNAPSHOT_COVERAGE_GAP:${missing.length}`);
 const baseline=await persistDecisionBenchmark({datasetId:dataset.id,candidateKey:'production-classifier-baseline',candidateVersion:'production-diagnostic-pinned',policyVersion:'production-diagnostic-pinned',minimumEffectiveSampleSize:input.minimumEffectiveSampleSize,actor:input.actor,predictions:examples.rows.map((row:any)=>({exampleKey:row.example_key,predicted:row.production_status,probability:Math.max(0,Math.min(1,Number(row.production_score)/100)),reviewRequired:row.production_status==='UNCERTAIN'}))});
 const creatorFocus=await persistDecisionBenchmark({datasetId:dataset.id,candidateKey:'creator-focus-v4-shadow',candidateVersion:CREATOR_FOCUS_CLASSIFIER_VERSION,policyVersion:CREATOR_FOCUS_POLICY_VERSION,minimumEffectiveSampleSize:input.minimumEffectiveSampleSize,actor:input.actor,predictions:examples.rows.map((row:any)=>({exampleKey:row.example_key,predicted:row.proposed_status,probability:Number(row.probability),reviewRequired:row.proposed_status==='UNCERTAIN'}))});
 return {dataset,baseline,creatorFocus,servingAuthority:false,automaticPromotion:false};
}
