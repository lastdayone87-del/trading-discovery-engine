import { createHash } from 'node:crypto';
import { getDb } from './db';
import { ConfigurableWeightedStrategy, type EvidenceItem, type RawChannelInput, type VerificationDecision } from './evidenceEngine';
import { textMatchesTerm } from './evidenceEngine/utils/textMatching';

export const ADAPTIVE_CLASSIFIER_VERSION='adaptive-shadow-v1';
export const ADAPTIVE_POLICY_VERSION='adaptive-conservative-v1';
export type ShadowStatus='TRADING_CONFIRMED'|'NON_TRADING'|'UNCERTAIN';
export interface AdaptiveTerm {surfaceId:string;conceptId:string;literal:string;normalized:string;conceptClass:string;origin:'HUMAN_APPROVED_TERMINOLOGY'|'APPROVED_CONCEPT';catalogVersion:string}
export interface ShadowResult {status:ShadowStatus;confidenceScore:number;category:string;evidence:EvidenceItem[];reasonCodes:string[];versions:{classifier:string;policy:string;featureSnapshot:string;catalogs:string[]}}

const stable=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const sum=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');

/** Only explicitly governed surfaces are eligible; observed/learned terms are excluded. */
export async function loadAdaptiveTerms(country:string):Promise<AdaptiveTerm[]>{
  const db=await getDb();
  const r=await db.query(`SELECT DISTINCT s.id::text surface_id,c.id::text concept_id,s.literal,s.normalized,c.concept_class,
    CASE WHEN EXISTS(SELECT 1 FROM terminology_observations o WHERE o.surface_id=s.id AND o.human_approved=true) THEN 'HUMAN_APPROVED_TERMINOLOGY' ELSE 'APPROVED_CONCEPT' END origin,
    COALESCE((SELECT string_agg(DISTINCT v.version::text,',' ORDER BY v.version::text) FROM serving_catalog_entries e JOIN serving_catalog_versions v ON v.id=e.catalog_version_id WHERE v.status='APPROVED' AND lower(e.surface_text)=lower(s.literal) AND (e.country=$1 OR e.country='GLOBAL')),'concept-graph') catalog_version
    FROM term_surfaces s JOIN concept_surface_senses cs ON cs.surface_id=s.id AND cs.sense_status='APPROVED'
    JOIN concepts c ON c.id=cs.concept_id AND c.status='ACTIVE'
    WHERE s.valid_to IS NULL AND s.ambiguity=false AND c.concept_class IN('STRATEGY','MARKET','INSTRUMENT','EDUCATION','PLATFORM')
      AND (EXISTS(SELECT 1 FROM terminology_observations o WHERE o.surface_id=s.id AND o.human_approved=true)
        OR EXISTS(SELECT 1 FROM serving_catalog_entries e JOIN serving_catalog_versions v ON v.id=e.catalog_version_id WHERE v.status='APPROVED' AND lower(e.surface_text)=lower(s.literal) AND (e.country=$1 OR e.country='GLOBAL'))
        OR EXISTS(SELECT 1 FROM concept_moderation_decisions m WHERE m.action='APPROVE_SENSE' AND m.target_id=cs.id))
    ORDER BY s.normalized,c.id`,[country]);
  return r.rows.map((x:any)=>({surfaceId:x.surface_id,conceptId:x.concept_id,literal:x.literal,normalized:x.normalized,conceptClass:x.concept_class,origin:x.origin,catalogVersion:x.catalog_version}));
}

