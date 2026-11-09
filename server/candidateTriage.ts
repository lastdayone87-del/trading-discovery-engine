import type { DiscoverySource } from '../src/types';
import type { VerificationDecision } from './evidenceEngine';
import type { DiscoveredChannelRaw } from './youtube';
import { uncoveredFailedProviders } from './enrichmentOperationalFailure';
import {
  assessIntakeTradingFocus,
  hasCoveredNonLatinScript,
  INTAKE_TRADING_FOCUS_POLICY_VERSION,
  type IntakeTradingFocusAssessment,
} from './intakeTradingFocus';

export { hasCoveredNonLatinScript };

// v6 replaces the non-Latin blanket admission with an evidence-based
// ADMIT/WITHHOLD/DEFER assessment shared by the inline and durable paths.
export const CANDIDATE_TRIAGE_POLICY_VERSION = 'candidate-triage-v6-intake-trading-focus';

export type SearchCandidateTriageDisposition =
  | 'PLAUSIBLE_TRADING_HYPOTHESIS'
  | 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS'
  | 'DEFER_NO_CONFIDENT_EVIDENCE'
  | 'NOT_APPLICABLE';

export interface SearchCandidateTriageDecision {
  disposition: SearchCandidateTriageDisposition;
  reasonCodes: string[];
  matchedSignals: string[];
}

function staleMatchedVideo(candidate: DiscoveredChannelRaw, now = Date.now()): boolean {
  if (candidate.matchedDocument?.type !== 'VIDEO' || !candidate.matchedDocument.publishedAt) return false;
  const publishedAt = Date.parse(candidate.matchedDocument.publishedAt);
  if (!Number.isFinite(publishedAt)) return false;
  const configured = Number(process.env.DISCOVERY_MAX_MATCH_AGE_DAYS ?? '730');
  const maxAgeDays = Number.isFinite(configured) ? Math.max(0, configured) : 730;
  if (maxAgeDays === 0) return false;
  return now - publishedAt > maxAgeDays * 86_400_000;
}

function mapDecision(assessment: IntakeTradingFocusAssessment): SearchCandidateTriageDecision {
  if (assessment.decision === 'ADMIT') {
    return {
      disposition: 'PLAUSIBLE_TRADING_HYPOTHESIS',
      reasonCodes: assessment.reasonCodes,
      matchedSignals: assessment.matchedSignals,
    };
  }
  if (assessment.decision === 'DEFER') {
    return {
      disposition: 'DEFER_NO_CONFIDENT_EVIDENCE',
      reasonCodes: assessment.reasonCodes,
      matchedSignals: assessment.matchedSignals,
    };
  }
  return {
    disposition: 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS',
    reasonCodes: assessment.reasonCodes,
    matchedSignals: assessment.matchedSignals,
  };
}

/**
 * Cheap routing-only firewall. Search-match content is never promoted to
 * creator-level evidence; it is used only to decide whether an autonomous
 * result is worth spending additional provider quota on.
 *
 * The focus assessment is channel-level: it uses the channel bio plus every
 * available video title/description, not only the matched search document.
 */
