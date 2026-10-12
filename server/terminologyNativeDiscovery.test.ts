import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  KNOWN_INSTRUMENT_TERMS,
  NATIVE_PROMOTION_MIN_CREATORS,
  NATIVE_PROMOTION_MIN_EXECUTIONS,
  NATIVE_PROMOTION_MIN_YIELD_PER_1000_QUOTA,
  detectSpamSignals,
  evaluateNativeTermPromotion,
  evaluateTermNovelty,
  evaluateTermQualityFlags,
  evaluateTrialEntry,
  findLiteralSpan,
  getPlannerTerminology,
  refreshTerminologyLifecycle,
} from './terminologyIntelligence';
import { planDiverseQueries } from './queryPlanner';

const SOURCES = [
  { kind: 'CHANNEL_NAME' as const, index: 0, text: 'Börsenanalyse LuxX' },
  { kind: 'VIDEO_TITLE' as const, index: 0, text: 'Flux Ordres Nasdaq - Order Flow NQ' },
  { kind: 'VIDEO_TITLE' as const, index: 1, text: 'Day trading update' },
  { kind: 'DESCRIPTION' as const, index: 0, text: 'Rejoignez mon canal Telegram signaux gratuits' },
];

test('instrument list is pinned against drift', () => {
  assert.deepEqual([...KNOWN_INSTRUMENT_TERMS].sort(), [
    'AEX', 'BTC', 'CAC 40', 'DAX', 'ES', 'ETH', 'EURUSD', 'FDAX', 'FTSE 100',
    'GBPUSD', 'Gold', 'IBEX 35', 'NQ', 'Nasdaq', 'S&P 500', 'WTI Crude',
  ].sort());
});

test('literal spans trace to exact source text', () => {
  assert.deepEqual(findLiteralSpan('Börsenanalyse', SOURCES), {
    sourceKind: 'CHANNEL_NAME', sourceIndex: 0, span: 'Börsenanalyse', videoId: null,
  });
  assert.deepEqual(findLiteralSpan('flux ordres', SOURCES)?.sourceKind, 'VIDEO_TITLE');
  assert.equal(findLiteralSpan('flux ordres', SOURCES)?.sourceIndex, 0);
  // Case-insensitive match returns the source-cased span.
  assert.equal(findLiteralSpan('nasdaq', SOURCES)?.span, 'Nasdaq');
  // Word boundaries: ES must not match inside ordinary words.
  assert.equal(findLiteralSpan('ES', [{ kind: 'DESCRIPTION', index: 0, text: 'heroes and best trades' }]), null);
  assert.notEqual(findLiteralSpan('ES', [{ kind: 'DESCRIPTION', index: 0, text: 'trade ES Futures today' }]), null);
  // Invented or paraphrased terms have no span and must not persist.
  assert.equal(findLiteralSpan('Scalping Strategie', SOURCES), null);
  assert.equal(findLiteralSpan('X', SOURCES), null);
  assert.equal(findLiteralSpan('', SOURCES), null);
  // Non-Latin scripts match by substring (no word boundaries in CJK).
  assert.notEqual(findLiteralSpan('原油', [{ kind: 'VIDEO_TITLE', index: 0, text: '原油期货交易' }]), null);
});

test('novelty distinguishes new terms from known ones', () => {
  const curated = ['Börsenanalyse', 'DAX Analyse'];
  const existing = ['Scalping Strategie'];
  assert.deepEqual(
    evaluateTermNovelty('Börsenanalyse', { country: 'Germany', curatedTerms: curated, existingTerms: existing }),
    { novel: false, knownAs: 'curated:Germany:Börsenanalyse' }
  );
  assert.deepEqual(
    evaluateTermNovelty('btc', { country: 'Germany', curatedTerms: curated, existingTerms: existing }),
    { novel: false, knownAs: 'instrument:BTC' }
  );
  assert.deepEqual(
    evaluateTermNovelty('SCALPING STRATEGIE', { country: 'Germany', curatedTerms: curated, existingTerms: existing }),
    { novel: false, knownAs: 'extracted:Scalping Strategie' }
  );
  assert.deepEqual(
    evaluateTermNovelty('P2P-Algo', { country: 'Germany', curatedTerms: curated, existingTerms: existing }),
    { novel: true, knownAs: null }
  );
});

test('spam patterns reject solicitation, preserve legitimate terms', () => {
  assert.deepEqual(detectSpamSignals('join my free WhatsApp signals'), ['signal-group-solicitation', 'messenger-solicitation']);
  assert.deepEqual(detectSpamSignals('Gold promo code FREE100'), ['promotional']);
  assert.deepEqual(detectSpamSignals('guaranteed 100x gains 💰'), ['guaranteed-returns', 'money-bait']);
  assert.deepEqual(detectSpamSignals('click link below'), ['engagement-bait']);
  // Legitimate local terminology — including terms without English
  // instrument names — must never match.
  for (const legit of ['Börsenanalyse', 'Flux Ordres', 'SMC', 'price action', 'Order Flow NQ', 'ICT killzones', 'Gold', 'DAX', '原油期货']) {
    assert.deepEqual(detectSpamSignals(legit), [], `legit term flagged: ${legit}`);
  }
});

