import type {
  ClassificationStageResult, EvidenceCollectionReport, EvidenceFieldRef, EvidenceItem,
  LifecycleAction, RawChannelInput, StagedClassificationReport
} from './types';
import { collapseSourceIndependentObservations } from '../entityResolution';
import { hasCreatorLevelUnrelatedAttribution } from './decisionPolicy';

export const STAGED_CLASSIFICATION_VERSION = '3.2.1';

function inferredFields(item: EvidenceItem): EvidenceFieldRef[] {
  if (item.provenance?.fields?.length) return item.provenance.fields;
  switch (item.source) {
    case 'channel_metadata': return [{ field: 'channel_title' }, { field: 'channel_bio' }];
    case 'video_metadata': return [{ field: 'video_title' }, { field: 'video_description' }];
    case 'external_links': return [{ field: 'external_link_domain' }];
    case 'country_knowledge': return [{ field: 'country' }, { field: 'channel_bio' }];
    case 'discord_metadata': return [{ field: 'discord_invite' }];
    case 'multilingual_context': return [{ field: 'language' }, { field: 'channel_bio' }, { field: 'video_title' }];
    case 'gemini_semantic': return [{ field: 'channel_title' }, { field: 'channel_bio' }, { field: 'video_title' }, { field: 'video_description' }];
    default: return [];
  }
}

