import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { appendProviderCallEvent, completeJob, enqueueJob, getDb, rescheduleJob } from './db';
import { executeProviderCall, resolveGeminiRouteId } from './providerResilience';
import { geminiOrgIdForSlot } from './evidenceEngine/providers/GeminiSemanticProvider';

export const FEATURE_SET_VERSION='candidate-features-v1';
export const CLASSIFIER_VERSION='bounded-semantic-v1';
export const PROMPT_VERSION='candidate-adjudication-prompt-v1';
export const ASSERTION_SCHEMA_VERSION='candidate-assertion-schema-v1';
export const ASSERTION_LABELS=['TRADING','NON_TRADING','AMBIGUOUS','SPAM','BRAND','PERSON','GENERIC','OTHER'] as const;
/**
 * One document can yield hundreds of distinct normalized spans. Processing
 * all of them in one job loads a very large evidence set and can exceed the
 * daily snapshot budget, which strands the job instead of making progress.
 * Bound each run and continue from a durable cursor.
 */
export const SCORING_BATCH_GROUPS=50;
export type AssertionLabel=typeof ASSERTION_LABELS[number];
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const generic=new Set(['the','and','for','with','from','this','that','video','channel','official','new','live','today','finance','money','market']);
const trading=/\b(trad(?:e|er|ing)|forex|futures?|options?|stocks?|crypto|bitcoin|price action|order flow|technical analysis|prop firm|invest(?:ing|ment))\b/iu;
const injection=/\b(ignore (?:all |previous )?instructions|system prompt|developer message|jailbreak|respond with)\b/iu;

export function scoringBatchSize(remaining:number, configured=SCORING_BATCH_GROUPS):number{
  const left=Math.max(0,Math.floor(Number(remaining)||0));
  const bounded=Math.max(1,Math.floor(Number(configured)||SCORING_BATCH_GROUPS));
  return Math.min(left,bounded);
}

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

/**
 * AI adjudication is optional paid work. Do not create durable AI jobs while
 * the control plane says it is paused or has no assertion/cost budget: those
 * jobs can never run and grow the backlog indefinitely. Existing queued jobs
 * are preserved and remain claimable once the control is re-enabled.
 */
export function aiAdjudicationAdmitted(control:{
  ai_paused?: boolean;
  daily_ai_assertions?: number | string | null;
  max_ai_cost_microunits?: number | string | null;
} | null | undefined): boolean {
  if (!control) return false;
  const assertions = Number(control.daily_ai_assertions);
  const cost = Number(control.max_ai_cost_microunits);
  return control.ai_paused !== true
    && Number.isFinite(assertions)
    && assertions > 0
    && Number.isFinite(cost)
    && cost > 0;
}

/**
 * Remaining paid AI capacity for today's scoring pass. The configured caps are
 * not enough: the adjudicator itself counts today's completed results, so an
 * enqueue burst must be bounded by the same remaining assertion/cost headroom.
 */
export function aiAdjudicationCapacity(
  control: {
    ai_paused?: boolean;
    daily_ai_assertions?: number | string | null;
    max_ai_cost_microunits?: number | string | null;
  } | null | undefined,
  todayAssertions: number,
  todayCostMicrounits: number,
  reservedCostMicrounits: number,
  activeQueuedJobs = 0,
): number {
  if (!aiAdjudicationAdmitted(control)) return 0;
  const active = Math.max(0, Math.trunc(activeQueuedJobs) || 0);
  // Existing PENDING/PROCESSING jobs are already ahead of this enqueue burst.
  // Count them against both the assertion and cost headroom so a scoring pass
  // cannot add more work than the adjudicator can still accept today.
  const assertionRemaining = Math.max(0, Number(control!.daily_ai_assertions) - Math.max(0, todayAssertions) - active);
  const costRemaining = Math.max(0, Number(control!.max_ai_cost_microunits) - Math.max(0, todayCostMicrounits));
  const reserved = Math.max(0, reservedCostMicrounits);
  const queuedCost = active * reserved;
  const costSlots = reserved > 0
    ? Math.floor(Math.max(0, costRemaining - queuedCost) / reserved)
    : assertionRemaining;
  return Math.max(0, Math.min(assertionRemaining, costSlots));
}

export async function enqueueCandidateScoring(documentId:string):Promise<void>{await enqueueJob('SCORE_CANDIDATES',{payloadSchemaVersion:1,documentId,featureSetVersion:FEATURE_SET_VERSION},{priority:4,maxAttempts:3,idempotencyKey:`candidate-score:${documentId}:${FEATURE_SET_VERSION}`});}

