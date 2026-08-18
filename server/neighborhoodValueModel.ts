export interface NeighborhoodValueInputs {
  relevantNewCreators: number;
  qualityNewCreators: number;
  knownCreators: number;
  coverageGain?: number;          // 0.0 to 1.0
  informationGain?: number;       // 0.0 to 1.0
  frontierExpansionGain?: number; // 0.0 to 1.0
  uncertaintyReduction?: number;  // 0.0 to 1.0
  providerQuotaCost?: number;     // e.g. 100 units
  reviewUnitsCost?: number;       // e.g. 0 or 1
  redundancyRatio?: number;       // 0.0 to 1.0 (overlap / Jaccard)
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
 * Calculates shadow observed marginal value for a neighborhood search execution.
 * Raw new-channel count alone is NOT rewarded; value requires relevant, high-quality
 * creators, coverage/information gain, and low redundancy.
 */
export function calculateObservedMarginalValue(inputs: NeighborhoodValueInputs): ShadowMarginalValueResult['components'] & { totalValue: number } {
  const relGain = Math.min(100, (inputs.relevantNewCreators || 0) * 25);
  const qualGain = Math.min(100, (inputs.qualityNewCreators || 0) * 35);
  const covGain = Math.min(100, (inputs.coverageGain ?? 0.2) * 20);
  const infoGain = Math.min(100, (inputs.informationGain ?? 0.2) * 15);
  const frontierGain = Math.min(100, (inputs.frontierExpansionGain ?? 0.1) * 20);
  const uncReduction = Math.min(100, (inputs.uncertaintyReduction ?? 0.1) * 10);

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
 * Calculates shadow expected marginal value prior to retrieval based on neighborhood history.
 */
export function calculateExpectedMarginalValue(
  historicalAverageYield: { relevantNewRatio: number; qualityNewRatio: number; averageOverlap: number },
  estimatedQuota = 100
): number {
  const expectedRel = historicalAverageYield.relevantNewRatio * 2; // expected count per 10 results
  const expectedQual = historicalAverageYield.qualityNewRatio * 1.5;

  const components = calculateObservedMarginalValue({
    relevantNewCreators: expectedRel,
    qualityNewCreators: expectedQual,
    knownCreators: 5,
    coverageGain: 0.25,
    informationGain: 0.25,
    frontierExpansionGain: 0.2,
    uncertaintyReduction: 0.2,
    providerQuotaCost: estimatedQuota,
    reviewUnitsCost: 0.5,
    redundancyRatio: historicalAverageYield.averageOverlap
  });

  return components.totalValue;
}
