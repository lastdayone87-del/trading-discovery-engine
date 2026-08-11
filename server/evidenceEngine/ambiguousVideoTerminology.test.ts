import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateUnifiedDecisionPolicy, qualifiesSemanticUnrelatedTerminalReject } from './decisionPolicy';
import { calibrateSemanticConfidence } from './semanticCalibration';
import type { EvidenceCollectionReport, EvidenceItem } from './types';

const collection: EvidenceCollectionReport = {
  sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false,
  fieldsPresent: ['description', 'video_titles'], reasonCodes: [],
  providers: [{ provider: 'gemini_semantic', availability: 'AVAILABLE', evidenceCount: 1, outcome: 'EXECUTED_WITH_EVIDENCE', reasonCodes: ['PROVIDER_EVIDENCE_EMITTED'] }],
  terminalNegativeSufficiency: { status: 'SUFFICIENT', creatorLevelCoverage: true, independentSourceFamilies: 0, independentObservations: 1, reasonCodes: ['CREATOR_LEVEL_NEGATIVE_COVERAGE'] }
};

function semanticUnrelated(): EvidenceItem {
  const confidence=calibrateSemanticConfidence(96);
  return {
    id:'semantic-unrelated', source:'gemini_semantic', polarity:'NEGATIVE', category:'IRRELEVANT_DOMAIN',
    fact:'Creator is an international electronics and technology company unrelated to finance, investing, or trading.',
    rawMatches:['electronics','engineering','oscilloscopes'], confidence, reliability:'MEDIUM', reliabilityMultiplier:.65,
    rawWeight:26, finalWeight:-(26*.65*(confidence/100)), timestamp:new Date(0).toISOString(),
    provenance:{ provider:'gemini_semantic', type:'IRRELEVANT_DOMAIN', matchedTerm:'electronics, engineering, test equipment', sourceRef:'structured-semantic:gemini-3.6-flash',
      fields:[{field:'channel_bio',sourceId:'about'}], semantic:{ modelVersion:'gemini-3.6-flash', promptVersion:'priority2-multilingual-structured-1', featureVersion:'field-aware-evidence-1', calibrationVersion:'multilingual-semantic-calibration-bootstrap-1', taxonomyLabel:'UNRELATED', rawConfidence:96, calibratedConfidence:confidence, detectedLanguages:[], reasonCodes:['CREATOR_FOCUS_UNRELATED'] } }
  } as EvidenceItem;
}

function terminology(field:'video_title'|'channel_bio', term='options'): EvidenceItem {
  return {
    id:`term-${field}`, source:'video_metadata', polarity:'POSITIVE', category:'TERMINOLOGY', fact:`Recent video uploads cover financial instruments: ${term}`,
    rawMatches:[term], confidence:95, reliability:'VERY_HIGH', reliabilityMultiplier:.9, rawWeight:10, finalWeight:8.55, timestamp:new Date(0).toISOString(),
    provenance:{provider:'video_metadata',type:'metadata',matchedTerm:term,sourceRef:'sample',fields:[{field,sourceId:'sample'}]}
  } as EvidenceItem;
}

test('isolated ambiguous terminology in a video title does not veto creator-level UNRELATED rejection',()=>{
  const evidence=[semanticUnrelated(),terminology('video_title','options')];
  assert.equal(qualifiesSemanticUnrelatedTerminalReject(evidence,collection),true);
  const decision=evaluateUnifiedDecisionPolicy({evidence,collection,lifecycleAction:'REJECT',minimumPositiveWeight:25,minimumTradingScore:68});
  assert.equal(decision.status,'NON_TRADING');
  assert.ok(decision.reasonCodes.includes('HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED'));
});

test('creator-level positive terminology still blocks creator-level UNRELATED shortcut',()=>{
  const evidence=[semanticUnrelated(),terminology('channel_bio','options trading')];
  assert.equal(qualifiesSemanticUnrelatedTerminalReject(evidence,collection),false);
  const decision=evaluateUnifiedDecisionPolicy({evidence,collection,lifecycleAction:'REJECT',minimumPositiveWeight:25,minimumTradingScore:68});
  assert.equal(decision.status,'UNCERTAIN');
});

test('non-terminology positive video evidence remains substantive',()=>{
  const positive=terminology('video_title','options');
  positive.category='METHODOLOGY_CONCEPT';
  positive.fact='Video explicitly teaches an options trading strategy with calls, puts, strikes and expiration.';
  const evidence=[semanticUnrelated(),positive];
  assert.equal(qualifiesSemanticUnrelatedTerminalReject(evidence,collection),false);
});
