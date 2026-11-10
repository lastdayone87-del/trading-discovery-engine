import type { EvidenceSufficiency, VerificationDecision } from '../evidenceEngine/types';

export const DETERMINISTIC_FIRST_ROUTING_VERSION = 'deterministic-first-routing-v1';

/**
 * Default-on integrated routing. A process-level LEGACY switch restores the
 * pre-v2 pipeline behavior without a database migration or restart race.
 */
export function resolveClassificationRoutingMode(
  env: NodeJS.ProcessEnv = process.env,
): 'ACTIVE' | 'LEGACY' {
  return String(env.DETERMINISTIC_CLASSIFICATION_ROUTING || 'ACTIVE').trim().toUpperCase() === 'LEGACY'
    ? 'LEGACY'
    : 'ACTIVE';
}

export type ClassificationRoute =
  | 'DETERMINISTIC_TRADING'
  | 'SEMANTIC_TRADING'
  | 'DETERMINISTIC_NON_TRADING'
  | 'SEMANTIC_NON_TRADING'
  | 'HUMAN_REVIEW'
  | 'ENRICH'
  | 'UNCERTAIN';

export interface ClassificationRoutingDecision {
  version: string;
  route: ClassificationRoute;
  fastTrack: boolean;
  semanticUsed: boolean;
  semanticAttempted: boolean;
  humanReview: boolean;
  enrich: boolean;
  confidence: number;
  evidenceSufficiency: EvidenceSufficiency;
  recognitionState: string | null;
  semanticPolicy: string | null;
  fallbackReason: string | null;
  reasonCodes: string[];
}

export interface ClassificationRoutingOptions {
  /**
   * True only when the evidence bundle has independent creator-owned
   * corroboration. Human review is preferred over another enrichment loop
   * only when the evidence is already sufficient and independent.
   */
  independentEvidence?: boolean;
  mode?: 'ACTIVE' | 'LEGACY';
}

type RoutingInput = Pick<
  VerificationDecision,
  'status' | 'confidenceScore' | 'evidenceCollection' | 'recognitionState' | 'semanticPolicy' | 'decisionPolicy' | 'classificationMethod'
>;

function semanticProviderReports(decision: RoutingInput) {
  return (decision.evidenceCollection.providers || []).filter(provider =>
    /semantic/.test(String(provider.provider)),
  );
}

function semanticSignals(decision: RoutingInput) {
  const providers = semanticProviderReports(decision);
  return {
    used: providers.some(provider => provider.outcome === 'EXECUTED_WITH_EVIDENCE')
      || /^SEMANTIC_/.test(String(decision.classificationMethod || '')),
    attempted: providers.some(provider =>
      provider.availability === 'AVAILABLE'
      && provider.outcome !== 'SUPPRESSED_BY_POLICY'
      && provider.outcome !== 'NOT_APPLICABLE'
      && provider.outcome !== 'UNAVAILABLE_CONFIGURATION',
    ),
    failed: providers.some(provider => String(provider.outcome).startsWith('FAILED_')),
    abstained: providers.some(provider => String(provider.outcome).startsWith('ABSTAINED_')),
  };
}

function hasTerminalNegativeEvidence(decision: RoutingInput): boolean {
  if (decision.evidenceCollection.terminalNegativeSufficiency?.status !== 'SUFFICIENT') return false;
  // The policy layer only terminalizes creator-level unrelated-domain
  // evidence. The status cannot be terminalized by isolated keywords.
  return (decision.decisionPolicy?.reasonCodes || []).some(code =>
    code === 'HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED'
    || code === 'DOMINANT_CREATOR_LEVEL_IRRELEVANT_CONTRADICTION',
  );
}

