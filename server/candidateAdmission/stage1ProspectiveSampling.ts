import type { SamplingPolicy } from '../decisionEvaluation';
import type { RetrievalAssignmentPayload } from '../phaseBObservationOutbox';
import type { NominationInput } from './types';

/**
 * Temporary Stage 1 measurement policy.
 *
 * Stage 1 needs independent labels with a retrieval-bound assignment that exists
 * before classification. We capture the full prospective population that will
 * actually cross the classification boundary (100% inclusion). Already terminal
 * or stable channels are excluded because the ingestion pipeline short-circuits
 * them before producing a new diagnostic; assigning those rows would create
 * unusable assignment-without-diagnostic lineage.
 *
 * This remains evaluation-only: it does not change classification, review
 * eligibility, dashboard visibility, or any serving authority.
 */
export const STAGE1_PROSPECTIVE_SAMPLING_POLICY: SamplingPolicy = {
  policyKey: 'stage1-prospective-census',
  version: 1,
  salt: 'stage1-prospective-census-v1',
  protectedAuditBasisPoints: 10000,
  targetedAuditBasisPoints: 0
};

export interface ExistingStage1ChannelState {
  country_status?: string | null;
  trading_status?: string | null;
  scan_status?: string | null;
}

/** Mirrors the automated-ingestion short-circuit boundary. */
export function stage1ProspectiveNominationEligible(existing?: ExistingStage1ChannelState | null): boolean {
  if (!existing) return true;
  return !(
    existing.country_status === 'REJECTED' ||
    existing.trading_status === 'NON_TRADING' ||
    existing.trading_status === 'HUMAN_REJECTED' ||
    existing.trading_status === 'TRADING_CONFIRMED' ||
    existing.scan_status === 'SKIPPED_EXCLUDED' ||
    existing.scan_status === 'SKIPPED_NON_TRADING' ||
    existing.scan_status === 'COMPLETED'
  );
}

export function buildStage1ProspectiveRetrievalAssignment(
  input: NominationInput,
  observedAt: string
): RetrievalAssignmentPayload {
  return {
    type: 'RETRIEVAL_ASSIGNMENT',
    input: {
      channelId: input.channelId,
      targetCountry: input.country,
      discoveryOrigin: input.sourceType,
      language: input.declaredLanguage,
      observedAt,
      context: {
        stage: 'STAGE1_PROSPECTIVE',
        nominationSourceActionId: input.sourceActionId || null,
        queryId: input.queryId || null,
        queryRunId: input.queryRunId || null,
        jobId: input.jobId || null,
        retrievalLane: input.retrievalLane || null,
        searchOrdering: input.searchOrdering || null,
        pageNumber: input.pageNumber || null,
        resultRank: input.resultRank || null
      }
    },
    policy: STAGE1_PROSPECTIVE_SAMPLING_POLICY
  };
}
