import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCanonicalEvidenceCorpus } from './canonicalEvidencePlane';
import { buildContextualComposition } from './contextualComposition';
import { compositionConfirmsTrading } from './decisionPolicy';
import { getLayeredKnowledgeContext } from './knowledgePacks';
import { MultilingualContextProvider } from './providers/MultilingualContextProvider';
import { assessTradingText } from './tradingSignalTaxonomy';
import { assessNegativeEvidence, classifyNegativeEvidenceRole, negativeEvidencePolicyWeight } from './negativeEvidenceRole';
import { evaluateUnifiedDecisionPolicy } from './decisionPolicy';
import type { EvidenceCollectionReport, EvidenceItem, RawChannelInput } from './types';

function input(overrides: Partial<RawChannelInput>): RawChannelInput {
  const value: RawChannelInput = {
    channel_name: 'Fixture',
    description: '',
    country: 'United States',
    ...overrides,
  };
  value.evidence_corpus = buildCanonicalEvidenceCorpus(value);
  return value;
}

function compose(videos: Array<{ title: string; description?: string }>, description = '', channelName = 'Fixture') {
  const value = input({
    channel_name: channelName,
    description,
    videos: videos.map((video, index) => ({ id: `video-${index}`, ...video })),
  });
  return buildContextualComposition(value, getLayeredKnowledgeContext('United States'));
}

test('C5 v2: exact duplicate uploads collapse to one uninformative family', () => {
  const composition = compose(Array.from({ length: 9 }, () => ({ title: 'Another Day 🤑' })));
  assert.equal(composition.observedFamilies, 9);
  assert.equal(composition.duplicateFamiliesCollapsed, 8);
  assert.equal(composition.informativeFamilies, 0);
  assert.equal(composition.uninformativeFamilies, 1);
  assert.equal(composition.focus, 'INSUFFICIENT_COVERAGE');
});

test('C5 v2: bare links and generic YouTube boilerplate are absence, not opposition', () => {
  const value = input({
    channel_name: 'Fixture',
    description: 'Share your videos with friends, family, and the world',
    external_links: ['https://t.me/creator', 'https://g'],
  });
  const composition = buildContextualComposition(value, getLayeredKnowledgeContext('United States'));
  assert.equal(composition.informativeFamilies, 0);
  assert.equal(composition.uninformativeFamilies, 3);
  assert.equal(composition.focus, 'INSUFFICIENT_COVERAGE');
});

test('C5 v2: one trading family plus nine uninformative families cannot confirm without an explicit creator statement', () => {
  const videos = [
    { title: 'Day trading setup' },
    ...Array.from({ length: 9 }, () => ({ title: 'Another Day 🤑' })),
  ];
  const withoutCreator = compose(videos);
  assert.equal(withoutCreator.informativeFamilies, 1);
  assert.equal(withoutCreator.tradingCoreFamilies, 1);
  assert.equal(withoutCreator.focus, 'INSUFFICIENT_COVERAGE');
  assert.equal(compositionConfirmsTrading(withoutCreator), false);

  const withCreator = compose(videos, 'Day trading and order flow education.');
  assert.equal(withCreator.explicitCreatorTrading, true);
  assert.equal(withCreator.focus, 'TRADING_DOMINANT');
  assert.equal(compositionConfirmsTrading(withCreator), true);
});

test('C5 v2: ten trading and ten gaming families remain mixed at 0.5 coverage', () => {
  const videos = [
    ...Array.from({ length: 10 }, (_, index) => ({ title: `Day trading setup ${index}` })),
    ...Array.from({ length: 10 }, (_, index) => ({ title: `Minecraft gameplay ${index}` })),
  ];
  const composition = compose(videos);
  assert.equal(composition.informativeFamilies, 20);
  assert.equal(composition.tradingCoreFamilies, 10);
  assert.equal(composition.unrelatedFamilies, 10);
  assert.equal(composition.tradingCoverage, 0.5);
  assert.equal(composition.unrelatedCoverage, 0.5);
  assert.equal(composition.focus, 'MIXED');
  assert.equal(compositionConfirmsTrading(composition), false);
});

