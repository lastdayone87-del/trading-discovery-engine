import assert from 'node:assert/strict';
import test from 'node:test';
import type { VerificationDecision } from '../evidenceEngine/types';
import { resolveClassificationRouting, resolveClassificationRoutingMode } from './deterministicFirst';

type DecisionOverrides = Partial<VerificationDecision> & {
  providers?: VerificationDecision['evidenceCollection']['providers'];
  terminalStatus?: 'SUFFICIENT' | 'INSUFFICIENT';
  policyReasons?: string[];
};

function decision(overrides: DecisionOverrides = {}): VerificationDecision {
  const providers = overrides.providers || [];
  return {
    status: 'UNCERTAIN',
    confidenceScore: 50,
    category: 'UNCERTAIN',
    multiVideoConsistencyRatio: 0,
    positiveEvidence: [],
    negativeEvidence: [],
    totalPositiveWeight: 0,
    totalNegativeWeight: 0,
    countryContextUsed: { country: 'NL', language: 'en', matchedTerms: [], matchedNegativeTerms: [] },
    versions: { evidenceEngineVersion: 'test', scoringEngineVersion: 'test', geminiModelVersion: 'test' } as any,
    mathematicalJustification: '',
    evidenceCollection: {
      sufficiency: 'SUFFICIENT',
      sparseMetadata: false,
      degraded: false,
      fieldsPresent: ['description'],
      reasonCodes: [],
      providers,
      terminalNegativeSufficiency: {
        status: overrides.terminalStatus || 'INSUFFICIENT',
        creatorLevelCoverage: overrides.terminalStatus === 'SUFFICIENT',
        independentSourceFamilies: 0,
        independentObservations: 0,
        reasonCodes: [],
      },
    },
    timestamp: new Date(0).toISOString(),
    decisionPolicy: {
      version: 'test',
      tradingProbability: 50,
      nonTradingProbability: 50,
      coverageConfidence: 50,
      reasonCodes: overrides.policyReasons || [],
    },
    recognitionState: 'AMBIGUOUS_THIN',
    semanticPolicy: 'BOUNDED_WAIT',
    classificationMethod: undefined,
    ...overrides,
  } as VerificationDecision;
}

const semanticProvider = (outcome: string) => ({
  provider: 'gemini_semantic' as const,
  availability: 'AVAILABLE' as const,
  evidenceCount: 1,
  outcome: outcome as any,
  reasonCodes: [],
  durationMs: 10,
});

test('default routing is active and LEGACY is an explicit rollback', () => {
  assert.equal(resolveClassificationRoutingMode({} as NodeJS.ProcessEnv), 'ACTIVE');
  assert.equal(resolveClassificationRoutingMode({ DETERMINISTIC_CLASSIFICATION_ROUTING: 'legacy' } as NodeJS.ProcessEnv), 'LEGACY');
});

test('decisive deterministic trading is fast-tracked without semantic', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED',
    confidenceScore: 90,
    recognitionState: 'DECISIVE_TRADING',
    semanticPolicy: 'SKIP',
    providers: [semanticProvider('SUPPRESSED_BY_POLICY')],
  }), { independentEvidence: true });
  assert.equal(routed.route, 'DETERMINISTIC_TRADING');
  assert.equal(routed.fastTrack, true);
  assert.equal(routed.humanReview, false);
});

test('semantic-confirmed trading is not misreported as deterministic', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED',
    confidenceScore: 88,
    recognitionState: 'AMBIGUOUS_THIN',
    semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), { independentEvidence: true });
  assert.equal(routed.route, 'SEMANTIC_TRADING');
  assert.equal(routed.fastTrack, false);
  assert.equal(routed.semanticUsed, true);
});

