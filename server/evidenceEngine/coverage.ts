import type { EvidenceCollectionReport, RawChannelInput } from './types';
import { EVIDENCE_COVERAGE_SCHEMA_VERSION, type EvidenceCoverageSnapshot, type EvidenceDocumentObservation } from './documentTypes';
import { DEFAULT_DOCUMENT_SAMPLING, type DocumentSamplingStrategy } from './documentSampling';
import { evidenceDocumentChecksum } from './documentProjection';
import { assessDocumentIndependence } from './documentIndependence';

export const EVIDENCE_COVERAGE_POLICY_VERSION = 'evidence-coverage-policy-v1';

export function buildEvidenceCoverageSnapshot(
  input: RawChannelInput,
  documents: EvidenceDocumentObservation[],
  collection: EvidenceCollectionReport,
  observedAt: string,
  classificationDiagnosticId?: string,
  strategy: DocumentSamplingStrategy = DEFAULT_DOCUMENT_SAMPLING
): EvidenceCoverageSnapshot {
  const channelId = documents[0]?.channelId || input.channel_id || 'unknown';
  const subjectEntityId = documents[0]?.subjectEntityId || input.channel_entity_id || '00000000-0000-5000-8000-000000000000';
  const counts = documents.reduce<Record<string, number>>((all, document) => {
    all[document.documentType] = (all[document.documentType] || 0) + 1;
    return all;
  }, {});
  const published = documents.map(document => document.publishedAt).filter((value): value is string => Boolean(value)).sort();
  const languages = [...new Set(documents.map(document => document.language).filter((value): value is string => Boolean(value)))].sort();
  const independence = assessDocumentIndependence(documents);
  const failures = collection.providers.filter(provider => provider.availability === 'FAILED').map(provider => ({
    provider: provider.provider, outcome: provider.outcome, reasonCodes: provider.reasonCodes
  }));
  const expectedDocumentCount = (strategy.includeChannelDocuments ? 2 : 0) + strategy.latestVideos * 2 + strategy.playlists + strategy.transcripts;
  const inputChecksum = evidenceDocumentChecksum({
    input: { channelId, country: input.country, enrichmentStage: input.enrichment_stage },
    documentKeys: documents.map(document => document.documentKey).sort(), collection, strategy
  });
  const snapshotKey = evidenceDocumentChecksum({ classificationDiagnosticId: classificationDiagnosticId || null, inputChecksum, policy: EVIDENCE_COVERAGE_POLICY_VERSION });
  return {
    snapshotKey, channelId, subjectEntityId, classificationDiagnosticId,
    requestedSamplingStrategy: { ...strategy }, observedDocumentCounts: counts,
    temporalCoverage: { publishedDocumentCount: published.length, oldestPublishedAt: published[0] || null, latestPublishedAt: published.at(-1) || null },
    languageCoverage: { languages, unknownLanguageDocuments: documents.filter(document => !document.language).length },
    independentFamilyCount: independence.independentFamilyCount,
    providerAvailability: collection.providers.map(provider => ({ provider: provider.provider, availability: provider.availability, outcome: provider.outcome, reasonCodes: provider.reasonCodes })),
    acquisitionFailures: failures, oldestDocumentAt: published[0], latestDocumentAt: published.at(-1),
    expectedDocumentCount, observedDocumentCount: documents.length, completenessDisposition: collection.sufficiency,
    reasonCodes: [...collection.reasonCodes, ...(documents.some(document => document.documentType === 'SEARCH_MATCH_CONTEXT') ? ['SEARCH_MATCH_CONTEXT_SEPARATED'] : [])],
    inputChecksum, policyVersion: EVIDENCE_COVERAGE_POLICY_VERSION, schemaVersion: EVIDENCE_COVERAGE_SCHEMA_VERSION, observedAt
  };
}
