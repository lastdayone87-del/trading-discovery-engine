import { ScoringEngineConfig, VerificationEngineVersions } from './types';

export const ENGINE_VERSIONS: VerificationEngineVersions = {
  evidenceEngineVersion: '1.3.0',
  decisionEngineVersion: '1.3.0',
  scoringEngineVersion: '1.3.0',
  knowledgePackVersion: '1.2.0',
  geminiModelVersion: 'gemini-3.6-flash'
};

export const EXTERNAL_SCORING_CONFIG: ScoringEngineConfig = {
  minVerifiedTradingScore: 65,
  maxVerifiedNonTradingScore: 25,
  minMultiVideoConsistency: 0.35,
  minPositiveWeightTrading: 20,
  maxPositiveWeightNonTrading: 10,
  reliabilityWeights: {
    VERY_HIGH: 1.0,
    HIGH: 0.85,
    MEDIUM: 0.65,
    LOWER: 0.40
  }
};

/**
 * Dynamic configuration loader allowing runtime adjustments during regression benchmarks or production tuning
 */
let currentScoringConfig: ScoringEngineConfig = { ...EXTERNAL_SCORING_CONFIG };

export function getScoringConfig(): ScoringEngineConfig {
  return currentScoringConfig;
}

export function updateScoringConfig(newConfig: Partial<ScoringEngineConfig>): ScoringEngineConfig {
  currentScoringConfig = { ...currentScoringConfig, ...newConfig };
  return currentScoringConfig;
}

export function resetScoringConfig(): void {
  currentScoringConfig = { ...EXTERNAL_SCORING_CONFIG };
}
