import type { EvidenceFieldType, EvidenceItem, RawChannelInput, VerificationDecision } from '../evidenceEngine';
import type { TradingClassificationResult } from '../../src/types';
import type { DiscoveredChannelRaw } from '../youtube';
import { ADMISSION_CONFIRMATION_MIN_CONFIDENCE, normalizeTradingFocus } from './confidence';

/**
 * Map admission citation labels to the canonical creator-owned field names
 * used by the decision policy. Admission citations use the model-facing
 * `bio`/`link` labels; classification evidence uses `channel_bio` and
 * `external_link_domain`.
 */
function admissionCitationField(field: string): EvidenceFieldType | null {
  const normalized = String(field || '').trim().toLowerCase();
  const mapping: Record<string, EvidenceFieldType> = {
    bio: 'channel_bio',
    channel_bio: 'channel_bio',
    channel_name: 'channel_title',
    channel_title: 'channel_title',
    link: 'external_link_domain',
    external_link: 'external_link_domain',
    external_link_label: 'external_link_label',
    external_link_domain: 'external_link_domain',
    video_title: 'video_title',
    video_description: 'video_description',
    playlist_name: 'playlist_name',
    playlist_description: 'playlist_description',
    transcript_excerpt: 'transcript_excerpt',
    visual_evidence: 'visual_evidence',
    discord_invite: 'discord_invite',
    pinned_comment: 'pinned_comment',
  };
  return mapping[normalized] || null;
}

/**
 * Legacy semantic judges returned `trading_focus` on a 0–1 probability scale.
 * The generic normalizer treats an exact `1` as 1% because it cannot know the
 * scale. An already-confirmed semantic admission with citations is different:
 * `1` is the probability upper bound, so it is the 100% confirmation the
 * admission already recorded. This compatibility rule is intentionally scoped
 * to confirmed semantic admissions; generic 1% values and low-confidence
 * admissions remain reviewable.
 */
function confirmedAdmissionConfidence(candidate: DiscoveredChannelRaw, hasUsableTradingCitation: boolean): number {
  const raw = Number(candidate.admissionTradingConfidence);
  if (candidate.admissionConfirmedTrading === true
    && candidate.admissionDecisionSource === 'SEMANTIC'
    && raw === 1
    && hasUsableTradingCitation) {
    return 100;
  }
  return normalizeAdmissionTradingConfidence(candidate.admissionTradingConfidence);
}

/**
 * Legacy admission rows can still carry a 0–1 semantic confidence. Confirmed
 * admission is a positive-trading subject, so fractions below 1 are scaled to
 * percentages here before they reach integer channel columns.
 */
export function normalizeAdmissionTradingConfidence(value: unknown, mainSubject?: string | null): number {
  return normalizeTradingFocus(value, mainSubject || 'TRADING');
}

/**
 * A confident deterministic or human admission is a first-class classification
 * result. Semantic admissions are deliberately excluded at the pipeline
 * boundary: they are routing signals and must run the full classifier so the
 * original creator evidence, content category and composition safeguards are
 * evaluated. The shortcut still flows through country validation, Discord
 * inspection and quality gates.
 */