test('C5 v2: five trading and five finance-adjacent families remain mixed at 0.5 coverage', () => {
  const videos = [
    ...Array.from({ length: 5 }, (_, index) => ({ title: `Day trading setup ${index}` })),
    ...Array.from({ length: 5 }, (_, index) => ({ title: `Personal finance budgeting ${index}` })),
  ];
  const composition = compose(videos);
  assert.equal(composition.tradingCoverage, 0.5);
  assert.equal(composition.financeAdjacentFamilies, 5);
  assert.equal(composition.alternativeCoverage, 0.5);
  assert.equal(composition.focus, 'MIXED');
  assert.equal(compositionConfirmsTrading(composition), false);
});

test('C5 v2: two core trading families plus one finance family stay dominant', () => {
  const composition = compose([
    { title: 'Day trading setup' },
    { title: 'Order flow trading' },
    { title: 'Personal finance budgeting' },
  ]);
  assert.equal(composition.tradingCoreFamilies, 2);
  assert.equal(composition.tradingCoverage, 2 / 3);
  assert.equal(composition.alternativeCoverage, 1 / 3);
  assert.equal(composition.focus, 'TRADING_DOMINANT');
  assert.equal(compositionConfirmsTrading(composition), true);
});

test('C5 v2: two core trading families plus one unrelated family stay dominant', () => {
  const composition = compose([
    { title: 'Day trading setup' },
    { title: 'Order flow trading' },
    { title: 'Minecraft gameplay' },
  ]);
  assert.equal(composition.tradingCoreFamilies, 2);
  assert.equal(composition.unrelatedFamilies, 1);
  assert.equal(composition.unrelatedCoverage, 1 / 3);
  assert.equal(composition.alternativeCoverage, 1 / 3);
  assert.equal(composition.focus, 'TRADING_DOMINANT');
  assert.equal(compositionConfirmsTrading(composition), true);
});

test('C5 v2: duplicate collapse preserves distinct numbered videos', () => {
  const composition = compose([
    { title: 'Day trading setup 1' },
    { title: 'Day trading setup 2' },
  ]);
  assert.equal(composition.duplicateFamiliesCollapsed, 0);
  assert.equal(composition.tradingCoreFamilies, 2);
});

test('C5 v2: long numbered titles with nearly identical text stay distinct', () => {
  const shared = 'advanced day trading order flow strategy review setup execution journal risk position stop loss market structure liquidity fair value gap break of structure volume profile footprint chart';
  const composition = compose([
    { title: `${shared} episode 1` },
    { title: `${shared} episode 2` },
  ]);
  assert.equal(composition.duplicateFamiliesCollapsed, 0);
  assert.equal(composition.tradingCoreFamilies, 2);
});

test('C5 v2: the same generic title with different descriptions is not a duplicate', () => {
  const composition = compose([
    { title: 'Day trading setup', description: 'London session execution with order flow and stop loss placement.' },
    { title: 'Day trading setup', description: 'Backtesting the FTSE strategy with position sizing and trade journal review.' },
  ]);
  assert.equal(composition.duplicateFamiliesCollapsed, 0);
  assert.equal(composition.tradingCoreFamilies, 2);
});

