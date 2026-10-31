import type { EvidenceCollectionReport, EvidenceItem, LifecycleAction } from './types';
import { isSemanticClassificationSource } from './types';
import { SEMANTIC_TOP_CALIBRATED_CONFIDENCE } from './semanticCalibration';
import type { ContextualCompositionReport } from './contextualComposition';
import type { RecognitionAssessment } from './recognitionState';

export const UNIFIED_DECISION_POLICY_VERSION='unified-selective-policy-v2-conflict-aware';
export const SEMANTIC_UNRELATED_TERMINAL_MIN_CONFIDENCE=SEMANTIC_TOP_CALIBRATED_CONFIDENCE;

export interface UnifiedDecisionPolicyInput {evidence:EvidenceItem[];collection:EvidenceCollectionReport;lifecycleAction:LifecycleAction;minimumPositiveWeight:number;minimumTradingScore:number;composition?:ContextualCompositionReport;recognition?:RecognitionAssessment}
export interface UnifiedDecisionPolicyResult {status:'TRADING_CONFIRMED'|'NON_TRADING'|'UNCERTAIN';confidenceScore:number;tradingProbability:number;nonTradingProbability:number;coverageConfidence:number;reasonCodes:string[]}

/** C2: a channel title is a name prior, never independent confirmation. */
function hasIndependentCreatorOwnedPositiveField(items:EvidenceItem[]):boolean{
  return items.some(item=>item.polarity==='POSITIVE'&&(item.provenance?.fields||[]).some(field=>field.field!=='channel_title'&&field.field!=='search_match_context'&&Boolean(field.field)));
}

/**
 * C5 confirmation gate. A title or a title plus the matched document never
 * confirms. Confirmation requires a dominant trading composition with a
 * non-title Tier A family and either two observed trading families or an
 * explicit creator-level trading statement, and no dominant alternative.
 */
export function compositionConfirmsTrading(composition:ContextualCompositionReport):boolean{
  if(composition.focus!=='TRADING_DOMINANT') return false;
  if(composition.alternativeCoverage>=0.34||composition.explicitCreatorAlternative) return false;
  if(composition.nonTitleTierAFamilies<1) return false;
  // Explicit creator-level trading statement: Tier A plus financial context
  // with no dominant alternative. It does not need a second family.
  if(composition.explicitCreatorTrading) return true;
  // Otherwise require at least two observed trading families and majority
  // trading coverage.
  return composition.tradingCoverage>=0.5&&composition.tradingFamilies>=2;
}

const clamp=(n:number)=>Math.max(0,Math.min(100,n));
export function calibrateDecisionScore(raw:number):number{const n=clamp(raw);if(n<25)return Math.round(n*.8);if(n<50)return Math.round(20+(n-25)*.9);if(n<65)return Math.round(43+(n-50)*.8);if(n<80)return Math.round(55+(n-65)*1.4);return Math.round(Math.min(96,76+(n-80)));}

export function isWeakVideoTerminologyEvidence(item:EvidenceItem):boolean{
  if(item.polarity!=='POSITIVE'||item.category!=='TERMINOLOGY') return false;
  const fields=item.provenance?.fields||[];
  return fields.length>0&&fields.every(field=>field.field==='video_title');
}

/**
 * The exact substantive-weight/score boundary used by the terminal policy.
 * Shared with C6 recognition so a state cannot be labelled decisive unless the
 * final decision policy would also accept confirmation.
 */
