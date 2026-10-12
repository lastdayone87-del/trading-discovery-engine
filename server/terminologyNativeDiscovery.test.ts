import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { ChannelRecord } from '../src/types';
import {
  KNOWN_INSTRUMENT_TERMS,
  NATIVE_PROMOTION_MIN_CREATORS,
  NATIVE_PROMOTION_MIN_EXECUTIONS,
  NATIVE_PROMOTION_MIN_YIELD_PER_1000_QUOTA,
  buildNoveltyBaseline,
  classifyNativeCandidate,
  detectSpamSignals,
  evaluateNativeTermPromotion,
  evaluateTermNovelty,
  evaluateTermQualityFlags,
  evaluateTrialEntry,
  findLiteralSpan,
  getPlannerTerminology,
  observeTerminology,
  refreshTerminologyLifecycle,
  rollupNativeQualityEvidence,
  NATIVE_QUALITY_ROLLUP_SQL,
  type LiteralSourceText,
  type NoveltyBaseline,
} from './terminologyIntelligence';
import {
  admitNativeCandidates,
  alignVideoIdsToTitles,
  findRuleInstrumentHits,
} from './queryIntelligence';
import { planDiverseQueries } from './queryPlanner';

const SOURCES: LiteralSourceText[] = [
  { kind: 'CHANNEL_NAME', index: 0, text: 'Börsenanalyse LuxX' },
  { kind: 'VIDEO_TITLE', index: 0, text: 'Flux Ordres Nasdaq - Order Flow NQ' },
  { kind: 'VIDEO_TITLE', index: 1, text: 'Day trading update' },
  { kind: 'DESCRIPTION', index: 0, text: 'Rejoignez mon canal Telegram signaux gratuits' },
];

function okBaseline(overrides: Partial<NoveltyBaseline> = {}): NoveltyBaseline {
  return {
    ok: true,
    country: 'Germany',
    curatedTerms: ['Börsenanalyse', 'DAX Analyse'],
    existingTerms: ['Scalping Strategie'],
    failed: [],
    ...overrides,
  };
}

/** Evidence in the exact shape the observation writers persist. */
function writerEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    extractor: 'GEMINI',
    qualityVersion: 'native-v1',
    literal: true,
    sourceRef: { kind: 'VIDEO_TITLE', index: 0, span: 'P2P-Algo', videoId: 'vid-1' },
    novel: true,
    knownAs: null,
    generic: false,
    spamConfirmed: false,
    spamSignals: [],
    translationRisk: null,
    ...overrides,
  };
}

// --- Finding 13: one canonical instrument list ---

test('instrument list is pinned and shared (no parallel source of truth)', () => {
  assert.deepEqual([...KNOWN_INSTRUMENT_TERMS].sort(), [
    'AEX', 'BTC', 'CAC 40', 'DAX', 'ES', 'ETH', 'EURUSD', 'FDAX', 'FTSE 100',
    'GBPUSD', 'Gold', 'IBEX 35', 'NQ', 'Nasdaq', 'S&P 500', 'WTI Crude',
  ].sort());
  const extractorSource = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.match(extractorSource, /KNOWN_INSTRUMENT_TERMS/);
  assert.doesNotMatch(extractorSource, /const potentialInstruments/);
});

// --- Findings 6+7: exact original spans, length-safe case folding, significant whitespace ---

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
  const cjk = findLiteralSpan('原油', [{ kind: 'VIDEO_TITLE', index: 0, text: '原油期货交易' }]);
  assert.equal(cjk?.span, '原油');
});

test('NFKC compatibility characters map back to the exact original span', () => {
  // Full-width 'ＥＳ' normalizes to 'ES' — the span must be the original text.
  const hit = findLiteralSpan('ES', [{ kind: 'VIDEO_TITLE', index: 0, text: 'ＥＳ先物デイトレ' }]);
  assert.equal(hit?.span, 'ＥＳ');
  // Ligature 'ﬁ' normalizes to 'fi'.
  const ligature = findLiteralSpan('fib', [{ kind: 'DESCRIPTION', index: 0, text: 'ﬁb levels' }]);
  assert.equal(ligature?.span, 'ﬁb');
});

