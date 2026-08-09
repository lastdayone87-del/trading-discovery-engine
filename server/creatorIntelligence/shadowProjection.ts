import { getDb } from '../db';
import {
  CREATOR_INTELLIGENCE_CONTRACT_VERSION,
  creatorIntelligenceChecksum,
  validateCreatorOutcome,
  type CreatorActivityAssessment,
  type CreatorActivityStatus,
  type CreatorOutcome,
  type CreatorOutcomeMaturity,
  type CreatorOutcomeType
} from './contracts';

export const CREATOR_OUTCOME_PROJECTION_VERSION = 'creator-outcome-shadow-v1';
export const CREATOR_OUTCOME_POLICY_VERSION = 'creator-outcome-credit-v1';

export interface CreatorOutcomeProjectionSource {
  queryRunId: string; queryId: number; query: string; country: string; retrievalLane: 'VIDEO'|'CHANNEL'; searchOrdering: 'RELEVANCE'|'DATE';
  channelId: string; wasKnown: boolean; persisted: boolean; countryOutcome: string; tradingOutcome: string; sightingObservedAt: string;
  classificationStatus?: string; classificationCreatedAt?: string; enrichmentStage?: number;
  reviewDecision?: 'APPROVE'|'REJECT'|'FORCE_RESCAN'; reviewDecisionId?: string; reviewDecidedAt?: string;
  activityBand?: string; activityObservedAt?: string; latestUploadAt?: string;
  canonicalCreatorId?: string; entityClusterKey?: string;
  sourceEventKeys: string[]; providerUnits: number; reviewUnits: number;
}

export interface ProjectedCreatorOutcome { outcome: CreatorOutcome; source: CreatorOutcomeProjectionSource }

const validDate=(value:string|undefined):value is string=>!!value&&Number.isFinite(new Date(value).getTime());

export function mapCreatorActivity(source:CreatorOutcomeProjectionSource):CreatorActivityAssessment {
  const raw=String(source.activityBand||'UNKNOWN').toUpperCase();
  const status:CreatorActivityStatus=raw==='VERY_ACTIVE'||raw==='ACTIVE'?'ACTIVE':raw==='OCCASIONAL'?'RECENTLY_ACTIVE':raw==='DORMANT'?'DORMANT':raw==='INACTIVE'?'INACTIVE':'UNKNOWN';
  return {status,observedAt:validDate(source.activityObservedAt)?source.activityObservedAt:source.sightingObservedAt,latestContentAt:validDate(source.latestUploadAt)?source.latestUploadAt:undefined,evidenceSourceIds:source.sourceEventKeys,policyVersion:CREATOR_OUTCOME_POLICY_VERSION};
}

