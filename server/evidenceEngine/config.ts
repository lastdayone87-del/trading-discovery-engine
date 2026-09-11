import { ScoringEngineConfig, VerificationEngineVersions } from './types';
import {
  DEFAULT_MULTILINGUAL_ADJUDICATOR_MODEL,
  DEFAULT_MULTILINGUAL_CANDIDATE_MODEL,
} from './providers/GeminiSemanticProvider';

export const ENGINE_VERSIONS: VerificationEngineVersions = {
  evidenceEngineVersion: '3.0.0',
  decisionEngineVersion: '3.0.0',
  scoringEngineVersion: '3.0.0',
  knowledgePackVersion: '1.2.0',
  // Derived from the paid semantic provider defaults so version/audit
  // metadata always describes the model configuration that actually ran.
  geminiModelVersion: `${DEFAULT_MULTILINGUAL_CANDIDATE_MODEL} / ${DEFAULT_MULTILINGUAL_ADJUDICATOR_MODEL} adjudicator`
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
