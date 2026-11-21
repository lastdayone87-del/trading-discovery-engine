import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateUnifiedDecisionPolicy, hasIndependentCreatorOwnedPositiveField } from './decisionPolicy';
import type { EvidenceCollectionReport, EvidenceItem } from './types';
import type { ContextualCompositionReport } from './contextualComposition';

const collection = (overrides: Partial<EvidenceCollectionReport> = {}): EvidenceCollectionReport => ({
  sufficiency: 'SUFFICIENT',
  sparseMetadata: false,
  degraded: false,
  fieldsPresent: ['channel_name', 'channel_bio'],
  reasonCodes: [],
  providers: [],
  terminalNegativeSufficiency: {
    status: 'SUFFICIENT',
    creatorLevelCoverage: true,
    independentSourceFamilies: 1,
    independentObservations: 1,
    reasonCodes: ['CREATOR_LEVEL_NEGATIVE_COVERAGE'],
  },
  ...overrides,
});

const positive = (field: 'channel_bio' | 'channel_title'): EvidenceItem => ({
  id: `positive-${field}`,
  source: 'multilingual_context',
  polarity: 'POSITIVE',
  category: 'METHODOLOGY_CONCEPT',
  fact: 'Trading education',
  rawMatches: ['trading'],
  confidence: 90,
  reliability: 'HIGH',
  reliabilityMultiplier: 0.9,
  rawWeight: 12,
  finalWeight: 12,
  provenance: {
    provider: 'multilingual_context',
    type: 'authentic-trading-practice',
    matchedTerm: 'trading',
    sourceRef: 'v1',
    fields: [{ field, sourceId: 'v1', sourceFamilyId: 'video:v1' }],
  },
  timestamp: '2026-01-01T00:00:00Z',
});

const irrelevant = (): EvidenceItem => ({
  id: 'irrelevant',
  source: 'video_metadata',
  polarity: 'NEGATIVE',
  category: 'IRRELEVANT_DOMAIN',
  fact: 'Gaming commentary',
  rawMatches: ['gaming'],
  confidence: 95,
  reliability: 'HIGH',
  reliabilityMultiplier: 0.9,
  rawWeight: 30,
  finalWeight: -30,
  provenance: {
    provider: 'video_metadata',
    type: 'irrelevant-domain',
    matchedTerm: 'gaming',
    sourceRef: 'v1',
    fields: [{ field: 'channel_bio', sourceId: 'v1', sourceFamilyId: 'bio:v1' }],
  },
  timestamp: '2026-01-01T00:00:00Z',
});

test('confirmed confidence stays on the trading scale above the consumer gate', () => {
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: [positive('channel_bio')],
    collection: collection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 1,
    minimumTradingScore: 1,
  });
  assert.equal(decision.status, 'TRADING_CONFIRMED');
  assert.ok(decision.confidenceScore >= 82, `stored confidence ${decision.confidenceScore} fell below the >=80 gate`);
  assert.equal(decision.confidenceScore, Math.max(82, decision.tradingProbability));
});

test('rejected confidence stores a low trading score, not probability of rejection', () => {
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: [irrelevant()],
    collection: collection(),
    lifecycleAction: 'REJECT',
    minimumPositiveWeight: 1,
    minimumTradingScore: 1,
  });
  assert.equal(decision.status, 'NON_TRADING');
  assert.ok(decision.confidenceScore <= 22, `rejected channel stored trading confidence ${decision.confidenceScore}`);
  assert.equal(decision.confidenceScore, Math.min(22, 100 - decision.nonTradingProbability));
});

test('uncertain confidence stays inside the ambiguous band', () => {
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: [{ ...positive('channel_title'), provenance: { ...positive('channel_title').provenance, fields: [{ field: 'channel_title', sourceId: 'v1', sourceFamilyId: 'video:v1' }] } }],
    collection: collection(),
    lifecycleAction: 'REVIEW',
    minimumPositiveWeight: 1,
    minimumTradingScore: 1,
  });
  assert.equal(decision.status, 'UNCERTAIN');
  assert.ok(decision.confidenceScore >= 23 && decision.confidenceScore <= 79);
});

