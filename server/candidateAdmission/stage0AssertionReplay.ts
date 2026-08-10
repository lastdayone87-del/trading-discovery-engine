import { createHash } from 'node:crypto';
import { projectEvidenceAssertions } from '../evidenceEngine/documentProjection';
import { classifyEvidenceDocuments } from '../evidenceEngine/documentSemanticProvider';
import { aggregateCreatorFocus } from '../evidenceEngine/creatorFocusAggregation';
import { evaluateCreatorFocusV4 } from '../evidenceEngine/classifierV4';
import type { EvidenceCoverageSnapshot, EvidenceDocumentObservation } from '../evidenceEngine/documentTypes';
import type { EvidenceItem, RawChannelInput } from '../evidenceEngine/types';

const checksum = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function supportsDocument(item: EvidenceItem, document: EvidenceDocumentObservation): boolean {
  const refs = item.provenance?.fields || [];
  return refs.some(ref => {
    const provenance = document.provenance as { field?: string; index?: number | null };
    return provenance.field === ref.field
      && (ref.index === undefined || provenance.index === ref.index)
      && (ref.sourceFamilyId === undefined || document.sourceFamilyId === ref.sourceFamilyId)
      && (ref.sourceId === undefined || document.canonicalDocumentId === ref.sourceId || document.providerNativeId === ref.sourceId);
  });
}

function countBy(values: Array<string | undefined>): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = value || 'UNSPECIFIED';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

export function inspectAssertionReplayProjection(evidenceItems: EvidenceItem[], documents: EvidenceDocumentObservation[]) {
  let projectable = 0;
  let droppedNoRawMatches = 0;
  let droppedNoSupportingDocument = 0;
  const projected: EvidenceItem[] = [];
  const dropped: EvidenceItem[] = [];

  for (const item of evidenceItems) {
    const isAbstention = item.category === 'SEMANTIC_ABSTENTION';
    if (!item.rawMatches.length && !isAbstention) {
      droppedNoRawMatches++;
      dropped.push(item);
      continue;
    }
    if (!documents.some(document => supportsDocument(item, document))) {
      droppedNoSupportingDocument++;
      dropped.push(item);
      continue;
    }
    projectable++;
    projected.push(item);
  }

  return {
    evidenceItemCount: evidenceItems.length,
    positiveEvidenceItemCount: evidenceItems.filter(item => item.polarity === 'POSITIVE').length,
    negativeEvidenceItemCount: evidenceItems.filter(item => item.polarity === 'NEGATIVE').length,
    abstentionEvidenceItemCount: evidenceItems.filter(item => item.category === 'SEMANTIC_ABSTENTION').length,
    projectableEvidenceItemCount: projectable,
    droppedNoRawMatches,
    droppedNoSupportingDocument,
    evidenceCategories: countBy(evidenceItems.map(item => item.category)),
    evidencePolarities: countBy(evidenceItems.map(item => item.polarity)),
    semanticTaxonomyLabels: countBy(evidenceItems.map(item => item.provenance?.semantic?.taxonomyLabel)),
    projectedSemanticTaxonomyLabels: countBy(projected.map(item => item.provenance?.semantic?.taxonomyLabel)),
    droppedSemanticTaxonomyLabels: countBy(dropped.map(item => item.provenance?.semantic?.taxonomyLabel))
  };
}

/**
 * Pure historical counterfactual for Stage 0.
 *
 * This deliberately does not call runCreatorFocusShadow or any store. It
 * reconstructs the assertion plane from immutable production inputs and the
 * persisted document projection, then runs the existing semantic/focus stack
 * entirely in memory.
 */
export function replayCreatorFocusFromDiagnostic(input: {
  channelId: string;
  rawInput: RawChannelInput;
  evidenceItems: EvidenceItem[];
  documents: EvidenceDocumentObservation[];
  coverage: EvidenceCoverageSnapshot;
  observedAt?: string;
  calibrationApproved?: boolean;
}) {
  const observedAt = input.observedAt || input.coverage.observedAt;
  const projectionDiagnostics = inspectAssertionReplayProjection(input.evidenceItems, input.documents);
  const assertions = projectEvidenceAssertions(
    input.rawInput,
    input.evidenceItems,
    input.documents,
    observedAt
  );
  const documentAssertions = classifyEvidenceDocuments(input.documents, assertions);
  const aggregate = aggregateCreatorFocus(documentAssertions, observedAt);
  const decision = evaluateCreatorFocusV4({
    channelId: input.channelId,
    identityResolved: Boolean(input.coverage.subjectEntityId),
    coverage: input.coverage,
    aggregate,
    calibrationApproved: Boolean(input.calibrationApproved)
  });

  return {
    historicalReplay: true as const,
    persisted: false as const,
    servingAuthority: false as const,
    automaticPromotion: false as const,
    inputChecksum: checksum({
      channelId: input.channelId,
      documentKeys: input.documents.map(document => document.documentKey).sort(),
      evidenceItemIds: input.evidenceItems.map(item => item.id).sort(),
      coverageSnapshotKey: input.coverage.snapshotKey,
      observedAt
    }),
    assertionCount: assertions.length,
    assertionKeys: assertions.map(assertion => assertion.assertionKey).sort(),
    projectionDiagnostics,
    documentAssertions,
    aggregate,
    decision
  };
}
