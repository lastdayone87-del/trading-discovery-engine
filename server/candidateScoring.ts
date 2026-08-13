import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { appendProviderCallEvent, completeJob, enqueueJob, getDb } from './db';
import { executeProviderCall } from './providerResilience';

export const FEATURE_SET_VERSION='candidate-features-v1';
export const CLASSIFIER_VERSION='bounded-semantic-v1';
export const PROMPT_VERSION='candidate-adjudication-prompt-v1';
export const ASSERTION_SCHEMA_VERSION='candidate-assertion-schema-v1';
export const ASSERTION_LABELS=['TRADING','NON_TRADING','AMBIGUOUS','SPAM','BRAND','PERSON','GENERIC','OTHER'] as const;
export type AssertionLabel=typeof ASSERTION_LABELS[number];
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const generic=new Set(['the','and','for','with','from','this','that','video','channel','official','new','live','today','finance','money','market']);
const trading=/\b(trad(?:e|er|ing)|forex|futures?|options?|stocks?|crypto|bitcoin|price action|order flow|technical analysis|prop firm|invest(?:ing|ment))\b/iu;
const injection=/\b(ignore (?:all |previous )?instructions|system prompt|developer message|jailbreak|respond with)\b/iu;

export interface CandidateEvidence {normalizedSpan:string;literalSpan:string;documentId:string;clusterKey:string;sourceType:string;observedAt:string;language:string;startOffset:number;endOffset:number}
export interface CandidateFeatures {frequency:number;independentClusters:number;sourceDiversity:number;activeDays:number;temporalStability:number;burstScore:number;backgroundLift:number;languageAffinity:Record<string,number>;anomalyScore:number}
export interface ScoreResult {candidateKey:string;features:CandidateFeatures;decision:'REJECTED'|'ACCEPTED'|'AMBIGUOUS';reasonCodes:string[];evidenceChecksum:string;label:AssertionLabel;confidence:number}

export function scoreCandidate(rows:CandidateEvidence[]):ScoreResult {
  if(!rows.length)throw new Error('Candidate evidence is required.');
  const normalized=rows[0].normalizedSpan.normalize('NFKC').toLocaleLowerCase('und').trim();
  if(rows.some(r=>r.normalizedSpan!==rows[0].normalizedSpan))throw new Error('Candidate evidence must share one normalized span.');
  const clusters=new Set(rows.map(r=>r.clusterKey));const sources=new Set(rows.map(r=>r.sourceType));
  const days=new Set(rows.map(r=>r.observedAt.slice(0,10)));const languages=new Map<string,number>();
  for(const row of rows)languages.set(row.language||'und',(languages.get(row.language||'und')||0)+1);
  const languageAffinity=Object.fromEntries([...languages].sort().map(([k,v])=>[k,Number((v/rows.length).toFixed(6))]));
  const maxPerDay=Math.max(...[...days].map(d=>rows.filter(r=>r.observedAt.startsWith(d)).length));
  const burstScore=Number((maxPerDay/rows.length).toFixed(6));const correlated=1-clusters.size/rows.length;
  const backgroundLift=trading.test(normalized)?1:0;const anomalyScore=Number(Math.max(injection.test(normalized)?1:0,correlated).toFixed(6));
  const features:CandidateFeatures={frequency:rows.length,independentClusters:clusters.size,sourceDiversity:sources.size,activeDays:days.size,temporalStability:Number((Math.min(days.size,30)/30).toFixed(6)),burstScore,backgroundLift,languageAffinity,anomalyScore};
  const tokens=normalized.split(/\s+/u);const reasons:string[]=[];let decision:ScoreResult['decision']='AMBIGUOUS',label:AssertionLabel='AMBIGUOUS',confidence=.5;
  if(injection.test(normalized)){decision='REJECTED';label='SPAM';confidence=1;reasons.push('PROMPT_INJECTION_PATTERN');}
  else if(!normalized||normalized.length<3||tokens.every(t=>generic.has(t))){decision='REJECTED';label='GENERIC';confidence=.98;reasons.push('GENERIC_OR_TOO_SHORT');}
  else if(backgroundLift===1&&clusters.size>=2){decision='ACCEPTED';label='TRADING';confidence=.9;reasons.push('DICTIONARY_MATCH','INDEPENDENT_CLUSTER_SUPPORT');}
  else reasons.push(backgroundLift?'INSUFFICIENT_INDEPENDENCE':'SEMANTIC_AMBIGUITY');
  const evidenceChecksum=sha(rows.map(r=>`${r.documentId}|${r.startOffset}|${r.endOffset}|${r.clusterKey}|${r.observedAt}`).sort().join('\n'));
  return {candidateKey:sha(normalized),features,decision,reasonCodes:reasons,evidenceChecksum,label,confidence};
}