test('a channel title is not an independent creator-owned positive field', () => {
  assert.equal(hasIndependentCreatorOwnedPositiveField([positive('channel_title')]), false);
  assert.equal(hasIndependentCreatorOwnedPositiveField([positive('channel_bio')]), true);
  const searchOnly = positive('channel_bio');
  searchOnly.provenance = { ...searchOnly.provenance, fields: [{ field: 'search_match_context', sourceId: 'v1' }] };
  assert.equal(hasIndependentCreatorOwnedPositiveField([searchOnly]), false);
});

test('trading, investing, institution and hype categories confirm; adjacent and unrelated do not', () => {
  const confirm = (contentCategory?: string) => evaluateUnifiedDecisionPolicy({
    evidence: [positive('channel_bio')],
    collection: collection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 1,
    minimumTradingScore: 1,
    contentCategory,
  });
  for (const category of [
    'ACTIVE_TRADING', 'TRADING_EDUCATION', 'INVESTING_EDUCATION',
    // Commercial, broker/platform, signal and promotional channels remain
    // trading-relevant when their actual content is trading/investing.
    'MARKET_INSTITUTION', 'HYPE',
  ]) {
    assert.equal(confirm(category).status, 'TRADING_CONFIRMED', category);
  }
  for (const category of ['FINANCIAL_NEWS', 'PERSONAL_FINANCE', 'UNRELATED', 'AMBIGUOUS']) {
    const decision = confirm(category);
    assert.equal(decision.status, 'UNCERTAIN', category);
    assert.ok(decision.reasonCodes.includes('CONTENT_CATEGORY_NOT_TRADING_RELEVANT'), category);
  }
  // Legacy callers without a category keep the old behavior; a future label
  // unknown to this policy is not silently treated as non-relevant.
  assert.equal(confirm(undefined).status, 'TRADING_CONFIRMED');
  assert.equal(confirm('FUTURE_RELEVANT_CATEGORY').status, 'TRADING_CONFIRMED');
});

const caliComposition: ContextualCompositionReport = {
  version: 'contextual-composition-v2',
  focus: 'TRADING_DOMINANT',
  observedFamilies: 5,
  informativeFamilies: 5,
  duplicateFamiliesCollapsed: 0,
  tradingFamilies: 5,
  tradingCoreFamilies: 0,
  tradingAdjacentFamilies: 5,
  financeAdjacentFamilies: 0,
  unrelatedFamilies: 0,
  uninformativeFamilies: 0,
  alternativeFamilies: 0,
  neutralFamilies: 0,
  recentTradingFamilies: 4,
  recentAlternativeFamilies: 0,
  tradingCoverage: 1,
  alternativeCoverage: 0,
  financeCoverage: 0,
  unrelatedCoverage: 0,
  temporalCoverage: 'KNOWN',
  nonTitleTierAFamilies: 3,
  explicitCreatorTrading: false,
  explicitCreatorAlternative: false,
  namePriorTrading: true,
  familyClassifications: [],
  reasonCodes: ['TRADING_COVERAGE_DOMINANT'],
};

test('Cali Bourse shape: 0 core + 5 adjacent investing education confirms', () => {
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: [positive('channel_bio')],
    collection: collection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 1,
    minimumTradingScore: 1,
    composition: caliComposition,
    contentCategory: 'INVESTING_EDUCATION',
  });
  assert.equal(decision.status, 'TRADING_CONFIRMED');
});

test('Cali Bourse shape still confirms as a market institution', () => {
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: [positive('channel_bio')],
    collection: collection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 1,
    minimumTradingScore: 1,
    composition: caliComposition,
    contentCategory: 'MARKET_INSTITUTION',
  });
  assert.equal(decision.status, 'TRADING_CONFIRMED');
});

