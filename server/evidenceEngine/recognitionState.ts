import type {
  EvidenceCollectionReport,
  EvidenceItem,
  LifecycleAction,
  StagedClassificationReport,
} from './types';
import type { ContextualCompositionReport } from './contextualComposition';

/**
 * C6 deterministic recognition state.
 *
 * The state is derived before any semantic provider is called, so decisive and
 * query-only candidates never block on a model. It is a pure function of the
 * creator-owned evidence composition, deterministic evidence and provider
 * reports; it has no network, database or clock dependency.
 */
export const RECOGNITION_STATE_VERSION = 'recognition-state-v1';

export type RecognitionState =
  | 'DECISIVE_TRADING'
  | 'DECISIVE_NON_TRADING'
  | 'AMBIGUOUS_CONFLICT'
  | 'AMBIGUOUS_THIN'
  | 'QUERY_ONLY'
  | 'PROVIDER_DEGRADED'
  | 'INSUFFICIENT';

export type SemanticPolicy = 'SKIP' | 'BOUNDED_WAIT' | 'ENRICH' | 'NONE';

export type RecognitionGap =
  | 'CONTEXT_COVERAGE_MISSING'
  | 'ALTERNATIVE_FOCUS_CONFLICT'
  | 'TIER_A_CORROBORATION_MISSING'
  | 'QUERY_ONLY_EVIDENCE'
  | 'TEMPORAL_COVERAGE_MISSING'
  | 'PROVIDER_DEGRADED'
  | 'SEMANTIC_CANDIDATE_MISSING';

export interface RecognitionAssessment {
  version: string;
  state: RecognitionState;
  semanticPolicy: SemanticPolicy;
  semanticSkippedReason: string | null;
  gaps: RecognitionGap[];
  reasonCodes: string[];
  composition: Pick<ContextualCompositionReport,
    'focus' | 'observedFamilies' | 'tradingFamilies' | 'alternativeFamilies' |
    'neutralFamilies' | 'tradingCoverage' | 'alternativeCoverage' |
    'temporalCoverage' | 'nonTitleTierAFamilies' | 'explicitCreatorTrading' |
    'explicitCreatorAlternative'>;
}

export interface RecognitionAssessmentInput {
  composition: ContextualCompositionReport;
  evidence: EvidenceItem[];
  collection: EvidenceCollectionReport;
  lifecycleAction: LifecycleAction;
  /** True when semantic providers are configured/available for this evaluation. */
  semanticAvailable: boolean;
  /** True when at least one creator-owned (non-retrieval) field exists. */
  hasCreatorContext: boolean;
  staged?: StagedClassificationReport;
}

const stage = (report: StagedClassificationReport | undefined, name: string) =>
  report?.stages.find(item => item.stage === name);

const hasProviderFailure = (collection: EvidenceCollectionReport): boolean =>
  collection.providers.some(provider => provider.availability === 'FAILED');

/**
 * Assess the deterministic recognition state. `DECISIVE_*` and `QUERY_ONLY`
 * always skip semantic; only genuinely ambiguous states may wait.
 */