export function validateBoundedAssertion(raw:unknown,literal:string):{label:AssertionLabel;confidence:number;abstained:boolean;reasonCodes:string[]} {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('AI_SCHEMA_INVALID');const o=raw as Record<string,unknown>;
  const allowed=new Set(['literalSpan','label','confidence','abstained','reasonCodes']);if(Object.keys(o).some(k=>!allowed.has(k)))throw new Error('AI_SCHEMA_INVALID');
  if(o.literalSpan!==literal)throw new Error('AI_UNSEEN_OR_CHANGED_SPAN');if(!ASSERTION_LABELS.includes(o.label as AssertionLabel))throw new Error('AI_LABEL_UNSUPPORTED');
  if(typeof o.confidence!=='number'||o.confidence<0||o.confidence>1||typeof o.abstained!=='boolean'||!Array.isArray(o.reasonCodes)||o.reasonCodes.some(x=>typeof x!=='string'))throw new Error('AI_SCHEMA_INVALID');
  if(o.abstained&&o.label!=='AMBIGUOUS')throw new Error('AI_ABSTENTION_INVALID');return {label:o.label as AssertionLabel,confidence:o.confidence,abstained:o.abstained,reasonCodes:o.reasonCodes as string[]};
}

export async function enqueueCandidateScoring(documentId:string):Promise<void>{await enqueueJob('SCORE_CANDIDATES',{payloadSchemaVersion:1,documentId,featureSetVersion:FEATURE_SET_VERSION},{priority:4,maxAttempts:3,idempotencyKey:`candidate-score:${documentId}:${FEATURE_SET_VERSION}`});}

