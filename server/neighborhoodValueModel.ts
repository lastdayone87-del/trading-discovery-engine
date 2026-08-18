export interface ObservedValueInputs {
  relevantNewCreators: number;
  qualityNewCreators: number;
  coverageGain?: number;          // 0.0 to 1.0, defaults to 0 if unobserved
  informationGain?: number;       // 0.0 to 1.0, defaults to 0 if unobserved
  frontierExpansionGain?: number; // 0.0 to 1.0, defaults to 0 if unobserved
  uncertaintyReduction?: number;  // 0.0 to 1.0, defaults to 0 if unobserved
  providerQuotaCost?: number;     // e.g. 100
  reviewUnitsCost?: number;       // e.g. 0
  redundancyRatio?: number;       // 0.0 to 1.0
}

export interface PriorNeighborhoodContext {
  priorRelevantNewRatio: number;
  priorQualityNewRatio: number;
  priorAverageOverlap: number;
  priorExecutionsCount: number;
}

export interface ShadowMarginalValueResult {
  expectedMarginalValue: number;
  observedMarginalValue: number;
  components: {
    relevantCreatorGain: number;
    qualityCreatorGain: number;
    coverageGain: number;
    informationGain: number;
    frontierExpansionGain: number;
    uncertaintyReduction: number;
    quotaCostPenalty: number;
    reviewCostPenalty: number;
    redundancyPenalty: number;
  };
}

/**
 * Calculates shadow observed marginal value for a completed query run.
 * Unobserved evidence fields default to 0; no optimistic bonus defaults are awarded.
 */
export function calculateObservedMarginalValue(inputs: ObservedValueInputs): ShadowMarginalValueResult['components'] & { totalValue: number } {
  const relGain = Math.min(100, (inputs.relevantNewCreators || 0) * 25);
  const qualGain = Math.min(100, (inputs.qualityNewCreators || 0) * 35);
  // Zero defaults for unobserved gains — unknown evidence earns zero gain credit
  const covGain = Math.min(100, (inputs.coverageGain ?? 0.0) * 20);
  const infoGain = Math.min(100, (inputs.informationGain ?? 0.0) * 15);
  const frontierGain = Math.min(100, (inputs.frontierExpansionGain ?? 0.0) * 20);
  const uncReduction = Math.min(100, (inputs.uncertaintyReduction ?? 0.0) * 10);

  const quotaPenalty = ((inputs.providerQuotaCost ?? 100) / 100) * 5;
  const reviewPenalty = (inputs.reviewUnitsCost ?? 0) * 8;
  const redundancyPenalty = (inputs.redundancyRatio ?? 0) * 30;

  const grossValue = relGain + qualGain + covGain + infoGain + frontierGain + uncReduction;
  const totalCostAndPenalty = quotaPenalty + reviewPenalty + redundancyPenalty;
  const totalValue = Math.max(0, Math.round((grossValue - totalCostAndPenalty) * 10) / 10);

  return {
    totalValue,
    relevantCreatorGain: Math.round(relGain * 10) / 10,
    qualityCreatorGain: Math.round(qualGain * 10) / 10,
    coverageGain: Math.round(covGain * 10) / 10,
    informationGain: Math.round(infoGain * 10) / 10,
    frontierExpansionGain: Math.round(frontierGain * 10) / 10,
    uncertaintyReduction: Math.round(uncReduction * 10) / 10,
    quotaCostPenalty: Math.round(quotaPenalty * 10) / 10,
    reviewCostPenalty: Math.round(reviewPenalty * 10) / 10,
    redundancyPenalty: Math.round(redundancyPenalty * 10) / 10
  };
}

/**
 * Calculates genuinely predictive expected marginal value BEFORE current run execution.
 * Uses only bounded historical neighborhood context available prior to the run.
 */
export function calculateExpectedMarginalValue(
  priorContext: PriorNeighborhoodContext,
  estimatedQuota = 100
): number {
  // If no prior executions exist in neighborhood, use unobserved cold-start baseline
  if (priorContext.priorExecutionsCount === 0) {
    return calculateObservedMarginalValue({
      relevantNewCreators: 0,
      qualityNewCreators: 0,
      coverageGain: 0,
      informationGain: 0,
      frontierExpansionGain: 0,
      uncertaintyReduction: 0,
      providerQuotaCost: estimatedQuota,
      reviewUnitsCost: 0,
      redundancyRatio: 0
    }).totalValue;
  }

  const expectedRel = priorContext.priorRelevantNewRatio * 2.0; // expected count per batch
  const expectedQual = priorContext.priorQualityNewRatio * 1.5;

  const components = calculateObservedMarginalValue({
    relevantNewCreators: expectedRel,
    qualityNewCreators: expectedQual,
    coverageGain: priorContext.priorRelevantNewRatio,
    informationGain: priorContext.priorQualityNewRatio,
    frontierExpansionGain: Math.max(0, 1.0 - priorContext.priorAverageOverlap),
    uncertaintyReduction: 0,
    providerQuotaCost: estimatedQuota,
    reviewUnitsCost: 0,
    redundancyRatio: priorContext.priorAverageOverlap
  });

  return components.totalValue;
}
