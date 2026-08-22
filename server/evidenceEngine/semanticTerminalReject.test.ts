import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClassificationStages } from './stagedClassification';
import { evaluateUnifiedDecisionPolicy, SEMANTIC_UNRELATED_TERMINAL_MIN_CONFIDENCE } from './decisionPolicy';
import { calibrateSemanticConfidence, SEMANTIC_TOP_CALIBRATED_CONFIDENCE } from './semanticCalibration';
import type { EvidenceCollectionReport, EvidenceItem } from './types';

function semanticUnrelated(rawConfidence = 96, fields: any[] = [{ field: 'channel_bio', sourceId: 'about' }], taxonomyLabel = 'UNRELATED'): EvidenceItem {
  const calibratedConfidence = calibrateSemanticConfidence(rawConfidence);
  const rawWeight = 26;
  return {
    id: 'semantic-unrelated',
    source: 'gemini_semantic',
    polarity: 'NEGATIVE',
    category: taxonomyLabel === 'UNRELATED' ? 'IRRELEVANT_DOMAIN' : 'NON_TRADING_ADJACENT',
    fact: 'Multilingual semantic evidence [UNRELATED]: The content is a sports and entertainment podcast with no financial or trading focus.',
    rawMatches: ['sports podcast', 'entertainment', 'NFL history'],
    confidence: calibratedConfidence,
    reliability: 'MEDIUM',
    reliabilityMultiplier: 0.65,
    rawWeight,
    finalWeight: -(rawWeight * 0.65 * (calibratedConfidence / 100)),
    timestamp: new Date(0).toISOString(),
    provenance: {
      provider: 'gemini_semantic',
      type: taxonomyLabel === 'UNRELATED' ? 'IRRELEVANT_DOMAIN' : 'NON_TRADING_ADJACENT',
      matchedTerm: 'sports podcast, entertainment, NFL history',
      sourceRef: 'structured-semantic:gemini-3.6-flash',
      fields,
      semantic: {
        modelVersion: 'gemini-3.6-flash',
        promptVersion: 'priority2-multilingual-structured-1',
        featureVersion: 'field-aware-evidence-1',
        calibrationVersion: 'multilingual-semantic-calibration-bootstrap-1',
        taxonomyLabel,
        rawConfidence,
        calibratedConfidence,
        detectedLanguages: [],
        reasonCodes: ['CREATOR_FOCUS_UNRELATED']
      }
    }
  } as EvidenceItem;
}

function makeCollection(status: 'SUFFICIENT' | 'INSUFFICIENT' = 'SUFFICIENT', creatorLevelCoverage = status === 'SUFFICIENT'): EvidenceCollectionReport {
  return {
    sufficiency: 'SUFFICIENT',
    sparseMetadata: false,
    degraded: false,
    fieldsPresent: ['description', 'video_titles'],
    reasonCodes: [],
    providers: [{ provider: 'gemini_semantic', availability: 'AVAILABLE', evidenceCount: 1, outcome: 'EXECUTED_WITH_EVIDENCE', reasonCodes: ['PROVIDER_EVIDENCE_EMITTED'] }],
    terminalNegativeSufficiency: {
      status,
      creatorLevelCoverage,
      independentSourceFamilies: creatorLevelCoverage ? 2 : 0,
      independentObservations: creatorLevelCoverage ? 2 : 1,
      reasonCodes: status === 'SUFFICIENT' ? ['CREATOR_LEVEL_NEGATIVE_COVERAGE'] : ['TERMINAL_NEGATIVE_EVIDENCE_INSUFFICIENT']
    }
  };
}

const input = {
  channel_name: 'Games With Names',
  description: 'Games With Names is a sports and entertainment podcast focused on NFL history, wrestling, classic games, and interviews with athletes.'
};

function decide(evidence: EvidenceItem[], collection = makeCollection()) {
  const stages = evaluateClassificationStages(input, evidence, collection);
  return {
    stages,
    decision: evaluateUnifiedDecisionPolicy({
      evidence,
      collection,
      lifecycleAction: stages.lifecycleAction,
      minimumPositiveWeight: 25,
      minimumTradingScore: 68
    })
  };
}