export function triageAutonomousSearchCandidate(
  candidate: DiscoveredChannelRaw,
  source: DiscoverySource,
  isEnrichmentPass: boolean
): SearchCandidateTriageDecision {
  if (source !== 'automated_query' || isEnrichmentPass || (candidate.enrichmentStage || 0) > 0) {
    return { disposition: 'NOT_APPLICABLE', reasonCodes: ['NON_INITIAL_AUTONOMOUS_RESULT'], matchedSignals: [] };
  }

  // A search hit from many years ago is weak evidence for the user's actual
  // target: active traders publishing now. Withhold stale VIDEO matches before
  // country hydration, semantic classification, enrichment, or Discord crawling.
  if (staleMatchedVideo(candidate)) {
    return {
      disposition: 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS',
      reasonCodes: ['STALE_RETRIEVAL_DOCUMENT', 'DO_NOT_SPEND_ENRICHMENT_QUOTA'],
      matchedSignals: [],
    };
  }

  // Bounded relationship-canary admission. Candidates discovered by traversing
  // creator relationships inside an explicitly designated canary cohort carry
  // relationshipProvenance; the relationship itself establishes a bounded
  // hypothesis WITHOUT any keyword requirement, so the keyword admission
  // bottleneck below does not apply to this cohort. This is hypothesis only:
  // relationship evidence never proves trading identity — it merely unlocks
  // the existing verification chain (Gate 1 country + metadata hydration,
  // audience gate, Gate 2 evidence-based trading classification, Discord and
  // quality gates), which remain solely authoritative. Depth is capped so
  // traversal cannot run away.
  const relationship = candidate.relationshipProvenance;
  if (
    relationship &&
    typeof relationship.cohortId === 'string' && relationship.cohortId.trim().length > 0 &&
    (relationship.kind === 'featured' || relationship.kind === 'playlist') &&
    Number.isInteger(relationship.depth) && relationship.depth >= 1 && relationship.depth <= 2
  ) {
    return {
      disposition: 'PLAUSIBLE_TRADING_HYPOTHESIS',
      reasonCodes: ['RELATIONSHIP_DERIVED_HYPOTHESIS', 'RELATIONSHIP_CORROBORATION_VIA_ENRICHMENT_PASS'],
      matchedSignals: [`RELATIONSHIP_${relationship.kind.toUpperCase()}`, `RELATIONSHIP_DEPTH_${relationship.depth}`],
    };
  }

  const assessment = assessIntakeTradingFocus({
    channelName: candidate.channelName,
    description: candidate.description,
    matchedDocument: candidate.matchedDocument,
    videoTitles: candidate.videoTitles,
    videoDescriptions: candidate.videoDescriptions,
  });
  return mapDecision(assessment);
}

/**
 * Creator-level plausibility after enrichment. Unlike retrieval routing, this
 * uses only the independent evidence bundle produced by the classifier.
 */
export function hasIndependentTradingHypothesis(decision: VerificationDecision): boolean {
  if (decision.status === 'TRADING_CONFIRMED') return true;
  // Operational provider failure is not negative evidence. Preserve the case
  // for one bounded retry rather than converting missing provider output into a
  // durable "no trading hypothesis" withholding decision. A served semantic
  // fallback counts as coverage restored (only genuinely uncovered failures
  // preserve the case), so a covered abstention with no positive evidence
  // follows the same lifecycle as a healthy abstention. Reports without any
  // provider detail fall back to the raw degraded flag (fail-safe preserve).
  const providers = decision.evidenceCollection.providers || [];
  if (providers.length === 0) {
    if (decision.evidenceCollection.degraded) return true;
  } else if (uncoveredFailedProviders(decision.evidenceCollection).length > 0) {
    return true;
  }
  const substantivePositive = decision.positiveEvidence.some(item =>
    item.rawMatches.length > 0 &&
    item.category !== 'SEMANTIC_ABSTENTION' &&
    Math.abs(item.finalWeight) > 0
  );
  if (substantivePositive) return true;
  const candidateStage = decision.stagedClassification?.stages.find(stage => stage.stage === 'CANDIDATE_DETECTION');
  return candidateStage?.disposition === 'PASS';
}

export type KeywordBaseline = 'WOULD_ADMIT' | 'WOULD_WITHHOLD';

/**
 * Observational keyword-baseline signal for relationship-canary measurement.
 * Answers "would the old keyword-first funnel have admitted this candidate?"
 * by evaluating the EXISTING keyword predicate on the candidate WITHOUT its
 * relationship marker. Pure and side-effect free. The result is recorded for
 * cohort metrics only and must never influence admission, classification,
 * country/exclusion, or review authority — callers use it for observation.
 */
export function observeKeywordBaseline(
  candidate: DiscoveredChannelRaw,
  source: DiscoverySource = 'automated_query',
): { baseline: KeywordBaseline; reasonCodes: string[] } {
  const { relationshipProvenance: _ignored, ...unmarked } = candidate;
  // The baseline describes the old retrieval-document funnel: channel name +
  // matched document only. Channel bio and video fields were not part of that
  // predicate and must not change the observational comparison.
  const decision = triageAutonomousSearchCandidate({
    ...(unmarked as DiscoveredChannelRaw),
    description: '',
    videoTitles: [],
    videoDescriptions: [],
  }, source, false);
  return {
    baseline: decision.disposition === 'PLAUSIBLE_TRADING_HYPOTHESIS' ? 'WOULD_ADMIT' : 'WOULD_WITHHOLD',
    reasonCodes: decision.reasonCodes,
  };
}

/** Shared policy version for admission audits. */
export { INTAKE_TRADING_FOCUS_POLICY_VERSION };