export function evaluateDecisionScoreBoundary(evidence:EvidenceItem[],minimumPositiveWeight:number,minimumTradingScore:number):{positiveWeight:number;negativeWeight:number;substantivePositiveWeight:number;raw:number;satisfied:boolean}{
  const positive=evidence.filter(item=>item.polarity==='POSITIVE'&&item.rawMatches.length);
  const negative=evidence.filter(item=>item.polarity==='NEGATIVE');
  const positiveWeight=positive.reduce((sum,item)=>sum+Math.abs(item.finalWeight),0);
  const negativeWeight=negative.reduce((sum,item)=>sum+Math.abs(item.finalWeight),0);
  const substantivePositiveWeight=positive.filter(item=>!isWeakVideoTerminologyEvidence(item)).reduce((sum,item)=>sum+Math.abs(item.finalWeight),0);
  const raw=clamp(50+positiveWeight-negativeWeight);
  return {positiveWeight,negativeWeight,substantivePositiveWeight,raw,satisfied:substantivePositiveWeight>=minimumPositiveWeight&&raw>=minimumTradingScore};
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
  const semanticUnrelated=evidence.filter(item=>isSemanticClassificationSource(item.source)&&item.polarity==='NEGATIVE'&&item.category==='IRRELEVANT_DOMAIN'&&item.provenance?.semantic?.taxonomyLabel==='UNRELATED'&&Number(item.provenance.semantic.calibratedConfidence)>=SEMANTIC_UNRELATED_TERMINAL_MIN_CONFIDENCE);
  return semanticUnrelated.length>0&&hasCreatorLevelUnrelatedAttribution(semanticUnrelated);
}

function observationGroupKey(field: { field?: string; sourceFamilyId?: string | null; sourceId?: string | null; index?: number | null }): string | null {
  // Canonical source identity first: fields from one underlying video share
  // its source family even when each field carries its own document ID
  // (title vs description), while independent links/playlists/videos keep
  // distinct families and stay separate observations.
  if (field.sourceFamilyId) return `family:${field.sourceFamilyId}`;
  if (field.field === 'video_title' || field.field === 'video_description') {
    const id = field.sourceId ?? field.index;
    return id !== undefined && id !== null && id !== '' ? `video:${id}` : null;
  }
  if (field.field) return `field:${field.field}`;
  return null;
}

/**
 * Deduplicate evidence weight by canonical observed group. Multiple providers
 * may interpret the same document (e.g. the channel bio matched by both the
 * global and the country knowledge provider); without dedup the same token's
 * weight counts two or three times toward terminal thresholds.
 *
 * Weight is attributed per observation key: an item spanning several keys
 * contributes an equal share to each (so single items keep their exact total
 * however many documents they cite), and each key keeps the strongest share
 * covering it. Fully overlapping interpretations therefore collapse to one
 * voice, while independent links, playlists, videos — and multi-video
 * aggregates alongside per-video items — keep their support. Items without
 * any attributable field are never merged.
 * Shared with staged classification so stage dispositions and the final
 * policy always agree on terminal weight.
 */
export function dedupeWeightByFieldGroup<T extends { provenance?: { fields?: Array<{ field?: string; sourceFamilyId?: string | null; sourceId?: string | null; index?: number | null }> }; finalWeight: number }>(items: T[]): number {
  const keyShare = new Map<string, number>();
  let ungrouped = 0;
  for (const item of items) {
    const keys = (item.provenance?.fields || [])
      .map(observationGroupKey)
      .filter((value): value is string => value !== null);
    if (keys.length === 0) {
      ungrouped += Math.abs(item.finalWeight);
      continue;
    }
    const uniqueKeys = [...new Set(keys)];
    const share = Math.abs(item.finalWeight) / uniqueKeys.length;
    for (const key of uniqueKeys) {
      keyShare.set(key, Math.max(keyShare.get(key) || 0, share));
    }
  }
  let total = ungrouped;
  for (const weight of keyShare.values()) total += weight;
  return total;
}

function qualifiesDominantAttributedContradiction(evidence:EvidenceItem[],collection:EvidenceCollectionReport):boolean{
  if(collection.terminalNegativeSufficiency?.status!=='SUFFICIENT')return false;
  const positiveWeight=dedupeWeightByFieldGroup(evidence.filter(item=>item.polarity==='POSITIVE'&&item.rawMatches.length));
  const terminalNegativeWeight=dedupeWeightByFieldGroup(evidence.filter(item=>item.polarity==='NEGATIVE'&&item.category==='IRRELEVANT_DOMAIN'));
  return terminalNegativeWeight>=25&&(positiveWeight===0||terminalNegativeWeight>positiveWeight*1.5);
}