test('terminal floor matches the highest confidence tier the production calibration can emit', () => {
  assert.equal(calibrateSemanticConfidence(100), 84);
  assert.equal(SEMANTIC_TOP_CALIBRATED_CONFIDENCE, 84);
  assert.equal(SEMANTIC_UNRELATED_TERMINAL_MIN_CONFIDENCE, SEMANTIC_TOP_CALIBRATED_CONFIDENCE);
});

test('production-shaped Games With Names evidence becomes NON_TRADING below the global negative-weight threshold', () => {
  const evidence = [semanticUnrelated(96)];
  assert.equal(evidence[0].confidence, 84);
  assert.ok(Math.abs(evidence[0].finalWeight + 14.196) < 0.001);

  const { stages, decision } = decide(evidence);
  assert.equal(stages.lifecycleAction, 'REJECT');
  assert.equal(decision.status, 'NON_TRADING');
  assert.ok(decision.reasonCodes.includes('HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED'));
});

test('semantic UNRELATED below the top calibrated confidence tier remains UNCERTAIN', () => {
  const evidence = [semanticUnrelated(88)];
  assert.equal(evidence[0].confidence, 75);
  const { stages, decision } = decide(evidence);
  assert.equal(stages.lifecycleAction, 'REJECT');
  assert.equal(decision.status, 'UNCERTAIN');
  assert.ok(decision.reasonCodes.includes('SCORE_BOUNDARY_NOT_SATISFIED'));
});

test('substantive positive trading evidence blocks the semantic shortcut', () => {
  const positive: EvidenceItem = {
    id: 'positive', source: 'channel_metadata', polarity: 'POSITIVE', category: 'TERMINOLOGY', fact: 'Trading term', rawMatches: ['futures'], confidence: 80,
    reliability: 'HIGH', reliabilityMultiplier: 0.8, rawWeight: 10, finalWeight: 6.4, timestamp: new Date(0).toISOString(),
    provenance: { provider: 'channel_metadata', type: 'metadata', matchedTerm: 'futures', sourceRef: 'channel_bio', fields: [{ field: 'channel_bio', sourceId: 'about' }] }
  };
  const { decision } = decide([semanticUnrelated(96), positive]);
  assert.equal(decision.status, 'UNCERTAIN');
  assert.ok(!decision.reasonCodes.includes('HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED'));
});

test('semantic evidence from one isolated video cannot use the shortcut', () => {
  const { decision } = decide([semanticUnrelated(96, [{ field: 'video_title', sourceId: 'video-1', sourceFamilyId: 'youtube-video:1' }])]);
  assert.equal(decision.status, 'UNCERTAIN');
});

test('direct confirmation cannot rely on weak video-title terminology alone', () => {
  const weakTitle: EvidenceItem = {
    id: 'weak-title', source: 'video_metadata', polarity: 'POSITIVE', category: 'TERMINOLOGY', fact: 'Trading term in a title', rawMatches: ['trading'], confidence: 90,
    reliability: 'HIGH', reliabilityMultiplier: 0.85, rawWeight: 40, finalWeight: 35, timestamp: new Date(0).toISOString(),
    provenance: { provider: 'video_metadata', type: 'terminology', matchedTerm: 'trading', sourceRef: 'video-1', fields: [{ field: 'video_title', sourceId: 'video-1' }] }
  };
  const decision = evaluateUnifiedDecisionPolicy({ evidence: [weakTitle], collection: makeCollection(), lifecycleAction: 'CONFIRM', minimumPositiveWeight: 25, minimumTradingScore: 68 });
  assert.equal(decision.status, 'UNCERTAIN');
  assert.ok(decision.reasonCodes.includes('SUBSTANTIVE_POSITIVE_EVIDENCE_REQUIRED'));
});