export function buildAdmissionConfirmedClassification(
  input: RawChannelInput,
  candidate: DiscoveredChannelRaw,
): { result: TradingClassificationResult; decision: VerificationDecision; input: RawChannelInput } {
  const category = candidate.admissionCategory || 'General Trading';
  const citations = (candidate.admissionCitations || []).filter(citation =>
    citation.supports === 'TRADING' || citation.supports === 'FINANCE_ADJACENT');
  // Deterministic admission is a first-class evidence source. Semantic
  // admissions must carry the actual provider; it is never inferred from a
  // model name.
  const human = candidate.admissionDecisionSource === 'HUMAN';
  const deterministic = candidate.admissionDecisionSource === 'DETERMINISTIC';
  const nonSemantic = deterministic || human;
  const admissionConfirmed = candidate.admissionConfirmedTrading === true;
  // Semantic confirmation still needs creator-owned, non-title evidence. A
  // confirmed admission with only a title citation is not enough to stand on
  // its own; it stays reviewable. Missing provider provenance alone is not a
  // downgrade: the admission decision is recorded as the honest source.
  const creatorOwnedCitationFields = new Set([
    'bio',
    'channel_bio',
    'link',
    'video_title',
    'video_description',
    'external_link',
    'external_link_label',
    'external_link_domain',
    'playlist_name',
    'playlist_description',
    'transcript_excerpt',
    'visual_evidence',
    'discord_invite',
    'pinned_comment',
  ]);
  const semanticCreatorCitations = citations.filter(citation =>
    creatorOwnedCitationFields.has(String(citation.field || '').trim().toLowerCase()));
  const usableCitations = nonSemantic ? citations : semanticCreatorCitations;
  const hasTradingCitation = usableCitations.some(citation => citation.supports === 'TRADING');
  const confidence = confirmedAdmissionConfidence(candidate, hasTradingCitation);
  const evidenceProvider = nonSemantic
    ? 'channel_metadata' as const
    : (candidate.admissionProvider || (admissionConfirmed && usableCitations.length > 0 ? 'admission_decision' as const : undefined));
  const timestamp = new Date().toISOString();
  const positiveEvidence: EvidenceItem[] = evidenceProvider ? usableCitations.map((citation, index) => {
    const mappedField = admissionCitationField(citation.field);
    return {
      id: `${human ? 'human-review' : deterministic ? 'deterministic' : 'semantic'}-admission-${index + 1}`,
      source: evidenceProvider,
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
        provider: evidenceProvider,
        type: human ? 'human_review_admission_citation' : deterministic ? 'deterministic_admission_citation' : 'semantic_admission_citation',
        matchedTerm: citation.quote,
        sourceRef: `${citation.field}${citation.index == null ? '' : `:${citation.index}`}`,
        ...(mappedField ? { fields: [{ field: mappedField, index: citation.index }] } : {}),
        ...(nonSemantic ? {} : {
          semantic: {
            modelVersion: candidate.admissionModel || 'semantic-admission-v1',
            promptVersion: 'semantic-admission-v1',
            featureVersion: 'semantic-admission-v1',
            calibrationVersion: 'semantic-admission-v1',
            taxonomyLabel: 'ACTIVE_TRADING',
            rawConfidence: confidence,
            calibratedConfidence: confidence,
            detectedLanguages: [],
            reasonCodes: ['SEMANTIC_ADMISSION'],
          },
        }),
      },
      timestamp,
    };
  }) : [];
  if (nonSemantic && admissionConfirmed && positiveEvidence.length === 0) {
    // Deterministic and human admissions are not AI confirmations. Their
    // durable decision is a first-class evidence source even when a legacy
    // payload lost its citations.
    positiveEvidence.push({
      id: `${human ? 'human-review' : 'deterministic'}-admission-decision`,
      source: 'channel_metadata',
      polarity: 'POSITIVE',
      category: 'METHODOLOGY_CONCEPT',
      fact: `${human ? 'Human review admission' : 'Deterministic admission'} decision ${candidate.admissionDecisionId || 'unknown'} confirmed trading focus at ${confidence}/100.`,
      rawMatches: [candidate.admissionDecisionId || candidate.channelId],
      confidence,
      reliability: 'HIGH',
      reliabilityMultiplier: 1,
      rawWeight: 1,
      finalWeight: confidence / 100,
      provenance: {
        provider: 'channel_metadata',
        type: 'admission_decision',
        matchedTerm: candidate.admissionDecisionId || candidate.channelId,
        sourceRef: 'admission_decision',
      },
      timestamp,
    });
  }
  const providerMissing = !nonSemantic && !candidate.admissionProvider;
  const titleOnlySemanticEvidence = !nonSemantic && citations.length > 0 && usableCitations.length === 0;
  const evidenceSufficiency = nonSemantic || (positiveEvidence.length > 0 && hasTradingCitation)
    ? 'SUFFICIENT' as const
    : 'INSUFFICIENT' as const;
  const degraded = human || deterministic
    ? false
    : confidence < ADMISSION_CONFIRMATION_MIN_CONFIDENCE || evidenceSufficiency !== 'SUFFICIENT';
  const humanReview = degraded;
  const semanticEvidenceGapReason = evidenceSufficiency === 'SUFFICIENT'
    ? null
    : titleOnlySemanticEvidence
      ? 'SEMANTIC_ADMISSION_TITLE_ONLY_EVIDENCE'
      : citations.length === 0
        ? 'SEMANTIC_ADMISSION_CITATIONS_MISSING'
        : providerMissing
          ? 'SEMANTIC_ADMISSION_PROVIDER_MISSING'
          : 'SEMANTIC_ADMISSION_CITATIONS_MISSING';
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
        : [semanticEvidenceGapReason || 'SEMANTIC_ADMISSION_CITATIONS_MISSING'],
      providers: evidenceProvider ? [{
        provider: evidenceProvider,
        availability: 'AVAILABLE',
        evidenceCount: positiveEvidence.length,
        outcome: positiveEvidence.length > 0 ? 'EXECUTED_WITH_EVIDENCE' : 'EXECUTED_NO_MATCH',
        reasonCodes: [evidenceProvider === 'admission_decision'
          ? 'ADMISSION_DECISION_CONFIRMED'
          : human ? 'HUMAN_REVIEW_ADMISSION' : deterministic ? 'DETERMINISTIC_ADMISSION' : 'SEMANTIC_ADMISSION'],
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
        : [semanticEvidenceGapReason || 'SEMANTIC_ADMISSION_CITATIONS_MISSING'],
    },
    classificationMethod: human ? 'HUMAN_REVIEW_ADMISSION' : deterministic ? 'DETERMINISTIC_EVIDENCE' : 'SEMANTIC_ADMISSION',
    recognitionState: human || deterministic || (confidence >= ADMISSION_CONFIRMATION_MIN_CONFIDENCE && evidenceSufficiency === 'SUFFICIENT') ? 'DECISIVE_TRADING' : 'AMBIGUOUS_THIN',
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
      recognitionState: human || deterministic || (confidence >= ADMISSION_CONFIRMATION_MIN_CONFIDENCE && evidenceSufficiency === 'SUFFICIENT') ? 'DECISIVE_TRADING' : 'AMBIGUOUS_THIN',
      semanticPolicy: nonSemantic ? 'NONE' : 'SKIP',
      fallbackReason: evidenceSufficiency === 'SUFFICIENT'
        ? null
        : semanticEvidenceGapReason,
      reasonCodes: evidenceSufficiency === 'SUFFICIENT'
        ? [reasonCode]
        : [semanticEvidenceGapReason || 'SEMANTIC_ADMISSION_CITATIONS_MISSING'],
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
