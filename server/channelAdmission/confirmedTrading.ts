import type { RawChannelInput, VerificationDecision } from '../evidenceEngine';
import type { TradingClassificationResult } from '../../src/types';
import type { DiscoveredChannelRaw } from '../youtube';

/**
 * A confident semantic admission is a first-class classification result. It
 * bypasses the deterministic trading-relevance re-decision but still flows
 * through country validation, Discord inspection and quality gates.
 */
export function buildAdmissionConfirmedClassification(
  input: RawChannelInput,
  candidate: DiscoveredChannelRaw,
): { result: TradingClassificationResult; decision: VerificationDecision; input: RawChannelInput } {
  const confidence = Math.max(80, Math.min(100, Number(candidate.admissionTradingConfidence) || 90));
  const category = candidate.admissionCategory || 'General Trading';
  const decision: VerificationDecision = {
    status: 'TRADING_CONFIRMED',
    confidenceScore: confidence,
    category,
    multiVideoConsistencyRatio: 1,
    positiveEvidence: [],
    negativeEvidence: [],
    totalPositiveWeight: 0,
    totalNegativeWeight: 0,
    countryContextUsed: {
      country: input.country || 'UNKNOWN',
      language: input.detected_languages?.[0]?.language || 'UNKNOWN',
      matchedTerms: ['SEMANTIC_ADMISSION'],
      matchedNegativeTerms: [],
    },
    versions: {
      evidenceEngineVersion: 'semantic-admission-v1',
      decisionEngineVersion: 'semantic-admission-v1',
      scoringEngineVersion: 'semantic-admission-v1',
      knowledgePackVersion: 'semantic-admission-v1',
      geminiModelVersion: 'semantic-admission-v1',
    },
    mathematicalJustification: `Semantic admission judged the creator's main subject to be trading with confidence ${confidence}/100. Admission decision ${candidate.admissionDecisionId || 'unknown'} owns this result; country and Discord gates still run.`,
    evidenceCollection: {
      sufficiency: 'SUFFICIENT',
      sparseMetadata: false,
      degraded: false,
      fieldsPresent: ['admission_evidence'],
      reasonCodes: ['SEMANTIC_ADMISSION_CONFIRMED'],
      providers: [],
      terminalNegativeSufficiency: {
        status: 'INSUFFICIENT',
        creatorLevelCoverage: false,
        independentSourceFamilies: 0,
        independentObservations: 0,
        reasonCodes: ['SEMANTIC_ADMISSION_NOT_TERMINAL_NEGATIVE'],
      },
    },
    timestamp: new Date().toISOString(),
    decisionPolicy: {
      version: 'semantic-admission-v1',
      tradingProbability: confidence,
      nonTradingProbability: 100 - confidence,
      coverageConfidence: 100,
      reasonCodes: ['SEMANTIC_ADMISSION_CONFIRMED'],
    },
    classificationMethod: 'SEMANTIC_ADMISSION',
    recognitionState: 'DECISIVE_TRADING',
    semanticPolicy: 'SKIP',
  };
  const result: TradingClassificationResult = {
    status: 'TRADING_CONFIRMED',
    confidenceScore: confidence,
    category,
    breakdown: {
      classification_method: 'SEMANTIC_ADMISSION',
      reasoning: [
        `Semantic admission confirmed trading focus at ${confidence}/100.`,
        `Admission decision: ${candidate.admissionDecisionId || 'unknown'}.`,
        'Deterministic trading-relevance re-decision skipped; country and Discord gates remain authoritative.',
      ],
    } as any,
  };
  return { result, decision, input };
}
