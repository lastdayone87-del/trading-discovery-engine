import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClassificationStages, stage } from './stagedClassification';
import { evaluateUnifiedDecisionPolicy } from './decisionPolicy';
import { ConfigurableWeightedStrategy } from './scoringEngine';
import { ENGINE_VERSIONS } from './config';
import { getLayeredKnowledgeContext } from './knowledgePacks';
import { calibrateSemanticConfidence } from './semanticCalibration';
import type { EvidenceCollectionReport, EvidenceItem } from './types';

/**
 * Pre-PR baseline pins for the Gemini semantic path. Every gate below ran
 * byte-identically before the Groq integration (which only widened source
 * filters to also admit groq_semantic), so these assertions prove Gemini
 * behavior is unchanged.
 */

function geminiUnrelated(): EvidenceItem {
  const rawConfidence = 96;
  const calibratedConfidence = calibrateSemanticConfidence(rawConfidence);
  const rawWeight = 26;
  return {
    id: 'gemini-unrelated',
    source: 'gemini_semantic',
    polarity: 'NEGATIVE',
    category: 'IRRELEVANT_DOMAIN',
    fact: 'Multilingual semantic evidence [UNRELATED]: sports commentary.',
    rawMatches: ['sports commentary'],
    confidence: calibratedConfidence,
    reliability: 'MEDIUM',
    reliabilityMultiplier: 0.65,
    rawWeight,
    finalWeight: -(rawWeight * 0.65 * (calibratedConfidence / 100)),
    timestamp: new Date(0).toISOString(),
    provenance: {
      provider: 'gemini_semantic',
      type: 'IRRELEVANT_DOMAIN',
      matchedTerm: 'sports commentary',
      sourceRef: 'structured-semantic:gemini-3.6-flash',
      fields: [{ field: 'channel_bio', sourceId: 'about' }],
      semantic: {
        modelVersion: 'gemini-3.6-flash',
        promptVersion: 'priority2-multilingual-structured-1',
        featureVersion: 'field-aware-evidence-1',
        calibrationVersion: 'multilingual-semantic-calibration-bootstrap-1',
        taxonomyLabel: 'UNRELATED',
        rawConfidence,
        calibratedConfidence,
        detectedLanguages: [],
        reasonCodes: ['CREATOR_FOCUS_UNRELATED'],
      },
    },
  } as EvidenceItem;
}

function geminiTradingPositive(): EvidenceItem {
  return {
    id: 'gemini-trading',
    source: 'gemini_semantic',
    polarity: 'POSITIVE',
    category: 'METHODOLOGY_CONCEPT',
    fact: 'Multilingual semantic evidence [ACTIVE_TRADING]: teaches price action.',
    rawMatches: ['price action'],
    confidence: 84,
    reliability: 'MEDIUM',
    reliabilityMultiplier: 0.65,
    rawWeight: 24,
    finalWeight: 24 * 0.65 * 0.84,
    timestamp: new Date(0).toISOString(),
    provenance: {
      provider: 'gemini_semantic',
      type: 'METHODOLOGY_CONCEPT',
      matchedTerm: 'price action',
      sourceRef: 'structured-semantic:gemini-3.6-flash',
      semantic: {
        modelVersion: 'gemini-3.6-flash',
        promptVersion: 'priority2-multilingual-structured-1',
        featureVersion: 'field-aware-evidence-1',
        calibrationVersion: 'multilingual-semantic-calibration-bootstrap-1',
        taxonomyLabel: 'ACTIVE_TRADING',
        rawConfidence: 96,
        calibratedConfidence: 84,
        detectedLanguages: [],
        reasonCodes: [],
      },
    },
  } as EvidenceItem;
}

function sufficientCollection(): EvidenceCollectionReport {
  return {
    sufficiency: 'SUFFICIENT',
    sparseMetadata: false,
    degraded: false,
    fieldsPresent: ['description', 'video_titles'],
    reasonCodes: [],
    providers: [{ provider: 'gemini_semantic', availability: 'AVAILABLE', evidenceCount: 1, outcome: 'EXECUTED_WITH_EVIDENCE', reasonCodes: ['PROVIDER_EVIDENCE_EMITTED'] }],
    terminalNegativeSufficiency: {
      status: 'SUFFICIENT',
      creatorLevelCoverage: true,
      independentSourceFamilies: 2,
      independentObservations: 2,
      reasonCodes: ['CREATOR_LEVEL_NEGATIVE_COVERAGE'],
    },
  };
}

