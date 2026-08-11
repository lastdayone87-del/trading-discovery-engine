import type { SamplingPolicy } from '../decisionEvaluation';
import type { RetrievalAssignmentPayload } from '../phaseBObservationOutbox';
import type { NominationInput } from './types';

/**
 * Temporary Stage 1 measurement policy.
 *
 * Stage 1 needs independent labels with a retrieval-bound assignment that exists
 * before classification. We capture the full prospective nomination population
 * (100% inclusion) so human review does not have to guess which cases were
 * sampled. This remains evaluation-only: it does not change classification,
 * review eligibility, dashboard visibility, or any serving authority.
 *
 * The salt is intentionally stable but has no selection effect while inclusion
 * is 100%. It only makes assignment identity/randomization reproducible.
 */
export const STAGE1_PROSPECTIVE_SAMPLING_POLICY: SamplingPolicy = {
  policyKey: 'stage1-prospective-census',
  version: 1,
  salt: 'stage1-prospective-census-v1',
  protectedAuditBasisPoints: 10000,
  targetedAuditBasisPoints: 0
};

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