export async function processCandidateScoringJob(job:{id:string;payload:any}):Promise<void>{
  const p=job.payload;
  if(p.payloadSchemaVersion!==1||p.featureSetVersion!==FEATURE_SET_VERSION)throw new Error('Unsupported SCORE_CANDIDATES payload version.');
  const db=await getDb();
  const control=await db.query('SELECT * FROM candidate_scoring_controls WHERE singleton=true');
  if(!control.rowCount||control.rows[0].scoring_paused){
    // An operator pause is not a candidate failure. Defer without consuming a
    // bounded attempt so the document resumes when scoring is re-enabled.
    await rescheduleJob(job.id,new Date(Date.now()+60*60_000).toISOString(),'SCORING_PAUSED');
    return;
  }
  const spent=await db.query(`SELECT count(*)::int n FROM candidate_feature_snapshots WHERE computed_at>=date_trunc('day',now())`);
  const remaining=Math.max(0,Number(control.rows[0].daily_scoring_candidates)-Number(spent.rows[0].n));
  if(remaining<=0){
    // Keep the document queued for the next database day instead of failing it
    // before any scoring work starts.
    const nextDay=await db.query(`SELECT (date_trunc('day',now())+interval '1 day') AS next_day`);
    const retryAt=nextDay.rows[0]?.next_day?new Date(nextDay.rows[0].next_day):new Date(Date.now()+24*60*60_000);
    await rescheduleJob(job.id,retryAt.toISOString(),'SCORING_DAILY_BUDGET_EXHAUSTED',undefined,p);
    return;
  }
  // Process at most one bounded slice of the document, and never more spans
  // than the remaining daily snapshot budget allows.
  const batchSize=scoringBatchSize(remaining);
  const cursor=typeof p.cursor==='string'&&p.cursor.length?p.cursor:null;
  const spans=await db.query(`SELECT DISTINCT normalized_span FROM corpus_candidate_occurrences WHERE document_id=$1 AND ($2::text IS NULL OR normalized_span>$2) ORDER BY normalized_span LIMIT $3`,[p.documentId,cursor,batchSize]);
  if(!spans.rowCount){await completeJob(job.id);return;}
  const spanList=spans.rows.map((row:any)=>String(row.normalized_span));
  const values=await db.query(`SELECT o.normalized_span,o.literal_span,o.document_id::text,a.entity_cluster_key,a.source_type,a.observed_at,d.language,o.start_offset,o.end_offset FROM corpus_candidate_occurrences o JOIN corpus_documents d ON d.id=o.document_id JOIN corpus_source_artifacts a ON a.id=d.artifact_id WHERE o.normalized_span=ANY($1::text[]) ORDER BY o.normalized_span,a.observed_at,o.occurrence_key`,[spanList]);
  const groups=new Map<string,CandidateEvidence[]>();
  for(const r of values.rows){const row:CandidateEvidence={normalizedSpan:r.normalized_span,literalSpan:r.literal_span,documentId:r.document_id,clusterKey:r.entity_cluster_key,sourceType:r.source_type,observedAt:new Date(r.observed_at).toISOString(),language:r.language,startOffset:r.start_offset,endOffset:r.end_offset};groups.set(row.normalizedSpan,[...(groups.get(row.normalizedSpan)||[]),row]);}
  if(groups.size>remaining)throw new Error('Candidate scoring batch exceeds the remaining daily budget.');
  const aiUsage=await db.query(`SELECT count(*)::int n,COALESCE(sum(cost_microunits),0)::bigint cost FROM candidate_adjudication_results WHERE completed_at>=date_trunc('day',now())`);
  const aiReservedCost=Math.max(0,Number(process.env.CANDIDATE_AI_COST_MICROUNITS||0));
  const aiActive=await db.query(`SELECT count(*)::int n FROM jobs WHERE type='AI_ADJUDICATE_CANDIDATE' AND status IN ('PENDING','PROCESSING')`);
  const aiCapacity=aiAdjudicationCapacity(control.rows[0],Number(aiUsage.rows[0]?.n||0),Number(aiUsage.rows[0]?.cost||0),aiReservedCost,Number(aiActive.rows[0]?.n||0));
  const aiAdmitted=aiCapacity>0;
  let deferredAi=0;
  let aiEnqueued=0;
  for(const [normalized,rows] of groups){const result=scoreCandidate(rows);const inserted=await db.query(`INSERT INTO candidate_feature_snapshots(candidate_key,normalized_span,feature_set_version,features,decision,reason_codes,evidence_checksum) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(candidate_key,feature_set_version,evidence_checksum) DO NOTHING RETURNING id`,[result.candidateKey,normalized,FEATURE_SET_VERSION,JSON.stringify(result.features),result.decision,JSON.stringify(result.reasonCodes),result.evidenceChecksum]);if(!inserted.rowCount)continue;
    const snapshotId=inserted.rows[0].id;await db.query(`INSERT INTO classification_assertions(candidate_key,feature_snapshot_id,assertion_source,label,confidence,abstained,reason_codes,literal_span,classifier_version,schema_version,assertion_key) VALUES($1,$2,'DETERMINISTIC',$3,$4,false,$5,$6,$7,$8,$9)`,[result.candidateKey,snapshotId,result.label,result.confidence,JSON.stringify(result.reasonCodes),rows[0].literalSpan,FEATURE_SET_VERSION,ASSERTION_SCHEMA_VERSION,`deterministic:${snapshotId}:${FEATURE_SET_VERSION}`]);
    const flags:Array<{flag:string;severity:number;evidence:Record<string,number>}>=[];if(result.reasonCodes.includes('PROMPT_INJECTION_PATTERN'))flags.push({flag:'PROMPT_INJECTION',severity:1,evidence:{patternMatch:1}});const correlation=1-result.features.independentClusters/result.features.frequency;if(correlation>=.5)flags.push({flag:'CORRELATED_SOURCES',severity:correlation,evidence:{frequency:result.features.frequency,independentClusters:result.features.independentClusters}});if(result.features.frequency>=3&&result.features.burstScore>=.8)flags.push({flag:'TEMPORAL_BURST',severity:result.features.burstScore,evidence:{frequency:result.features.frequency,activeDays:result.features.activeDays}});for(const flag of flags)await db.query(`INSERT INTO candidate_anomaly_flags(candidate_key,feature_snapshot_id,flag,severity,evidence,flag_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(flag_key) DO NOTHING`,[result.candidateKey,snapshotId,flag.flag,flag.severity,JSON.stringify(flag.evidence),`anomaly:${snapshotId}:${flag.flag}`]);
    if(result.decision==='AMBIGUOUS'){
      if(aiAdmitted&&aiEnqueued<aiCapacity){
        await enqueueJob('AI_ADJUDICATE_CANDIDATE',{payloadSchemaVersion:1,candidateKey:result.candidateKey,featureSnapshotId:snapshotId,literalSpan:rows[0].literalSpan,classifierVersion:CLASSIFIER_VERSION},{priority:3,maxAttempts:2,idempotencyKey:`candidate-ai:${result.candidateKey}:${CLASSIFIER_VERSION}:${result.evidenceChecksum}`});
        aiEnqueued+=1;
      } else deferredAi+=1;
    }
  }
  if(deferredAi>0)console.info(JSON.stringify({event:'candidate_ai_adjudication_deferred',count:deferredAi,reason:control.rows[0]?.ai_paused?'AI_PAUSED':'AI_BUDGET_UNAVAILABLE',timestamp:new Date().toISOString()}));
  const lastSpan=spanList[spanList.length-1];
  const hasMore=spans.rowCount===batchSize&&(await db.query(`SELECT 1 FROM corpus_candidate_occurrences WHERE document_id=$1 AND normalized_span>$2 LIMIT 1`,[p.documentId,lastSpan])).rowCount>0;
  if(hasMore){
    // Persist the cursor in the job payload and return the job to PENDING
    // without consuming an attempt. The next claim continues this document.
    await rescheduleJob(job.id,new Date(Date.now()+1_000).toISOString(),'SCORING_BATCH_CONTINUE',undefined,{...p,cursor:lastSpan});
    return;
  }
  await completeJob(job.id);
}