export function classifyAdaptiveShadow(input:RawChannelInput,production:VerificationDecision,terms:AdaptiveTerm[],graphConceptIds:Set<string>=new Set()):ShadowResult{
  const channelText=`${input.channel_name} ${input.description||''}`;const videos=[...(input.video_titles||[]),...(input.video_descriptions||[])];
  const matched=terms.filter(t=>textMatchesTerm(channelText,t.literal)||videos.some(v=>textMatchesTerm(v,t.literal)));
  const distinct=[...new Map(matched.map(t=>[t.conceptId,t])).values()];
  const videoConcepts=new Set(distinct.filter(t=>videos.some(v=>textMatchesTerm(v,t.literal))).map(t=>t.conceptId));
  const corroborated=distinct.filter(t=>videoConcepts.has(t.conceptId)||graphConceptIds.has(t.conceptId));
  const now=new Date().toISOString();const evidence:EvidenceItem[]=[];
  if(corroborated.length)evidence.push({id:`adaptive:${sum(corroborated.map(t=>t.surfaceId)).slice(0,16)}`,source:'adaptive_catalog',polarity:'POSITIVE',category:'METHODOLOGY_CONCEPT',fact:`Governed adaptive catalog matched ${corroborated.length} corroborated concepts.`,rawMatches:corroborated.map(t=>t.literal),confidence:80,reliability:'MEDIUM',reliabilityMultiplier:.65,rawWeight:Math.min(12,corroborated.length*4),finalWeight:Math.min(12,corroborated.length*4)*.65*.8,provenance:{provider:'adaptive_catalog',type:'GOVERNED_CONCEPT',matchedTerm:corroborated.map(t=>t.literal).join(', '),sourceRef:'Approved terminology/concept snapshot'},timestamp:now});
  const graphMatches=corroborated.filter(t=>graphConceptIds.has(t.conceptId));
  if(graphMatches.length)evidence.push({id:`graph:${sum(graphMatches.map(t=>t.conceptId)).slice(0,16)}`,source:'evidence_graph',polarity:'POSITIVE',category:'TERMINOLOGY',fact:`Evidence Graph corroborates ${graphMatches.length} governed concepts.`,rawMatches:graphMatches.map(t=>t.literal),confidence:75,reliability:'MEDIUM',reliabilityMultiplier:.5,rawWeight:Math.min(6,graphMatches.length*2),finalWeight:Math.min(6,graphMatches.length*2)*.5*.75,provenance:{provider:'evidence_graph',type:'CORROBORATION_ONLY',matchedTerm:graphMatches.map(t=>t.literal).join(', '),sourceRef:'Immutable active channel-to-concept edges'},timestamp:now});
  const strategy=new ConfigurableWeightedStrategy();const candidate=strategy.evaluateDecision([...production.positiveEvidence,...production.negativeEvidence,...evidence],{globalInstruments:[],globalPlatformsPropFirms:[],globalAdvancedConcepts:[],globalNegativeTerms:[]},input.country||'UNKNOWN');
  const reasons:string[]=[];let status=candidate.status as ShadowStatus;
  if(!evidence.length){status=production.status as ShadowStatus;candidate.confidenceScore=production.confidenceScore;}
  if(production.status==='NON_TRADING'&&status==='TRADING_CONFIRMED'){status='UNCERTAIN';reasons.push('PRODUCTION_NEGATIVE_VETO');}
  if(status==='TRADING_CONFIRMED'&&corroborated.length<2){status='UNCERTAIN';reasons.push('ADAPTIVE_MULTI_CONCEPT_CORROBORATION_REQUIRED');}
  if(!evidence.length)reasons.push('NO_GOVERNED_ADAPTIVE_EVIDENCE');if(!reasons.length)reasons.push('CONSERVATIVE_POLICY_SATISFIED');
  const catalogs=[...new Set(corroborated.map(t=>t.catalogVersion))].sort();const featureSnapshot=sum({terms:terms.map(t=>[t.surfaceId,t.conceptId,t.catalogVersion]),graph:[...graphConceptIds].sort()});
  return {status,confidenceScore:status==='UNCERTAIN'&&candidate.status==='TRADING_CONFIRMED'?Math.min(candidate.confidenceScore,64):candidate.confidenceScore,category:String(candidate.category),evidence,reasonCodes:reasons,versions:{classifier:ADAPTIVE_CLASSIFIER_VERSION,policy:ADAPTIVE_POLICY_VERSION,featureSnapshot,catalogs}};
}

