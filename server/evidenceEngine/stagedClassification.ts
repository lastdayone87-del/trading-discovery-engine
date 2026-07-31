import type {
  ClassificationStageResult, EvidenceCollectionReport, EvidenceFieldRef, EvidenceItem,
  LifecycleAction, RawChannelInput, StagedClassificationReport
} from './types';

export const STAGED_CLASSIFICATION_VERSION = '2.1.0';

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

/**
 * Builds the diagnostic and policy gates for the staged classifier. Arithmetic is
 * deliberately left to the scoring policy; stages decide whether that score is
 * allowed to become a workflow outcome.
 */
export function evaluateClassificationStages(input: RawChannelInput, evidence: EvidenceItem[], collection: EvidenceCollectionReport): StagedClassificationReport {
  const positive = evidence.filter(item => item.polarity === 'POSITIVE' && item.rawMatches.length > 0);
  const negative = evidence.filter(item => item.polarity === 'NEGATIVE');
  const semantic = positive.filter(item => item.source === 'gemini_semantic' || item.category === 'METHODOLOGY_CONCEPT' || item.category === 'TERMINOLOGY' || item.category === 'INSTRUMENT');
  const strongPositive = positive.filter(item => item.reliability !== 'LOWER' && Math.abs(item.finalWeight) >= 6);
  const corroborating = strongPositive.filter(item => item.category !== 'MULTI_VIDEO_CONSISTENCY');
  const sources = new Set(corroborating.map(item => item.source));
  const fields = uniqueFields(corroborating);
  const attributableFields=corroborating.flatMap(item=>item.provenance?.fields||[]);
  const observations=new Set(attributableFields.map(ref=>`${ref.field}:${ref.sourceId || ref.index || ''}`));
  const observationFamilies=new Set(attributableFields.map(ref=>ref.field==='video_title'||ref.field==='video_description'?'video':ref.field==='playlist_name'||ref.field==='playlist_description'?'playlist':ref.field));
  const repeated = evidence.some(item => item.category === 'MULTI_VIDEO_CONSISTENCY' && item.polarity === 'POSITIVE');
  const independentDimensions = new Set(corroborating.map(item => item.category));
  const negativeWeight = negative.reduce((sum, item) => sum + Math.abs(item.finalWeight), 0);
  const positiveWeight = positive.reduce((sum, item) => sum + Math.abs(item.finalWeight), 0);
  const dominantContradiction = negative.length > 0 && (negativeWeight >= 25 || negativeWeight > positiveWeight * 1.5);

  const availability = collection.sufficiency === 'SUFFICIENT' && !collection.degraded
    ? result('AVAILABILITY', 'PASS', ['STAGE_EVIDENCE_SUFFICIENT'], evidence, { sufficiency: collection.sufficiency, degraded: false })
    : result('AVAILABILITY', 'ABSTAIN', collection.reasonCodes.length ? collection.reasonCodes : ['STAGE_EVIDENCE_NOT_READY'], evidence, { sufficiency: collection.sufficiency, degraded: collection.degraded });
  const candidate = semantic.length > 0
    ? result('CANDIDATE_DETECTION', 'PASS', ['SEMANTIC_CANDIDATE_FOUND'], semantic, { candidateSignals: semantic.length })
    : result('CANDIDATE_DETECTION', 'ABSTAIN', ['NO_SEMANTIC_CANDIDATE'], [], { candidateSignals: 0 });
  // Independence is established by separately attributable observations, not by
  // duplicate provider emissions of the same lexical match. Multiple videos,
  // an About page plus a video, or another distinct document family qualify.
  const independentObservations=observations.size>=2 && (observationFamilies.size>=2 || attributableFields.filter(f=>f.field==='video_title'||f.field==='video_description').length>=2);
  const corroborated = corroborating.length > 0 && (repeated || independentObservations || sources.size >= 2 || independentDimensions.size >= 2);
  const corroboration = corroborated
    ? result('CORROBORATION', 'PASS', ['INDEPENDENT_OBSERVATION_CORROBORATION'], corroborating, { sources: sources.size, fields: observations.size, dimensions: independentDimensions.size, repeatedVideos: repeated })
    : result('CORROBORATION', 'ABSTAIN', ['CORROBORATION_REQUIRED'], corroborating, { sources: sources.size, fields: observations.size, dimensions: independentDimensions.size, repeatedVideos: repeated });
  const contradiction = dominantContradiction
    ? result('CONTRADICTION', 'FAIL', ['DOMINANT_AFFIRMATIVE_CONTRADICTION'], negative, { negativeWeight, positiveWeight })
    : result('CONTRADICTION', 'PASS', negative.length ? ['CONTRADICTION_NOT_DOMINANT'] : ['NO_AFFIRMATIVE_CONTRADICTION'], negative, { negativeWeight, positiveWeight });

  let lifecycleAction: LifecycleAction = 'REVIEW';
  if (availability.disposition !== 'PASS') lifecycleAction = collection.sufficiency === 'MISSING' || collection.sufficiency === 'INSUFFICIENT' ? 'ENRICH' : 'REVIEW';
  else if (contradiction.disposition === 'FAIL') lifecycleAction = 'REJECT';
  else if (candidate.disposition === 'PASS' && corroboration.disposition === 'PASS') lifecycleAction = 'CONFIRM';
  const lifecycle = result('LIFECYCLE', 'PASS', [`ROUTE_${lifecycleAction}`], [], { action: lifecycleAction });
  return { pipelineVersion: STAGED_CLASSIFICATION_VERSION, stages: [availability, candidate, corroboration, contradiction, lifecycle], lifecycleAction };
}

export function stage(report: StagedClassificationReport, name: ClassificationStageResult['stage']): ClassificationStageResult {
  return report.stages.find(item => item.stage === name)!;
}
