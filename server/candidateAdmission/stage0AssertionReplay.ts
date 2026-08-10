import { createHash } from 'node:crypto';
import { projectEvidenceAssertions } from '../evidenceEngine/documentProjection';
import { classifyEvidenceDocuments } from '../evidenceEngine/documentSemanticProvider';
import { aggregateCreatorFocus } from '../evidenceEngine/creatorFocusAggregation';
import { evaluateCreatorFocusV4 } from '../evidenceEngine/classifierV4';
import type { EvidenceCoverageSnapshot, EvidenceDocumentObservation } from '../evidenceEngine/documentTypes';
import type { EvidenceItem, RawChannelInput } from '../evidenceEngine/types';

const checksum = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

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
    documentAssertions,
    aggregate,
    decision
  };
}
