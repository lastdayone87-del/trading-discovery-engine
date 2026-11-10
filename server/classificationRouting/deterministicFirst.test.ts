import assert from 'node:assert/strict';
import test from 'node:test';
import type { VerificationDecision } from '../evidenceEngine/types';
import { nonTradingContentFocus, resolveClassificationRouting, resolveClassificationRoutingMode } from './deterministicFirst';

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
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: ['forex trading live analysis', 'dance choreography trending music song vlog', 'music cover song', 'weekend vlog'],
  });
  assert.equal(routed.route, 'HUMAN_REVIEW');
  assert.equal(routed.fallbackReason, 'NON_TRADING_CONTENT_FOCUS_REQUIRES_REVIEW');
});

test('a confirmed channel with real trading analysis in its videos is not sent to review', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: ['EURUSD technical analysis price action', 'live trading market structure', 'breakout setup review', 'weekly forex outlook'],
  });
  assert.equal(routed.route, 'SEMANTIC_TRADING');
});

test('a bio-only confirmation is not reviewed by the video mismatch guard', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), { independentEvidence: true, videoTexts: [] });
  assert.equal(routed.route, 'SEMANTIC_TRADING');
});

test('one off-topic video does not send a confirmed trading channel to review', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: ['EURUSD technical analysis', 'gold price action review', 'weekend dance vlog'],
  });
  assert.equal(routed.route, 'SEMANTIC_TRADING');
});

test('a strong trading phrase in the bio does not mask a non-trading video sample', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: ['dance choreography', 'music cover', 'cooking recipe', 'daily vlog'],
  });
  assert.equal(routed.route, 'HUMAN_REVIEW');
});

test('word boundaries keep guidance, credit spreads, market reactions and corporate earnings out of the guard', () => {
  const focus = nonTradingContentFocus('Weekly guidance on credit spreads, market reaction and corporate earnings.');
  assert.equal(focus.total, 0);
  assert.deepEqual(focus.categories, []);
});

test('repeated promotional footers and URLs do not create non-trading focus', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: [
      `EURUSD trade recap Monday\nmemecoin giveaway\nhttps://broker.example.com/ref=1`,
      `GBPUSD trade recap Tuesday\nmemecoin giveaway\nhttps://broker.example.com/ref=2`,
      `USDJPY trade recap Wednesday\nmemecoin giveaway\nhttps://broker.example.com/ref=3`,
    ],
  });
  assert.equal(routed.route, 'SEMANTIC_TRADING');
});

test('repeated trading titles survive footer removal', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: [
      'Live trading\nMusic: track one',
      'Live trading\nMusic: track two',
      'Live trading\nMusic: track three',
    ],
  });
  assert.equal(routed.route, 'SEMANTIC_TRADING');
});

test('generic personal-finance outlooks still reach review', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: ['Retirement savings outlook', 'How to budget your paycheck', 'Pay off your mortgage'],
  });
  assert.equal(routed.route, 'HUMAN_REVIEW');
});

test('pump-and-dump is not counted as promotion', () => {
  assert.equal(nonTradingContentFocus('pump-and-dump scheme').total, 0);
  assert.equal(nonTradingContentFocus('pump and dump scheme').total, 0);
});

test('Distinct videos with identical off-topic metadata still count toward the guard', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: ['dance choreography music', 'dance choreography music', 'dance choreography music'],
  });
  assert.equal(routed.route, 'HUMAN_REVIEW');
});

test('repeated off-topic subject lines are not stripped as distribution boilerplate', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: [
      'Monday recap\nDance music',
      'Tuesday recap\nDance music',
      'Wednesday recap\nDance music',
    ],
  });
  assert.equal(routed.route, 'HUMAN_REVIEW');
});

test('Bitcoin and Nasdaq forecasts count as strong market analysis', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: ['Bitcoin forecast this week\nmakeup tutorial', 'Nasdaq outlook and levels\nbeauty routine', 'weekend dance vlog'],
  });
  assert.equal(routed.route, 'SEMANTIC_TRADING');
});

test('repeated music credits are treated as boilerplate, not entertainment focus', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: [
      'Gold update\nMusic: Track A',
      'Silver update\nMusic: Track B',
      'EURUSD update\nMusic: Track C',
    ],
  });
  assert.equal(routed.route, 'SEMANTIC_TRADING');
});

test('beauty titles do not match the asset name dow', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: ['Eyeshadow preview', 'Makeup tutorial', 'Beauty routine'],
  });
  assert.equal(routed.route, 'HUMAN_REVIEW');
});

test('a bare currency ticker does not bypass the personal-finance focus guard', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: ['EURUSD', 'Retirement savings', 'Budget tips'],
  });
  assert.equal(routed.route, 'HUMAN_REVIEW');
});

test('semantic ambiguity with sufficient independent evidence goes to human review', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'UNCERTAIN', confidenceScore: 64, recognitionState: 'AMBIGUOUS_CONFLICT', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), { independentEvidence: true });
  assert.equal(routed.route, 'HUMAN_REVIEW');
  assert.equal(routed.fallbackReason, 'SEMANTIC_AMBIGUOUS_WITH_SUFFICIENT_EVIDENCE');
});

test('semantic ambiguity without independent evidence still enriches', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'UNCERTAIN', confidenceScore: 64, recognitionState: 'AMBIGUOUS_CONFLICT', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), { independentEvidence: false });
  assert.equal(routed.route, 'ENRICH');
});

test('chart links do not erase trading analysis on the same description line', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: [
      'makeup tutorial\nEURUSD analysis https://chart.example.com/1',
      'beauty routine\nGBPUSD analysis https://chart.example.com/2',
      'dance vlog\nUSDJPY analysis https://chart.example.com/3',
    ],
  });
  assert.equal(routed.route, 'SEMANTIC_TRADING');
});

test('a shared financial-sounding footer does not bypass the review guard', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: [
      'Dance choreography\nSubscribe for daily market analysis',
      'Makeup tutorial\nSubscribe for daily market analysis',
      'Cooking recipe\nSubscribe for daily market analysis',
    ],
  });
  assert.equal(routed.route, 'HUMAN_REVIEW');
});

test('a repeated broker referral footer with a promotion does not create focus', () => {
  const routed = resolveClassificationRouting(decision({
    status: 'TRADING_CONFIRMED', confidenceScore: 90, recognitionState: 'AMBIGUOUS_THIN', semanticPolicy: 'BOUNDED_WAIT',
    providers: [semanticProvider('EXECUTED_WITH_EVIDENCE')],
  }), {
    independentEvidence: true,
    videoTexts: [
      'EURUSD trade recap Monday\nReferral link: memecoin giveaway https://broker.example.com/1',
      'GBPUSD trade recap Tuesday\nReferral link: memecoin giveaway https://broker.example.com/2',
      'USDJPY trade recap Wednesday\nReferral link: memecoin giveaway https://broker.example.com/3',
    ],
  });
  assert.equal(routed.route, 'SEMANTIC_TRADING');
});
