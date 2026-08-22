import type { EvidenceCollectionReport, EvidenceItem, LifecycleAction } from './types';
import { SEMANTIC_TOP_CALIBRATED_CONFIDENCE } from './semanticCalibration';

export const UNIFIED_DECISION_POLICY_VERSION='unified-selective-policy-v2-conflict-aware';
export const SEMANTIC_UNRELATED_TERMINAL_MIN_CONFIDENCE=SEMANTIC_TOP_CALIBRATED_CONFIDENCE;

export interface UnifiedDecisionPolicyInput {evidence:EvidenceItem[];collection:EvidenceCollectionReport;lifecycleAction:LifecycleAction;minimumPositiveWeight:number;minimumTradingScore:number}
export interface UnifiedDecisionPolicyResult {status:'TRADING_CONFIRMED'|'NON_TRADING'|'UNCERTAIN';confidenceScore:number;tradingProbability:number;nonTradingProbability:number;coverageConfidence:number;reasonCodes:string[]}

const clamp=(n:number)=>Math.max(0,Math.min(100,n));
export function calibrateDecisionScore(raw:number):number{const n=clamp(raw);if(n<25)return Math.round(n*.8);if(n<50)return Math.round(20+(n-25)*.9);if(n<65)return Math.round(43+(n-50)*.8);if(n<80)return Math.round(55+(n-65)*1.4);return Math.round(Math.min(96,76+(n-80)));}

function isWeakVideoTerminologyEvidence(item:EvidenceItem):boolean{
  if(item.polarity!=='POSITIVE'||item.category!=='TERMINOLOGY') return false;
  const fields=item.provenance?.fields||[];
  return fields.length>0&&fields.every(field=>field.field==='video_title');
}

export function hasCreatorLevelUnrelatedAttribution(items:EvidenceItem[]):boolean{
  const fields=items.flatMap(item=>item.provenance?.fields||[]);
  if(fields.some(field=>field.field==='channel_bio')) return true;
  const videoFamilies=new Set(fields.filter(field=>field.field==='video_title'||field.field==='video_description').map(field=>field.sourceFamilyId||field.sourceId).filter((value):value is string=>Boolean(value)));
  return videoFamilies.size>=2;
}

export function qualifiesSemanticUnrelatedTerminalReject(evidence:EvidenceItem[], collection:EvidenceCollectionReport):boolean{
  if(collection.terminalNegativeSufficiency?.status!=='SUFFICIENT'||!collection.terminalNegativeSufficiency.creatorLevelCoverage) return false;
  const substantivePositiveWeight=evidence.filter(item=>item.polarity==='POSITIVE'&&item.rawMatches.length&&!isWeakVideoTerminologyEvidence(item)).reduce((sum,item)=>sum+Math.abs(item.finalWeight),0);
  if(substantivePositiveWeight>0) return false;
  const semanticUnrelated=evidence.filter(item=>item.source==='gemini_semantic'&&item.polarity==='NEGATIVE'&&item.category==='IRRELEVANT_DOMAIN'&&item.provenance?.semantic?.taxonomyLabel==='UNRELATED'&&Number(item.provenance.semantic.calibratedConfidence)>=SEMANTIC_UNRELATED_TERMINAL_MIN_CONFIDENCE);
  return semanticUnrelated.length>0&&hasCreatorLevelUnrelatedAttribution(semanticUnrelated);
}

function qualifiesDominantAttributedContradiction(evidence:EvidenceItem[],collection:EvidenceCollectionReport):boolean{
  if(collection.terminalNegativeSufficiency?.status!=='SUFFICIENT')return false;
  const positiveWeight=evidence.filter(item=>item.polarity==='POSITIVE'&&item.rawMatches.length).reduce((sum,item)=>sum+Math.abs(item.finalWeight),0);
  const terminalNegativeWeight=evidence.filter(item=>item.polarity==='NEGATIVE'&&item.category==='IRRELEVANT_DOMAIN').reduce((sum,item)=>sum+Math.abs(item.finalWeight),0);
  return terminalNegativeWeight>=25&&(positiveWeight===0||terminalNegativeWeight>positiveWeight*1.5);
}

export function evaluateUnifiedDecisionPolicy(input:UnifiedDecisionPolicyInput):UnifiedDecisionPolicyResult{
  const positive=input.evidence.filter(item=>item.polarity==='POSITIVE'&&item.rawMatches.length),negative=input.evidence.filter(item=>item.polarity==='NEGATIVE');
  const positiveWeight=positive.reduce((sum,item)=>sum+Math.abs(item.finalWeight),0),substantivePositiveWeight=positive.filter(item=>!isWeakVideoTerminologyEvidence(item)).reduce((sum,item)=>sum+Math.abs(item.finalWeight),0),negativeWeight=negative.reduce((sum,item)=>sum+Math.abs(item.finalWeight),0);
  const raw=clamp(50+positiveWeight-negativeWeight),tradingProbability=calibrateDecisionScore(raw),nonTradingProbability=calibrateDecisionScore(100-raw);
  const substantiveProviders=input.collection.providers.filter(provider=>provider.outcome==='EXECUTED_WITH_EVIDENCE').length;
  const documentFamilies=new Set(positive.flatMap(item=>item.provenance?.fields||[]).map(field=>field.sourceFamilyId||`${field.field}:${field.sourceId||field.index||''}`)).size;
  const coverageConfidence=input.collection.sufficiency==='MISSING'?0:input.collection.sufficiency==='INSUFFICIENT'?30:Math.min(100,55+Math.min(20,substantiveProviders*5)+Math.min(25,documentFamilies*5));
  const reasons:string[]=[];let status:UnifiedDecisionPolicyResult['status']='UNCERTAIN';
  const positiveBoundary=substantivePositiveWeight>=input.minimumPositiveWeight&&raw>=input.minimumTradingScore;
  const semanticUnrelatedTerminal=qualifiesSemanticUnrelatedTerminalReject(input.evidence,input.collection);
  const dominantAttributedContradiction=qualifiesDominantAttributedContradiction(input.evidence,input.collection);
  if(input.lifecycleAction==='CONFIRM'&&positiveBoundary){status='TRADING_CONFIRMED';reasons.push('CALIBRATED_SUPPORT_AND_INDEPENDENCE_SATISFIED');}
  else if(input.lifecycleAction==='REJECT'&&(semanticUnrelatedTerminal||dominantAttributedContradiction)){
    status='NON_TRADING';reasons.push(semanticUnrelatedTerminal?'HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED':'DOMINANT_CREATOR_LEVEL_IRRELEVANT_CONTRADICTION');
  } else {
    reasons.push(input.lifecycleAction==='ENRICH'?'EVIDENCE_COVERAGE_INCOMPLETE':input.lifecycleAction==='REVIEW'?'SELECTIVE_POLICY_ABSTAINED':positive.length>0&&substantivePositiveWeight<input.minimumPositiveWeight?'SUBSTANTIVE_POSITIVE_EVIDENCE_REQUIRED':'SCORE_BOUNDARY_NOT_SATISFIED');
  }
  const confidenceScore=status==='TRADING_CONFIRMED'?Math.max(82,tradingProbability):status==='NON_TRADING'?Math.min(22,100-nonTradingProbability):Math.min(79,Math.max(23,tradingProbability));
  return {status,confidenceScore,tradingProbability,nonTradingProbability,coverageConfidence,reasonCodes:reasons};
}