function uniqueFields(items: EvidenceItem[]): EvidenceFieldRef[] {
  const seen = new Set<string>();
  return items.flatMap(inferredFields).filter(ref => {
    const key = `${ref.field}:${ref.index ?? ''}:${ref.sourceId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function result(stage: ClassificationStageResult['stage'], disposition: ClassificationStageResult['disposition'], reasonCodes: string[], items: EvidenceItem[], metrics: ClassificationStageResult['metrics']): ClassificationStageResult {
  return { stage, disposition, reasonCodes, evidenceIds: items.map(item => item.id), fields: uniqueFields(items), metrics };
}

function isPromotionalOrAdjacentNegative(item: EvidenceItem): boolean {
  return item.category === 'HYPE_SPECULATION' || item.category === 'NON_TRADING_ADJACENT';
}

function isWeakVideoTerminologyEvidence(item: EvidenceItem): boolean {
  if (item.polarity !== 'POSITIVE' || item.category !== 'TERMINOLOGY') return false;
  const fields = item.provenance?.fields || [];
  return fields.length > 0 && fields.every(field => field.field === 'video_title');
}

function terminalContradictionWeights(negative: EvidenceItem[], positiveWeight: number) {
  const terminalNegative = negative.filter(item => item.category === 'IRRELEVANT_DOMAIN' && !isPromotionalOrAdjacentNegative(item));
  const terminalNegativeWeight = terminalNegative.reduce((sum, item) => sum + Math.abs(item.finalWeight), 0);
  const materiallyDominant = terminalNegativeWeight >= 25 && (positiveWeight === 0 || terminalNegativeWeight > positiveWeight * 1.5);
  return { terminalNegative, terminalNegativeWeight, materiallyDominant };
}

/** The staged layer only decides whether governed semantic UNRELATED evidence is
 * eligible to reach the decision policy. Confidence threshold and substantive
 * positive blockers remain the responsibility of decisionPolicy.ts. */
function hasCreatorLevelSemanticUnrelatedCandidate(negative: EvidenceItem[], collection: EvidenceCollectionReport): boolean {
  if (collection.terminalNegativeSufficiency?.status !== 'SUFFICIENT' || !collection.terminalNegativeSufficiency.creatorLevelCoverage) return false;
  const semanticUnrelated=negative.filter(item => item.source === 'gemini_semantic' && item.category === 'IRRELEVANT_DOMAIN' && item.provenance?.semantic?.taxonomyLabel === 'UNRELATED');
  return semanticUnrelated.length>0&&hasCreatorLevelUnrelatedAttribution(semanticUnrelated);
}

export function evaluateClassificationStages(input: RawChannelInput, evidence: EvidenceItem[], collection: EvidenceCollectionReport): StagedClassificationReport {
  const positive = evidence.filter(item => item.polarity === 'POSITIVE' && item.rawMatches.length > 0);
  const negative = evidence.filter(item => item.polarity === 'NEGATIVE');
  const semantic = positive.filter(item => item.source === 'gemini_semantic' || item.category === 'METHODOLOGY_CONCEPT' || item.category === 'TERMINOLOGY' || item.category === 'INSTRUMENT');
  const strongPositive = positive.filter(item => item.reliability !== 'LOWER' && Math.abs(item.finalWeight) >= 6);
  const corroborating = strongPositive.filter(item => item.category !== 'MULTI_VIDEO_CONSISTENCY');
  const sources = new Set(corroborating.map(item => item.source));
  const attributableFields=corroborating.flatMap(item=>item.provenance?.fields||[]);
  const observations=new Set(attributableFields.map(ref=>`${ref.field}:${ref.sourceId || ref.index || ''}`));
  const observationFamilies=new Set(attributableFields.map(ref=>ref.field==='video_title'||ref.field==='video_description'?'video':ref.field==='playlist_name'||ref.field==='playlist_description'?'playlist':ref.field));
  const independence=collapseSourceIndependentObservations(attributableFields.map((ref,index)=>({observationId:`${ref.field}:${ref.sourceId||ref.index||index}`,sourceFamilyId:ref.sourceFamilyId,sourceEntityId:ref.sourceEntityId})));
  const repeatedItems=evidence.filter(item => item.category === 'MULTI_VIDEO_CONSISTENCY' && item.polarity === 'POSITIVE');
  const repeatedFields=repeatedItems.flatMap(item=>item.provenance?.fields||[]);
  const repeatedIndependence=collapseSourceIndependentObservations(repeatedFields.map((ref,index)=>({observationId:`${ref.field}:${ref.sourceId||ref.index||index}`,sourceFamilyId:ref.sourceFamilyId,sourceEntityId:ref.sourceEntityId})));
  const repeated = repeatedItems.length>0&&(repeatedFields.length===0||repeatedIndependence.independentFamilyCount>=2);
  const repeatedCreatorHypothesis = repeatedItems.filter(item => item.confidence >= 70 && Math.abs(item.finalWeight) >= 18);
  const repeatedCreatorIndependent = repeatedCreatorHypothesis.length > 0 && repeatedIndependence.independentFamilyCount >= 3;
  const independentDimensions = new Set(corroborating.map(item => item.category));
  const negativeWeight = negative.reduce((sum, item) => sum + Math.abs(item.finalWeight), 0);
  const positiveWeight = positive.reduce((sum, item) => sum + Math.abs(item.finalWeight), 0);
  const {terminalNegative,terminalNegativeWeight,materiallyDominant}=terminalContradictionWeights(negative,positiveWeight);
  const terminalNegativeSufficient=collection.terminalNegativeSufficiency?.status==='SUFFICIENT';
  const semanticUnrelatedCandidate=hasCreatorLevelSemanticUnrelatedCandidate(negative,collection);
  const dominantContradiction = materiallyDominant && terminalNegativeSufficient;
  const mixedNegativeConflict = negative.length > 0 && negativeWeight >= 25 && !dominantContradiction && !semanticUnrelatedCandidate;

  const availability = collection.sufficiency === 'SUFFICIENT'
    ? result('AVAILABILITY', 'PASS', [collection.degraded ? 'STAGE_EVIDENCE_SUFFICIENT_WITH_PROVIDER_DEGRADATION' : 'STAGE_EVIDENCE_SUFFICIENT'], evidence, { sufficiency: collection.sufficiency, degraded: collection.degraded })
    : result('AVAILABILITY', 'ABSTAIN', collection.reasonCodes.length ? collection.reasonCodes : ['STAGE_EVIDENCE_NOT_READY'], evidence, { sufficiency: collection.sufficiency, degraded: collection.degraded });
  const candidateEvidence = semantic.length > 0 ? semantic : repeatedCreatorIndependent ? repeatedCreatorHypothesis : [];
  const candidate = candidateEvidence.length > 0
    ? result('CANDIDATE_DETECTION', 'PASS', [semantic.length > 0 ? 'SEMANTIC_CANDIDATE_FOUND' : 'REPEATED_INDEPENDENT_TRADING_UPLOADS'], candidateEvidence, { candidateSignals: candidateEvidence.length, repeatedIndependentFamilies: repeatedIndependence.independentFamilyCount })
    : result('CANDIDATE_DETECTION', 'ABSTAIN', ['NO_SEMANTIC_OR_REPEATED_CREATOR_CANDIDATE'], [], { candidateSignals: 0, repeatedIndependentFamilies: repeatedIndependence.independentFamilyCount });
  const independentObservations=independence.independentFamilyCount>=2 && observations.size>=2 && (observationFamilies.size>=2 || attributableFields.filter(f=>f.field==='video_title'||f.field==='video_description').length>=2);
  const corroborated = repeatedCreatorIndependent || (corroborating.length > 0 && (repeated || independentObservations || ((sources.size >= 2 || independentDimensions.size >= 2)&&independence.independentFamilyCount>=2)));
  const corroborationEvidence = repeatedCreatorIndependent ? [...corroborating, ...repeatedCreatorHypothesis] : corroborating;
  const weakVideoTerminologyOnly = positive.length > 0 && positive.every(isWeakVideoTerminologyEvidence);
  const corroboration = corroborated
    ? result('CORROBORATION', 'PASS', [repeatedCreatorIndependent ? 'REPEATED_VIDEO_SOURCE_FAMILY_INDEPENDENCE_SATISFIED' : 'SOURCE_FAMILY_INDEPENDENCE_SATISFIED'], corroborationEvidence, { sources: sources.size, fields: observations.size, sourceFamilies:Math.max(independence.independentFamilyCount,repeatedIndependence.independentFamilyCount),sourceEntities:Math.max(independence.independentEntityCount,repeatedIndependence.independentEntityCount),dimensions: independentDimensions.size, repeatedVideos: repeated, repeatedCreatorIndependent })
    : result('CORROBORATION', 'ABSTAIN', [weakVideoTerminologyOnly?'WEAK_VIDEO_TERMINOLOGY_ONLY':corroborating.length&&independence.independentFamilyCount<2?'SOURCE_FAMILY_INDEPENDENCE_REQUIRED':'CORROBORATION_REQUIRED'], corroborating, { sources: sources.size, fields: observations.size, sourceFamilies:independence.independentFamilyCount,sourceEntities:independence.independentEntityCount,dimensions: independentDimensions.size, repeatedVideos: repeated, repeatedCreatorIndependent });
  const contradiction = semanticUnrelatedCandidate
    ? result('CONTRADICTION','FAIL',['CREATOR_LEVEL_SEMANTIC_UNRELATED_CANDIDATE'],negative,{negativeWeight,positiveWeight,terminalNegativeWeight})
    : dominantContradiction
      ? result('CONTRADICTION', 'FAIL', ['DOMINANT_CREATOR_LEVEL_IRRELEVANT_CONTRADICTION'], terminalNegative, { negativeWeight, positiveWeight, terminalNegativeWeight })
      : mixedNegativeConflict
        ? result('CONTRADICTION','ABSTAIN',['MIXED_EVIDENCE_TERMINAL_REJECTION_WITHHELD'],negative,{negativeWeight,positiveWeight,terminalNegativeWeight,independentNegativeObservations:collection.terminalNegativeSufficiency?.independentObservations||0,independentNegativeSourceFamilies:collection.terminalNegativeSufficiency?.independentSourceFamilies||0})
        : result('CONTRADICTION', 'PASS', negative.length ? ['CONTRADICTION_NOT_TERMINAL_OR_DOMINANT'] : ['NO_AFFIRMATIVE_CONTRADICTION'], negative, { negativeWeight, positiveWeight, terminalNegativeWeight });

  let lifecycleAction: LifecycleAction = 'REVIEW';
  if (availability.disposition !== 'PASS') lifecycleAction = collection.sufficiency === 'MISSING' || collection.sufficiency === 'INSUFFICIENT' ? 'ENRICH' : 'REVIEW';
  else if (contradiction.disposition === 'FAIL') lifecycleAction = 'REJECT';
  else if (contradiction.disposition === 'ABSTAIN') lifecycleAction = candidate.disposition==='PASS'&&corroboration.disposition==='PASS'?'REVIEW':'ENRICH';
  else if (candidate.disposition === 'PASS' && corroboration.disposition === 'PASS') lifecycleAction = 'CONFIRM';
  const lifecycle = result('LIFECYCLE', 'PASS', [`ROUTE_${lifecycleAction}`], [], { action: lifecycleAction });
  return { pipelineVersion: STAGED_CLASSIFICATION_VERSION, stages: [availability, candidate, corroboration, contradiction, lifecycle], lifecycleAction };
}

export function stage(report: StagedClassificationReport, name: ClassificationStageResult['stage']): ClassificationStageResult {
  return report.stages.find(item => item.stage === name)!;
}