test('repeated independent creator videos can establish creator-level UNRELATED', () => {
  const repeated = semanticUnrelated(96, [
    { field: 'video_title', sourceId: 'video-1', sourceFamilyId: 'youtube-video:1' },
    { field: 'video_description', sourceId: 'video-2', sourceFamilyId: 'youtube-video:2' },
    { field: 'video_title', sourceId: 'video-3', sourceFamilyId: 'youtube-video:3' }
  ]);
  const { decision } = decide([repeated]);
  assert.equal(decision.status, 'NON_TRADING');
  assert.ok(decision.reasonCodes.includes('HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED'));
});

test('multiple fields from the same video family are still one observation', () => {
  const correlated = semanticUnrelated(96, [
    { field: 'video_title', sourceId: 'video-1-title', sourceFamilyId: 'youtube-video:1' },
    { field: 'video_description', sourceId: 'video-1-description', sourceFamilyId: 'youtube-video:1' }
  ]);
  const { decision } = decide([correlated]);
  assert.equal(decision.status, 'UNCERTAIN');
});

test('repeated video semantics cannot bypass missing creator-level negative coverage', () => {
  const repeated = semanticUnrelated(96, [
    { field: 'video_title', sourceId: 'video-1', sourceFamilyId: 'youtube-video:1' },
    { field: 'video_title', sourceId: 'video-2', sourceFamilyId: 'youtube-video:2' }
  ]);
  const { decision } = decide([repeated], makeCollection('SUFFICIENT', false));
  assert.equal(decision.status, 'UNCERTAIN');
});

test('substantive creator trading evidence also blocks repeated-video rejection', () => {
  const repeated = semanticUnrelated(96, [
    { field: 'video_title', sourceId: 'video-1', sourceFamilyId: 'youtube-video:1' },
    { field: 'video_title', sourceId: 'video-2', sourceFamilyId: 'youtube-video:2' }
  ]);
  const positive: EvidenceItem = {
    id: 'creator-trading-positive', source: 'channel_metadata', polarity: 'POSITIVE', category: 'METHODOLOGY_CONCEPT', fact: 'Creator teaches trading methodology', rawMatches: ['risk management'], confidence: 90,
    reliability: 'HIGH', reliabilityMultiplier: 0.8, rawWeight: 12, finalWeight: 8.64, timestamp: new Date(0).toISOString(),
    provenance: { provider: 'channel_metadata', type: 'methodology', matchedTerm: 'risk management', sourceRef: 'channel_bio', fields: [{ field: 'channel_bio', sourceId: 'about' }] }
  };
  const { decision } = decide([repeated, positive]);
  assert.equal(decision.status, 'UNCERTAIN');
});

test('taxonomy other than UNRELATED cannot use the shortcut', () => {
  const { decision } = decide([semanticUnrelated(96, [{ field: 'channel_bio', sourceId: 'about' }], 'PERSONAL_FINANCE')]);
  assert.equal(decision.status, 'UNCERTAIN');
});

test('insufficient terminal-negative coverage cannot use the shortcut', () => {
  const collection = makeCollection('INSUFFICIENT');
  const { decision } = decide([semanticUnrelated(96)], collection);
  assert.equal(decision.status, 'UNCERTAIN');
});

test('ordinary negative evidence below -25 remains UNCERTAIN without semantic terminal conditions', () => {
  const evidence: EvidenceItem[] = [{
    id: 'ordinary-negative', source: 'channel_metadata', polarity: 'NEGATIVE', category: 'IRRELEVANT_DOMAIN', fact: 'Non-trading hint', rawMatches: ['sports'], confidence: 90,
    reliability: 'MEDIUM', reliabilityMultiplier: 0.65, rawWeight: 20, finalWeight: -14.2, timestamp: new Date(0).toISOString(),
    provenance: { provider: 'channel_metadata', type: 'metadata', matchedTerm: 'sports', sourceRef: 'channel_bio', fields: [{ field: 'channel_bio', sourceId: 'about' }] }
  }];
  const { decision } = decide(evidence);
  assert.equal(decision.status, 'UNCERTAIN');
});