test('terminal creator-level negative can be deterministic non-trading', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'NON_TRADING',
    confidenceScore: 10,
    recognitionState: 'DECISIVE_NON_TRADING',
    semanticPolicy: 'SKIP',
    terminalStatus: 'SUFFICIENT',
    policyReasons: ['HIGH_CONFIDENCE_CREATOR_LEVEL_UNRELATED'],
    providers: [semanticProvider('SUPPRESSED_BY_POLICY')],
  }));
  assert.equal(routed.route, 'DETERMINISTIC_NON_TRADING');
  assert.equal(routed.fastTrack, true);
});

test('non-trading without terminal creator-level negative evidence goes to human review', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'NON_TRADING',
    confidenceScore: 10,
    recognitionState: 'DECISIVE_NON_TRADING',
    semanticPolicy: 'SKIP',
    terminalStatus: 'INSUFFICIENT',
    policyReasons: [],
    providers: [semanticProvider('SUPPRESSED_BY_POLICY')],
  }));
  assert.equal(routed.route, 'HUMAN_REVIEW');
  assert.equal(routed.humanReview, true);
  assert.ok(routed.reasonCodes.includes('NON_TERMINAL_NEGATIVE_EVIDENCE_REQUIRES_REVIEW'));
});

test('sufficient independent evidence with failed semantic goes to human review', () => {
  const routed = resolveClassificationRouting(decision({
    providers: [semanticProvider('FAILED_PROVIDER')],
    recognitionState: 'AMBIGUOUS_THIN',
    semanticPolicy: 'BOUNDED_WAIT',
  }), { independentEvidence: true });
  assert.equal(routed.route, 'HUMAN_REVIEW');
  assert.equal(routed.fallbackReason, 'SEMANTIC_FAILED_WITH_SUFFICIENT_EVIDENCE');
});

test('sufficient evidence without independent corroboration keeps enriching', () => {
  const routed = resolveClassificationRouting(decision({
    providers: [semanticProvider('ABSTAINED_LOW_CONFIDENCE')],
    recognitionState: 'AMBIGUOUS_THIN',
    semanticPolicy: 'BOUNDED_WAIT',
  }), { independentEvidence: false });
  assert.equal(routed.route, 'ENRICH');
  assert.equal(routed.enrich, true);
});

test('thin evidence always enriches instead of creating review debt', () => {
  const routed = resolveClassificationRouting(decision({
    evidenceCollection: {
      ...decision().evidenceCollection,
      sufficiency: 'INSUFFICIENT',
    },
    recognitionState: 'INSUFFICIENT',
    providers: [semanticProvider('FAILED_PROVIDER')],
  }), { independentEvidence: true });
  assert.equal(routed.route, 'ENRICH');
});

test('query-only evidence enriches without semantic spend', () => {
  const routed = resolveClassificationRouting(decision({
    recognitionState: 'QUERY_ONLY',
    semanticPolicy: 'SKIP',
    providers: [semanticProvider('SUPPRESSED_BY_POLICY')],
  }), { independentEvidence: true });
  assert.equal(routed.route, 'ENRICH');
});

test('a confirmed channel whose video sample contradicts its bio is sent to human review', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'DECISIVE_TRADING', semanticPolicy: 'SKIP',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true, videoSampleCount: 10,
    channelText: 'Forex trading live analysis. dance choreography trending music song vlog',
  });
  assert.equal(routed.route, 'HUMAN_REVIEW');
  assert.equal(routed.fallbackReason, 'NON_TRADING_CONTENT_FOCUS_REQUIRES_REVIEW');
});

test('a confirmed channel with real trading analysis in its videos is not sent to review', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'DECISIVE_TRADING', semanticPolicy: 'SKIP',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true, videoSampleCount: 10,
    channelText: 'EURUSD technical analysis price action live trading market structure breakout',
  });
  assert.equal(routed.route, 'SEMANTIC_TRADING');
});

test('a bio-only confirmation is not reviewed by the video mismatch guard', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'DECISIVE_TRADING', semanticPolicy: 'SKIP',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), { independentEvidence: true, videoSampleCount: 0, channelText: 'Forex trader' });
  assert.equal(routed.route, 'SEMANTIC_TRADING');
});