function result(
  input: {
    route: ClassificationRoute;
    confidence: number;
    evidenceSufficiency: EvidenceSufficiency;
    recognitionState: string | null;
    semanticPolicy: string | null;
    semanticUsed: boolean;
    semanticAttempted: boolean;
    fastTrack?: boolean;
    humanReview?: boolean;
    enrich?: boolean;
    fallbackReason?: string | null;
    reasonCodes: string[];
  },
): ClassificationRoutingDecision {
  return {
    version: DETERMINISTIC_FIRST_ROUTING_VERSION,
    route: input.route,
    fastTrack: input.fastTrack === true,
    semanticUsed: input.semanticUsed,
    semanticAttempted: input.semanticAttempted,
    humanReview: input.humanReview === true,
    enrich: input.enrich === true,
    confidence: input.confidence,
    evidenceSufficiency: input.evidenceSufficiency,
    recognitionState: input.recognitionState,
    semanticPolicy: input.semanticPolicy,
    fallbackReason: input.fallbackReason ?? null,
    reasonCodes: input.reasonCodes,
  };
}

/**
 * Route one evidence-engine decision.
 *
 * The deterministic engine already owns the terminal policy. This layer adds
 * the operational route: fast-track a decisive deterministic result, keep AI
 * for ambiguity, and send genuinely exhausted ambiguity to human review. It
 * never converts an isolated negative keyword into a rejection: a NON_TRADING
 * status without terminal creator-level negative evidence is routed back to
 * human review.
 */