export function projectCreatorOutcome(source:CreatorOutcomeProjectionSource,cutoffAt:string):ProjectedCreatorOutcome {
  if(!validDate(cutoffAt))throw new Error('INVALID_CREATOR_OUTCOME_CUTOFF');
  const activity=mapCreatorActivity(source),reviewed=!!source.reviewDecision;
  const effectiveTrading=source.reviewDecision==='APPROVE'?'TRADING_CONFIRMED':source.reviewDecision==='REJECT'?'HUMAN_REJECTED':source.reviewDecision==='FORCE_RESCAN'?'UNCERTAIN':source.classificationStatus||source.tradingOutcome;
  let outcomeType:CreatorOutcomeType;
  if(source.countryOutcome==='REJECTED')outcomeType='COUNTRY_REJECTED';
  else if(effectiveTrading==='HUMAN_REJECTED')outcomeType='HUMAN_REJECTED';
  else if(effectiveTrading==='NON_TRADING')outcomeType='NON_TRADING';
  else if(effectiveTrading==='NEEDS_REVIEW')outcomeType='NEEDS_REVIEW';
  else if(effectiveTrading==='TRADING_CONFIRMED')outcomeType=source.wasKnown?'KNOWN_VERIFIED_CREATOR':'NEW_VERIFIED_CREATOR';
  else if(effectiveTrading==='UNCERTAIN')outcomeType='UNCERTAIN';
  else outcomeType='OPERATIONALLY_UNRESOLVED';
  const maturity:CreatorOutcomeMaturity=reviewed?'TERMINAL':Number(source.enrichmentStage||0)>0?'ENRICHED':'PROVISIONAL';
  const verified=['NEW_VERIFIED_CREATOR','KNOWN_VERIFIED_CREATOR'].includes(outcomeType)&&!!source.canonicalCreatorId;
  const effectiveAt=source.reviewDecidedAt||source.classificationCreatedAt||source.sightingObservedAt;
  const objectiveKey=`legacy-query:${source.country.normalize('NFKC').toLocaleLowerCase('en')}`;
  const outcome:CreatorOutcome={outcomeKey:creatorIntelligenceChecksum({projectionVersion:CREATOR_OUTCOME_PROJECTION_VERSION,queryRunId:source.queryRunId,channelId:source.channelId,cutoffAt,sourceChecksum:creatorIntelligenceChecksum(source)}),actionId:`legacy-query-run:${source.queryRunId}`,objectiveKey,
    creator:{canonicalCreatorId:source.canonicalCreatorId,sourceAccountId:source.channelId,sourceAccountType:'YOUTUBE_CHANNEL',identityConfidence:source.canonicalCreatorId?'CONFIRMED':'UNRESOLVED',entityClusterKey:source.entityClusterKey},outcomeType,maturity,
    incremental:outcomeType==='NEW_VERIFIED_CREATOR'&&verified,activeCreatorCredit:verified&&activity.status==='ACTIVE',verifiedCreatorCredit:verified,coverageCellKeys:[],cost:{providerUnits:source.providerUnits,reviewUnits:source.reviewUnits},
    evidence:{sourceEventKeys:[...new Set(source.sourceEventKeys)].sort(),countryStatus:normalizeCountry(source.countryOutcome),tradingStatus:normalizeTrading(effectiveTrading),activity},observedAt:source.sightingObservedAt,effectiveAt,policyVersion:CREATOR_OUTCOME_POLICY_VERSION,contractVersion:CREATOR_INTELLIGENCE_CONTRACT_VERSION};
  validateCreatorOutcome(outcome);return {outcome,source};
}

