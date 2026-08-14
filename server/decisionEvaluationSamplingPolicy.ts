import type { SamplingPolicy } from './decisionEvaluation';

export function buildDecisionEvaluationSamplingPolicy(rawSalt: string | undefined): SamplingPolicy | null {
  const salt = rawSalt?.trim();
  if (!salt) return null;

  return {
    policyKey: 'protected-audit',
    version: 1,
    salt,
    protectedAuditBasisPoints: 100,
    targetedAuditBasisPoints: 0,
  };
}