export async function processCandidateScoringJob(job:{id:string;payload:any}):Promise<void>{
  const p=job.payload;if(p.payloadSchemaVersion!==1||p.featureSetVersion!==FEATURE_SET_VERSION)throw new Error('Unsupported SCORE_CANDIDATES payload version.');const db=await getDb();
  const control=await db.query('SELECT * FROM candidate_scoring_controls WHERE singleton=true');if(!control.rowCount||control.rows[0].scoring_paused)throw new Error('Candidate scoring is paused.');
  const spent=await db.query(`SELECT count(*)::int n FROM candidate_feature_snapshots WHERE computed_at>=date_trunc('day',now())`);if(spent.rows[0].n>=control.rows[0].daily_scoring_candidates)throw new Error('Candidate scoring daily budget is exhausted.');
  const values=await db.query(`SELECT o.normalized_span,o.literal_span,o.document_id::text,a.entity_cluster_key,a.source_type,a.observed_at,d.language,o.start_offset,o.end_offset FROM corpus_candidate_occurrences o JOIN corpus_documents d ON d.id=o.document_id JOIN corpus_source_artifacts a ON a.id=d.artifact_id WHERE o.normalized_span IN(SELECT normalized_span FROM corpus_candidate_occurrences WHERE document_id=$1) ORDER BY o.normalized_span,a.observed_at,o.occurrence_key`,[p.documentId]);
  const groups=new Map<string,CandidateEvidence[]>();for(const r of values.rows){const row:CandidateEvidence={normalizedSpan:r.normalized_span,literalSpan:r.literal_span,documentId:r.document_id,clusterKey:r.entity_cluster_key,sourceType:r.source_type,observedAt:new Date(r.observed_at).toISOString(),language:r.language,startOffset:r.start_offset,endOffset:r.end_offset};groups.set(row.normalizedSpan,[...(groups.get(row.normalizedSpan)||[]),row]);}
  if(groups.size>Number(control.rows[0].daily_scoring_candidates)-Number(spent.rows[0].n))throw new Error('Candidate scoring job exceeds the remaining daily budget.');
  for(const [normalized,rows] of groups){const result=scoreCandidate(rows);const inserted=await db.query(`INSERT INTO candidate_feature_snapshots(candidate_key,normalized_span,feature_set_version,features,decision,reason_codes,evidence_checksum) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(candidate_key,feature_set_version,evidence_checksum) DO NOTHING RETURNING id`,[result.candidateKey,normalized,FEATURE_SET_VERSION,JSON.stringify(result.features),result.decision,JSON.stringify(result.reasonCodes),result.evidenceChecksum]);if(!inserted.rowCount)continue;
    const snapshotId=inserted.rows[0].id;await db.query(`INSERT INTO classification_assertions(candidate_key,feature_snapshot_id,assertion_source,label,confidence,abstained,reason_codes,literal_span,classifier_version,schema_version,assertion_key) VALUES($1,$2,'DETERMINISTIC',$3,$4,false,$5,$6,$7,$8,$9)`,[result.candidateKey,snapshotId,result.label,result.confidence,JSON.stringify(result.reasonCodes),rows[0].literalSpan,FEATURE_SET_VERSION,ASSERTION_SCHEMA_VERSION,`deterministic:${snapshotId}:${FEATURE_SET_VERSION}`]);
    const flags:Array<{flag:string;severity:number;evidence:Record<string,number>}>=[];if(result.reasonCodes.includes('PROMPT_INJECTION_PATTERN'))flags.push({flag:'PROMPT_INJECTION',severity:1,evidence:{patternMatch:1}});const correlation=1-result.features.independentClusters/result.features.frequency;if(correlation>=.5)flags.push({flag:'CORRELATED_SOURCES',severity:correlation,evidence:{frequency:result.features.frequency,independentClusters:result.features.independentClusters}});if(result.features.frequency>=3&&result.features.burstScore>=.8)flags.push({flag:'TEMPORAL_BURST',severity:result.features.burstScore,evidence:{frequency:result.features.frequency,activeDays:result.features.activeDays}});for(const flag of flags)await db.query(`INSERT INTO candidate_anomaly_flags(candidate_key,feature_snapshot_id,flag,severity,evidence,flag_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(flag_key) DO NOTHING`,[result.candidateKey,snapshotId,flag.flag,flag.severity,JSON.stringify(flag.evidence),`anomaly:${snapshotId}:${flag.flag}`]);
    if(result.decision==='AMBIGUOUS')await enqueueJob('AI_ADJUDICATE_CANDIDATE',{payloadSchemaVersion:1,candidateKey:result.candidateKey,featureSnapshotId:snapshotId,literalSpan:rows[0].literalSpan,classifierVersion:CLASSIFIER_VERSION},{priority:3,maxAttempts:2,idempotencyKey:`candidate-ai:${result.candidateKey}:${CLASSIFIER_VERSION}:${result.evidenceChecksum}`});
  }await completeJob(job.id);
}