test('Cali Bourse shape still confirms as hype', () => {
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: [positive('channel_bio')],
    collection: collection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 1,
    minimumTradingScore: 1,
    composition: caliComposition,
    contentCategory: 'HYPE',
  });
  assert.equal(decision.status, 'TRADING_CONFIRMED');
});

const semanticTrading = (fields = [{ field: 'video_title' as const, index: 0, sourceId: 'v1', sourceFamilyId: 'video:v1' }]): EvidenceItem => ({
  ...positive('channel_bio'),
  id: 'semantic-trading',
  source: 'gemini_semantic',
  confidence: 84,
  provenance: {
    ...positive('channel_bio').provenance,
    provider: 'gemini_semantic',
    fields,
    semantic: {
      taxonomyLabel: 'ACTIVE_TRADING',
      calibratedConfidence: 84,
      rawConfidence: 95,
      modelVersion: 'test',
      promptVersion: 'test',
      featureVersion: 'test',
      calibrationVersion: 'test',
      reasonCodes: ['PRIMARY_TRADER', 'CONTENT_LIVE'],
      detectedLanguages: [],
    },
  } as any,
});

test('one AI trading verdict confirms without a Tier-A composition veto', () => {
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: [semanticTrading()],
    collection: collection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 10,
    minimumTradingScore: 1,
    contentCategory: 'ACTIVE_TRADING',
    composition: { focus: 'INSUFFICIENT_COVERAGE' } as any,
    recognition: { state: 'AMBIGUOUS_THIN' } as any,
  });
  assert.equal(decision.status, 'TRADING_CONFIRMED');
  assert.ok(decision.reasonCodes.includes('AI_LED_TRADING_CONFIRMATION'));
});

test('an AI verdict without a creator-owned citation still cannot confirm', () => {
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: [semanticTrading([{ field: 'channel_title' } as any])],
    collection: collection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 10,
    minimumTradingScore: 1,
    contentCategory: 'ACTIVE_TRADING',
    composition: { focus: 'INSUFFICIENT_COVERAGE' } as any,
    recognition: { state: 'AMBIGUOUS_THIN' } as any,
  });
  assert.equal(decision.status, 'UNCERTAIN');
});

test('a dominant creator-owned contradiction still blocks an AI trading verdict', () => {
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: [semanticTrading(), irrelevant()],
    collection: collection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 10,
    minimumTradingScore: 1,
    contentCategory: 'ACTIVE_TRADING',
    composition: { focus: 'INSUFFICIENT_COVERAGE' } as any,
    recognition: { state: 'AMBIGUOUS_THIN' } as any,
  });
  assert.notEqual(decision.status, 'TRADING_CONFIRMED');
});

test('an AI-led verdict confirms despite a raw score below the deterministic boundary', () => {
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: [{ ...semanticTrading(), finalWeight: 5 }],
    collection: collection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 10,
    minimumTradingScore: 99,
    contentCategory: 'ACTIVE_TRADING',
    composition: { focus: 'INSUFFICIENT_COVERAGE' } as any,
    recognition: { state: 'AMBIGUOUS_THIN' } as any,
  });
  assert.equal(decision.status, 'TRADING_CONFIRMED');
  assert.ok(decision.reasonCodes.includes('AI_LED_TRADING_CONFIRMATION'));
});

test('a cited AI verdict with no concept matches still confirms', () => {
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: [{ ...semanticTrading(), rawMatches: [] }],
    collection: collection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 1,
    minimumTradingScore: 1,
    contentCategory: 'ACTIVE_TRADING',
    composition: { focus: 'INSUFFICIENT_COVERAGE' } as any,
    recognition: { state: 'AMBIGUOUS_THIN' } as any,
  });
  assert.equal(decision.status, 'TRADING_CONFIRMED');
  assert.ok(decision.reasonCodes.includes('AI_LED_TRADING_CONFIRMATION'));
});