test('length-changing case folds keep correct original spans', () => {
  // Turkish dotted capital İ lowercases to i̇ (1 char → 2): slicing the
  // original source with an index taken from lowercased text (' İ P2P-Algo'
  // → 'i̇ p2p-algo') shifts every later offset by one and corrupts the span.
  // Engine case folding keeps indices valid: the span is exact.
  const hit = findLiteralSpan('p2p-algo', [{ kind: 'VIDEO_TITLE', index: 0, text: 'İ P2P-Algo backtest' }]);
  assert.equal(hit?.span, 'P2P-Algo');
  assert.equal(findLiteralSpan('KİLİT', [{ kind: 'VIDEO_TITLE', index: 0, text: 'KİLİT seviye analizi' }])?.span, 'KİLİT');
  // Combined CJK + preceding length-changing fold: lowercased-index slicing
  // returns '油 ' here; engine matching with an index map returns '原油'.
  const cjkShifted = findLiteralSpan('原油', [{ kind: 'VIDEO_TITLE', index: 0, text: 'İ原油 futures' }]);
  assert.equal(cjkShifted?.span, '原油');
});

test('internal whitespace is significant; surrounding whitespace is not', () => {
  const doubleSpace: LiteralSourceText[] = [{ kind: 'DESCRIPTION', index: 0, text: 'live order  flow session' }];
  assert.equal(findLiteralSpan('order  flow', doubleSpace)?.span, 'order  flow');
  // A single-space candidate does not match a double-space source: the phrase
  // as written never appears there.
  assert.equal(findLiteralSpan('order flow', doubleSpace), null);
  assert.equal(findLiteralSpan('  Börsenanalyse  ', SOURCES)?.span, 'Börsenanalyse');
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

// --- Finding 9: English + localized spam screening ---

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

test('compatibility characters cannot bypass spam screening', () => {
  // 'Ⓓ' (U+24B9) NFKC-normalizes to 'D': the raw candidate evades /discount/.
  assert.deepEqual(detectSpamSignals('Ⓓiscount code FREE'), ['promotional']);
  assert.deepEqual(detectSpamSignals('Ⓡejoignez signaux gratuits').some(code => code.endsWith('-fr')), true);
  // Screening normalizes only for detection: legitimate terminology with
  // compatibility characters stays clean and keeps its original text.
  for (const legit of ['ﬁb levels', 'ＢＴＣanalyse', 'Börsenanalyse']) {
    assert.deepEqual(detectSpamSignals(legit), [], `legit term flagged: ${legit}`);
  }
  const verdict = classifyNativeCandidate(
    'Ⓓiscount code FREE',
    [{ kind: 'DESCRIPTION', index: 0, text: 'grab the Ⓓiscount code FREE today' }],
    okBaseline(),
    {}
  );
  assert.equal(verdict.admit, false);
  if (verdict.admit === false) assert.equal(verdict.reason, 'spam');
});

test('localized solicitation is screened without touching legitimate local language', () => {
  assert.ok(detectSpamSignals('Rejoignez mon canal Telegram signaux gratuits').some(code => code.endsWith('-fr')));
  assert.ok(detectSpamSignals('signaux gratuits vip').some(code => code.endsWith('-fr')));
  assert.ok(detectSpamSignals('Kostenlose Signale, tritt bei der VIP Gruppe').some(code => code.endsWith('-de')));
  assert.ok(detectSpamSignals('Únete a mi canal gratis señales vip').some(code => code.endsWith('-es')));
  // Unicode-letter-aware boundaries: per ECMAScript \b is ASCII-only even
  // with the `u` flag, so accented variants need explicit lookarounds.
  for (const variant of ['únete al grupo', 'unete al grupo', 'ÚNETE AL GRUPO', 'grupo de señales gratis', 'señales gratuitas vip']) {
    assert.ok(detectSpamSignals(variant).some(code => code.endsWith('-es')), `missed ES solicitation: ${variant}`);
  }
  // Glued words are not boundaries: fragments inside longer tokens stay clean.
  assert.deepEqual(detectSpamSignals('xúnete al grupox'), []);
  for (const legit of ['Analyse Technique', 'Börsenanalyse', 'Futures Handel', 'Acción del Precio', 'Flux Ordres', 'Séance de trading', 'Señales de Trading', 'Canal de Telegram', 'Grupo de Trading', 'Análisis Técnico', 'Gestión del Riesgo', 'Velas Japonesas']) {
    assert.deepEqual(detectSpamSignals(legit), [], `legit local term flagged: ${legit}`);
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

// --- Finding 3: fail-closed novelty baseline + pure classifier ---

test('novelty baseline fails closed on either lookup failure', () => {
  const vocab = { country: 'Germany', languages: ['de'], native_trading_terminology: ['Börsenanalyse'], popular_instruments: [], local_market_phrases: [], common_content_format_names: [] };
  assert.deepEqual(buildNoveltyBaseline({ country: 'Germany', vocab, vocabOk: true, existingTerms: [], existingOk: true }).failed, []);
  const vocabFailed = buildNoveltyBaseline({ country: 'Germany', vocab: undefined, vocabOk: false, existingTerms: ['X'], existingOk: true });
  assert.equal(vocabFailed.ok, false);
  assert.deepEqual(vocabFailed.failed, ['curated']);
  assert.deepEqual(vocabFailed.curatedTerms, []);
  const existingFailed = buildNoveltyBaseline({ country: 'Germany', vocab, vocabOk: true, existingTerms: [], existingOk: false });
  assert.equal(existingFailed.ok, false);
  assert.deepEqual(existingFailed.failed, ['existing']);
  assert.deepEqual(existingFailed.existingTerms, []);
});

test('classifier rejects in order: shape, length, literal, spam, novelty-unknown', () => {
  assert.equal(classifyNativeCandidate(42, SOURCES, okBaseline(), {}).admit, false);
  const short = classifyNativeCandidate('X', SOURCES, okBaseline(), {});
  assert.equal(short.admit, false);
  if (short.admit === false) assert.equal(short.reason, 'too-short');
  const invented = classifyNativeCandidate('Scalping Strategie', SOURCES, okBaseline(), {});
  assert.equal(invented.admit, false);
  if (invented.admit === false) assert.equal(invented.reason, 'non-literal');
  const spam = classifyNativeCandidate('join free signals vip group', [{ kind: 'DESCRIPTION', index: 0, text: 'join free signals vip group now' }], okBaseline(), {});
  assert.equal(spam.admit, false);
  if (spam.admit === false) {
    assert.equal(spam.reason, 'spam');
    assert.ok(spam.spamSignals.length > 0);
  }
  // A genuinely new, literal, clean term is still rejected when novelty is unknown.
  const unknown = classifyNativeCandidate('P2P-Algo', [{ kind: 'VIDEO_TITLE', index: 0, text: 'P2P-Algo backtest' }], okBaseline({ ok: false, failed: ['curated', 'existing'] }), {});
  assert.equal(unknown.admit, false);
  if (unknown.admit === false) assert.equal(unknown.reason, 'novelty-unknown');
  const admitted = classifyNativeCandidate('P2P-Algo', [{ kind: 'VIDEO_TITLE', index: 0, text: 'P2P-Algo backtest' }], okBaseline(), { language: 'de' });
  assert.equal(admitted.admit, true);
  if (admitted.admit === true) {
    assert.equal(admitted.located.span, 'P2P-Algo');
    assert.equal(admitted.novelty.novel, true);
  }
});

// --- Findings 1+2: disjoint attribution, verified-trader yield, mandatory verified evidence ---

function strongPromotionBase() {
  return {
    novel: true,
    spamConfirmed: false,
    executions: 5,
    quotaConsumed: 2000,
    confirmedTradingCreators: 12,
    nonTradingCreators: 1,
    wrongCountryCreators: 0,
    needsReviewCreators: 1,
    distinctCreators: 4,
    distinctCommunities: 3,
    coordinatedBurst: false,
  };
}

test('promotion policy promotes verified evidence, holds or rejects the rest', () => {
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

  const mistargeted = evaluateNativeTermPromotion({ ...strongPromotionBase(), confirmedTradingCreators: 2, nonTradingCreators: 0, wrongCountryCreators: 7, needsReviewCreators: 1 });
  assert.equal(mistargeted.decision, 'REJECT');
  assert.ok(mistargeted.reasons.some(reason => reason.startsWith('wrong-country-share')));

  const burdened = evaluateNativeTermPromotion({ ...strongPromotionBase(), confirmedTradingCreators: 2, nonTradingCreators: 0, needsReviewCreators: 12 });
  assert.equal(burdened.decision, 'HOLD');

  const burst = evaluateNativeTermPromotion({ ...strongPromotionBase(), coordinatedBurst: true, distinctCommunities: 1 });
  assert.equal(burst.decision, 'HOLD');

  const weakYield = evaluateNativeTermPromotion({ ...strongPromotionBase(), confirmedTradingCreators: 1, quotaConsumed: 5000 });
  assert.equal(weakYield.decision, 'HOLD');
});

test('attribution shares use a disjoint denominator (no double counting)', () => {
  // 2 confirmed + 7 wrong-country + 1 review = 10 attributed; the 0.70
  // wrong-country share must reject (old code computed 7/12 and passed).
  const result = evaluateNativeTermPromotion({
    ...strongPromotionBase(),
    confirmedTradingCreators: 2,
    nonTradingCreators: 0,
    wrongCountryCreators: 7,
    needsReviewCreators: 1,
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.metrics.wrongCountryShare, 0.7);
  // Review share over the hold threshold holds.
  const reviewHeavy = evaluateNativeTermPromotion({
    ...strongPromotionBase(),
    confirmedTradingCreators: 2,
    nonTradingCreators: 0,
    wrongCountryCreators: 0,
    needsReviewCreators: 6,
  });
  assert.equal(reviewHeavy.decision, 'HOLD');
  assert.equal(reviewHeavy.metrics.reviewShare, 0.75);
});

test('promotion requires verified trading creators, never unverified yield', () => {
  // Zero confirmed + zero non-trading: nothing contradicts, but nothing
  // verifies either — HOLD, never PROMOTE.
  const empty = evaluateNativeTermPromotion({
    ...strongPromotionBase(),
    confirmedTradingCreators: 0,
    nonTradingCreators: 0,
    wrongCountryCreators: 0,
    needsReviewCreators: 0,
  });
  assert.equal(empty.decision, 'HOLD');
  assert.deepEqual(empty.reasons, ['no-verified-traders']);
  // Review-only results hold for verification.
  const reviewOnly = evaluateNativeTermPromotion({
    ...strongPromotionBase(),
    confirmedTradingCreators: 0,
    nonTradingCreators: 0,
    wrongCountryCreators: 0,
    needsReviewCreators: 5,
  });
  assert.equal(reviewOnly.decision, 'HOLD');
  // Non-trading results alone hold (and can never promote via unverified yield).
  const nonTradingOnly = evaluateNativeTermPromotion({
    ...strongPromotionBase(),
    confirmedTradingCreators: 0,
    nonTradingCreators: 6,
    wrongCountryCreators: 0,
    needsReviewCreators: 0,
  });
  assert.equal(nonTradingOnly.decision, 'HOLD');
});

test('promotion floors mirror the lifecycle minimums', () => {
  assert.equal(NATIVE_PROMOTION_MIN_EXECUTIONS, 3);
  assert.equal(NATIVE_PROMOTION_MIN_CREATORS, 3);
});

// --- Finding 10: rollup over the real writer evidence shape ---

test('quality rollup reads the evidence shape writers persist', () => {
  assert.deepEqual(rollupNativeQualityEvidence([writerEvidence()]), { v1Observations: 1, spamConfirmed: false, novel: true });
  assert.deepEqual(rollupNativeQualityEvidence([writerEvidence({ novel: false, knownAs: 'curated:Germany:X', generic: true })]), {
    v1Observations: 1, spamConfirmed: false, novel: false,
  });
  // Out-of-band spam-flagged rows (array or canonical flag) gate trial entry.
  assert.equal(rollupNativeQualityEvidence([writerEvidence({ spamSignals: ['signal-group-solicitation'] })]).spamConfirmed, true);
  assert.equal(rollupNativeQualityEvidence([writerEvidence({ spamConfirmed: true })]).spamConfirmed, true);
  // Legacy observations without the pipeline marker keep legacy rules.
  assert.deepEqual(rollupNativeQualityEvidence([{ extractor: 'KNOWN_INSTRUMENT_V1' }, null, undefined, [] as unknown as Record<string, unknown>]), {
    v1Observations: 0, spamConfirmed: false, novel: false,
  });
  // Mixed rows: any spam flag or novel marker wins across the term.
  assert.deepEqual(
    rollupNativeQualityEvidence([writerEvidence({ novel: false }), writerEvidence({ novel: true, spamSignals: ['promotional'] })]),
    { v1Observations: 2, spamConfirmed: true, novel: true }
  );
});

test('non-native rows cannot flip the quality rollup either path', () => {
  // Legacy rows carrying novel/spam flags (the exact out-of-band case the
  // guards withstand) must not admit a non-novel term or block trial entry.
  const mixed = [
    { extractor: 'LEGACY', novel: true, spamConfirmed: true, spamSignals: ['signal-group-solicitation'] },
    { qualityVersion: 'other-pipeline', novel: true, spamSignals: ['promotional'] },
    writerEvidence({ novel: false }),
  ];
  assert.deepEqual(rollupNativeQualityEvidence(mixed), { v1Observations: 1, spamConfirmed: false, novel: false });
  assert.deepEqual(
    rollupNativeQualityEvidence([
      { extractor: 'LEGACY', novel: true, spamConfirmed: true, spamSignals: ['x'] },
      { extractor: 'KNOWN_INSTRUMENT_V1' },
    ]),
    { v1Observations: 0, spamConfirmed: false, novel: false }
  );
});

test('malformed spamSignals degrade to false instead of failing', () => {
  const shapes: Array<Record<string, unknown>> = [
    writerEvidence({ spamSignals: { unexpected: 'object' } }),
    writerEvidence({ spamSignals: 'promotional' }),
    writerEvidence({ spamSignals: 42 }),
    writerEvidence({ spamSignals: null }),
    writerEvidence({}),
    writerEvidence({ spamSignals: [] }),
  ];
  for (const evidence of shapes) {
    assert.equal(rollupNativeQualityEvidence([evidence]).spamConfirmed, false, JSON.stringify(evidence.spamSignals));
  }
  assert.equal(rollupNativeQualityEvidence([writerEvidence({ spamSignals: ['promotional'] })]).spamConfirmed, true);
});

// --- Fake-Queryable behavioral integration (no database) ---

interface RecordedCall {
  text: string;
  params: unknown[];
}

function fakeRunner(scenarios: {
  aggregates: Record<string, unknown>;
  quality: { v1: number; spam: boolean; novel: boolean };
  latestEvent?: Record<string, unknown> | null;
}): { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      if (text.includes('FROM terminology_observations WHERE canonical_term_id=$1')) {
        return { rows: [{ v1: scenarios.quality.v1, spam: scenarios.quality.spam, novel: scenarios.quality.novel }] };
      }
      if (text.startsWith('SELECT event_type, reason FROM')) {
        return { rows: scenarios.latestEvent ? [scenarios.latestEvent] : [] };
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

function eventInserts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter(call => call.text.startsWith('INSERT INTO terminology_lifecycle_events'));
}

function snapshotInserts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter(call => call.text.startsWith('INSERT INTO terminology_score_snapshots'));
}

test('legacy terms without new evidence transition exactly as before', async () => {
  const runner = fakeRunner({ aggregates: legacyAggregates(), quality: { v1: 0, spam: false, novel: false } });
  await refreshTerminologyLifecycle(42, undefined, runner as never);
  const updates = runner.calls.filter(call => call.text.startsWith('UPDATE canonical_trading_terms'));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params.slice(1, 4), ['SEARCH_TRIAL', true, 2]);
  const events = eventInserts(runner.calls);
  assert.equal(events.length, 1);
  assert.equal(events[0].params[3], 'PROMOTION');
  const snapshots = snapshotInserts(runner.calls);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].params[6], 'SEARCH_TRIAL');
});

test('spam-flagged new terms are held with a recorded reason', async () => {
  const runner = fakeRunner({
    aggregates: legacyAggregates(),
    quality: { v1: 1, spam: true, novel: false },
  });
  await refreshTerminologyLifecycle(42, undefined, runner as never);
  assert.equal(runner.calls.filter(call => call.text.startsWith('UPDATE canonical_trading_terms')).length, 0);
  const events = eventInserts(runner.calls);
  assert.equal(events.length, 1);
  assert.match(events[0].text, /'ELIGIBILITY_CHANGE'/);
  assert.match(String(events[0].params[2]), /spam-confirmed/);
  // Finding 12: the snapshot records the persisted state, not the blocked decision.
  const snapshots = snapshotInserts(runner.calls);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].params[6], 'OBSERVED');
});

test('non-novel new terms are held on trial entry', async () => {
  const runner = fakeRunner({
    aggregates: legacyAggregates(),
    quality: { v1: 1, spam: false, novel: false },
  });
  await refreshTerminologyLifecycle(42, undefined, runner as never);
  assert.equal(runner.calls.filter(call => call.text.startsWith('UPDATE canonical_trading_terms')).length, 0);
  const events = eventInserts(runner.calls);
  assert.equal(events.length, 1);
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

test('blocked lifecycle events are idempotent for an unchanged reason', async () => {
  const blocked = {
    aggregates: legacyAggregates(),
    quality: { v1: 1, spam: false, novel: false },
  };
  const first = fakeRunner({ ...blocked });
  await refreshTerminologyLifecycle(42, undefined, first as never);
  assert.equal(eventInserts(first.calls).length, 1);
  const blockReason = String(eventInserts(first.calls)[0].params[2]);
  // Same block reason on the next refresh: no duplicate event.
  const second = fakeRunner({ ...blocked, latestEvent: { event_type: 'ELIGIBILITY_CHANGE', reason: blockReason } });
  await refreshTerminologyLifecycle(42, undefined, second as never);
  assert.equal(eventInserts(second.calls).length, 0);
  assert.equal(snapshotInserts(second.calls).length, 1);
  // Changed reason (e.g. term later flagged spam): a new event is recorded.
  const third = fakeRunner({
    aggregates: legacyAggregates(),
    quality: { v1: 1, spam: true, novel: false },
    latestEvent: { event_type: 'ELIGIBILITY_CHANGE', reason: blockReason },
  });
  await refreshTerminologyLifecycle(42, undefined, third as never);
  assert.equal(eventInserts(third.calls).length, 1);
  assert.match(String(eventInserts(third.calls)[0].params[2]), /spam-confirmed/);
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

// --- Findings 4+5+8+14: admission ordering, rule boundaries, video IDs, observability ---

function testChannel(): ChannelRecord {
  return {
    channel_id: 'ch-1',
    channel_name: 'Börsenanalyse LuxX',
    country: 'Germany',
    discord_invite: null,
  } as unknown as ChannelRecord;
}

function fakeDeps(scenarios: {
  observe?: (args: Record<string, unknown>) => Promise<number | null>;
  save?: (country: string, term: string) => Promise<unknown>;
  log?: (message: string) => void;
  observed: Array<Record<string, unknown>>;
  saved: Array<{ country: string; term: string }>;
}) {
  return {
    observeTerm: async (args: Record<string, unknown>): Promise<number | null> => {
      scenarios.observed.push(args);
      return scenarios.observe ? scenarios.observe(args) : 7;
    },
    saveTerm: async (country: string, term: string): Promise<unknown> => {
      scenarios.saved.push({ country, term });
      if (scenarios.save) return scenarios.save(country, term);
    },
    log: scenarios.log ?? (() => undefined),
  };
}

test('observation failure never persists the extracted term (retryable)', async () => {
  const observed: Array<Record<string, unknown>> = [];
  const saved: Array<{ country: string; term: string }> = [];
  const sources: LiteralSourceText[] = [{ kind: 'VIDEO_TITLE', index: 0, text: 'P2P-Algo backtest', videoId: 'vid-9' }];
  // Observation throws: nothing persisted, error propagates for a later retry.
  const throwing = fakeDeps({ observed, saved, observe: async () => { throw new Error('db down'); } });
  await assert.rejects(
    admitNativeCandidates({
      channel: testChannel(), sources,
      parsed: { terminology: ['P2P-Algo'] },
      baseline: okBaseline(), humanApproved: false, humanObservation: 'ENRICHMENT', deps: throwing,
    }),
    /db down/
  );
  assert.equal(saved.length, 0);
  // Observation returns null (invalid/over-length): skipped, retryable.
  observed.length = 0;
  const nulling = fakeDeps({ observed, saved, observe: async () => null });
  const nullReport = await admitNativeCandidates({
    channel: testChannel(), sources,
    parsed: { terminology: ['P2P-Algo'] },
    baseline: okBaseline(), humanApproved: false, humanObservation: 'ENRICHMENT', deps: nulling,
  });
  assert.equal(nullReport.admitted, 0);
  assert.equal(nullReport.rejected['observation-failed'], 1);
  assert.equal(saved.length, 0);
  // Retry after the failure succeeds end to end, in observe-then-save order.
  observed.length = 0;
  const order: string[] = [];
  const working = fakeDeps({
    observed,
    saved,
    observe: async (args) => { order.push(`observe:${String((args.evidence as Record<string, unknown>).novel)}`); return 7; },
    save: async () => { order.push('save'); },
  });
  const report = await admitNativeCandidates({
    channel: testChannel(), sources,
    parsed: { terminology: ['P2P-Algo'] },
    baseline: okBaseline(), humanApproved: false, humanObservation: 'ENRICHMENT', deps: working,
  });
  assert.equal(report.admitted, 1);
  assert.deepEqual(order, ['observe:true', 'save']);
  assert.deepEqual(saved, [{ country: 'Germany', term: 'P2P-Algo' }]);
});

test('real observation validation rejects over-length candidates before persistence', async () => {
  // No database needed: the length guard runs before any runner is acquired.
  const tooLong = `P2P-Algo-${'x'.repeat(80)}`;
  assert.ok(tooLong.length > 80);
  assert.equal(await observeTerminology({ term: tooLong, country: 'Germany', termType: 'TERMINOLOGY', observationType: 'ENRICHMENT' }), null);
});

test('rule-based instrument matching respects token boundaries', () => {
  assert.deepEqual(findRuleInstrumentHits('heroes and best trades', [], ''), []);
  const hits = findRuleInstrumentHits('trade ES Futures today', [], '');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].instrument, 'ES');
  assert.equal(hits[0].located.span, 'ES');
  // Full-width instrument mention traces to the exact original span.
  const wide = findRuleInstrumentHits('ＥＳ先物', [], '');
  assert.equal(wide.length, 1);
  assert.equal(wide[0].located.span, 'ＥＳ');
});

test('locale survives the shared admission helper into observations', async () => {
  const observed: Array<Record<string, unknown>> = [];
  const saved: Array<{ country: string; term: string }> = [];
  const sources: LiteralSourceText[] = [{ kind: 'VIDEO_TITLE', index: 0, text: 'P2P-Algo backtest', videoId: 'vid-1' }];
  const deps = fakeDeps({ observed, saved });
  const report = await admitNativeCandidates({
    channel: testChannel(), sources,
    parsed: { terminology: ['P2P-Algo'] },
    baseline: okBaseline(), language: 'de', locale: 'de-DE',
    humanApproved: false, humanObservation: 'ENRICHMENT', deps,
  });
  assert.equal(report.admitted, 1);
  assert.equal(observed[0].language, 'de');
  assert.equal(observed[0].locale, 'de-DE');
});

test('video IDs align to titles and persist on the observation', async () => {
  assert.deepEqual(alignVideoIdsToTitles(['a', 'b'], [{ id: 'v-a', title: 'a' }, { id: 'v-b', title: 'b' }]), ['v-a', 'v-b']);
  assert.deepEqual(alignVideoIdsToTitles(['b', 'a'], [{ id: 'v-a', title: 'a' }, { id: 'v-b', title: 'b' }]), ['v-b', 'v-a']);
  assert.deepEqual(alignVideoIdsToTitles(['a', 'missing'], [{ id: 'v-a', title: 'a' }]), ['v-a', null]);
  assert.deepEqual(alignVideoIdsToTitles(['a']), [null]);

  const observed: Array<Record<string, unknown>> = [];
  const saved: Array<{ country: string; term: string }> = [];
  const sources: LiteralSourceText[] = [
    { kind: 'VIDEO_TITLE', index: 0, text: 'P2P-Algo backtest', videoId: 'vid-1' },
    { kind: 'VIDEO_TITLE', index: 1, text: 'SMC entry model', videoId: 'vid-2' },
  ];
  const deps = fakeDeps({ observed, saved });
  const report = await admitNativeCandidates({
    channel: testChannel(), sources,
    parsed: { terminology: ['P2P-Algo', 'SMC'] },
    baseline: okBaseline(), humanApproved: false, humanObservation: 'ENRICHMENT', deps,
  });
  assert.equal(report.admitted, 2);
  assert.equal(observed[0].videoId, 'vid-1');
  assert.equal(observed[1].videoId, 'vid-2');
  assert.deepEqual(
    (observed[0].evidence as Record<string, unknown>).sourceRef,
    { kind: 'VIDEO_TITLE', index: 0, span: 'P2P-Algo', videoId: 'vid-1' }
  );
});

test('rejected candidates are observable by reason, without source content', async () => {
  const observed: Array<Record<string, unknown>> = [];
  const saved: Array<{ country: string; term: string }> = [];
  const logs: string[] = [];
  const sentinel = 'SENTINEL-UNIQUE-PHRASE-ORDER-FLOW';
  const sources: LiteralSourceText[] = [{ kind: 'DESCRIPTION', index: 0, text: `about ${sentinel} join free signals vip` }];
  const deps = fakeDeps({ observed, saved, log: (message) => logs.push(message) });
  const report = await admitNativeCandidates({
    channel: testChannel(), sources,
    parsed: { terminology: ['Invented Term', 'join free signals vip', 42, sentinel] },
    baseline: okBaseline(), humanApproved: false, humanObservation: 'ENRICHMENT', deps,
  });
  assert.equal(report.admitted, 1);
  assert.equal(report.rejected['non-literal'], 1);
  assert.equal(report.rejected.spam, 1);
  assert.equal(report.rejected['non-string'], 1);
  assert.deepEqual(saved, [{ country: 'Germany', term: sentinel }]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /admitted=1/);
  assert.match(logs[0], /"non-literal":1/);
  assert.doesNotMatch(logs[0], new RegExp(sentinel));
});

test('unknown novelty baseline rejects everything and is logged', async () => {
  const observed: Array<Record<string, unknown>> = [];
  const saved: Array<{ country: string; term: string }> = [];
  const logs: string[] = [];
  const sources: LiteralSourceText[] = [{ kind: 'VIDEO_TITLE', index: 0, text: 'P2P-Algo backtest' }];
  const deps = fakeDeps({ observed, saved, log: (message) => logs.push(message) });
  const report = await admitNativeCandidates({
    channel: testChannel(), sources,
    parsed: { terminology: ['P2P-Algo'] },
    baseline: okBaseline({ ok: false, curatedTerms: [], existingTerms: [], failed: ['curated', 'existing'] }),
    humanApproved: false, humanObservation: 'ENRICHMENT', deps,
  });
  assert.equal(report.admitted, 0);
  assert.equal(report.rejected['novelty-unknown'], 1);
  assert.equal(observed.length, 0);
  assert.equal(saved.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /noveltyBaseline=unknown:curated,existing/);
});

test('quality aggregation runs in SQL over the corrected evidence schema', () => {
  // Structural pin: the production aggregate must read the keys writers
  // persist (top-level qualityVersion/novel/spamSignals/spamConfirmed) and
  // must not reference the evidence.quality object no writer produces.
  assert.match(NATIVE_QUALITY_ROLLUP_SQL, /evidence->>'qualityVersion'/);
  assert.match(NATIVE_QUALITY_ROLLUP_SQL, /evidence->>'novel'/);
  assert.match(NATIVE_QUALITY_ROLLUP_SQL, /evidence->'spamSignals'/);
  assert.match(NATIVE_QUALITY_ROLLUP_SQL, /evidence->'spamConfirmed'/);
  assert.match(NATIVE_QUALITY_ROLLUP_SQL, /bool_or/);
  assert.doesNotMatch(NATIVE_QUALITY_ROLLUP_SQL, /evidence->'quality'/);
  // Single evidence set: every aggregate is restricted to native-v1 rows, so
  // legacy/out-of-band flags can neither admit nor block (finding: bool_or
  // previously scanned unfiltered rows while the count was filtered).
  assert.match(NATIVE_QUALITY_ROLLUP_SQL, /WHERE canonical_term_id=\$1 AND evidence->>'qualityVersion'='native-v1'/);
  // Safe array-length guard: CASE, not AND — PostgreSQL does not guarantee
  // AND evaluation order, so a non-array value could abort the query.
  assert.match(NATIVE_QUALITY_ROLLUP_SQL, /CASE WHEN jsonb_typeof\(evidence->'spamSignals'\) = 'array' THEN/);
  assert.doesNotMatch(NATIVE_QUALITY_ROLLUP_SQL, /AND jsonb_array_length/);
  // Malformed out-of-band rows degrade to false instead of failing the cast:
  // the guards mirror the pure rollup's strict checks (parity validated
  // against a live replica: SQL {4,t,t} == rollup {4,true,true} on the same
  // battery, legacy term → {0,false,false}).
  assert.deepEqual(
    rollupNativeQualityEvidence([{ qualityVersion: 'native-v1', novel: 'yes', spamConfirmed: 'true', spamSignals: 'x' }]),
    { v1Observations: 1, spamConfirmed: false, novel: false }
  );
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

test('extraction forwards language and locale into the admission helper', () => {
  const source = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.match(source, /locale: languageContext\?\.locale,\n(\s*)humanApproved,/);
  assert.match(source, /language: languageContext\?\.language,\n(\s*)locale: languageContext\?\.locale,/);
});

test('extraction admits only literal, non-spam candidates with observe-first ordering', () => {
  const source = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.match(source, /classifyNativeCandidate\(raw, args\.sources, args\.baseline/);
  assert.match(source, /if \(termId == null\)/);
  assert.match(source, /buildNoveltyBaseline\(/);
  assert.doesNotMatch(source, /\(\) => \[\] as string\[\]/);
});

test('lifecycle refresh consults the trial-entry gate', () => {
  const source = readFileSync(new URL('./terminologyIntelligence.ts', import.meta.url), 'utf8');
  assert.match(source, /evaluateTrialEntry\(\{ novel: quality\.novel, spamConfirmed: quality\.spamConfirmed \}\)/);
});