export async function processAiAdjudicationJob(job:{id:string;payload:any;attempts?:number}):Promise<void>{
  const p=job.payload;if(p.payloadSchemaVersion!==1||p.classifierVersion!==CLASSIFIER_VERSION)throw new Error('Unsupported AI_ADJUDICATE_CANDIDATE payload version.');const db=await getDb();const c=await db.query('SELECT * FROM candidate_scoring_controls WHERE singleton=true');if(!c.rowCount||c.rows[0].ai_paused)throw new Error('Candidate AI adjudication is paused.');
  const usage=await db.query(`SELECT count(*)::int n,COALESCE(sum(cost_microunits),0)::bigint cost FROM candidate_adjudication_results WHERE completed_at>=date_trunc('day',now())`);const reservedCost=Math.max(0,Number(process.env.CANDIDATE_AI_COST_MICROUNITS||0));if(usage.rows[0].n>=c.rows[0].daily_ai_assertions||Number(usage.rows[0].cost)+reservedCost>Number(c.rows[0].max_ai_cost_microunits))throw new Error('Candidate AI budget is exhausted.');
  const key=process.env.GEMINI_API_KEY;if(!key)throw new Error('GEMINI_API_KEY is not configured.');const ai=new GoogleGenAI({apiKey:key});const prompt=`Classify only the literal source span below. Never rewrite or add a term. Abstain when uncertain. Return exactly JSON keys literalSpan,label,confidence,abstained,reasonCodes. Closed labels: ${ASSERTION_LABELS.join(',')}. literalSpan=${JSON.stringify(p.literalSpan)}`;
  const resultKey=`ai:${p.featureSnapshotId}:${CLASSIFIER_VERSION}:attempt-${job.attempts||1}`;let responseText='';try{const response=await executeProviderCall({context:{provider:'gemini',operation:'candidate-adjudication',jobId:job.id},timeoutMs:Number(process.env.GEMINI_PROVIDER_TIMEOUT_MS||'45000'),enabled:true,emit:appendProviderCallEvent,call:(signal)=>ai.models.generateContent({model:process.env.CANDIDATE_AI_MODEL||'gemini-3.6-flash',contents:prompt,config:{responseMimeType:'application/json',abortSignal:signal}})});responseText=response.text||'';const parsed=validateBoundedAssertion(JSON.parse(responseText),p.literalSpan);const assertionKey=`ai:${p.featureSnapshotId}:${CLASSIFIER_VERSION}`;
    const usageMeta=(response as any).usageMetadata||{};await db.query(`INSERT INTO classification_assertions(candidate_key,feature_snapshot_id,assertion_source,label,confidence,abstained,reason_codes,literal_span,classifier_version,model_version,prompt_version,schema_version,raw_response_hash,assertion_key) VALUES($1,$2,'AI',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(assertion_key) DO NOTHING`,[p.candidateKey,p.featureSnapshotId,parsed.label,parsed.confidence,parsed.abstained,JSON.stringify(parsed.reasonCodes),p.literalSpan,CLASSIFIER_VERSION,process.env.CANDIDATE_AI_MODEL||'gemini-3.6-flash',PROMPT_VERSION,ASSERTION_SCHEMA_VERSION,sha(responseText),assertionKey]);await db.query(`INSERT INTO candidate_adjudication_results(candidate_key,feature_snapshot_id,classifier_version,status,input_tokens,output_tokens,cost_microunits,result_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(result_key) DO NOTHING`,[p.candidateKey,p.featureSnapshotId,CLASSIFIER_VERSION,parsed.abstained?'ABSTAINED':'COMPLETED',Number(usageMeta.promptTokenCount||0),Number(usageMeta.candidatesTokenCount||0),reservedCost,resultKey]);await completeJob(job.id);
  }catch(error){const code=error instanceof Error?error.message:'AI_FAILED';await db.query(`INSERT INTO candidate_adjudication_results(candidate_key,feature_snapshot_id,classifier_version,status,error_code,result_key) VALUES($1,$2,$3,'FAILED_CLOSED',$4,$5) ON CONFLICT(result_key) DO NOTHING`,[p.candidateKey,p.featureSnapshotId,CLASSIFIER_VERSION,code.slice(0,120),resultKey]);throw error;}
}

export async function inspectCandidateAssertions(limit=100):Promise<unknown>{const db=await getDb();const rows=await db.query(`SELECT f.candidate_key,f.normalized_span,f.feature_set_version,f.features,f.decision,f.reason_codes,f.evidence_checksum,f.computed_at,jsonb_agg(jsonb_build_object('source',a.assertion_source,'label',a.label,'confidence',a.confidence,'abstained',a.abstained,'classifierVersion',a.classifier_version,'modelVersion',a.model_version,'createdAt',a.created_at) ORDER BY a.created_at) assertions FROM candidate_feature_snapshots f JOIN classification_assertions a ON a.feature_snapshot_id=f.id GROUP BY f.id ORDER BY f.computed_at DESC LIMIT $1`,[Math.min(500,Math.max(1,limit))]);const costs=await db.query(`SELECT status,count(*)::int count,COALESCE(sum(cost_microunits),0)::bigint cost_microunits FROM candidate_adjudication_results GROUP BY status`);return {mode:'SHADOW',publicationEnabled:false,featureSetVersion:FEATURE_SET_VERSION,classifierVersion:CLASSIFIER_VERSION,items:rows.rows,ai:costs.rows};}