test('quality flags are evidence-only and documented as heuristic', () => {
  assert.deepEqual(
    evaluateTermQualityFlags('ES', { language: 'en', curatedTerms: ['ES Futures'] }),
    { generic: true, translationRisk: null }
  );
  assert.deepEqual(
    evaluateTermQualityFlags('Gold', { language: 'en', curatedTerms: [] }),
    { generic: true, translationRisk: null }
  );
  assert.equal(
    evaluateTermQualityFlags('day trading guide', { language: 'ja', curatedTerms: [] }).translationRisk,
    'ascii-in-non-latin-context'
  );
  assert.equal(
    evaluateTermQualityFlags('デイトレード', { language: 'ja', curatedTerms: [] }).translationRisk,
    null
  );
  assert.equal(evaluateTermQualityFlags('SMC', { curatedTerms: [] }).translationRisk, null);
});

test('trial entry admits only novel, non-spam terms', () => {
  assert.deepEqual(evaluateTrialEntry({ novel: true, spamConfirmed: false }), { allowed: true, reasons: ['novel-eligible'] });
  assert.deepEqual(evaluateTrialEntry({ novel: true, spamConfirmed: true }).allowed, false);
  assert.deepEqual(evaluateTrialEntry({ novel: false, spamConfirmed: false }), { allowed: false, reasons: ['not-novel'] });
});

function strongPromotionBase() {
  return {
    novel: true,
    spamConfirmed: false,
    executions: 5,
    quotaConsumed: 2000,
    newCreators: 12,
    confirmedTradingCreators: 9,
    nonTradingCreators: 1,
    wrongCountryCreators: 0,
    needsReviewCreators: 1,
    distinctCreators: 4,
    distinctCommunities: 3,
    coordinatedBurst: false,
  };
}

test('promotion policy promotes strong evidence, holds or rejects the rest', () => {
  const promote = evaluateNativeTermPromotion(strongPromotionBase());
  assert.equal(promote.decision, 'PROMOTE');
  assert.ok(promote.metrics.yieldPer1000Quota >= NATIVE_PROMOTION_MIN_YIELD_PER_1000_QUOTA);

  const thin = evaluateNativeTermPromotion({ ...strongPromotionBase(), executions: 1, distinctCreators: 1 });
  assert.equal(thin.decision, 'HOLD');
  assert.ok(thin.reasons.some(reason => reason.startsWith('insufficient-')));

  const spam = evaluateNativeTermPromotion({ ...strongPromotionBase(), spamConfirmed: true });
  assert.equal(spam.decision, 'REJECT');

  const generic = evaluateNativeTermPromotion({ ...strongPromotionBase(), novel: false });
  assert.equal(generic.decision, 'REJECT');

  const mistargeted = evaluateNativeTermPromotion({ ...strongPromotionBase(), wrongCountryCreators: 12, newCreators: 2, confirmedTradingCreators: 1 });
  assert.equal(mistargeted.decision, 'REJECT');

  const unproven = evaluateNativeTermPromotion({ ...strongPromotionBase(), confirmedTradingCreators: 0, nonTradingCreators: 6, newCreators: 0 });
  assert.equal(unproven.decision, 'REJECT');

  const burdened = evaluateNativeTermPromotion({ ...strongPromotionBase(), needsReviewCreators: 12, newCreators: 4, confirmedTradingCreators: 2 });
  assert.equal(burdened.decision, 'HOLD');

  const burst = evaluateNativeTermPromotion({ ...strongPromotionBase(), coordinatedBurst: true, distinctCommunities: 1 });
  assert.equal(burst.decision, 'HOLD');

  const weakYield = evaluateNativeTermPromotion({ ...strongPromotionBase(), newCreators: 1, quotaConsumed: 5000 });
  assert.equal(weakYield.decision, 'HOLD');
});

test('promotion floors mirror the lifecycle minimums', () => {
  assert.equal(NATIVE_PROMOTION_MIN_EXECUTIONS, 3);
  assert.equal(NATIVE_PROMOTION_MIN_CREATORS, 3);
});

// --- Fake-Queryable behavioral integration (no database) ---

interface RecordedCall {
  text: string;
  params: unknown[];
}

function fakeRunner(scenarios: {
  aggregates: Record<string, unknown>;
  quality: { v1: number; spam: boolean; novel: boolean };
}): { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      if (text.includes('qualityVersion')) {
        return { rows: [{ v1: scenarios.quality.v1, spam: scenarios.quality.spam, novel: scenarios.quality.novel }] };
      }
      if (text.startsWith('SELECT t.*')) {
        return { rows: [scenarios.aggregates] };
      }
      return { rows: [] };
    },
  };
}