export async function projectShadowCreatorOutcomes(cutoffAt:string):Promise<{projectionRunId:string;observed:number;inserted:number;idempotent:boolean;servingAuthority:false}> {
  if(!validDate(cutoffAt))throw new Error('INVALID_CREATOR_OUTCOME_CUTOFF');
  const db=await getDb();
  const control=await db.query(`SELECT enabled FROM creator_outcome_projection_control WHERE singleton=true`);
  if(!control.rows[0]?.enabled)throw new Error('CREATOR_OUTCOME_PROJECTION_DISABLED');
  const result=await db.query(`SELECT qr.id query_run_id,qr.query_id,ql.query,qr.country,qr.retrieval_lane,qr.search_ordering,qr.quota_used,
    s.channel_id,s.was_known,s.persisted,s.country_outcome,s.trading_outcome,s.observed_at sighting_observed_at,
    d.id classification_diagnostic_id,d.status classification_status,d.created_at classification_created_at,COALESCE((d.normalized_input->>'enrichment_stage')::int,0) enrichment_stage,
    rd.id review_decision_id,rd.decision review_decision,rd.decided_at review_decided_at,
    c.activity_band,c.activity_observed_at,c.latest_upload_at,
    CASE WHEN ce.entity_type='CREATOR' THEN ce.id END canonical_creator_id,
    COALESCE(CASE WHEN ce.entity_type='CREATOR' THEN ce.id::text END,s.channel_id) entity_cluster_key,
    COALESCE(ev.event_keys,'[]'::json) source_event_keys,COALESCE(de.event_keys,'[]'::json) decision_event_keys,COALESCE(ee.event_keys,'[]'::json) entity_event_keys
    FROM query_runs qr JOIN query_library ql ON ql.id=qr.query_id JOIN channel_sightings s ON s.query_run_id=qr.id
    LEFT JOIN channels c ON c.channel_id=s.channel_id
    LEFT JOIN LATERAL(SELECT id,decision->>'status' status,normalized_input,created_at FROM production_classification_diagnostics WHERE channel_id=s.channel_id AND query_run_id=qr.id AND created_at<=$1 ORDER BY created_at DESC,id DESC LIMIT 1)d ON true
    LEFT JOIN LATERAL(SELECT id,decision::text decision,decided_at FROM channel_review_decisions WHERE channel_id=s.channel_id AND decided_at<=$1 ORDER BY decided_at DESC,id DESC LIMIT 1)rd ON true
    LEFT JOIN entity_bindings eb ON eb.namespace='YOUTUBE_CHANNEL_ID' AND eb.normalized_value=s.channel_id AND eb.status='APPROVED' AND eb.created_at<=$1
    LEFT JOIN canonical_entities ce ON ce.id=eb.entity_id AND ce.created_at<=$1
    LEFT JOIN LATERAL(SELECT json_agg(event_key ORDER BY event_time,event_key) event_keys FROM outcome_events WHERE query_run_id=qr.id AND subject_id IN(qr.id::text,s.channel_id) AND event_time<=$1)ev ON true
    LEFT JOIN LATERAL(SELECT json_agg(event_key ORDER BY event_time,event_key) event_keys FROM decision_events WHERE query_run_id=qr.id AND subject_id IN(qr.id::text,s.channel_id) AND event_time<=$1)de ON true
    LEFT JOIN LATERAL(SELECT json_agg(event_key ORDER BY occurred_at,event_key) event_keys FROM entity_projection_events WHERE entity_id=ce.id AND occurred_at<=$1)ee ON true
    WHERE qr.source='automated_query' AND s.observed_at<=$1 ORDER BY qr.id,s.channel_id,s.page_number,s.result_rank`,[cutoffAt]);
  const cutoffTime=new Date(cutoffAt).getTime(),activityAt=(row:any)=>row.activity_observed_at?new Date(row.activity_observed_at).toISOString():undefined,activityEligible=(row:any)=>!!activityAt(row)&&new Date(activityAt(row)!).getTime()<=cutoffTime;
  const rawSources:CreatorOutcomeProjectionSource[]=result.rows.map((row:any)=>({queryRunId:String(row.query_run_id),queryId:Number(row.query_id),query:String(row.query),country:String(row.country),retrievalLane:row.retrieval_lane||'VIDEO',searchOrdering:row.search_ordering||'RELEVANCE',channelId:String(row.channel_id),wasKnown:!!row.was_known,persisted:!!row.persisted,countryOutcome:String(row.country_outcome),tradingOutcome:String(row.trading_outcome),sightingObservedAt:new Date(row.sighting_observed_at).toISOString(),classificationStatus:row.classification_status||undefined,classificationCreatedAt:row.classification_created_at?new Date(row.classification_created_at).toISOString():undefined,enrichmentStage:Number(row.enrichment_stage||0),reviewDecision:row.review_decision||undefined,reviewDecisionId:row.review_decision_id||undefined,reviewDecidedAt:row.review_decided_at?new Date(row.review_decided_at).toISOString():undefined,activityBand:activityEligible(row)?row.activity_band:undefined,activityObservedAt:activityEligible(row)?activityAt(row):undefined,latestUploadAt:activityEligible(row)&&row.latest_upload_at?new Date(row.latest_upload_at).toISOString():undefined,canonicalCreatorId:row.canonical_creator_id||undefined,entityClusterKey:row.entity_cluster_key,sourceEventKeys:[...(Array.isArray(row.source_event_keys)?row.source_event_keys.map(String):[]),...(Array.isArray(row.decision_event_keys)?row.decision_event_keys.map((key:any)=>`decision-event:${key}`):[]),...(Array.isArray(row.entity_event_keys)?row.entity_event_keys.map((key:any)=>`entity-event:${key}`):[]),...(row.classification_diagnostic_id?[`classification-diagnostic:${row.classification_diagnostic_id}`]:[]),...(row.review_decision_id?[`review-decision:${row.review_decision_id}`]:[]),...(activityEligible(row)?[`activity-observation:${row.channel_id}:${activityAt(row)}`]:[])],providerUnits:Number(row.quota_used||0),reviewUnits:row.review_decision_id?1:0}));
  const unique=new Map<string,CreatorOutcomeProjectionSource>();for(const source of rawSources){const key=`${source.queryRunId}\u001f${source.channelId}`,prior=unique.get(key);if(!prior)unique.set(key,source);else prior.sourceEventKeys=[...new Set([...prior.sourceEventKeys,...source.sourceEventKeys])];}
  const sources=[...unique.values()];const counts=new Map<string,number>();for(const source of sources)counts.set(source.queryRunId,(counts.get(source.queryRunId)||0)+1);for(const source of sources)source.providerUnits=source.providerUnits/Math.max(1,counts.get(source.queryRunId)||1);
  const inputChecksum=creatorIntelligenceChecksum(sources),runKey=creatorIntelligenceChecksum({cutoffAt,projectionVersion:CREATOR_OUTCOME_PROJECTION_VERSION,inputChecksum}),existing=await db.query(`SELECT id FROM creator_outcome_projection_runs WHERE run_key=$1`,[runKey]);
  if(existing.rowCount)return {projectionRunId:existing.rows[0].id,observed:sources.length,inserted:0,idempotent:true,servingAuthority:false};
  const projected=sources.map(source=>projectCreatorOutcome(source,cutoffAt)),outputChecksum=creatorIntelligenceChecksum(projected.map(x=>x.outcome));const client=await db.connect();
  try{await client.query('BEGIN');const run=await client.query(`INSERT INTO creator_outcome_projection_runs(run_key,cutoff_at,projection_version,contract_version,policy_version,input_checksum,output_checksum,input_count,output_count,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'COMPLETED') ON CONFLICT(run_key) DO NOTHING RETURNING id`,[runKey,cutoffAt,CREATOR_OUTCOME_PROJECTION_VERSION,CREATOR_INTELLIGENCE_CONTRACT_VERSION,CREATOR_OUTCOME_POLICY_VERSION,inputChecksum,outputChecksum,projected.length]);if(!run.rowCount){const prior=await client.query(`SELECT id FROM creator_outcome_projection_runs WHERE run_key=$1`,[runKey]);await client.query('COMMIT');return {projectionRunId:prior.rows[0].id,observed:sources.length,inserted:0,idempotent:true,servingAuthority:false};}let inserted=0;for(const item of projected){const saved=await client.query(`INSERT INTO creator_outcome_records(outcome_key,projection_run_id,action_key,objective_key,query_run_id,query_id,channel_id,canonical_creator_id,identity_confidence,entity_cluster_key,outcome_type,maturity,incremental,verified_creator_credit,active_creator_credit,provider_units,review_units,evidence,observed_at,effective_at,policy_version,contract_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT(outcome_key) DO NOTHING RETURNING id`,[item.outcome.outcomeKey,run.rows[0].id,item.outcome.actionId,item.outcome.objectiveKey,item.source.queryRunId,item.source.queryId,item.source.channelId,item.outcome.creator.canonicalCreatorId||null,item.outcome.creator.identityConfidence,item.outcome.creator.entityClusterKey||null,item.outcome.outcomeType,item.outcome.maturity,item.outcome.incremental,item.outcome.verifiedCreatorCredit,item.outcome.activeCreatorCredit,item.outcome.cost.providerUnits,item.outcome.cost.reviewUnits,JSON.stringify(item.outcome.evidence),item.outcome.observedAt,item.outcome.effectiveAt,item.outcome.policyVersion,item.outcome.contractVersion]);if(saved.rowCount){inserted++;for(const eventKey of item.outcome.evidence.sourceEventKeys){const sourceKind=eventKey.startsWith('classification-diagnostic:')?'CLASSIFICATION_DIAGNOSTIC':eventKey.startsWith('review-decision:')?'REVIEW_DECISION':eventKey.startsWith('decision-event:')?'DECISION_EVENT':eventKey.startsWith('entity-event:')?'ENTITY_EVENT':eventKey.startsWith('activity-observation:')?'ACTIVITY_OBSERVATION':'OUTCOME_EVENT';await client.query(`INSERT INTO creator_outcome_source_events(outcome_id,source_event_key,source_kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[saved.rows[0].id,eventKey,sourceKind]);}}}await client.query('COMMIT');return {projectionRunId:run.rows[0].id,observed:sources.length,inserted,idempotent:false,servingAuthority:false};}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

function normalizeCountry(value:string):CreatorOutcome['evidence']['countryStatus'] {return ['CONFIRMED','LIKELY','UNCERTAIN','REJECTED'].includes(value)?value as any:undefined;}
function normalizeTrading(value:string):CreatorOutcome['evidence']['tradingStatus'] {return ['TRADING_CONFIRMED','NON_TRADING','UNCERTAIN','NEEDS_REVIEW','HUMAN_REJECTED'].includes(value)?value as any:undefined;}