test('shared taxonomy classifies multilingual trading, commentary and non-trading controls', () => {
  const context = getLayeredKnowledgeContext('United States');
  const expected: Array<[string, string]> = [
    ['Analyse technique du CAC40', 'TRADING_ADJACENT'],
    ['Forex Trader depuis 2017', 'TRADING_CORE'],
    ['Trading et Investissement sur les marchés', 'TRADING_CORE'],
    ['Nasdaq : la claque ! Panique ou opportunité ?', 'TRADING_ADJACENT'],
    ['Or sous 4 000 $ : pourquoi j’ai coupé ma position', 'TRADING_ADJACENT'],
    ['Trading au sens large', 'TRADING_ADJACENT'],
    ['Minecraft es mi vida', 'UNRELATED'],
    ['El sol', 'UNINFORMATIVE'],
    ['Menu options', 'UNINFORMATIVE'],
    ['ES futures trading', 'TRADING_CORE'],
    ['Options trading', 'TRADING_CORE'],
    ['Les bases de Trading', 'TRADING_ADJACENT'],
    ['Nq trading videos', 'TRADING_CORE'],
    ['Trades for 1st day of July 2022', 'TRADING_CORE'],
    ['STUDY THE CHART. MASTER THE SETUP. #SMC', 'TRADING_CORE'],
    ['Another Day 🤑', 'UNINFORMATIVE'],
    ['Day trading. Not financial advice.', 'TRADING_CORE'],
    ['Workplace risk management', 'UNINFORMATIVE'],
    ['Gestion du risque', 'UNINFORMATIVE'],
    ['ICT', 'UNINFORMATIVE'],
    ['ICT trading', 'TRADING_CORE'],
    ['Pokemon trading cards opening and grading', 'UNRELATED'],
    ['Official music video', 'UNRELATED'],
    ['Minecraft gameplay', 'UNRELATED'],
    ['Personal finance budgeting', 'FINANCE_ADJACENT'],
    ['Investing for beginners', 'FINANCE_ADJACENT'],
    ['Retirement planning', 'FINANCE_ADJACENT'],
  ];
  for (const [text, focus] of expected) {
    assert.equal(assessTradingText(text, context).focus, focus, text);
  }
});

test('claim polarity suppresses disclaimers and quoted criticism but keeps asserted hype', async () => {
  const provider = new MultilingualContextProvider();
  const context = getLayeredKnowledgeContext('United States');
  const collect = async (description: string) => {
    const value = input({ description });
    return provider.collectEvidence(value, context);
  };

  assert.equal((await collect('No guaranteed profits')).some(item => item.category === 'HYPE_SPECULATION'), false);
  assert.equal((await collect('Scam gurus promise guaranteed profits')).some(item => item.category === 'HYPE_SPECULATION'), false);
  assert.equal((await collect("I don't trade forex")).some(item => item.polarity === 'POSITIVE'), false);
  assert.equal((await collect('Gestion du risque')).some(item => item.polarity === 'POSITIVE'), false);
  const assertedHype = await collect('Guaranteed profits');
  assert.equal(assertedHype.some(item => item.category === 'HYPE_SPECULATION'), true);

  const mixed = await collect('No guaranteed profits. Day trading and order flow education.');
  assert.equal(mixed.some(item => item.category === 'HYPE_SPECULATION'), false);
  assert.equal(mixed.some(item => item.category === 'METHODOLOGY_CONCEPT'), true);
});

function negative(partial: Partial<EvidenceItem>): EvidenceItem {
  return {
    id: 'negative',
    source: 'channel_metadata',
    polarity: 'NEGATIVE',
    category: 'HYPE_SPECULATION',
    fact: 'negative',
    rawMatches: ['guaranteed profit'],
    confidence: 90,
    reliability: 'HIGH',
    reliabilityMultiplier: 0.85,
    rawWeight: 32,
    finalWeight: -26.1,
    timestamp: '2026-01-01T00:00:00Z',
    provenance: { provider: 'channel_metadata', type: 'HYPE_SPECULATION', matchedTerm: 'guaranteed profit', sourceRef: 'bio' },
    ...partial,
  };
}

