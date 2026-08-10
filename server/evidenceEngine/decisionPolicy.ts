import type { EvidenceCollectionReport, EvidenceItem, LifecycleAction } from './types';
import { SEMANTIC_TOP_CALIBRATED_CONFIDENCE } from './semanticCalibration';

export const UNIFIED_DECISION_POLICY_VERSION='unified-selective-policy-v1';
/**
 * Terminal UNRELATED requires the highest confidence tier emitted by the active
 * governed semantic calibration artifact. The bootstrap artifact tops out at
 * 84, so a hard-coded floor of 85 is an impossible predicate in production.
 */
export const SEMANTIC_UNRELATED_TERMINAL_MIN_CONFIDENCE=SEMANTIC_TOP_CALIBRATED_CONFIDENCE;

export interface UnifiedDecisionPolicyInput {evidence:EvidenceItem[];collection:EvidenceCollectionReport;lifecycleAction:LifecycleAction;minimumPositiveWeight:number;minimumTradingScore:number}
export interface UnifiedDecisionPolicyResult {status:'TRADING_CONFIRMED'|'NON_TRADING'|'UNCERTAIN';confidenceScore:number;tradingProbability:number;nonTradingProbability:number;coverageConfidence:number;reasonCodes:string[]}

const clamp=(n:number)=>Math.max(0,Math.min(100,n));
/** Conservative bootstrap calibration. Replace only with a governed time-split artifact. */
export function calibrateDecisionScore(raw:number):number{const n=clamp(raw);if(n<25)return Math.round(n*.8);if(n<50)return Math.round(20+(n-25)*.9);if(n<65)return Math.round(43+(n-50)*.8);if(n<80)return Math.round(55+(n-65)*1.4);return Math.round(Math.min(96,76+(n-80)));}

/**
 * A lexical terminology hit from an isolated video title is not, by itself,
 * substantive evidence that the creator is a trading creator. Terms such as
 * "options", "futures", "position", "margin", and "volume" are polysemous.
 * Creator/bio evidence, semantic trading evidence, and richer/non-terminology
 * observations remain substantive and therefore still block terminal rejection.
 */
function isWeakVideoTerminologyEvidence(item:EvidenceItem):boolean{
  if(item.polarity!=='POSITIVE'||item.category!=='TERMINOLOGY') return false;
  const fields=item.provenance?.fields||[];
  return fields.length>0&&fields.every(field=>field.field==='video_title');
}

/**
 * Narrow terminal-negative escape hatch for creator-level semantic evidence.
 * It deliberately does not lower the global negative-weight threshold. The
 * semantic model must explicitly classify the creator as UNRELATED, meet the
 * top governed calibrated-confidence tier, be attributable to the creator bio,
 * have terminal-negative sufficiency, and face no substantive positive trading
 * evidence. Isolated video-title terminology is treated as weak lexical evidence
 * rather than a creator-identity contradiction.
 */
export function qualifiesSemanticUnrelatedTerminalReject(evidence:EvidenceItem[], collection:EvidenceCollectionReport):boolean{
  if(collection.terminalNegativeSufficiency?.status!=='SUFFICIENT') return false;
  const substantivePositiveWeight=evidence
    .filter(item=>item.polarity==='POSITIVE'&&item.rawMatches.length&&!isWeakVideoTerminologyEvidence(item))
    .reduce((sum,item)=>sum+Math.abs(item.finalWeight),0);
  if(substantivePositiveWeight>0) return false;
  return evidence.some(item=>
    item.source==='gemini_semantic' &&
    item.polarity==='NEGATIVE' &&
    item.category==='IRRELEVANT_DOMAIN' &&
    item.provenance?.semantic?.taxonomyLabel==='UNRELATED' &&
    Number(item.provenance.semantic.calibratedConfidence)>=SEMANTIC_UNRELATED_TERMINAL_MIN_CONFIDENCE &&
    (item.provenance?.fields||[]).some(field=>field.field==='channel_bio')
  );
}

export function evaluateUnifiedDecisionPolicy(input:UnifiedDecisionPolicyInput):UnifiedDecisionPolicyResult{
  const positive=input.evidence.filter(item=>item.polarity==='POSITIVE'&&item.rawMatches.length),negative=input.evidence.filter(item=>item.polarity==='NEGATIVE');
  const positiveWeight=positive.reduce((sum,item)=>sum+Math.abs(item.finalWeight),0),negativeWeight=negative.reduce((sum,item)=>sum+Math.abs(item.finalWeight),0);
  const raw=clamp(50+positiveWeight-negativeWeight),tradingProbability=calibrateDecisionScore(raw),nonTradingProbability=calibrateDecisionScore(100-raw);
  const substantiveProviders=input.collection.providers.filter(provider=>provider.outcome==='EXECUTED_WITH_EVIDENCE').length;
  const documentFamilies=new Set(positive.flatMap(item=>item.provenance?.fields||[]).map(field=>field.sourceFamilyId||`${field.field}:${field.sourceId||field.index||''}`)).size;
  const coverageConfidence=input.collection.sufficiency==='MISSING'?0:input.collection.sufficiency==='INSUFFICIENT'?30:Math.min(100,55+Math.min(20,substantiveProviders*5)+Math.min(25,documentFamilies*5));
  const reasons:string[]=[];let status:UnifiedDecisionPolicyResult['status']='UNCERTAIN';
  const positiveBoundary=positiveWeight>=input.minimumPositiveWeight&&raw>=input.minimumTradingScore;
  const semanticUnrelatedTerminal=qualifiesSemanticUnrelatedTerminalReject(input.evidence,input.collection);
  if(input.lifecycleAction==='CONFIRM'&&positiveBoundary){status='TRADING_CONFIRMED';reasons.push('CALIBRATED_SUPPORT_AND_INDEPENDENCE_SATISFIED');}
  else if(input.lifecycleAction==='REJECT'&&negative.length&&(negativeWeight>=25||semanticUnrelatedTerminal)){
    status='NON_TRADING';
    reasons.push(semanticUnrelatedTerminal?'HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED':'DOMINANT_ATTRIBUTED_CONTRADICTION');
  }
  else {reasons.push(input.lifecycleAction==='ENRICH'?'EVIDENCE_COVERAGE_INCOMPLETE':input.lifecycleAction==='REVIEW'?'SELECTIVE_POLICY_ABSTAINED':'SCORE_BOUNDARY_NOT_SATISFIED');}
  const confidenceScore=status==='TRADING_CONFIRMED'?Math.max(82,tradingProbability):status==='NON_TRADING'?Math.min(22,100-nonTradingProbability):Math.min(79,Math.max(23,tradingProbability));
  return {status,confidenceScore,tradingProbability,nonTradingProbability,coverageConfidence,reasonCodes:reasons};
}