function legacyAggregates(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lifecycle_status: 'OBSERVED',
    search_eligible: false,
    term_type: 'TERMINOLOGY',
    distinct_creators: 3,
    distinct_communities: 2,
    human_approved: 0,
    decayed_evidence: 6,
    executions: 0,
    decayed_yield: 0,
    ...overrides,
  };
}

test('legacy terms without new evidence transition exactly as before', async () => {
  const runner = fakeRunner({
    aggregates: legacyAggregates(),
    quality: { v1: 0, spam: false, novel: false },
  });
  await refreshTerminologyLifecycle(42, undefined, runner as never);
  const updates = runner.calls.filter(call => call.text.startsWith('UPDATE canonical_trading_terms'));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params.slice(1, 4), ['SEARCH_TRIAL', true, 2]);
  const events = runner.calls.filter(call => call.text.startsWith('INSERT INTO terminology_lifecycle_events'));
  assert.equal(events.length, 1);
  assert.match(String(events[0].params[3]), /PROMOTION/);
  assert.ok(runner.calls.some(call => call.text.startsWith('INSERT INTO terminology_score_snapshots')));
});

test('spam-flagged new terms are held with a recorded reason', async () => {
  const runner = fakeRunner({
    aggregates: legacyAggregates(),
    quality: { v1: 2, spam: true, novel: false },
  });
  await refreshTerminologyLifecycle(42, undefined, runner as never);
  assert.equal(runner.calls.filter(call => call.text.startsWith('UPDATE canonical_trading_terms')).length, 0);
  const events = runner.calls.filter(call => call.text.startsWith('INSERT INTO terminology_lifecycle_events'));
  assert.equal(events.length, 1);
  assert.match(events[0].text, /'ELIGIBILITY_CHANGE'/);
  assert.match(String(events[0].params[2]), /spam-confirmed/);
  assert.ok(runner.calls.some(call => call.text.startsWith('INSERT INTO terminology_score_snapshots')));
});

test('non-novel new terms are held on trial entry', async () => {
  const runner = fakeRunner({
    aggregates: legacyAggregates(),
    quality: { v1: 1, spam: false, novel: false },
  });
  await refreshTerminologyLifecycle(42, undefined, runner as never);
  assert.equal(runner.calls.filter(call => call.text.startsWith('UPDATE canonical_trading_terms')).length, 0);
  const events = runner.calls.filter(call => call.text.startsWith('INSERT INTO terminology_lifecycle_events'));
  assert.match(events[0].text, /'ELIGIBILITY_CHANGE'/);
  assert.match(String(events[0].params[2]), /not-novel/);
});

test('novel new terms pass through to the legacy decision', async () => {
  const runner = fakeRunner({
    aggregates: legacyAggregates(),
    quality: { v1: 1, spam: false, novel: true },
  });
  await refreshTerminologyLifecycle(42, undefined, runner as never);
  const updates = runner.calls.filter(call => call.text.startsWith('UPDATE canonical_trading_terms'));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params.slice(1, 4), ['SEARCH_TRIAL', true, 2]);
});

test('yield failure still demotes through the shared path', async () => {
  const runner = fakeRunner({
    aggregates: legacyAggregates({ lifecycle_status: 'SEARCH_TRIAL', search_eligible: true, executions: 5, decayed_yield: 0.01 }),
    quality: { v1: 0, spam: false, novel: false },
  });
  await refreshTerminologyLifecycle(42, undefined, runner as never);
  const updates = runner.calls.filter(call => call.text.startsWith('UPDATE canonical_trading_terms'));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[1], 'DEMOTED');
});

test('planner serves trial terms to live cycles', () => {
  const candidates = planDiverseQueries({
    country: 'Germany',
    count: 5,
    learnedVocabulary: [],
    existingQueries: [],
    provenTerminology: [{ id: 1, term: 'P2P-Algo', score: 0.9, lifecycle: 'SEARCH_TRIAL' }],
  });
  assert.ok(JSON.stringify(candidates).includes('P2P-Algo'));
});

test('extraction admits only literal, non-spam candidates', () => {
  const source = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.match(source, /findLiteralSpan\(raw, literalSources\)/);
  assert.match(source, /detectSpamSignals\(raw\)/);
  assert.match(source, /evaluateTermNovelty\(raw,/);
});

test('lifecycle refresh consults the trial-entry gate', () => {
  const source = readFileSync(new URL('./terminologyIntelligence.ts', import.meta.url), 'utf8');
  assert.match(source, /evaluateTrialEntry\(\{ novel: quality\.novel, spamConfirmed: quality\.spamConfirmed \}\)/);
});