/** Enqueue bounded ambiguous candidates that were deferred while AI was
 * paused or out of budget. Runs only when the control is enabled and funded. */
export async function enqueueDeferredAiAdjudications(limit=50):Promise<number>{
  const db=await getDb();
  const control=await db.query('SELECT * FROM candidate_scoring_controls WHERE singleton=true');
  if(!control.rowCount)return 0;
  const usage=await db.query(`SELECT count(*)::int n,COALESCE(sum(cost_microunits),0)::bigint cost FROM candidate_adjudication_results WHERE completed_at>=date_trunc('day',now())`);
  const reservedCost=Math.max(0,Number(process.env.CANDIDATE_AI_COST_MICROUNITS||0));
  const active=await db.query(`SELECT count(*)::int n FROM jobs WHERE type='AI_ADJUDICATE_CANDIDATE' AND status IN ('PENDING','PROCESSING')`);
  const capacity=aiAdjudicationCapacity(control.rows[0],Number(usage.rows[0]?.n||0),Number(usage.rows[0]?.cost||0),reservedCost,Number(active.rows[0]?.n||0));
  if(capacity<=0)return 0;
  const bounded=Math.min(capacity,Math.max(1,Math.trunc(Number(limit))||50));
  const rows=await db.query(`
    SELECT DISTINCT ON (f.candidate_key)
           f.candidate_key,f.id::text feature_snapshot_id,f.normalized_span,f.evidence_checksum,
           (SELECT o.literal_span FROM corpus_candidate_occurrences o WHERE o.normalized_span=f.normalized_span ORDER BY o.created_at DESC LIMIT 1) literal_span
      FROM candidate_feature_snapshots f
     WHERE f.decision='AMBIGUOUS'
       AND NOT EXISTS (SELECT 1 FROM classification_assertions a WHERE a.candidate_key=f.candidate_key AND a.assertion_source='AI')
       AND NOT EXISTS (SELECT 1 FROM candidate_adjudication_results r WHERE r.candidate_key=f.candidate_key)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type='AI_ADJUDICATE_CANDIDATE' AND j.payload->>'candidateKey'=f.candidate_key AND j.status IN ('PENDING','PROCESSING','FAILED'))
     ORDER BY f.candidate_key,f.computed_at DESC
     LIMIT $1`,[bounded]);
  let enqueued=0;
  for(const row of rows.rows){
    const literal=String(row.literal_span||row.normalized_span||'');
    if(!literal)continue;
    await enqueueJob('AI_ADJUDICATE_CANDIDATE',{payloadSchemaVersion:1,candidateKey:row.candidate_key,featureSnapshotId:row.feature_snapshot_id,literalSpan:literal,classifierVersion:CLASSIFIER_VERSION},{priority:3,maxAttempts:2,idempotencyKey:`candidate-ai:${row.candidate_key}:${CLASSIFIER_VERSION}:${row.evidence_checksum}`});
    enqueued+=1;
  }
  return enqueued;
}

