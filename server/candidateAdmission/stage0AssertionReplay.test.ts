import assert from 'node:assert/strict';
import test from 'node:test';
import { replayCreatorFocusFromDiagnostic } from './stage0AssertionReplay';
import type { EvidenceCoverageSnapshot, EvidenceDocumentObservation } from '../evidenceEngine/documentTypes';
import type { EvidenceItem, RawChannelInput } from '../evidenceEngine/types';

const observedAt = '2026-08-10T12:00:00.000Z';
const subjectEntityId = '00000000-0000-5000-8000-000000000001';

function document(documentKey: string, index: number): EvidenceDocumentObservation {
  return {
    documentKey,
    canonicalDocumentId: `video:${index}`,
    subjectEntityId,
    channelId: 'channel-1',
    documentType: 'VIDEO_TITLE',
    provider: 'youtube',
    providerNativeId: `video-${index}`,
    canonicalLocator: { field: 'video_title', index },
    sourceFamilyId: `video-family-${index}`,
    sourceEntityId: `video-${index}`,
    language: 'en',
    script: 'Latin',
    contentType: 'video',
    publishedAt: '2026-08-01T12:00:00.000Z',
    observedAt,
    normalizedText: index === 0 ? 'ES futures order flow' : 'NQ futures market profile',
    textChecksum: `text-${index}`,
    rawPayloadChecksum: `raw-${index}`,
    provenance: { field: 'video_title', index, source: 'canonical-evidence-plane' },
    schemaVersion: 'evidence-document-v1'
  };
}

function evidence(id: string, index: number, polarity: 'POSITIVE' | 'NEGATIVE', taxonomyLabel: string): EvidenceItem {
  return {
    id,
    source: 'video_metadata',
    polarity,
    category: polarity === 'POSITIVE' ? 'INSTRUMENT' : 'IRRELEVANT_DOMAIN',
    fact: polarity === 'POSITIVE' ? 'Trading instrument evidence' : 'Unrelated creator evidence',
    rawMatches: [polarity === 'POSITIVE' ? 'futures' : 'sports'],
    confidence: 95,
    reliability: 'HIGH',
    reliabilityMultiplier: 1,
    rawWeight: 1,
    finalWeight: polarity === 'POSITIVE' ? 0.95 : -0.95,
    provenance: {
      provider: 'video_metadata',
      type: 'semantic',
      matchedTerm: polarity === 'POSITIVE' ? 'futures' : 'sports',
      sourceRef: `video-${index}`,
      fields: [{ field: 'video_title', index, sourceFamilyId: `video-family-${index}`, sourceId: `video-${index}` }],
      semantic: {
        modelVersion: 'test-model',
        promptVersion: 'test-prompt',
        featureVersion: 'test-features',
        calibrationVersion: 'test-calibration',
        taxonomyLabel,
        rawConfidence: 0.95,
        calibratedConfidence: 0.95,
        detectedLanguages: [{ language: 'en', script: 'Latin', confidence: 1, field: 'video_title' }],
        reasonCodes: []
      }
    },
    timestamp: observedAt
  };
}

const rawInput: RawChannelInput = {
  channel_id: 'channel-1',
  channel_entity_id: subjectEntityId,
  channel_name: 'Replay Fixture',
  description: 'Fixture'
};

const coverage: EvidenceCoverageSnapshot = {
  snapshotKey: 'coverage-1',
  channelId: 'channel-1',
  subjectEntityId,
  requestedSamplingStrategy: {},
  observedDocumentCounts: { VIDEO_TITLE: 2 },
  temporalCoverage: {},
  languageCoverage: {},
  independentFamilyCount: 2,
  providerAvailability: [],
  acquisitionFailures: [],
  expectedDocumentCount: 2,
  observedDocumentCount: 2,
  completenessDisposition: 'SUFFICIENT',
  reasonCodes: [],
  inputChecksum: 'coverage-input',
  policyVersion: 'test-coverage-policy',
  schemaVersion: 'evidence-coverage-v1',
  observedAt
};

const documents = [document('doc-1', 0), document('doc-2', 1)];

test('replay is deterministic and never claims persistence or serving authority', () => {
  const evidenceItems = [evidence('ev-1', 0, 'POSITIVE', 'ACTIVE_TRADING'), evidence('ev-2', 1, 'POSITIVE', 'ACTIVE_TRADING')];
  const first = replayCreatorFocusFromDiagnostic({ channelId: 'channel-1', rawInput, evidenceItems, documents, coverage });
  const second = replayCreatorFocusFromDiagnostic({ channelId: 'channel-1', rawInput, evidenceItems, documents, coverage });
  assert.deepEqual(first, second);
  assert.equal(first.persisted, false);
  assert.equal(first.servingAuthority, false);
  assert.equal(first.automaticPromotion, false);
  assert.equal(first.assertionCount, 2);
  assert.ok(first.aggregate.tradingMass > 0.9);
});

test('replay distinguishes affirmative unrelated evidence from trading evidence', () => {
  const unrelated = [evidence('ev-3', 0, 'NEGATIVE', 'UNRELATED'), evidence('ev-4', 1, 'NEGATIVE', 'UNRELATED')];
  const result = replayCreatorFocusFromDiagnostic({ channelId: 'channel-1', rawInput, evidenceItems: unrelated, documents, coverage });
  assert.equal(result.assertionCount, 2);
  assert.ok(result.aggregate.alternativeMass > 0.9);
  assert.equal(result.aggregate.tradingMass, 0);
  assert.equal(result.decision.proposedStatus, 'NON_TRADING');
});

test('missing supporting assertions reproduces the ambiguous zero-mass condition', () => {
  const result = replayCreatorFocusFromDiagnostic({ channelId: 'channel-1', rawInput, evidenceItems: [], documents, coverage });
  assert.equal(result.assertionCount, 0);
  assert.equal(result.aggregate.tradingMass, 0);
  assert.equal(result.aggregate.alternativeMass, 0);
  assert.equal(result.decision.proposedStatus, 'UNCERTAIN');
});