test('negative evidence roles keep only creator-level unrelated-domain evidence terminal', () => {
  assert.equal(classifyNegativeEvidenceRole(negative({})), 'CONFIDENCE_PENALTY');
  assert.equal(classifyNegativeEvidenceRole(negative({ category: 'NON_TRADING_ADJACENT' })), 'CONFIDENCE_PENALTY');
  assert.equal(classifyNegativeEvidenceRole(negative({ category: 'IRRELEVANT_DOMAIN' })), 'TERMINAL');
  assert.equal(classifyNegativeEvidenceRole(negative({
    category: 'IRRELEVANT_DOMAIN',
    provenance: {
      provider: 'channel_metadata', type: 'IRRELEVANT_DOMAIN', matchedTerm: 'gaming', sourceRef: 'video',
      fields: [{ field: 'video_title', sourceId: 'v1', sourceFamilyId: 'video:v1' }],
    },
  })), 'CONFIDENCE_PENALTY');
  assert.equal(classifyNegativeEvidenceRole(negative({
    category: 'IRRELEVANT_DOMAIN',
    provenance: {
      provider: 'channel_metadata', type: 'IRRELEVANT_DOMAIN', matchedTerm: 'gaming', sourceRef: 'videos',
      fields: [
        { field: 'video_title', sourceId: 'v1', sourceFamilyId: 'video:v1' },
        { field: 'video_title', sourceId: 'v2', sourceFamilyId: 'video:v2' },
      ],
    },
  })), 'TERMINAL');
  assert.equal(classifyNegativeEvidenceRole(negative({
    category: 'IRRELEVANT_DOMAIN',
    provenance: {
      provider: 'channel_metadata', type: 'IRRELEVANT_DOMAIN', matchedTerm: 'gaming', sourceRef: 'bio',
      fields: [{ field: 'channel_bio', sourceId: 'about' }],
    },
  })), 'TERMINAL');
  assert.equal(classifyNegativeEvidenceRole(negative({ claimPolarity: 'DISCLAIMER' })), 'DISCLAIMER');
  assert.equal(classifyNegativeEvidenceRole(negative({ claimPolarity: 'QUOTED' })), 'QUOTED');
  assert.equal(negativeEvidencePolicyWeight(negative({ claimPolarity: 'DISCLAIMER' })), 0);
  assert.equal(negativeEvidencePolicyWeight(negative({})), 26.1);

  const assessment = assessNegativeEvidence(negative({ category: 'IRRELEVANT_DOMAIN' }));
  assert.equal(assessment.role, 'TERMINAL');
  assert.equal(assessment.term, 'guaranteed profit');
});

test('a non-terminal negative is a confidence penalty, not a confirmation veto', () => {
  const collection: EvidenceCollectionReport = {
    sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false,
    fieldsPresent: ['channel_bio'], reasonCodes: [], providers: [],
  };
  const positive = (id: string, weight: number): EvidenceItem => ({
    id, source: 'channel_metadata', polarity: 'POSITIVE', category: 'METHODOLOGY_CONCEPT',
    fact: 'trading education', rawMatches: ['order flow'], confidence: 90, reliability: 'HIGH',
    reliabilityMultiplier: 0.85, rawWeight: weight, finalWeight: weight,
    provenance: {
      provider: 'channel_metadata', type: 'methodology', matchedTerm: 'order flow',
      sourceRef: 'bio', fields: [{ field: 'channel_bio', sourceFamilyId: 'about' }],
    },
    timestamp: '2026-01-01T00:00:00Z',
  });
  const items = [positive('pos', 70), negative({})];
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: items, collection, lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 25, minimumTradingScore: 65,
  });
  assert.equal(decision.status, 'TRADING_CONFIRMED');
  assert.ok(decision.reasonCodes.includes('NON_TERMINAL_NEGATIVE_PENALTY_ONLY'));

  const disclaimer = evaluateUnifiedDecisionPolicy({
    evidence: [positive('pos', 70), negative({ claimPolarity: 'DISCLAIMER' })],
    collection, lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 25, minimumTradingScore: 65,
  });
  assert.equal(disclaimer.status, 'TRADING_CONFIRMED');
  assert.ok(disclaimer.tradingProbability > decision.tradingProbability);
});