test('LEGACY routing restores the pre-v2 confirmation veto for the same verdict', () => {
  const previous = process.env.DETERMINISTIC_CLASSIFICATION_ROUTING;
  process.env.DETERMINISTIC_CLASSIFICATION_ROUTING = 'LEGACY';
  try {
    const decision = evaluateUnifiedDecisionPolicy({
      evidence: [{ ...semanticTrading(), finalWeight: 12 }],
      collection: collection(),
      lifecycleAction: 'CONFIRM',
      minimumPositiveWeight: 1,
      minimumTradingScore: 1,
      contentCategory: 'ACTIVE_TRADING',
      composition: { focus: 'INSUFFICIENT_COVERAGE' } as any,
      recognition: { state: 'AMBIGUOUS_THIN' } as any,
    });
    assert.notEqual(decision.status, 'TRADING_CONFIRMED');
    assert.ok(!decision.reasonCodes.includes('AI_LED_TRADING_CONFIRMATION'));
    assert.ok(decision.reasonCodes.includes('CONTEXTUAL_COMPOSITION_CONFIRMATION_REQUIRED'));
  } finally {
    if (previous === undefined) delete process.env.DETERMINISTIC_CLASSIFICATION_ROUTING;
    else process.env.DETERMINISTIC_CLASSIFICATION_ROUTING = previous;
  }
});

const semanticLabel = (label: string, polarity: 'POSITIVE' | 'NEGATIVE' = 'NEGATIVE'): EvidenceItem => ({
  id: `semantic-${label}`,
  source: 'gemini_semantic',
  polarity,
  category: polarity === 'POSITIVE' ? 'METHODOLOGY_CONCEPT' : 'IRRELEVANT_DOMAIN',
  fact: `Semantic ${label}`,
  rawMatches: ['trading'],
  confidence: 84,
  reliability: 'MEDIUM',
  reliabilityMultiplier: 0.65,
  rawWeight: 26,
  finalWeight: polarity === 'POSITIVE' ? 17 : -17,
  provenance: {
    provider: 'gemini_semantic',
    type: polarity === 'POSITIVE' ? 'METHODOLOGY_CONCEPT' : 'IRRELEVANT_DOMAIN',
    matchedTerm: label,
    sourceRef: 'semantic',
    fields: [{ field: 'channel_bio', sourceId: 'bio:v1', sourceFamilyId: 'bio:v1' }],
    semantic: {
      modelVersion: 'test', promptVersion: 'test', featureVersion: 'test', calibrationVersion: 'test',
      taxonomyLabel: label, calibratedConfidence: 84, rawConfidence: 95, detectedLanguages: [], reasonCodes: [],
    },
  },
  timestamp: '2026-01-01T00:00:00Z',
});

test('bank/non-trading institution is a terminal negative while a trading platform is not', () => {
  const bank = evaluateUnifiedDecisionPolicy({
    evidence: [semanticLabel('BANK_OR_NON_TRADING_INSTITUTION')],
    collection: collection(),
    lifecycleAction: 'REJECT',
    minimumPositiveWeight: 1,
    minimumTradingScore: 1,
    contentCategory: 'BANK_OR_NON_TRADING_INSTITUTION',
  });
  assert.equal(bank.status, 'NON_TRADING');
  assert.ok(bank.reasonCodes.includes('HIGH_CONFIDENCE_CREATOR_LEVEL_BANK_OR_NON_TRADING_INSTITUTION'));

  const platform = evaluateUnifiedDecisionPolicy({
    evidence: [semanticLabel('TRADING_PLATFORM_OR_FIRM', 'POSITIVE')],
    collection: collection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 1,
    minimumTradingScore: 1,
    contentCategory: 'TRADING_PLATFORM_OR_FIRM',
  });
  assert.equal(platform.status, 'TRADING_CONFIRMED');

  const bankCategory = evaluateUnifiedDecisionPolicy({
    evidence: [positive('channel_bio')],
    collection: collection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 1,
    minimumTradingScore: 1,
    contentCategory: 'BANK_OR_NON_TRADING_INSTITUTION',
  });
  assert.equal(bankCategory.status, 'UNCERTAIN');
  assert.ok(bankCategory.reasonCodes.includes('CONTENT_CATEGORY_NOT_TRADING_RELEVANT'));
});
