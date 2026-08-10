import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClassificationStages } from './stagedClassification';
import { evaluateUnifiedDecisionPolicy } from './decisionPolicy';
import type { EvidenceCollectionReport, EvidenceItem } from './types';

function semanticUnrelated(calibratedConfidence = 92): EvidenceItem {
  return {
    id: 'semantic-unrelated',
    source: 'gemini_semantic',
    polarity: 'NEGATIVE',
    category: 'IRRELEVANT_DOMAIN',
    fact: 'Creator is a sports podcast unrelated to trading.',
    rawMatches: ['sports', 'podcast'],
    confidence: 96,
    reliability: 'MEDIUM',
    reliabilityMultiplier: 0.65,
    rawWeight: 26,
    finalWeight: -14.2,
    timestamp: new Date(0).toISOString(),
    provenance: {
      provider: 'gemini_semantic',
      type: 'structured-semantic',
      matchedTerm: 'sports',
      sourceRef: 'channel_bio',
      fields: [{ field: 'channel_bio', sourceId: 'about' }],
      semantic: {
        modelVersion: 'gemini-3.6-flash',
        promptVersion: 'test',
        featureVersion: 'test',
        calibrationVersion: 'test',
        taxonomyLabel: 'UNRELATED',
        rawConfidence: 96,
        calibratedConfidence,
        detectedLanguages: [],
        reasonCodes: ['CREATOR_FOCUS_UNRELATED']
      }
    }
  };
}

const collection: EvidenceCollectionReport = {
  sufficiency: 'SUFFICIENT',
  sparseMetadata: false,
  degraded: false,
  fieldsPresent: ['description'],
  reasonCodes: [],
  providers: [{ provider: 'gemini_semantic', availability: 'AVAILABLE', evidenceCount: 1, outcome: 'EXECUTED_WITH_EVIDENCE', reasonCodes: ['PROVIDER_EVIDENCE_EMITTED'] }],
  terminalNegativeSufficiency: {
    status: 'SUFFICIENT',
    creatorLevelCoverage: true,
    independentSourceFamilies: 0,
    independentObservations: 1,
    reasonCodes: ['CREATOR_LEVEL_NEGATIVE_COVERAGE']
  }
};

const input = { channel_name: 'Games With Names', description: 'A sports podcast focused on football history and athletes.' };

test('high-confidence creator-level UNRELATED can become NON_TRADING below the global negative-weight threshold', () => {
  const evidence = [semanticUnrelated(92)];
  const stages = evaluateClassificationStages(input, evidence, collection);
  assert.equal(stages.lifecycleAction, 'REJECT');

  const decision = evaluateUnifiedDecisionPolicy({
    evidence,
    collection,
    lifecycleAction: stages.lifecycleAction,
    minimumPositiveWeight: 25,
    minimumTradingScore: 68
  });
  assert.equal(decision.status, 'NON_TRADING');
  assert.ok(decision.reasonCodes.includes('HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED'));
});

test('semantic UNRELATED below the confidence floor remains UNCERTAIN even when stages route REJECT', () => {
  const evidence = [semanticUnrelated(84)];
  const stages = evaluateClassificationStages(input, evidence, collection);
  assert.equal(stages.lifecycleAction, 'REJECT');
  const decision = evaluateUnifiedDecisionPolicy({ evidence, collection, lifecycleAction: stages.lifecycleAction, minimumPositiveWeight: 25, minimumTradingScore: 68 });
  assert.equal(decision.status, 'UNCERTAIN');
  assert.ok(decision.reasonCodes.includes('SCORE_BOUNDARY_NOT_SATISFIED'));
});

test('substantive positive trading evidence blocks the semantic shortcut', () => {
  const positive: EvidenceItem = {
    id: 'positive', source: 'channel_metadata', polarity: 'POSITIVE', category: 'TERMINOLOGY', fact: 'Trading term', rawMatches: ['futures'], confidence: 80,
    reliability: 'HIGH', reliabilityMultiplier: 0.8, rawWeight: 10, finalWeight: 6.4, timestamp: new Date(0).toISOString(),
    provenance: { provider: 'channel_metadata', type: 'metadata', matchedTerm: 'futures', sourceRef: 'channel_bio', fields: [{ field: 'channel_bio', sourceId: 'about' }] }
  };
  const evidence = [semanticUnrelated(92), positive];
  const stages = evaluateClassificationStages(input, evidence, collection);
  const decision = evaluateUnifiedDecisionPolicy({ evidence, collection, lifecycleAction: stages.lifecycleAction, minimumPositiveWeight: 25, minimumTradingScore: 68 });
  assert.equal(decision.status, 'UNCERTAIN');
  assert.ok(!decision.reasonCodes.includes('HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED'));
});