export function resolveClassificationRouting(
  decision: RoutingInput,
  options: ClassificationRoutingOptions = {},
): ClassificationRoutingDecision {
  const mode = options.mode || 'ACTIVE';
  const sufficiency = decision.evidenceCollection.sufficiency;
  const recognitionState = decision.recognitionState ?? null;
  const semanticPolicy = decision.semanticPolicy ?? null;
  const semantic = semanticSignals(decision);
  const confidence = Number(decision.confidenceScore) || 0;
  const independent = options.independentEvidence === true;

  if (mode === 'LEGACY') {
    return result({
      route: decision.status === 'TRADING_CONFIRMED' ? 'SEMANTIC_TRADING'
        : decision.status === 'NON_TRADING' ? 'SEMANTIC_NON_TRADING'
          : 'UNCERTAIN',
      confidence,
      evidenceSufficiency: sufficiency,
      recognitionState,
      semanticPolicy,
      semanticUsed: semantic.used,
      semanticAttempted: semantic.attempted,
      reasonCodes: ['LEGACY_ROUTING'],
    });
  }

  if (decision.status === 'TRADING_CONFIRMED') {
    if (semantic.used) {
      return result({
        route: 'SEMANTIC_TRADING', confidence, evidenceSufficiency: sufficiency,
        recognitionState, semanticPolicy, semanticUsed: true, semanticAttempted: semantic.attempted,
        reasonCodes: ['SEMANTIC_CONFIRMED_TRADING'],
      });
    }
    const decisive = recognitionState === 'DECISIVE_TRADING' && sufficiency === 'SUFFICIENT' && confidence >= 82;
    return result({
      route: decisive ? 'DETERMINISTIC_TRADING' : 'SEMANTIC_TRADING',
      confidence, evidenceSufficiency: sufficiency, recognitionState, semanticPolicy,
      semanticUsed: false, semanticAttempted: semantic.attempted,
      fastTrack: decisive,
      reasonCodes: decisive ? ['DETERMINISTIC_DECISIVE_TRADING', 'SEMANTIC_SKIPPED'] : ['TRADING_CONFIRMED_WITHOUT_DECISIVE_DETERMINISTIC_SUPPORT'],
    });
  }

  if (decision.status === 'NON_TRADING') {
    // Safety net: a negative decision is valid only when the policy recorded
    // terminal creator-level negative evidence. Otherwise a human must look.
    if (!hasTerminalNegativeEvidence(decision)) {
      return result({
        route: 'HUMAN_REVIEW', confidence, evidenceSufficiency: sufficiency,
        recognitionState, semanticPolicy, semanticUsed: semantic.used, semanticAttempted: semantic.attempted,
        humanReview: true,
        fallbackReason: 'NON_TERMINAL_NEGATIVE_EVIDENCE_REQUIRES_REVIEW',
        reasonCodes: ['NON_TERMINAL_NEGATIVE_EVIDENCE_REQUIRES_REVIEW'],
      });
    }
    if (semantic.used) {
      return result({
        route: 'SEMANTIC_NON_TRADING', confidence, evidenceSufficiency: sufficiency,
        recognitionState, semanticPolicy, semanticUsed: true, semanticAttempted: semantic.attempted,
        reasonCodes: ['SEMANTIC_CONFIRMED_NON_TRADING'],
      });
    }
    const decisive = recognitionState === 'DECISIVE_NON_TRADING' && sufficiency === 'SUFFICIENT';
    return result({
      route: decisive ? 'DETERMINISTIC_NON_TRADING' : 'SEMANTIC_NON_TRADING',
      confidence, evidenceSufficiency: sufficiency, recognitionState, semanticPolicy,
      semanticUsed: false, semanticAttempted: semantic.attempted,
      fastTrack: decisive,
      reasonCodes: decisive ? ['DETERMINISTIC_DECISIVE_NON_TRADING', 'SEMANTIC_SKIPPED'] : ['NON_TRADING_WITHOUT_DECISIVE_DETERMINISTIC_SUPPORT'],
    });
  }

  // UNCERTAIN. Enrichment is the only honest action when the evidence bundle
  // is thin or query-only; human review is for sufficient evidence that the
  // semantic layer could not resolve.
  if (sufficiency !== 'SUFFICIENT' || recognitionState === 'QUERY_ONLY' || recognitionState === 'INSUFFICIENT') {
    return result({
      route: 'ENRICH', confidence, evidenceSufficiency: sufficiency,
      recognitionState, semanticPolicy, semanticUsed: semantic.used, semanticAttempted: semantic.attempted,
      enrich: true,
      fallbackReason: sufficiency !== 'SUFFICIENT' ? 'EVIDENCE_INSUFFICIENT_FOR_REVIEW' : 'ASSESSMENT_REQUIRES_MORE_EVIDENCE',
      reasonCodes: [sufficiency !== 'SUFFICIENT' ? 'INSUFFICIENT_EVIDENCE_ENRICH' : 'MORE_EVIDENCE_REQUIRED'],
    });
  }

  if (recognitionState === 'PROVIDER_DEGRADED') {
    return result({
      route: 'ENRICH', confidence, evidenceSufficiency: sufficiency,
      recognitionState, semanticPolicy, semanticUsed: semantic.used, semanticAttempted: semantic.attempted,
      enrich: true,
      fallbackReason: 'PROVIDER_DEGRADED_RETRY',
      reasonCodes: ['PROVIDER_DEGRADED_RETRY'],
    });
  }

  const semanticUnresolved = semantic.failed || semantic.abstained
    || (!semantic.used && (semanticPolicy === 'NONE' || semanticPolicy === 'BOUNDED_WAIT'));
  if (semanticUnresolved && independent) {
    const fallbackReason = semantic.failed
      ? 'SEMANTIC_FAILED_WITH_SUFFICIENT_EVIDENCE'
      : semantic.abstained
        ? 'SEMANTIC_ABSTAINED_WITH_SUFFICIENT_EVIDENCE'
        : 'NO_SEMANTIC_CAPACITY_WITH_SUFFICIENT_EVIDENCE';
    return result({
      route: 'HUMAN_REVIEW', confidence, evidenceSufficiency: sufficiency,
      recognitionState, semanticPolicy, semanticUsed: semantic.used, semanticAttempted: semantic.attempted,
      humanReview: true,
      fallbackReason,
      reasonCodes: [fallbackReason],
    });
  }

  return result({
    route: 'ENRICH', confidence, evidenceSufficiency: sufficiency,
    recognitionState, semanticPolicy, semanticUsed: semantic.used, semanticAttempted: semantic.attempted,
    enrich: true,
    fallbackReason: independent ? 'AMBIGUOUS_AFTER_SEMANTIC' : 'INDEPENDENT_EVIDENCE_REQUIRED',
    reasonCodes: [independent ? 'AMBIGUOUS_AFTER_SEMANTIC_ENRICH' : 'INDEPENDENT_EVIDENCE_REQUIRED'],
  });
}