export function evaluateUnifiedDecisionPolicy(input:UnifiedDecisionPolicyInput):UnifiedDecisionPolicyResult{
  const positive=input.evidence.filter(item=>item.polarity==='POSITIVE'&&item.rawMatches.length),negative=input.evidence.filter(item=>item.polarity==='NEGATIVE');
  const boundary=evaluateDecisionScoreBoundary(input.evidence,input.minimumPositiveWeight,input.minimumTradingScore);
  const positiveWeight=boundary.positiveWeight,substantivePositiveWeight=boundary.substantivePositiveWeight,negativeWeight=boundary.negativeWeight;
  const raw=boundary.raw,tradingProbability=calibrateDecisionScore(raw),nonTradingProbability=calibrateDecisionScore(100-raw);
  const substantiveProviders=input.collection.providers.filter(provider=>provider.outcome==='EXECUTED_WITH_EVIDENCE').length;
  const documentFamilies=new Set(positive.flatMap(item=>item.provenance?.fields||[]).map(field=>field.sourceFamilyId||`${field.field}:${field.sourceId||field.index||''}`)).size;
  const coverageConfidence=input.collection.sufficiency==='MISSING'?0:input.collection.sufficiency==='INSUFFICIENT'?30:Math.min(100,55+Math.min(20,substantiveProviders*5)+Math.min(25,documentFamilies*5));
  const reasons:string[]=[];let status:UnifiedDecisionPolicyResult['status']='UNCERTAIN';
  const independentCreatorField=hasIndependentCreatorOwnedPositiveField(positive);
  const compositionOk=input.composition?compositionConfirmsTrading(input.composition):true;
  const recognitionAllowsConfirmation=!input.recognition||input.recognition.state==='DECISIVE_TRADING';
  const positiveBoundary=boundary.satisfied;
  const semanticUnrelatedTerminal=qualifiesSemanticUnrelatedTerminalReject(input.evidence,input.collection);
  const dominantAttributedContradiction=qualifiesDominantAttributedContradiction(input.evidence,input.collection);
  if(input.lifecycleAction==='CONFIRM'&&positiveBoundary&&independentCreatorField&&compositionOk&&recognitionAllowsConfirmation){status='TRADING_CONFIRMED';reasons.push('CALIBRATED_SUPPORT_AND_INDEPENDENCE_SATISFIED');}
  else if(input.lifecycleAction==='REJECT'&&(semanticUnrelatedTerminal||dominantAttributedContradiction)){
    status='NON_TRADING';reasons.push(semanticUnrelatedTerminal?'HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED':'DOMINANT_CREATOR_LEVEL_IRRELEVANT_CONTRADICTION');
  } else {
    if(input.lifecycleAction==='CONFIRM'&&!independentCreatorField)reasons.push('INDEPENDENT_CREATOR_OWNED_FIELD_REQUIRED');
    if(input.lifecycleAction==='CONFIRM'&&!compositionOk)reasons.push('CONTEXTUAL_COMPOSITION_CONFIRMATION_REQUIRED');
    if(input.lifecycleAction==='CONFIRM'&&!recognitionAllowsConfirmation)reasons.push('RECOGNITION_STATE_NOT_DECISIVE_TRADING');
    reasons.push(input.lifecycleAction==='ENRICH'?'EVIDENCE_COVERAGE_INCOMPLETE':input.lifecycleAction==='REVIEW'?'SELECTIVE_POLICY_ABSTAINED':positive.length>0&&substantivePositiveWeight<input.minimumPositiveWeight?'SUBSTANTIVE_POSITIVE_EVIDENCE_REQUIRED':'SCORE_BOUNDARY_NOT_SATISFIED');
  }
  // C3: no status floors. confidenceScore is the calibrated probability; the
  // display layer labels heuristic/calibrated/neutral separately.
  const confidenceScore=status==='TRADING_CONFIRMED'?tradingProbability:status==='NON_TRADING'?nonTradingProbability:Math.min(79,Math.max(23,tradingProbability));
  return {status,confidenceScore,tradingProbability,nonTradingProbability,coverageConfidence,reasonCodes:reasons};
}