const input = { channel_name: 'Sports Podcast', description: 'A sports and entertainment podcast.' };

test('gemini UNRELATED filtering still reaches the terminal reject path', () => {
  const report = evaluateClassificationStages(input, [geminiUnrelated()], sufficientCollection());
  assert.equal(stage(report, 'CONTRADICTION').disposition, 'FAIL');
  assert.ok(stage(report, 'CONTRADICTION').reasonCodes.includes('CREATOR_LEVEL_SEMANTIC_UNRELATED_CANDIDATE'));
  assert.equal(report.lifecycleAction, 'REJECT');
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: [geminiUnrelated()], collection: sufficientCollection(), lifecycleAction: 'REJECT',
    minimumPositiveWeight: 25, minimumTradingScore: 68,
  });
  assert.equal(decision.status, 'NON_TRADING');
  assert.ok(decision.reasonCodes.includes('HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED'));
});

test('gemini positive filtering still seats the semantic candidate', () => {
  const report = evaluateClassificationStages(input, [geminiTradingPositive()], sufficientCollection());
  assert.equal(stage(report, 'CANDIDATE_DETECTION').disposition, 'PASS');
  assert.ok(stage(report, 'CANDIDATE_DETECTION').reasonCodes.includes('SEMANTIC_CANDIDATE_FOUND'));
});

test('gemini field inference still attributes the four creator-level fields', () => {
  const item = geminiTradingPositive();
  delete (item.provenance as unknown as Record<string, unknown>).fields;
  const report = evaluateClassificationStages(input, [item], sufficientCollection());
  assert.deepEqual(stage(report, 'CANDIDATE_DETECTION').fields, [
    { field: 'channel_title' },
    { field: 'channel_bio' },
    { field: 'video_title' },
    { field: 'video_description' },
  ]);
});

test('gemini scoring summary keeps the provenance model with constant fallback', () => {
  const context = getLayeredKnowledgeContext('United States');
  const withProvenance = new ConfigurableWeightedStrategy().evaluateDecision(
    [geminiUnrelated()], context, 'United States', sufficientCollection(),
  );
  assert.equal(withProvenance.geminiSemanticSummary?.isTrading, 'NO');
  assert.equal(withProvenance.geminiSemanticSummary?.modelUsed, 'gemini-3.6-flash');
  assert.deepEqual(withProvenance.geminiSemanticSummary?.concepts, ['sports commentary']);

  const legacy = { ...geminiUnrelated(), provenance: { provider: 'gemini_semantic', type: 'IRRELEVANT_DOMAIN', matchedTerm: 'sports', sourceRef: 'legacy' } } as EvidenceItem;
  const fallback = new ConfigurableWeightedStrategy().evaluateDecision(
    [legacy], context, 'United States', sufficientCollection(),
  );
  assert.equal(fallback.geminiSemanticSummary?.modelUsed, ENGINE_VERSIONS.geminiModelVersion);
});

test('gemini abstentions audit as UNCERTAIN, never trading approval', () => {
  const abstained: EvidenceItem = {
    id: 'gemini-abstained', source: 'gemini_semantic', polarity: 'POSITIVE', category: 'SEMANTIC_ABSTENTION',
    fact: 'Multilingual semantic evidence [AMBIGUOUS]: abstained.', rawMatches: [],
    confidence: 35, reliability: 'LOWER', reliabilityMultiplier: 0.4, rawWeight: 0, finalWeight: 0,
    timestamp: new Date(0).toISOString(),
    provenance: {
      provider: 'gemini_semantic', type: 'SEMANTIC_ABSTENTION', matchedTerm: 'AMBIGUOUS', sourceRef: 'structured-semantic:gemini-3.6-flash',
      semantic: {
        modelVersion: 'gemini-3.6-flash', promptVersion: 'priority2-multilingual-structured-1', featureVersion: 'field-aware-evidence-1',
        calibrationVersion: 'multilingual-semantic-calibration-bootstrap-1', taxonomyLabel: 'AMBIGUOUS',
        rawConfidence: 52, calibratedConfidence: 35, detectedLanguages: [], reasonCodes: ['SEMANTIC_MODEL_ABSTAINED'],
      },
    },
  };
  const context = getLayeredKnowledgeContext('United States');
  const decision = new ConfigurableWeightedStrategy().evaluateDecision(
    [abstained], context, 'United States', sufficientCollection(),
  );
  assert.equal(decision.geminiSemanticSummary?.isTrading, 'UNCERTAIN');
});