export async function runAndRecordAdaptiveShadow(channelId:string,input:RawChannelInput,production:VerificationDecision):Promise<ShadowResult>{
  const db=await getDb();const terms=await loadAdaptiveTerms(input.country||'UNKNOWN');
  const graph=await db.query(`SELECT DISTINCT n2.canonical_entity_id::text concept_id FROM evidence_nodes n1 JOIN evidence_edges e ON e.from_node_id=n1.id JOIN evidence_nodes n2 ON n2.id=e.to_node_id WHERE n1.node_type='CHANNEL' AND n1.canonical_key=$1 AND n2.node_type='CONCEPT' AND n2.canonical_entity_id IS NOT NULL AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now()) AND e.confidence_basis_points>=8000`,[`channel:${channelId.normalize('NFKC').trim().toLocaleLowerCase('en')}`]);
  const result=classifyAdaptiveShadow(input,production,terms,new Set(graph.rows.map((r:any)=>r.concept_id)));
  await db.query(`INSERT INTO adaptive_classifier_shadow_runs(channel_id,production_status,production_confidence,shadow_status,shadow_confidence,agreement,production_evidence,shadow_evidence,evidence_difference,review_rate_delta,classifier_version,policy_version,feature_snapshot_checksum,catalog_versions,reason_codes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[channelId,production.status,production.confidenceScore,result.status,result.confidenceScore,production.status===result.status,JSON.stringify({positive:production.positiveEvidence,negative:production.negativeEvidence}),JSON.stringify(result.evidence),JSON.stringify({added:result.evidence.map(e=>e.id),productionPositiveCount:production.positiveEvidence.length,shadowAddedCount:result.evidence.length}),Number(result.status==='UNCERTAIN')-Number(production.status==='UNCERTAIN'),result.versions.classifier,result.versions.policy,result.versions.featureSnapshot,JSON.stringify(result.versions.catalogs),JSON.stringify(result.reasonCodes)]);
  return result;
}

/** Append review truth independently; callers must invoke this only after the production review commits. */
export async function recordAdaptiveShadowLabel(channelId:string,reviewDecisionId:string,groundTruthStatus:'TRADING_CONFIRMED'|'NON_TRADING'):Promise<void>{
  const db=await getDb();await db.query(`INSERT INTO adaptive_classifier_shadow_labels(shadow_run_id,review_decision_id,ground_truth_status) SELECT id,$2,$3 FROM adaptive_classifier_shadow_runs WHERE channel_id=$1 AND NOT EXISTS(SELECT 1 FROM adaptive_classifier_shadow_labels l WHERE l.shadow_run_id=adaptive_classifier_shadow_runs.id) ON CONFLICT DO NOTHING`,[channelId,reviewDecisionId,groundTruthStatus]);
}

export async function inspectAdaptiveClassifier(limit=100){const db=await getDb(),n=Math.min(500,Math.max(1,limit));const [runs,metrics,labeled]=await Promise.all([db.query('SELECT * FROM adaptive_classifier_shadow_runs ORDER BY classified_at DESC LIMIT $1',[n]),db.query(`SELECT count(*)::int total,count(*) FILTER(WHERE agreement)::int agreements,count(*) FILTER(WHERE NOT agreement)::int disagreements,avg(review_rate_delta)::float review_rate_delta,count(*) FILTER(WHERE production_status='TRADING_CONFIRMED' AND shadow_status<>'TRADING_CONFIRMED')::int shadow_recall_losses,count(*) FILTER(WHERE production_status<>'TRADING_CONFIRMED' AND shadow_status='TRADING_CONFIRMED')::int shadow_recall_candidates FROM adaptive_classifier_shadow_runs`),db.query(`SELECT count(*)::int labeled,
  avg((production_status=ground_truth_status)::int)::float production_accuracy,avg((shadow_status=ground_truth_status)::int)::float shadow_accuracy,
  count(*) FILTER(WHERE shadow_status='TRADING_CONFIRMED' AND ground_truth_status='TRADING_CONFIRMED')::int shadow_true_positives,
  count(*) FILTER(WHERE shadow_status='TRADING_CONFIRMED' AND ground_truth_status='NON_TRADING')::int shadow_false_positives,
  count(*) FILTER(WHERE shadow_status<>'TRADING_CONFIRMED' AND ground_truth_status='TRADING_CONFIRMED')::int shadow_false_negatives,
  count(*) FILTER(WHERE production_status='TRADING_CONFIRMED' AND ground_truth_status='NON_TRADING')::int production_false_positives
  FROM adaptive_classifier_shadow_runs r JOIN adaptive_classifier_shadow_labels l ON l.shadow_run_id=r.id`)]);const m=labeled.rows[0],tp=Number(m.shadow_true_positives),fp=Number(m.shadow_false_positives),fn=Number(m.shadow_false_negatives);return {mode:'SHADOW_ONLY',productionDecisionMaker:true,automaticPromotion:false,classifierVersion:ADAPTIVE_CLASSIFIER_VERSION,policyVersion:ADAPTIVE_POLICY_VERSION,metrics:{...metrics.rows[0],...m,shadowPrecision:tp+fp?tp/(tp+fp):null,shadowRecall:tp+fn?tp/(tp+fn):null,falsePositiveDelta:fp-Number(m.production_false_positives)},runs:runs.rows};}
