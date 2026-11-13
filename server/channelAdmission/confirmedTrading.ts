import type { EvidenceItem, RawChannelInput, VerificationDecision } from '../evidenceEngine';
import type { TradingClassificationResult } from '../../src/types';
import type { DiscoveredChannelRaw } from '../youtube';

/**
 * Semantic models sometimes return `trading_focus` as a 0–1 probability even
 * though admission stores a 0–100 percentage. `channels.confidence_score` and
 * `channels.trading_confidence_score` are integers, so a fractional value
 * makes the whole classification pipeline fail at persistence. Normalize both
 * representations defensively at the admission boundary.
 */
export function normalizeAdmissionTradingConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const percentage = parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
  return Math.max(0, Math.min(100, Math.round(percentage)));
}

/**
 * A confident semantic admission is a first-class classification result. It
 * bypasses the deterministic trading-relevance re-decision but still flows
 * through country validation, Discord inspection and quality gates.
 */
export function buildAdmissionConfirmedClassification(
  input: RawChannelInput,
  candidate: DiscoveredChannelRaw,
): { result: TradingClassificationResult; decision: VerificationDecision; input: RawChannelInput } {
  const confidence = normalizeAdmissionTradingConfidence(candidate.admissionTradingConfidence);
  const category = candidate.admissionCategory || 'General Trading';
  const citations = (candidate.admissionCitations || []).filter(citation =>
    citation.supports === 'TRADING' || citation.supports === 'FINANCE_ADJACENT');
  // Deterministic admission is a first-class evidence source. Semantic
  // admissions must carry the actual provider; it is never inferred from a
  // model name.
  const human = candidate.admissionDecisionSource === 'HUMAN';
  const deterministic = candidate.admissionDecisionSource === 'DETERMINISTIC';
  const nonSemantic = deterministic || human;
  const provider = nonSemantic ? 'channel_metadata' as const : candidate.admissionProvider;
  const timestamp = new Date().toISOString();
  const positiveEvidence: EvidenceItem[] = provider ? citations.map((citation, index) => ({
    id: `${human ? 'human-review' : deterministic ? 'deterministic' : 'semantic'}-admission-${index + 1}`,
    source: provider,
    polarity: 'POSITIVE',
    category: 'METHODOLOGY_CONCEPT',
    fact: `${human ? 'Human review admission' : deterministic ? 'Deterministic admission' : 'Semantic admission'} citation: ${citation.quote}`,
    rawMatches: [citation.quote],
    confidence,
    reliability: 'HIGH',
    reliabilityMultiplier: 1,
    rawWeight: 1,
    finalWeight: confidence / 100,
    provenance: {
      provider,
      type: human ? 'human_review_admission_citation' : deterministic ? 'deterministic_admission_citation' : 'semantic_admission_citation',
      matchedTerm: citation.quote,
      sourceRef: `${citation.field}${citation.index == null ? '' : `:${citation.index}`}`,
      ...(nonSemantic ? {} : {
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
      }),
    },
    timestamp,
  })) : [];
  const providerMissing = !nonSemantic && citations.length > 0 && !provider;
  const evidenceSufficiency = nonSemantic || positiveEvidence.length > 0 ? 'SUFFICIENT' as const : 'INSUFFICIENT' as const;
  const degraded = human ? false : confidence < 80 || (!nonSemantic && positiveEvidence.length === 0);
  const humanReview = degraded;
  const reasonCode = human ? 'HUMAN_REVIEW_ADMISSION_CONFIRMED' : deterministic ? 'DETERMINISTIC_ADMISSION_CONFIRMED' : 'SEMANTIC_ADMISSION_CONFIRMED';
  const provenanceLabel = human ? 'HUMAN_REVIEW_ADMISSION' : deterministic ? 'DETERMINISTIC_ADMISSION' : 'SEMANTIC_ADMISSION';
  const versionTag = human ? 'human-review-admission-v1' : deterministic ? 'deterministic-admission-v1' : 'semantic-admission-v1';
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
      matchedTerms: [provenanceLabel],
      matchedNegativeTerms: [],
    },
    versions: {
      evidenceEngineVersion: versionTag,
      decisionEngineVersion: versionTag,
      scoringEngineVersion: versionTag,
      knowledgePackVersion: versionTag,
      geminiModelVersion: versionTag,
    },
    mathematicalJustification: `${human ? 'Human review admission' : deterministic ? 'Deterministic #618 admission' : 'Semantic admission'} judged the creator's main subject to be trading with confidence ${confidence}/100. Admission decision ${candidate.admissionDecisionId || 'unknown'} owns this result; country and Discord gates still run.`,
    evidenceCollection: {
      sufficiency: evidenceSufficiency,
      sparseMetadata: positiveEvidence.length === 0,
      degraded,
      fieldsPresent: human ? ['human_review_evidence'] : deterministic ? ['deterministic_evidence'] : positiveEvidence.length > 0 ? ['admission_evidence'] : [],
      reasonCodes: evidenceSufficiency === 'SUFFICIENT'
        ? [reasonCode]
        : [providerMissing ? 'SEMANTIC_ADMISSION_PROVIDER_MISSING' : 'SEMANTIC_ADMISSION_CITATIONS_MISSING'],
      providers: provider ? [{
        provider,
        availability: 'AVAILABLE',
        evidenceCount: positiveEvidence.length,
        outcome: positiveEvidence.length > 0 ? 'EXECUTED_WITH_EVIDENCE' : 'EXECUTED_NO_MATCH',
        reasonCodes: [human ? 'HUMAN_REVIEW_ADMISSION' : deterministic ? 'DETERMINISTIC_ADMISSION' : 'SEMANTIC_ADMISSION'],
      }] : [],
      terminalNegativeSufficiency: {
        status: 'INSUFFICIENT',
        creatorLevelCoverage: false,
        independentSourceFamilies: 0,
        independentObservations: 0,
        reasonCodes: [`${provenanceLabel}_NOT_TERMINAL_NEGATIVE`],
      },
    },
    timestamp,
    decisionPolicy: {
      version: versionTag,
      tradingProbability: confidence,
      nonTradingProbability: 100 - confidence,
      coverageConfidence: evidenceSufficiency === 'SUFFICIENT' ? 100 : 0,
      reasonCodes: evidenceSufficiency === 'SUFFICIENT'
        ? [reasonCode]
        : [providerMissing ? 'SEMANTIC_ADMISSION_PROVIDER_MISSING' : 'SEMANTIC_ADMISSION_CITATIONS_MISSING'],
    },
    classificationMethod: human ? 'HUMAN_REVIEW_ADMISSION' : deterministic ? 'DETERMINISTIC_EVIDENCE' : 'SEMANTIC_ADMISSION',
    recognitionState: human || (confidence >= 80 && evidenceSufficiency === 'SUFFICIENT') ? 'DECISIVE_TRADING' : 'AMBIGUOUS_THIN',
    semanticPolicy: nonSemantic ? 'NONE' : 'SKIP',
    providerCoverage: 1,
    evidenceCount: positiveEvidence.length,
    deterministicRouting: {
      version: versionTag,
      route: humanReview ? 'HUMAN_REVIEW' : nonSemantic ? 'DETERMINISTIC_TRADING' : 'SEMANTIC_TRADING',
      fastTrack: !humanReview,
      semanticUsed: !nonSemantic,
      semanticAttempted: !nonSemantic,
      humanReview,
      enrich: false,
      confidence,
      evidenceSufficiency,
      recognitionState: human || (confidence >= 80 && evidenceSufficiency === 'SUFFICIENT') ? 'DECISIVE_TRADING' : 'AMBIGUOUS_THIN',
      semanticPolicy: nonSemantic ? 'NONE' : 'SKIP',
      fallbackReason: evidenceSufficiency === 'SUFFICIENT'
        ? null
        : (providerMissing ? 'SEMANTIC_ADMISSION_PROVIDER_MISSING' : 'SEMANTIC_ADMISSION_CITATIONS_MISSING'),
      reasonCodes: evidenceSufficiency === 'SUFFICIENT'
        ? [reasonCode]
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
      ai_reviewed: !nonSemantic,
      classification_method: human ? 'HUMAN_REVIEW_ADMISSION' : deterministic ? 'DETERMINISTIC_EVIDENCE' : 'SEMANTIC_ADMISSION',
      confidence_basis: degraded ? 'HEURISTIC' : 'CALIBRATED',
      reasoning: [
        `${human ? 'Human review admission' : deterministic ? 'Deterministic admission' : 'Semantic admission'} confirmed trading focus at ${confidence}/100.`,
        `Admission decision: ${candidate.admissionDecisionId || 'unknown'}.`,
        human
          ? 'Human review admission owns this classification; country and Discord gates remain authoritative.'
          : deterministic
            ? 'Deterministic #618 admission result owns this classification; country and Discord gates remain authoritative.'
            : 'Deterministic trading-relevance re-decision skipped; country and Discord gates remain authoritative.',
      ],
    },
  };
  return { result, decision, input };
}