export async function processAiAdjudicationJob(job:{id:string;payload:any;attempts?:number}):Promise<void>{
  const p=job.payload;if(p.payloadSchemaVersion!==1||p.classifierVersion!==CLASSIFIER_VERSION)throw new Error('Unsupported AI_ADJUDICATE_CANDIDATE payload version.');const db=await getDb();const c=await db.query('SELECT * FROM candidate_scoring_controls WHERE singleton=true');
  if(!c.rowCount||c.rows[0].ai_paused){
    // A pause is an operator control, not a failed adjudication. Defer the job
    // for retry without consuming its bounded attempts.
    await rescheduleJob(job.id,new Date(Date.now()+60*60_000).toISOString(),'AI_ADJUDICATION_PAUSED',{attemptNumber:job.attempts});
    return;
  }
  const usage=await db.query(`SELECT count(*)::int n,COALESCE(sum(cost_microunits),0)::bigint cost FROM candidate_adjudication_results WHERE completed_at>=date_trunc('day',now())`);const reservedCost=Math.max(0,Number(process.env.CANDIDATE_AI_COST_MICROUNITS||0));
  if(usage.rows[0].n>=c.rows[0].daily_ai_assertions||Number(usage.rows[0].cost)+reservedCost>Number(c.rows[0].max_ai_cost_microunits)){
    // Budget exhaustion must not consume the bounded attempts before any
    // provider work starts. Defer to the database's next day boundary so the
    // SQL budget window and the retry window use the same timezone.
    const nextDay=await db.query(`SELECT (date_trunc('day',now())+interval '1 day') AS next_day`);
    const retryAt=nextDay.rows[0]?.next_day ? new Date(nextDay.rows[0].next_day) : new Date(Date.now()+24*60*60_000);
    await rescheduleJob(job.id,retryAt.toISOString(),'AI_BUDGET_EXHAUSTED',{attemptNumber:job.attempts});
    return;
  }
  const key=process.env.GEMINI_API_KEY;if(!key)throw new Error('GEMINI_API_KEY is not configured.');const ai=new GoogleGenAI({apiKey:key});const prompt=`Classify only the literal source span below. Never rewrite or add a term. Abstain when uncertain. Return exactly JSON keys literalSpan,label,confidence,abstained,reasonCodes. Closed labels: ${ASSERTION_LABELS.join(',')}. literalSpan=${JSON.stringify(p.literalSpan)}`;
  const resultKey=`ai:${p.featureSnapshotId}:${CLASSIFIER_VERSION}:attempt-${job.attempts||1}`;let responseText='';try{const response=await executeProviderCall({context:{provider:'gemini',operation:'candidate-adjudication',jobId:job.id,requestMetadata:{geminiRoute:resolveGeminiRouteId('gemini-1'),geminiOrg:geminiOrgIdForSlot(process.env,1)}},timeoutMs:Number(process.env.GEMINI_PROVIDER_TIMEOUT_MS||'45000'),enabled:true,emit:appendProviderCallEvent,call:(signal)=>ai.models.generateContent({model:process.env.CANDIDATE_AI_MODEL||'gemini-3.6-flash',contents:prompt,config:{responseMimeType:'application/json',abortSignal:signal}})});responseText=response.text||'';const parsed=validateBoundedAssertion(JSON.parse(responseText),p.literalSpan);const assertionKey=`ai:${p.featureSnapshotId}:${CLASSIFIER_VERSION}`;
    const usageMeta=(response as any).usageMetadata||{};await db.query(`INSERT INTO classification_assertions(candidate_key,feature_snapshot_id,assertion_source,label,confidence,abstained,reason_codes,literal_span,classifier_version,model_version,prompt_version,schema_version,raw_response_hash,assertion_key) VALUES($1,$2,'AI',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(assertion_key) DO NOTHING`,[p.candidateKey,p.featureSnapshotId,parsed.label,parsed.confidence,parsed.abstained,JSON.stringify(parsed.reasonCodes),p.literalSpan,CLASSIFIER_VERSION,process.env.CANDIDATE_AI_MODEL||'gemini-3.6-flash',PROMPT_VERSION,ASSERTION_SCHEMA_VERSION,sha(responseText),assertionKey]);await db.query(`INSERT INTO candidate_adjudication_results(candidate_key,feature_snapshot_id,classifier_version,status,input_tokens,output_tokens,cost_microunits,result_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(result_key) DO NOTHING`,[p.candidateKey,p.featureSnapshotId,CLASSIFIER_VERSION,parsed.abstained?'ABSTAINED':'COMPLETED',Number(usageMeta.promptTokenCount||0),Number(usageMeta.candidatesTokenCount||0),reservedCost,resultKey]);await completeJob(job.id);
  }catch(error){const code=error instanceof Error?error.message:'AI_FAILED';await db.query(`INSERT INTO candidate_adjudication_results(candidate_key,feature_snapshot_id,classifier_version,status,error_code,result_key) VALUES($1,$2,$3,'FAILED_CLOSED',$4,$5) ON CONFLICT(result_key) DO NOTHING`,[p.candidateKey,p.featureSnapshotId,CLASSIFIER_VERSION,code.slice(0,120),resultKey]);throw error;}
}

export async function inspectCandidateAssertions(limit=100):Promise<unknown>{const db=await getDb();const rows=await db.query(`SELECT f.candidate_key,f.normalized_span,f.feature_set_version,f.features,f.decision,f.reason_codes,f.evidence_checksum,f.computed_at,jsonb_agg(jsonb_build_object('source',a.assertion_source,'label',a.label,'confidence',a.confidence,'abstained',a.abstained,'classifierVersion',a.classifier_version,'modelVersion',a.model_version,'createdAt',a.created_at) ORDER BY a.created_at) assertions FROM candidate_feature_snapshots f JOIN classification_assertions a ON a.feature_snapshot_id=f.id GROUP BY f.id ORDER BY f.computed_at DESC LIMIT $1`,[Math.min(500,Math.max(1,limit))]);const costs=await db.query(`SELECT status,count(*)::int count,COALESCE(sum(cost_microunits),0)::bigint cost_microunits FROM candidate_adjudication_results GROUP BY status`);return {mode:'SHADOW',publicationEnabled:false,featureSetVersion:FEATURE_SET_VERSION,classifierVersion:CLASSIFIER_VERSION,items:rows.rows,ai:costs.rows};}