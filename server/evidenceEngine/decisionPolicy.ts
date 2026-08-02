import type { EvidenceCollectionReport, EvidenceItem, LifecycleAction } from './types';

export const UNIFIED_DECISION_POLICY_VERSION='unified-selective-policy-v1';

export interface UnifiedDecisionPolicyInput {evidence:EvidenceItem[];collection:EvidenceCollectionReport;lifecycleAction:LifecycleAction;minimumPositiveWeight:number;minimumTradingScore:number}
export interface UnifiedDecisionPolicyResult {status:'TRADING_CONFIRMED'|'NON_TRADING'|'UNCERTAIN';confidenceScore:number;tradingProbability:number;nonTradingProbability:number;coverageConfidence:number;reasonCodes:string[]}

const clamp=(n:number)=>Math.max(0,Math.min(100,n));
/** Conservative bootstrap calibration. Replace only with a governed time-split artifact. */
export function calibrateDecisionScore(raw:number):number{const n=clamp(raw);if(n<25)return Math.round(n*.8);if(n<50)return Math.round(20+(n-25)*.9);if(n<65)return Math.round(43+(n-50)*.8);if(n<80)return Math.round(55+(n-65)*1.4);return Math.round(Math.min(96,76+(n-80)));}

export function evaluateUnifiedDecisionPolicy(input:UnifiedDecisionPolicyInput):UnifiedDecisionPolicyResult{
  const positive=input.evidence.filter(item=>item.polarity==='POSITIVE'&&item.rawMatches.length),negative=input.evidence.filter(item=>item.polarity==='NEGATIVE');
  const positiveWeight=positive.reduce((sum,item)=>sum+Math.abs(item.finalWeight),0),negativeWeight=negative.reduce((sum,item)=>sum+Math.abs(item.finalWeight),0);
  const raw=clamp(50+positiveWeight-negativeWeight),tradingProbability=calibrateDecisionScore(raw),nonTradingProbability=calibrateDecisionScore(100-raw);
  const substantiveProviders=input.collection.providers.filter(provider=>provider.outcome==='EXECUTED_WITH_EVIDENCE').length;
  const documentFamilies=new Set(positive.flatMap(item=>item.provenance?.fields||[]).map(field=>field.sourceFamilyId||`${field.field}:${field.sourceId||field.index||''}`)).size;
  const coverageConfidence=input.collection.sufficiency==='MISSING'?0:input.collection.sufficiency==='INSUFFICIENT'?30:Math.min(100,55+Math.min(20,substantiveProviders*5)+Math.min(25,documentFamilies*5));
  const reasons:string[]=[];let status:UnifiedDecisionPolicyResult['status']='UNCERTAIN';
  const positiveBoundary=positiveWeight>=input.minimumPositiveWeight&&raw>=input.minimumTradingScore;
  if(input.lifecycleAction==='CONFIRM'&&positiveBoundary){status='TRADING_CONFIRMED';reasons.push('CALIBRATED_SUPPORT_AND_INDEPENDENCE_SATISFIED');}
  else if(input.lifecycleAction==='REJECT'&&negative.length&&negativeWeight>=25){status='NON_TRADING';reasons.push('DOMINANT_ATTRIBUTED_CONTRADICTION');}
  else {reasons.push(input.lifecycleAction==='ENRICH'?'EVIDENCE_COVERAGE_INCOMPLETE':input.lifecycleAction==='REVIEW'?'SELECTIVE_POLICY_ABSTAINED':'SCORE_BOUNDARY_NOT_SATISFIED');}
  const confidenceScore=status==='TRADING_CONFIRMED'?Math.max(82,tradingProbability):status==='NON_TRADING'?Math.min(22,100-nonTradingProbability):Math.min(79,Math.max(23,tradingProbability));
  return {status,confidenceScore,tradingProbability,nonTradingProbability,coverageConfidence,reasonCodes:reasons};
}
