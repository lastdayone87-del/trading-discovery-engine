import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurableWeightedStrategy } from './scoringEngine';
import { evaluateClassificationStages } from './stagedClassification';
import { getLayeredKnowledgeContext } from './knowledgePacks';
import type { EvidenceCollectionReport, EvidenceItem } from './types';
import type { RecognitionAssessment } from './recognitionState';

const collection = (overrides: Partial<EvidenceCollectionReport> = {}): EvidenceCollectionReport => ({
  sufficiency: 'SUFFICIENT',
  sparseMetadata: false,
  degraded: false,
  fieldsPresent: ['channel_name', 'video_titles'],
  reasonCodes: [],
  providers: [],
  terminalNegativeSufficiency: {
    status: 'SUFFICIENT',
    creatorLevelCoverage: true,
    independentSourceFamilies: 1,
    independentObservations: 1,
    reasonCodes: ['CREATOR_LEVEL_NEGATIVE_COVERAGE'],
  },
  ...overrides,
});

const negative = (): EvidenceItem => ({
  id: 'gaming',
  source: 'video_metadata',
  polarity: 'NEGATIVE',
  category: 'IRRELEVANT_DOMAIN',
  fact: 'Gaming commentary',
  rawMatches: ['gaming'],
  confidence: 90,
  reliability: 'HIGH',
  reliabilityMultiplier: 0.85,
  rawWeight: 35,
  finalWeight: -30,
  provenance: {
    provider: 'video_metadata',
    type: 'irrelevant-domain',
    matchedTerm: 'gaming',
    sourceRef: 'v1',
    fields: [{ field: 'video_title', sourceId: 'v1', sourceFamilyId: 'video:v1' }],
  },
  timestamp: '2026-01-01T00:00:00Z',
});

const weak = (): EvidenceItem => ({
  id: 'weak',
  source: 'video_metadata',
  polarity: 'POSITIVE',
  category: 'TERMINOLOGY',
  fact: 'Trading terminology',
  rawMatches: ['trading'],
  confidence: 60,
  reliability: 'MEDIUM',
  reliabilityMultiplier: 0.7,
  rawWeight: 12,
  finalWeight: 5,
  provenance: {
    provider: 'video_metadata',
    type: 'terminology',
    matchedTerm: 'trading',
    sourceRef: 'v1',
    fields: [{ field: 'video_title', sourceId: 'v1', sourceFamilyId: 'video:v1' }],
  },
  timestamp: '2026-01-01T00:00:00Z',
});

const ambiguousRecognition = (): RecognitionAssessment => ({
  version: 'recognition-state-v1',
  state: 'AMBIGUOUS_CONFLICT',
  semanticPolicy: 'BOUNDED_WAIT',
  semanticSkippedReason: null,
  gaps: [],
  reasonCodes: [],
  composition: {
    focus: 'MIXED',
    observedFamilies: 1,
    tradingFamilies: 0,
    alternativeFamilies: 1,
    neutralFamilies: 0,
    tradingCoverage: 0,
    alternativeCoverage: 1,
    temporalCoverage: 'KNOWN',
    nonTitleTierAFamilies: 0,
    explicitCreatorTrading: false,
    explicitCreatorAlternative: true,
  },
});

test('a terminal status stays deterministic when recognition is non-decisive', () => {
  const items = [negative()];
  const stages = evaluateClassificationStages({ channel_name: 'Games', description: 'gaming' }, items, collection());
  assert.equal(stages.lifecycleAction, 'REJECT');
  const decision = new ConfigurableWeightedStrategy().evaluateDecision(
    items,
    getLayeredKnowledgeContext('United States'),
    'United States',
    collection(),
    stages,
    undefined,
    ambiguousRecognition(),
  );
  assert.equal(decision.status, 'NON_TRADING');
  // The recognition object abstained, but the unified policy still reached a
  // terminal decision from the dominant attributed contradiction.
  assert.equal(decision.classificationMethod, 'DETERMINISTIC_EVIDENCE');
});

test('a non-terminal status with non-decisive recognition stays heuristic', () => {
  const items = [weak()];
  const stages = evaluateClassificationStages({ channel_name: 'A', description: '' }, items, collection());
  assert.equal(stages.lifecycleAction, 'REVIEW');
  const decision = new ConfigurableWeightedStrategy().evaluateDecision(
    items,
    getLayeredKnowledgeContext('United States'),
    'United States',
    collection(),
    stages,
    undefined,
    ambiguousRecognition(),
  );
  assert.equal(decision.status, 'UNCERTAIN');
  assert.equal(decision.classificationMethod, 'HEURISTIC_ONLY');
});

test('degraded evidence remains degraded even with a non-decisive recognition report', () => {
  const items = [weak()];
  const stages = evaluateClassificationStages({ channel_name: 'A', description: '' }, items, collection({ degraded: true }));
  const decision = new ConfigurableWeightedStrategy().evaluateDecision(
    items,
    getLayeredKnowledgeContext('United States'),
    'United States',
    collection({ degraded: true }),
    stages,
    undefined,
    ambiguousRecognition(),
  );
  assert.equal(decision.status, 'UNCERTAIN');
  assert.equal(decision.classificationMethod, 'DEGRADED_HEURISTIC');
});
