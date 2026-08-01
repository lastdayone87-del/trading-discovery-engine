import {createHash} from 'node:crypto';
import {getDb} from './db';
import type {RawChannelInput,VerificationDecision} from './evidenceEngine';

function normalize(input:RawChannelInput){
  const stable={...input,channel_name:input.channel_name.normalize('NFKC').trim(),description:input.description||'',external_links:[...(input.external_links||[])].sort()};
  return {...stable,input_checksum:createHash('sha256').update(JSON.stringify(stable)).digest('hex')};
}

export async function recordProductionClassification(p:{channelId:string;input:RawChannelInput;decision:VerificationDecision;jobId?:string;queryRunId?:string;catalogVersions?:string[]}):Promise<string|undefined>{
  const db=await getDb();
  const inserted=await db.query(`INSERT INTO production_classification_diagnostics(channel_id,job_id,query_run_id,enrichment_stage,normalized_input,provider_execution,evidence_items,staged_report,decision,policy_versions,catalog_versions)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[p.channelId,p.jobId||null,p.queryRunId||null,p.input.enrichment_stage||0,JSON.stringify(normalize(p.input)),JSON.stringify(p.decision.evidenceCollection.providers),JSON.stringify([...p.decision.positiveEvidence,...p.decision.negativeEvidence]),JSON.stringify(p.decision.stagedClassification||{}),JSON.stringify({status:p.decision.status,confidenceScore:p.decision.confidenceScore,category:p.decision.category,positiveWeight:p.decision.totalPositiveWeight,negativeWeight:p.decision.totalNegativeWeight,justification:p.decision.mathematicalJustification}),JSON.stringify(p.decision.versions),JSON.stringify(p.catalogVersions||[])]);return inserted.rows[0]?.id;
}