export function assessRecognitionState(input: RecognitionAssessmentInput): RecognitionAssessment {
  const { composition, evidence, collection } = input;
  const positive = evidence.filter(item => item.polarity === 'POSITIVE' && item.rawMatches.length > 0);
  const substantivePositive = positive.some(item => item.category !== 'SEMANTIC_ABSTENTION' && Math.abs(item.finalWeight) > 0);
  const reasons: string[] = [];
  const gaps = new Set<RecognitionGap>();

  if (composition.temporalCoverage === 'UNKNOWN' && composition.observedFamilies > 0) gaps.add('TEMPORAL_COVERAGE_MISSING');
  if (composition.focus === 'MIXED') gaps.add('ALTERNATIVE_FOCUS_CONFLICT');
  if (composition.focus === 'INSUFFICIENT_COVERAGE') gaps.add('CONTEXT_COVERAGE_MISSING');
  if (composition.tradingFamilies > 0 && composition.nonTitleTierAFamilies === 0) gaps.add('TIER_A_CORROBORATION_MISSING');

  const candidate = stage(input.staged, 'CANDIDATE_DETECTION');
  const corroboration = stage(input.staged, 'CORROBORATION');
  const terminalNegative = collection.terminalNegativeSufficiency?.status === 'SUFFICIENT';
  const decisiveTrading = composition.focus === 'TRADING_DOMINANT'
    && input.lifecycleAction === 'CONFIRM'
    && substantivePositive
    && composition.nonTitleTierAFamilies >= 1
    && !composition.explicitCreatorAlternative;
  const decisiveNonTrading = composition.focus === 'ALTERNATIVE_DOMINANT'
    && input.lifecycleAction === 'REJECT'
    && composition.explicitCreatorAlternative
    && terminalNegative;

  let state: RecognitionState;
  let semanticPolicy: SemanticPolicy;
  let semanticSkippedReason: string | null = null;

  if (decisiveTrading) {
    state = 'DECISIVE_TRADING';
    semanticPolicy = 'SKIP';
    semanticSkippedReason = 'SEMANTIC_SKIPPED_DETERMINISTIC_DECISIVE';
    reasons.push('TRADING_DOMINANT_WITH_NON_TITLE_TIER_A', 'WEIGHTED_THRESHOLD_SATISFIED');
  } else if (decisiveNonTrading) {
    state = 'DECISIVE_NON_TRADING';
    semanticPolicy = 'SKIP';
    semanticSkippedReason = 'SEMANTIC_SKIPPED_DETERMINISTIC_DECISIVE';
    reasons.push('ALTERNATIVE_DOMINANT_WITH_CREATOR_LEVEL_NEGATIVE');
  } else if (composition.focus === 'QUERY_ONLY') {
    state = 'QUERY_ONLY';
    semanticPolicy = 'SKIP';
    semanticSkippedReason = 'SEMANTIC_SKIPPED_QUERY_ONLY';
    gaps.add('QUERY_ONLY_EVIDENCE');
    reasons.push('NO_CREATOR_OWNED_OBSERVED_FAMILY');
  } else if (composition.focus === 'MIXED') {
    state = 'AMBIGUOUS_CONFLICT';
    semanticPolicy = input.semanticAvailable && input.hasCreatorContext ? 'BOUNDED_WAIT' : 'ENRICH';
    reasons.push('TRADING_ALTERNATIVE_CONFLICT');
  } else if (composition.focus === 'INSUFFICIENT_COVERAGE') {
    state = 'AMBIGUOUS_THIN';
    semanticPolicy = input.semanticAvailable && input.hasCreatorContext ? 'BOUNDED_WAIT' : 'ENRICH';
    gaps.add('CONTEXT_COVERAGE_MISSING');
    if (composition.nonTitleTierAFamilies === 0) gaps.add('TIER_A_CORROBORATION_MISSING');
    reasons.push('INSUFFICIENT_INDEPENDENT_TRADING_COVERAGE');
  } else if (hasProviderFailure(collection) && !substantivePositive) {
    state = 'PROVIDER_DEGRADED';
    semanticPolicy = 'NONE';
    gaps.add('PROVIDER_DEGRADED');
    reasons.push('DETERMINISTIC_EVIDENCE_ABSENT_PROVIDER_FAILED');
  } else if (input.lifecycleAction === 'REJECT' && terminalNegative) {
    // Existing terminal negative path (creator-level negative coverage) that
    // is not alternative-dominant: the state remains ambiguous because the
    // composition does not explain the negative focus. Enrichment/review
    // remains safer than a forced terminal decision.
    state = 'AMBIGUOUS_CONFLICT';
    semanticPolicy = input.semanticAvailable && input.hasCreatorContext ? 'BOUNDED_WAIT' : 'ENRICH';
    gaps.add('ALTERNATIVE_FOCUS_CONFLICT');
    reasons.push('CREATOR_LEVEL_NEGATIVE_WITHOUT_ALTERNATIVE_FOCUS');
  } else if (!substantivePositive && !terminalNegative) {
    state = 'INSUFFICIENT';
    semanticPolicy = input.semanticAvailable && input.hasCreatorContext ? 'BOUNDED_WAIT' : 'ENRICH';
    reasons.push('NO_SUBSTANTIVE_CREATOR_EVIDENCE');
  } else {
    state = 'AMBIGUOUS_THIN';
    semanticPolicy = input.semanticAvailable && input.hasCreatorContext ? 'BOUNDED_WAIT' : 'ENRICH';
    reasons.push(candidate?.disposition === 'PASS'
      ? 'CANDIDATE_WITHOUT_TERMINAL_CORROBORATION'
      : 'NO_DETERMINISTIC_CANDIDATE');
    if (corroboration?.disposition !== 'PASS') gaps.add('TIER_A_CORROBORATION_MISSING');
  }

  return {
    version: RECOGNITION_STATE_VERSION,
    state,
    semanticPolicy,
    semanticSkippedReason,
    gaps: [...gaps].sort() as RecognitionGap[],
    reasonCodes: [...new Set(reasons)],
    composition: {
      focus: composition.focus,
      observedFamilies: composition.observedFamilies,
      tradingFamilies: composition.tradingFamilies,
      alternativeFamilies: composition.alternativeFamilies,
      neutralFamilies: composition.neutralFamilies,
      tradingCoverage: composition.tradingCoverage,
      alternativeCoverage: composition.alternativeCoverage,
      temporalCoverage: composition.temporalCoverage,
      nonTitleTierAFamilies: composition.nonTitleTierAFamilies,
      explicitCreatorTrading: composition.explicitCreatorTrading,
      explicitCreatorAlternative: composition.explicitCreatorAlternative,
    },
  };
}

/** Composition-aware replacement for "any substantive positive". */
export function hasIndependentTradingHypothesisFromComposition(
  composition: ContextualCompositionReport,
  assessment: RecognitionAssessment,
): boolean {
  if (assessment.state === 'DECISIVE_TRADING') return true;
  if (composition.focus === 'MIXED' && composition.nonTitleTierAFamilies >= 1) return true;
  return false;
}
