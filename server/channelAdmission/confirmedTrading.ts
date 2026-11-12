import type { EvidenceItem, RawChannelInput, VerificationDecision } from '../evidenceEngine';
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
  const rawConfidence = Number(candidate.admissionTradingConfidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(100, rawConfidence)) : 0;
  const category = candidate.admissionCategory || 'General Trading';
  const citations = (candidate.admissionCitations || []).filter(citation =>
    citation.supports === 'TRADING' || citation.supports === 'FINANCE_ADJACENT');
  // Never infer the provider from the model name. Missing provider provenance
  // is reported as insufficient evidence and routed to human review.
  const provider = candidate.admissionProvider;
  const timestamp = new Date().toISOString();
  const positiveEvidence: EvidenceItem[] = provider ? citations.map((citation, index) => ({
    id: `semantic-admission-${index + 1}`,
    source: provider,
    polarity: 'POSITIVE',
    category: 'METHODOLOGY_CONCEPT',
    fact: `Semantic admission citation: ${citation.quote}`,
    rawMatches: [citation.quote],
    confidence,
    reliability: 'HIGH',
    reliabilityMultiplier: 1,
    rawWeight: 1,
    finalWeight: confidence / 100,
    provenance: {
      provider,
      type: 'semantic_admission_citation',
      matchedTerm: citation.quote,
      sourceRef: `${citation.field}${citation.index == null ? '' : `:${citation.index}`}`,
      semantic: {
        modelVersion: candidate.admissionModel || 'semantic-admission-v1',
        promptVersion: 'semantic-admission-v1',
        featureVersion: 'semantic-admission-v1',
        calibrationVersion: 'semantic-admission-v1',
        taxonomyLabel: 'TRADING',
        rawConfidence: confidence,
        calibratedConfidence: confidence,
        detectedLanguages: [],
        reasonCodes: ['SEMANTIC_ADMISSION'],
      },
    },
    timestamp,
  })) : [];
  const providerMissing = citations.length > 0 && !provider;
  const evidenceSufficiency = positiveEvidence.length > 0 ? 'SUFFICIENT' as const : 'INSUFFICIENT' as const;
  const degraded = confidence < 80 || positiveEvidence.length === 0;
  const humanReview = degraded;
  const decision: VerificationDecision = {
    status: degraded ? 'UNCERTAIN' : 'TRADING_CONFIRMED',
    confidenceScore: confidence,
    category,
    multiVideoConsistencyRatio: 1,
    positiveEvidence,
    negativeEvidence: [],
    totalPositiveWeight: positiveEvidence.reduce((sum, item) => sum + item.finalWeight, 0),
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
      sufficiency: evidenceSufficiency,
      sparseMetadata: positiveEvidence.length === 0,
      degraded,
      fieldsPresent: positiveEvidence.length > 0 ? ['admission_evidence'] : [],
      reasonCodes: positiveEvidence.length > 0
        ? ['SEMANTIC_ADMISSION_CONFIRMED']
        : [providerMissing ? 'SEMANTIC_ADMISSION_PROVIDER_MISSING' : 'SEMANTIC_ADMISSION_CITATIONS_MISSING'],
      providers: provider ? [{
        provider,
        availability: 'AVAILABLE',
        evidenceCount: positiveEvidence.length,
        outcome: positiveEvidence.length > 0 ? 'EXECUTED_WITH_EVIDENCE' : 'EXECUTED_NO_MATCH',
        reasonCodes: positiveEvidence.length > 0 ? ['SEMANTIC_ADMISSION'] : ['SEMANTIC_ADMISSION_CITATIONS_MISSING'],
      }] : [],
      terminalNegativeSufficiency: {
        status: 'INSUFFICIENT',
        creatorLevelCoverage: false,
        independentSourceFamilies: 0,
        independentObservations: 0,
        reasonCodes: ['SEMANTIC_ADMISSION_NOT_TERMINAL_NEGATIVE'],
      },
    },
    timestamp,
    decisionPolicy: {
      version: 'semantic-admission-v1',
      tradingProbability: confidence,
      nonTradingProbability: 100 - confidence,
      coverageConfidence: positiveEvidence.length > 0 ? 100 : 0,
      reasonCodes: positiveEvidence.length > 0
        ? ['SEMANTIC_ADMISSION_CONFIRMED']
        : [providerMissing ? 'SEMANTIC_ADMISSION_PROVIDER_MISSING' : 'SEMANTIC_ADMISSION_CITATIONS_MISSING'],
    },
    classificationMethod: 'SEMANTIC_ADMISSION',
    recognitionState: confidence >= 80 && positiveEvidence.length > 0 ? 'DECISIVE_TRADING' : 'AMBIGUOUS_THIN',
    semanticPolicy: 'SKIP',
    providerCoverage: 1,
    evidenceCount: positiveEvidence.length,
    deterministicRouting: {
      version: 'semantic-admission-v1',
      route: humanReview ? 'HUMAN_REVIEW' : 'DETERMINISTIC_TRADING',
      fastTrack: !humanReview,
      semanticUsed: true,
      semanticAttempted: true,
      humanReview,
      enrich: false,
      confidence,
      evidenceSufficiency,
      recognitionState: confidence >= 80 && positiveEvidence.length > 0 ? 'DECISIVE_TRADING' : 'AMBIGUOUS_THIN',
      semanticPolicy: 'SKIP',
      fallbackReason: positiveEvidence.length === 0
        ? (providerMissing ? 'SEMANTIC_ADMISSION_PROVIDER_MISSING' : 'SEMANTIC_ADMISSION_CITATIONS_MISSING')
        : null,
      reasonCodes: positiveEvidence.length > 0
        ? ['SEMANTIC_ADMISSION_CONFIRMED']
        : [providerMissing ? 'SEMANTIC_ADMISSION_PROVIDER_MISSING' : 'SEMANTIC_ADMISSION_CITATIONS_MISSING'],
    },
  };
  const result: TradingClassificationResult = {
    status: degraded ? 'UNCERTAIN' : 'TRADING_CONFIRMED',
    confidenceScore: confidence,
    category,
    breakdown: {
      stage_a_score: confidence,
      consistency_ratio: 1,
      ai_reviewed: true,
      classification_method: 'SEMANTIC_ADMISSION',
      confidence_basis: degraded ? 'HEURISTIC' : 'CALIBRATED',
      reasoning: [
        `Semantic admission confirmed trading focus at ${confidence}/100.`,
        `Admission decision: ${candidate.admissionDecisionId || 'unknown'}.`,
        'Deterministic trading-relevance re-decision skipped; country and Discord gates remain authoritative.',
      ],
    },
  };
  return { result, decision, input };
}
