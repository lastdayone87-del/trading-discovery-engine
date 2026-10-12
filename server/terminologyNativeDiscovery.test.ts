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
  attributeTerminologyPerformance,
  observeTerminology,
  observeTerminologyDetailed,
  refreshTerminologyLifecycle,
  rollupNativeQualityEvidence,
  NATIVE_QUALITY_ROLLUP_SQL,
  type LiteralSourceText,
  type NoveltyBaseline,
} from './terminologyIntelligence';
import {
  admitNativeCandidates,
  alignVideoIdsToTitles,
  buildLiteralSources,
  findRuleInstrumentHits,
  hasNativeExtractionText,
  parseNativeVocabularyResponse,
  resolveExtractionVideoIds,
} from './queryIntelligence';
import { computeObservationKey } from './countryNativeIntelligence';
import { extractDiscoveredChannels } from './youtube';
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

test('NFKC expansions cannot fabricate literal provenance', () => {
  // U+3300 expands to a katakana sequence sharing one source offset: the
  // mapped slice ('不動産') does not contain the candidate ('不動産アパ').
  assert.equal(
    findLiteralSpan('不動産アパ', [{ kind: 'DESCRIPTION', index: 0, text: '不動産㌀' }]),
    null
  );
  // Valid NFKC equivalences still trace with exact original spans.
  assert.equal(findLiteralSpan('ES', [{ kind: 'VIDEO_TITLE', index: 0, text: 'ＥＳ先物' }])?.span, 'ＥＳ');
  assert.equal(findLiteralSpan('fib', [{ kind: 'DESCRIPTION', index: 0, text: 'ﬁb levels' }])?.span, 'ﬁb');
});

test('round-trip failure scans later matches in the same source', () => {
  // First hit cuts through the U+3300 expansion (rejected); the later exact
  // occurrence must still be found with its literal span.
  const hit = findLiteralSpan('アパ', [{ kind: 'DESCRIPTION', index: 0, text: '㌀ text アパ' }]);
  assert.deepEqual(hit, { sourceKind: 'DESCRIPTION', sourceIndex: 0, span: 'アパ', videoId: null });
  // Single false-span source still rejects (no valid later occurrence).
  assert.equal(findLiteralSpan('不動産アパ', [{ kind: 'DESCRIPTION', index: 0, text: '不動産㌀' }]), null);
});

test('punctuated Latin terms keep word-boundary guards', () => {
  // Script detection is letter-based: the en dash must not flip 'order–flow'
  // to the boundary-free path (which admitted it inside 'disorder–flow').
  const endash: LiteralSourceText[] = [{ kind: 'DESCRIPTION', index: 0, text: 'live order–flow session' }];
  assert.equal(findLiteralSpan('order–flow', endash)?.span, 'order–flow');
  assert.equal(findLiteralSpan('order–flow', [{ kind: 'DESCRIPTION', index: 0, text: 'disorder–flow analysis' }]), null);
  // Equivalent punctuation: em dash behaves the same.
  assert.equal(findLiteralSpan('order—flow', [{ kind: 'DESCRIPTION', index: 0, text: 'live order—flow session' }])?.span, 'order—flow');
  assert.equal(findLiteralSpan('order—flow', [{ kind: 'DESCRIPTION', index: 0, text: 'disorder—flow analysis' }]), null);
  // CJK terms with punctuation stay on the boundary-free substring path.
  assert.equal(findLiteralSpan('原油、期货', [{ kind: 'VIDEO_TITLE', index: 0, text: '今日原油、期货分析' }])?.span, '原油、期货');
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
  // Double-escape regression: the reverse pattern must use real Unicode
  // property classes, so 'grupo' inside 'subgrupo' is not a boundary.
  assert.deepEqual(detectSpamSignals('subgrupo gratuito'), []);
  assert.deepEqual(detectSpamSignals('el subgrupo见 gratis'), []);
  for (const variant of ['grupo gratis vip', 'canal únete gratis', 'señales únete']) {
    assert.ok(detectSpamSignals(variant).some(code => code.endsWith('-es')), `missed reverse ES solicitation: ${variant}`);
  }
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

test('missing country vocabulary is an unknown baseline, not an empty one', () => {
  // Successful lookup, no row for the country: fail closed. (vocabOk:true +
  // vocab:undefined is the exact scenario — a lookup failure takes a
  // different flag and is covered separately.)
  const missing = buildNoveltyBaseline({ country: 'Germany', vocab: undefined, vocabOk: true, existingTerms: [], existingOk: true });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.failed, ['curated']);
  const rejected = classifyNativeCandidate('P2P-Algo', [{ kind: 'VIDEO_TITLE', index: 0, text: 'P2P-Algo backtest' }], missing, {});
  assert.equal(rejected.admit, false);
  if (rejected.admit === false) assert.equal(rejected.reason, 'novelty-unknown');
  // Valid country row: baseline usable, genuinely new term admittable.
  const present = buildNoveltyBaseline({
    country: 'Germany',
    vocab: { country: 'Germany', languages: ['de'], native_trading_terminology: [], popular_instruments: [], local_market_phrases: [], common_content_format_names: [] },
    vocabOk: true, existingTerms: [], existingOk: true,
  });
  assert.equal(present.ok, true);
  const admitted = classifyNativeCandidate('P2P-Algo', [{ kind: 'VIDEO_TITLE', index: 0, text: 'P2P-Algo backtest' }], present, {});
  assert.equal(admitted.admit, true);
});

test('extraction relies on the shared constructor for missing rows', () => {
  // The caller passes the lookup outcome through; buildNoveltyBaseline owns
  // the missing-row rule (single choke point, unit-tested above).
  const source = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.match(source, /vocab: vocabOutcome\.vocab,/);
  assert.match(source, /vocabOk: vocabOutcome\.ok,/);
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

test('observation identity is stable across novelty reclassification', () => {
  const sourceEvidence = {
    extractor: 'GEMINI', qualityVersion: 'native-v1', literal: true,
    sourceRef: { kind: 'VIDEO_TITLE', index: 0, span: 'P2P-Algo', videoId: 'vid-1' },
    spamSignals: [], translationRisk: null,
  };
  const first = computeObservationKey({
    canonicalTermId: 1, channelId: 'ch', videoId: 'vid-1', observationType: 'ENRICHMENT',
    evidence: { ...sourceEvidence, novel: true, knownAs: null, generic: false },
  });
  // After the term is saved, re-extraction flips novelty fields — same key.
  const second = computeObservationKey({
    canonicalTermId: 1, channelId: 'ch', videoId: 'vid-1', observationType: 'ENRICHMENT',
    evidence: { ...sourceEvidence, novel: false, knownAs: 'extracted:P2P-Algo', generic: true },
  });
  assert.equal(first, second);
  // Genuinely different source evidence still keys differently.
  const other = computeObservationKey({
    canonicalTermId: 1, channelId: 'ch', videoId: 'vid-2', observationType: 'ENRICHMENT',
    evidence: { ...sourceEvidence, novel: true, knownAs: null, generic: false },
  });
  assert.notEqual(first, other);
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
  assert.equal(events[0].params[3], 'ELIGIBILITY_CHANGE');
  assert.match(String(events[0].params[4]), /spam-confirmed/);
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
  assert.equal(events[0].params[3], 'ELIGIBILITY_CHANGE');
  assert.match(String(events[0].params[4]), /not-novel/);
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
  const blockReason = String(eventInserts(first.calls)[0].params[4]);
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
  assert.match(String(eventInserts(third.calls)[0].params[4]), /spam-confirmed/);
});

test('refresh serializes per term: lock before reads, transaction around writes', async () => {
  // Fake Pool (connect, no release): refresh must BEGIN, lock the term row,
  // then read aggregates/quality, and COMMIT last — so concurrent refreshes
  // evaluate committed evidence under the same lock instead of racing.
  const statements: string[] = [];
  let released = false;
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      statements.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('FOR UPDATE')) {
        assert.deepEqual(params, [42]);
        return { rows: [{ id: 42 }] };
      }
      if (text.startsWith('SELECT t.*')) return { rows: [legacyAggregates()] };
      if (text.includes('FROM terminology_observations WHERE canonical_term_id=$1')) {
        return { rows: [{ v1: 1, spam: false, novel: true }] };
      }
      if (text.startsWith('SELECT event_type, reason FROM')) return { rows: [] };
      return { rows: [] };
    },
    release: () => { released = true; },
  };
  const pool = { connect: async () => client };
  await refreshTerminologyLifecycle(42, undefined, pool as never);
  assert.equal(statements[0], 'BEGIN');
  // Advisory transaction lock (never FOR UPDATE: row-lock upgrades against
  // FK KEY SHARE locks deadlock; FOR NO KEY UPDATE would not wait for
  // uncommitted observations and would reintroduce the pre-commit race).
  const lockAt = statements.findIndex(text => text.includes('pg_advisory_xact_lock'));
  assert.ok(lockAt >= 0, 'serialization lock acquired');
  assert.deepEqual(
    statements[lockAt],
    'SELECT pg_advisory_xact_lock(hashtext($1))'
  );
  assert.ok(!statements.some(text => text.includes('FOR UPDATE')), 'no row-lock upgrade');
  const aggregatesAt = statements.findIndex(text => text.startsWith('SELECT t.*'));
  const qualityAt = statements.findIndex(text => text.includes('bool_or'));
  const updateAt = statements.findIndex(text => text.startsWith('UPDATE canonical_trading_terms'));
  assert.ok(aggregatesAt > lockAt, 'aggregates read after lock acquisition');
  assert.ok(qualityAt > lockAt, 'quality evidence read under the same lock');
  assert.ok(updateAt > qualityAt, 'transition applied after evidence reads');
  assert.equal(statements[statements.length - 1], 'COMMIT');
  assert.equal(released, true);
});

test('already-eligible terms with blocking native evidence are revoked', async () => {
  // The race: an attribution refresh marks the term eligible while a native
  // observation is uncommitted; the observation refresh must then revoke,
  // not skip the gate because search_eligible is already true.
  const runner = fakeRunner({
    aggregates: legacyAggregates({ lifecycle_status: 'SEARCH_TRIAL', search_eligible: true, decayed_evidence: 9 }),
    quality: { v1: 1, spam: false, novel: false },
  });
  await refreshTerminologyLifecycle(42, undefined, runner as never);
  const updates = runner.calls.filter(call => call.text.startsWith('UPDATE canonical_trading_terms'));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[1], 'SEARCH_TRIAL');
  assert.match(updates[0].text, /search_eligible=false/);
  const events = eventInserts(runner.calls);
  assert.equal(events.length, 1);
  assert.equal(events[0].params[3], 'ELIGIBILITY_CHANGE');
  assert.match(String(events[0].params[4]), /revoked eligibility/);
  assert.match(String(events[0].params[4]), /not-novel/);
  const snapshots = snapshotInserts(runner.calls);
  assert.equal(snapshots[0].params[6], 'SEARCH_TRIAL');
});

test('revoke follows legacy demotion when the legacy decision demotes', async () => {
  const runner = fakeRunner({
    aggregates: legacyAggregates({ lifecycle_status: 'SEARCH_TRIAL', search_eligible: true, executions: 5, decayed_yield: 0.01 }),
    quality: { v1: 1, spam: true, novel: false },
  });
  await refreshTerminologyLifecycle(42, undefined, runner as never);
  const updates = runner.calls.filter(call => call.text.startsWith('UPDATE canonical_trading_terms'));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[1], 'DEMOTED');
  assert.match(updates[0].text, /search_eligible=false/);
  const events = eventInserts(runner.calls);
  assert.equal(events.length, 1);
  assert.equal(events[0].params[3], 'DEMOTION');
});

test('observation path acquires the advisory lock before any term-row write', async () => {
  // Deterministic lock-order regression: canonical upsert (exempt,
  // uncontended) may precede the lock, but the observation insert, recency
  // update, and refresh must all follow it — no row lock is ever held while
  // requesting the advisory lock.
  const statements: string[] = [];
  const runner = {
    query: async (text: string, params: unknown[] = []) => {
      statements.push(text);
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{ locked: true }] };
      if (text.startsWith('INSERT INTO canonical_trading_terms')) return { rows: [{ id: 7 }] };
      if (text.startsWith('INSERT INTO terminology_observations')) return { rows: [{ id: 1, observed_at: new Date().toISOString() }] };
      if (text.startsWith('SELECT t.*')) return { rows: [{ lifecycle_status: 'CANDIDATE', search_eligible: false, term_type: 'TERMINOLOGY', distinct_creators: 1, distinct_communities: 1, human_approved: 0, decayed_evidence: 1, executions: 0, decayed_yield: 0, trust_tier: 3 }] };
      if (text.includes('FROM terminology_observations WHERE canonical_term_id=$1')) return { rows: [{ v1: 0, spam: false, novel: false }] };
      return { rows: [] };
    },
  };
  const result = await observeTerminologyDetailed({
    term: 'P2P-Algo Lock-Order', country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId: 'ch-1', videoId: 'vid-1',
    evidence: { qualityVersion: 'native-v1' },
  }, runner as never);
  assert.deepEqual(result, { termId: 7, observationInserted: true });
  const at = (fragment: string) => statements.findIndex(text => text.includes(fragment));
  const canonicalAt = at('INSERT INTO canonical_trading_terms');
  const lockAt = at('pg_advisory_xact_lock');
  const obsAt = at('INSERT INTO terminology_observations');
  const recencyAt = at('SET last_observed_at');
  assert.ok(canonicalAt >= 0 && lockAt > canonicalAt, 'lock follows the exempt canonical upsert');
  assert.ok(obsAt > lockAt, 'observation insert follows the lock');
  assert.ok(recencyAt > lockAt, 'recency update follows the lock');
});

test('attribution path acquires the advisory lock before its performance insert', async () => {
  const statements: string[] = [];
  const runner = {
    query: async (text: string, params: unknown[] = []) => {
      statements.push(text);
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{ locked: true }] };
      if (text.startsWith('SELECT id FROM canonical_trading_terms')) return { rows: [{ id: 9 }] };
      if (text.startsWith('SELECT t.*')) return { rows: [{ lifecycle_status: 'CANDIDATE', search_eligible: false, term_type: 'TERMINOLOGY', distinct_creators: 1, distinct_communities: 1, human_approved: 0, decayed_evidence: 1, executions: 0, decayed_yield: 0, trust_tier: 3 }] };
      if (text.includes('FROM terminology_observations WHERE canonical_term_id=$1')) return { rows: [{ v1: 0, spam: false, novel: false }] };
      return { rows: [] };
    },
  };
  await attributeTerminologyPerformance(
    { generation_metadata: { learnedTerm: 'P2P-Algo' }, country: 'Germany' } as never,
    { distinctResults: 10, newChannels: 3 } as never,
    100,
    undefined,
    undefined,
    runner as never
  );
  const at = (fragment: string) => statements.findIndex(text => text.includes(fragment));
  const lockAt = at('pg_advisory_xact_lock');
  const perfAt = at('INSERT INTO terminology_performance');
  assert.ok(lockAt >= 0 && perfAt > lockAt, 'performance insert follows the lock');
});

// --- Finding C: deterministic lock-order competition model ---
//
// No writable database is available in this environment (no PHASE10_POSTGRES_URL
// or DATABASE_URL; the audit tunnel is read-only), so the live multi-connection
// proof cannot run here. This model executes the exact statement order the
// production paths issue (proven by the order tests above) under PostgreSQL
// lock-compatibility rules and both adversarial interleavings. It fails if the
// order ever regresses to hold-row-lock-while-requesting-advisory.

type SimLockMode = 'KEY_SHARE' | 'ROW_EXCLUSIVE';
interface SimStep { txn: 'OBS' | 'ATTR'; op: 'canon' | 'advisory' | 'keyshare' | 'rowexcl' | 'read' | 'commit' }

function runLockCompetition(obsSeq: SimStep[], attrSeq: SimStep[], first: 'OBS' | 'ATTR'): { deadlocked: boolean; attrSawCommit: boolean; steps: number } {
  // Program-counter model: a blocked transaction does NOT advance — its later
  // statements (including commit) stay queued behind the contested lock, like
  // real PostgreSQL blocking waits. A full round with zero progress on every
  // unfinished transaction is a deadlock cycle.
  let advisoryHolder: string | null = null;
  const rowHeld: Array<{ txn: string; mode: SimLockMode }> = [];
  const store = { obsCommitted: false };
  let attrSawCommit = false;
  const pc: Record<'OBS' | 'ATTR', number> = { OBS: 0, ATTR: 0 };
  const done = new Set<string>();
  let steps = 0;
  const conflicts = (txn: string, mode: SimLockMode): boolean =>
    rowHeld.some(entry => entry.txn !== txn && (mode === 'ROW_EXCLUSIVE' || entry.mode === 'ROW_EXCLUSIVE'));
  const order: Array<'OBS' | 'ATTR'> = first === 'OBS' ? ['OBS', 'ATTR'] : ['ATTR', 'OBS'];
  for (; steps < 500; steps++) {
    if (done.size >= 2) break;
    let progressed = false;
    for (const txn of order) {
      if (done.has(txn)) continue;
      const mine = txn === 'OBS' ? obsSeq : attrSeq;
      const current = mine[pc[txn]];
      if (!current) continue;
      if (current.op === 'commit') {
        for (let i = rowHeld.length - 1; i >= 0; i--) if (rowHeld[i].txn === txn) rowHeld.splice(i, 1);
        if (advisoryHolder === txn) advisoryHolder = null;
        if (txn === 'OBS') store.obsCommitted = true;
        done.add(txn);
        progressed = true;
        continue;
      }
      if (current.op === 'read') {
        if (txn === 'ATTR' && store.obsCommitted) attrSawCommit = true;
        pc[txn] += 1;
        progressed = true;
        continue;
      }
      if (current.op === 'canon') {
        pc[txn] += 1; // uncontended new-row upsert, holds nothing
        progressed = true;
        continue;
      }
      if (current.op === 'advisory') {
        if (advisoryHolder !== null && advisoryHolder !== txn) continue; // blocked: pc frozen
        advisoryHolder = txn;
        pc[txn] += 1;
        progressed = true;
        continue;
      }
      const mode: SimLockMode = current.op === 'keyshare' ? 'KEY_SHARE' : 'ROW_EXCLUSIVE';
      if (conflicts(txn, mode)) continue; // blocked: pc frozen
      rowHeld.push({ txn, mode });
      pc[txn] += 1;
      progressed = true;
    }
    if (!progressed) break;
  }
  const deadlocked = done.size < 2;
  return { deadlocked, attrSawCommit, steps };
}

const OBS_SEQUENCE: SimStep[] = [
  { txn: 'OBS', op: 'canon' },
  { txn: 'OBS', op: 'advisory' },
  { txn: 'OBS', op: 'keyshare' },
  { txn: 'OBS', op: 'rowexcl' },
  { txn: 'OBS', op: 'read' },
  { txn: 'OBS', op: 'rowexcl' },
  { txn: 'OBS', op: 'commit' },
];

const ATTR_SEQUENCE: SimStep[] = [
  { txn: 'ATTR', op: 'read' },
  { txn: 'ATTR', op: 'advisory' },
  { txn: 'ATTR', op: 'keyshare' },
  { txn: 'ATTR', op: 'read' },
  { txn: 'ATTR', op: 'rowexcl' },
  { txn: 'ATTR', op: 'commit' },
];

test('lock competition completes under every interleaving with post-commit visibility', () => {
  // Attribution wins the advisory race: observation waits holding nothing,
  // attribution commits, observation proceeds against committed state.
  const first = runLockCompetition(OBS_SEQUENCE, ATTR_SEQUENCE, 'ATTR');
  assert.equal(first.deadlocked, false);
  // Observation wins: attribution waits at the advisory lock, then reads the
  // committed observation (the visibility guarantee behind findings C and D).
  const second = runLockCompetition(OBS_SEQUENCE, ATTR_SEQUENCE, 'OBS');
  assert.equal(second.deadlocked, false);
  assert.equal(second.attrSawCommit, true);
});

test('recorded production sequences compete without deadlock (S9)', async () => {
  // The hand-written OBS/ATTR sequences above document the intended order;
  // THIS test derives sequences from the real production functions through
  // recording fakes, so a production reorder changes the model input. Any
  // unmapped write fails loudly instead of passing silently.
  type RecordedOp = 'canon' | 'advisory' | 'keyshare' | 'rowexcl' | 'read' | 'commit';
  const toOp = (text: string): RecordedOp | 'txn' | null => {
    if (text === 'BEGIN' || text === 'ROLLBACK') return 'txn';
    if (text === 'COMMIT') return 'commit';
    if (text.includes('pg_advisory_xact_lock')) return 'advisory';
    if (text.startsWith('INSERT INTO canonical_trading_terms')) return 'canon';
    if (
      text.startsWith('INSERT INTO terminology_observations') ||
      text.startsWith('INSERT INTO terminology_performance') ||
      text.startsWith('INSERT INTO terminology_lifecycle_events') ||
      text.startsWith('INSERT INTO terminology_score_snapshots') ||
      text.startsWith('INSERT INTO country_native_evidence_projections')
    ) {
      return 'keyshare';
    }
    if (text.startsWith('UPDATE canonical_trading_terms')) return 'rowexcl';
    if (text.startsWith('SELECT')) return 'read';
    if (/^(INSERT|UPDATE|DELETE)\s/i.test(text)) return null;
    return 'read';
  };
  const record = async (run: (client: never) => Promise<unknown>): Promise<{ ops: SimStep[]; raw: string[]; begins: number; commits: number }> => {
    const raw: string[] = [];
    const client = {
      query: async (text: string, params: unknown[] = []) => {
        raw.push(text);
        if (text.includes('pg_advisory_xact_lock')) return { rows: [{ locked: true }] };
        if (text.startsWith('INSERT INTO canonical_trading_terms')) return { rows: [{ id: 7 }] };
        if (text.startsWith('INSERT INTO terminology_observations')) {
          return { rows: [{ id: 1, observed_at: new Date().toISOString() }] };
        }
        if (text.startsWith('SELECT id FROM canonical_trading_terms')) return { rows: [{ id: 7 }] };
        if (text.startsWith('SELECT t.*')) {
          return { rows: [{ lifecycle_status: 'CANDIDATE', search_eligible: false, term_type: 'TERMINOLOGY', distinct_creators: 1, distinct_communities: 1, human_approved: 0, decayed_evidence: 1, executions: 0, decayed_yield: 0, trust_tier: 3 }] };
        }
        if (text.includes('FROM terminology_observations WHERE canonical_term_id=$1')) {
          return { rows: [{ v1: 0, spam: false, novel: false }] };
        }
        return { rows: [] };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client };
    await run(pool as never);
    const ops: SimStep[] = [];
    let begins = 0;
    let commits = 0;
    for (const text of raw) {
      const op = toOp(text);
      assert.ok(op !== null, `unmapped write escapes the model: ${text.slice(0, 80)}`);
      if (op === 'txn') {
        begins += 1;
        continue;
      }
      if (op === 'commit') {
        commits += 1;
        ops.push({ txn: 'OBS', op: 'commit' });
        continue;
      }
      ops.push({ txn: 'OBS', op });
    }
    return { ops, raw, begins, commits };
  };
  const observed = await record(client =>
    observeTerminologyDetailed({
      term: 'Competition Model Term', country: 'Germany', termType: 'TERMINOLOGY',
      observationType: 'VIDEO_TITLE', channelId: 'ch-1', videoId: 'vid-1',
      evidence: { qualityVersion: 'native-v1' },
    }, client)
  );
  // One transaction covers the whole observation critical section (S6).
  assert.equal(observed.begins, 1);
  assert.equal(observed.commits, 1);
  assert.ok(observed.ops.some(step => step.op === 'advisory'));
  assert.ok(observed.ops.some(step => step.op === 'keyshare'));
  const attributed = await record(client =>
    attributeTerminologyPerformance(
      { generation_metadata: { learnedTerm: 'Competition Model Term' }, country: 'Germany' } as never,
      { distinctResults: 10, newChannels: 3 } as never,
      100,
      undefined,
      undefined,
      client
    )
  );
  assert.equal(attributed.begins, 1);
  assert.equal(attributed.commits, 1);
  // Replay the RECORDED production order under competition, both schedulers.
  const forTxn = (ops: SimStep[], txn: 'OBS' | 'ATTR'): SimStep[] =>
    ops.map(step => ({ txn, op: step.op }));
  const obsFirst = runLockCompetition(forTxn(observed.ops, 'OBS'), forTxn(attributed.ops, 'ATTR'), 'OBS');
  assert.equal(obsFirst.deadlocked, false);
  assert.equal(obsFirst.attrSawCommit, true);
  const attrFirst = runLockCompetition(forTxn(observed.ops, 'OBS'), forTxn(attributed.ops, 'ATTR'), 'ATTR');
  assert.equal(attrFirst.deadlocked, false);
});

test('attribution on Pool shares one transaction across lock, write, and refresh', async () => {
  // S6: with a Pool runner the advisory lock, performance insert, and
  // lifecycle refresh must share one transaction-bound client — otherwise the
  // lock releases before the protected writes.
  // Distinct clients per connect(): a regression splitting the lock, the
  // performance insert, or the refresh across connections fails below.
  const byClient = new Map<number, string[]>();
  const released: number[] = [];
  let nextClient = 0;
  const pool = {
    connect: async () => {
      const id = nextClient++;
      byClient.set(id, []);
      return {
        query: async (text: string, params: unknown[] = []) => {
          byClient.get(id)!.push(text);
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
          if (text.includes('pg_advisory_xact_lock')) return { rows: [{ locked: true }] };
          if (text.startsWith('SELECT id FROM canonical_trading_terms')) return { rows: [{ id: 9 }] };
          if (text.startsWith('SELECT t.*')) {
            return { rows: [{ lifecycle_status: 'CANDIDATE', search_eligible: false, term_type: 'TERMINOLOGY', distinct_creators: 1, distinct_communities: 1, human_approved: 0, decayed_evidence: 1, executions: 0, decayed_yield: 0, trust_tier: 3 }] };
          }
          if (text.includes('FROM terminology_observations WHERE canonical_term_id=$1')) {
            return { rows: [{ v1: 0, spam: false, novel: false }] };
          }
          return { rows: [] };
        },
        release: () => { released.push(id); },
      };
    },
  };
  await attributeTerminologyPerformance(
    { generation_metadata: { learnedTerm: 'P2P-Algo' }, country: 'Germany' } as never,
    { distinctResults: 10, newChannels: 3 } as never,
    100,
    undefined,
    undefined,
    pool as never
  );
  assert.equal(byClient.size, 1, 'single connection serves the whole critical section');
  const statements = [...byClient.values()][0];
  const owner = [...byClient.keys()][0];
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements[statements.length - 1], 'COMMIT');
  assert.equal(statements.filter(text => text === 'BEGIN').length, 1);
  const lockAt = statements.findIndex(text => text.includes('pg_advisory_xact_lock'));
  const perfAt = statements.findIndex(text => text.startsWith('INSERT INTO terminology_performance'));
  const refreshAt = statements.findIndex(text => text.startsWith('SELECT t.*'));
  assert.ok(lockAt > 0 && perfAt > lockAt && refreshAt > perfAt);
  assert.deepEqual(released, [owner]);
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

export interface FakeVocabStore {
  rows: Map<string, { id: number; term: string; occurrences: number; validation_count: number; trust_tier: number }>;
  links: Set<string>;
  nextId: number;
}

export function createFakeVocabStore(): FakeVocabStore {
  return { rows: new Map(), links: new Set(), nextId: 1 };
}

function fakeDeps(scenarios: {
  observe?: (args: Record<string, unknown>) => Promise<{ termId: number; observationInserted: boolean } | null>;
  save?: (country: string, term: string) => Promise<unknown>;
  log?: (message: string) => void;
  reconcile?: (country: string, term: string, store: FakeVocabStore, channelId?: string) => Promise<{ rowInserted: boolean; linkInserted: boolean }>;
  store?: FakeVocabStore;
  reconciled?: Array<{ country: string; term: string }>;
  observed: Array<Record<string, unknown>>;
  saved: Array<{ country: string; term: string }>;
}) {
  const reconciled = scenarios.reconciled ?? [];
  const store = scenarios.store ?? createFakeVocabStore();
  return {
    observeTerm: async (args: Record<string, unknown>): Promise<{ termId: number; observationInserted: boolean } | null> => {
      scenarios.observed.push(args);
      return scenarios.observe ? scenarios.observe(args) : { termId: 7, observationInserted: true };
    },
    // Unit-test default: vocabulary already complete (replays are pure
    // duplicates). Tests covering repair pass a shared store instead.
    reconcileTerm: async (country: string, term: string, _category: string, channelId?: string): Promise<{ rowInserted: boolean; linkInserted: boolean }> => {
      reconciled.push({ country, term });
      if (scenarios.reconcile) return scenarios.reconcile(country, term, store, channelId);
      return { rowInserted: false, linkInserted: false };
    },
    saveTerm: async (country: string, term: string): Promise<unknown> => {
      scenarios.saved.push({ country, term });
      if (scenarios.save) return scenarios.save(country, term);
    },
    log: scenarios.log ?? (() => undefined),
  };
}

/**
 * Production-faithful store emulation: raw (country,term) conflict target,
 * normalized-equivalence reuse, idempotent links, counters recomputed from
 * links — mirroring defaultReconcileExtractedTerm without a database.
 */
export function emulatedReconcile(country: string, term: string, store: FakeVocabStore, channelId = 'ch-1'): { rowInserted: boolean; linkInserted: boolean } {
  const clean = term.trim();
  const normalized = clean.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
  const key = `${country}|${clean}`;
  let row = store.rows.get(key);
  let rowInserted = false;
  if (!row) {
    const reuse = [...store.rows.values()].find(
      candidate => candidate.term.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en') === normalized
    );
    if (reuse) {
      row = reuse;
    } else {
      row = { id: store.nextId++, term: clean, occurrences: 1, validation_count: 0, trust_tier: 3 };
      store.rows.set(key, row);
      rowInserted = true;
    }
  }
  const linkKey = `${row.id}|${channelId}`;
  let linkInserted = false;
  if (!store.links.has(linkKey)) {
    store.links.add(linkKey);
    linkInserted = true;
  }
  const confirmed = [...store.links].filter(link => link.startsWith(`${row!.id}|`)).length;
  row.validation_count = confirmed;
  row.trust_tier = confirmed >= 2 ? 2 : 3;
  return { rowInserted, linkInserted };
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
    observe: async (args) => { order.push(`observe:${String((args.evidence as Record<string, unknown>).novel)}`); return { termId: 7, observationInserted: true }; },
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

test('replayed observations reuse evidence without inflating vocabulary counts', async () => {
  const observed: Array<Record<string, unknown>> = [];
  const saved: Array<{ country: string; term: string }> = [];
  const sources: LiteralSourceText[] = [{ kind: 'VIDEO_TITLE', index: 0, text: 'P2P-Algo backtest', videoId: 'vid-1' }];
  // First extraction inserts; replay hits ON CONFLICT (same key, no new row).
  let calls = 0;
  const deps = fakeDeps({
    observed, saved,
    observe: async () => { calls += 1; return { termId: 7, observationInserted: calls === 1 }; },
  });
  const admission = {
    channel: testChannel(), sources,
    parsed: { terminology: ['P2P-Algo'] },
    baseline: okBaseline(), humanApproved: false, humanObservation: 'ENRICHMENT' as const, deps,
  };
  const first = await admitNativeCandidates(admission);
  assert.deepEqual([first.admitted, first.duplicates], [1, 0]);
  const second = await admitNativeCandidates(admission);
  assert.deepEqual([second.admitted, second.duplicates], [0, 1]);
  assert.deepEqual(saved, [{ country: 'Germany', term: 'P2P-Algo' }]);
});

test('failed saveTerm is repaired on retry without inflating counts', async () => {
  const observed: Array<Record<string, unknown>> = [];
  const saved: Array<{ country: string; term: string }> = [];
  const reconciled: Array<{ country: string; term: string }> = [];
  const store = createFakeVocabStore();
  const sources: LiteralSourceText[] = [{ kind: 'VIDEO_TITLE', index: 0, text: 'P2P-Algo backtest', videoId: 'vid-1' }];
  let saveCalls = 0;
  const deps = fakeDeps({
    reconciled, observed, saved, store,
    observe: async () => ({ termId: 7, observationInserted: saveCalls === 0 }),
    save: async () => { saveCalls += 1; if (saveCalls === 1) throw new Error('vocab save down'); },
    reconcile: async (country, term, vocab) => emulatedReconcile(country, term, vocab),
  });
  const admission = {
    channel: testChannel(), sources,
    parsed: { terminology: ['P2P-Algo'] },
    baseline: okBaseline(), humanApproved: false, humanObservation: 'ENRICHMENT' as const, deps,
  };
  // First attempt: observation commits, saveTerm throws -> propagates visibly.
  // (The failed save call itself is recorded once; it is never retried
  // blindly — the retry replays the observation as a duplicate instead.)
  await assert.rejects(admitNativeCandidates(admission), /vocab save down/);
  assert.equal(saved.length, 1);
  // Retry: observation replays as duplicate, missing row is repaired with
  // consistent counters (occurrences 1, validation derived from links).
  const retry = await admitNativeCandidates(admission);
  assert.deepEqual([retry.admitted, retry.duplicates], [1, 0]);
  assert.deepEqual(reconciled, [{ country: 'Germany', term: 'P2P-Algo' }]);
  assert.equal(saved.length, 1);
  const row = store.rows.get('Germany|P2P-Algo');
  assert.ok(row);
  assert.equal(row.occurrences, 1);
  assert.equal(row.validation_count, 1);
  assert.equal(row.trust_tier, 3);
  // Third run: everything present -> pure duplicate, no writes at all.
  const third = await admitNativeCandidates(admission);
  assert.deepEqual([third.admitted, third.duplicates], [0, 1]);
  assert.deepEqual(reconciled.length, 2);
});

// C2/S2: row existence alone never proves completeness — the link and the
// derived counters are reconciled on every replay, even when the row exists.
test('replay reconciles missing links and counters on existing rows', async () => {
  const store = createFakeVocabStore();
  store.rows.set('Germany|SMC', { id: 1, term: 'SMC', occurrences: 5, validation_count: 0, trust_tier: 3 });
  store.nextId = 2;
  const sources: LiteralSourceText[] = [{ kind: 'VIDEO_TITLE', index: 0, text: 'SMC backtest', videoId: 'vid-2' }];
  const deps = fakeDeps({
    reconciled: [], observed: [], saved: [], store,
    observe: async () => ({ termId: 8, observationInserted: false }),
    reconcile: async (country, term, vocab) => emulatedReconcile(country, term, vocab, 'ch-2'),
  });
  const report = await admitNativeCandidates({
    channel: { ...testChannel(), channel_id: 'ch-2' }, sources,
    parsed: { terminology: ['SMC'] },
    baseline: okBaseline(), humanApproved: false, humanObservation: 'ENRICHMENT', deps,
  });
  assert.deepEqual([report.admitted, report.duplicates], [1, 0]);
  const row = store.rows.get('Germany|SMC');
  assert.ok(row);
  assert.equal(row.occurrences, 5);
  assert.equal(row.validation_count, 1);
  assert.ok(store.links.has('1|ch-2'));
});

// C3: both lookups observe absence before either repair proceeds — both
// repair attempts run, one row is stored, every link survives.
test('concurrent repairs from two channels keep one row with both links', async () => {
  const shared = createFakeVocabStore();
  let releaseReads: (() => void) | null = null;
  const gate = new Promise<void>(resolve => { releaseReads = resolve; });
  let reads = 0;
  const reconcileCalls: string[] = [];
  const blockingReconcile = async (country: string, term: string, vocab: FakeVocabStore, channelId?: string) => {
    reconcileCalls.push(`${country}|${term}`);
    reads += 1;
    if (reads < 2) await gate;
    else if (releaseReads) releaseReads();
    return emulatedReconcile(country, term, vocab, channelId ?? 'ch-unknown');
  };
  const admissionFor = (channelId: string, deps: ReturnType<typeof fakeDeps>) => ({
    channel: { ...testChannel(), channel_id: channelId },
    sources: [{ kind: 'VIDEO_TITLE', index: 0, text: 'SMC backtest', videoId: 'vid-2' }] as LiteralSourceText[],
    parsed: { terminology: ['SMC'] },
    baseline: okBaseline(), humanApproved: false, humanObservation: 'ENRICHMENT' as const, deps,
  });
  const depsA = fakeDeps({ reconciled: [], observed: [], saved: [], store: shared, observe: async () => ({ termId: 8, observationInserted: false }), reconcile: blockingReconcile });
  const depsB = fakeDeps({ reconciled: [], observed: [], saved: [], store: shared, observe: async () => ({ termId: 8, observationInserted: false }), reconcile: blockingReconcile });
  const [first, second] = await Promise.all([
    admitNativeCandidates(admissionFor('ch-A', depsA)),
    admitNativeCandidates(admissionFor('ch-B', depsB)),
  ]);
  assert.equal(reconcileCalls.length, 2);
  assert.equal(shared.rows.size, 1);
  const row = shared.rows.get('Germany|SMC');
  assert.ok(row);
  assert.equal(row.occurrences, 1);
  assert.equal(row.validation_count, 2);
  assert.equal(row.trust_tier, 2);
  assert.ok(shared.links.has(`${row.id}|ch-A`));
  assert.ok(shared.links.has(`${row.id}|ch-B`));
  assert.equal(first.admitted + second.admitted, 2);
});

// S3: casing variants reuse the earliest normalized row instead of duplicating.
test('whitespace and NFKC variants reconcile to one vocabulary row', async () => {
  // lower() prefiltering would miss these; the country-wide normalized scan
  // must not split links across equivalent rows.
  const store = createFakeVocabStore();
  const deps = fakeDeps({
    reconciled: [], observed: [], saved: [], store,
    observe: async () => ({ termId: 9, observationInserted: false }),
    reconcile: async (country, term, vocab) => emulatedReconcile(country, term, vocab),
  });
  const admissionFor = (candidate: string) => ({
    channel: testChannel(),
    sources: [{ kind: 'VIDEO_TITLE', index: 0, text: `${candidate} session`, videoId: 'vid-4' }] as LiteralSourceText[],
    parsed: { terminology: [candidate] },
    baseline: okBaseline(), humanApproved: false, humanObservation: 'ENRICHMENT' as const, deps,
  });
  await admitNativeCandidates(admissionFor('order  flow'));
  await admitNativeCandidates(admissionFor('order flow'));
  assert.equal(store.rows.size, 1);
  const productionSql = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(productionSql, /lower\(term\)=lower/);
});

test('casing variants reconcile to one vocabulary row', async () => {
  const sharedStore = createFakeVocabStore();
  const deps = fakeDeps({
    reconciled: [], observed: [], saved: [], store: sharedStore,
    observe: async () => ({ termId: 9, observationInserted: false }),
    reconcile: async (country, term, vocab) => emulatedReconcile(country, term, vocab),
  });
  const admissionFor = (candidate: string) => ({
    channel: testChannel(),
    sources: [{ kind: 'VIDEO_TITLE', index: 0, text: `${candidate} outlook`, videoId: 'vid-3' }] as LiteralSourceText[],
    parsed: { terminology: [candidate] },
    baseline: okBaseline(), humanApproved: false, humanObservation: 'ENRICHMENT' as const, deps,
  });
  await admitNativeCandidates(admissionFor('BTC'));
  await admitNativeCandidates(admissionFor('btc'));
  await admitNativeCandidates(admissionFor('Btc'));
  assert.equal(sharedStore.rows.size, 1);
  assert.ok(sharedStore.rows.get('Germany|BTC'));
});

test('one literal in two categories saves once without inflating counts', async () => {
  // The vocabulary row is keyed (country, term): the first category wins and
  // the replay reconciles idempotently. Planner consumption uses term text,
  // trust tier, and validation counts — never the category column.
  const store = createFakeVocabStore();
  let observations = 0;
  const deps = fakeDeps({
    reconciled: [], observed: [], saved: [], store,
    observe: async () => { observations += 1; return { termId: 7, observationInserted: observations === 1 }; },
    // Faithful save emulation: creates the row and channel link, like production.
    save: async (country, term) => { emulatedReconcile(country, term, store); },
    reconcile: async (country, term, vocab) => emulatedReconcile(country, term, vocab),
  });
  const admission = {
    channel: testChannel(),
    sources: [{ kind: 'VIDEO_TITLE', index: 0, text: 'SMC backtest', videoId: 'vid-1' }] as LiteralSourceText[],
    parsed: { terminology: ['SMC'], phrases: ['SMC'] },
    baseline: okBaseline(), humanApproved: false, humanObservation: 'ENRICHMENT' as const, deps,
  };
  const report = await admitNativeCandidates(admission);
  assert.deepEqual([report.admitted, report.duplicates], [1, 1]);
  assert.equal(store.rows.size, 1);
  assert.equal(store.rows.get('Germany|SMC')?.occurrences, 1);
});

test('concurrent novel observations converge to the serial first-seen decision', () => {
  // Two overlapping extractions both record novel:true for a genuinely new
  // term. The trial-entry gate consumes novel via OR-aggregation, so the
  // concurrent outcome equals the serial first-seen outcome by construction:
  // revalidating under a lock would merely elect the other serial order.
  const single = rollupNativeQualityEvidence([writerEvidence({ novel: true })]);
  const doubled = rollupNativeQualityEvidence([writerEvidence({ novel: true }), writerEvidence({ novel: true })]);
  assert.deepEqual(
    evaluateTrialEntry({ novel: single.novel, spamConfirmed: single.spamConfirmed }),
    evaluateTrialEntry({ novel: doubled.novel, spamConfirmed: doubled.spamConfirmed })
  );
  assert.deepEqual(evaluateTrialEntry({ novel: doubled.novel, spamConfirmed: doubled.spamConfirmed }), {
    allowed: true, reasons: ['novel-eligible'],
  });
});

test('over-length candidates are rejected by the length guard, not by missing infrastructure', async () => {
  const tooLong = `P2P-Algo-${'x'.repeat(80)}`;
  assert.ok(tooLong.length > 80);
  // Injected fake runner: the guard must reject before any database query.
  // (With no runner at all, observeTerminology also returns null — which is
  // why the fake and its zero-query assertion are load-bearing. Removing the
  // length guard makes this test fail: the fake would receive queries.)
  const calls: string[] = [];
  const fake = {
    query: async (text: string) => { calls.push(text); return { rows: [] }; },
  };
  // Evidence is supplied so the earlier ENRICHMENT fail-closed check passes
  // and only the length guard can reject: without it, the fake would receive
  // INSERT/SELECT queries and the zero-query assertion would fail.
  assert.equal(
    await observeTerminology({ term: tooLong, country: 'Germany', termType: 'TERMINOLOGY', observationType: 'ENRICHMENT', evidence: { qualityVersion: 'native-v1' } }, fake as never),
    null
  );
  assert.equal(calls.length, 0);
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

test('instrument boundaries exclude adjacent digits and underscores', () => {
  const src = (text: string): LiteralSourceText[] => [{ kind: 'DESCRIPTION', index: 0, text }];
  assert.equal(findLiteralSpan('ES', src('trade ES1 futures')), null);
  assert.equal(findLiteralSpan('ES', src('trade ES_Futures')), null);
  assert.equal(findLiteralSpan('CAC 40', src('CAC 400 rally')), null);
  assert.equal(findLiteralSpan('ES', src('trade ES Futures today'))?.span, 'ES');
  assert.equal(findLiteralSpan('CAC 40', src('CAC 40 Analyse'))?.span, 'CAC 40');
  // Accented Latin still guards; CJK adjacency still matches; punctuation kept.
  assert.equal(findLiteralSpan('ES', src('dÉES trade')), null);
  assert.equal(findLiteralSpan('ES', [{ kind: 'VIDEO_TITLE', index: 0, text: 'ＥＳ先物' }])?.span, 'ＥＳ');
  assert.equal(findLiteralSpan('order–flow', src('live order–flow'))?.span, 'order–flow');
  assert.equal(findLiteralSpan('order–flow', src('disorder–flow')), null);
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
  // Duplicate titles consume videos uniquely: no ID repeats across positions.
  assert.deepEqual(alignVideoIdsToTitles(['T', 'T', 'X'], [{ id: 'A', title: 'T' }, { id: 'B', title: 'T' }]), ['A', 'B', null]);
  // Exhausted duplicates degrade to null instead of repeating an ID.
  assert.deepEqual(alignVideoIdsToTitles(['T', 'T', 'T'], [{ id: 'A', title: 'T' }, { id: 'B', title: 'T' }]), ['A', 'B', null]);
  // Single video, duplicate titles: first takes it, second is honestly null.
  assert.deepEqual(alignVideoIdsToTitles(['T', 'T'], [{ id: 'A', title: 'T' }]), ['A', null]);
  // Matched-document fallback: provider-native ID preserved through title
  // equality when no hydrated videos exist; never inferred on mismatch.
  assert.deepEqual(alignVideoIdsToTitles(['Real Title'], [], { id: 'v1', title: 'Real Title' }), ['v1']);
  assert.deepEqual(alignVideoIdsToTitles(['Other'], [], { id: 'v1', title: 'Real Title' }), [null]);
  assert.deepEqual(alignVideoIdsToTitles(['T'], [{ id: 'A', title: 'T' }], { id: 'v1', title: 'T' }), ['A']);
  // resolveExtractionVideoIds is the production handoff: the ingestion call
  // must forward its result to extraction (fails if the argument is removed).
  const ingestionSource = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  assert.match(ingestionSource, /resolveExtractionVideoIds\(candidate\)/);
  assert.match(ingestionSource, /extractVocabularyFromCreator\(([\s\S]{0,400}?)extractionVideoIds/);
  // Handoff behavior through the real helper: matched-document fallback,
  // mismatch honesty, and hydrated-videos precedence.
  assert.deepEqual(
    resolveExtractionVideoIds({ videoTitles: ['Real Title'], matchedDocument: { type: 'VIDEO', providerNativeId: 'v1', title: 'Real Title' } }),
    ['v1']
  );
  assert.deepEqual(
    resolveExtractionVideoIds({ videoTitles: ['Other'], matchedDocument: { type: 'VIDEO', providerNativeId: 'v1', title: 'Real Title' } }),
    [null]
  );
  assert.deepEqual(
    resolveExtractionVideoIds({ videoTitles: ['T'], videos: [{ id: 'A', title: 'T' }], matchedDocument: { type: 'VIDEO', providerNativeId: 'v1', title: 'T' } }),
    ['A']
  );

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

test('non-metadata inputs are excluded from provenance evidence', () => {
  // Inspection prose / fallback titles must never be labeled VIDEO_TITLE/DESCRIPTION.
  const excluded = buildLiteralSources('Kanal', ['Prose title'], 'Inspection prose here', ['vid-9'], { videoTitlesAreMetadata: false, descriptionIsMetadata: false });
  assert.deepEqual(excluded, [{ kind: 'CHANNEL_NAME', index: 0, text: 'Kanal' }]);
  // Default (real metadata): all kinds present with aligned video IDs.
  const full = buildLiteralSources('Kanal', ['T1', 'T2'], 'About text', ['v-1', 'v-2']);
  assert.deepEqual(full.map(entry => entry.kind), ['CHANNEL_NAME', 'VIDEO_TITLE', 'VIDEO_TITLE', 'DESCRIPTION']);
  assert.equal(full[1].videoId, 'v-1');
  assert.equal(full[2].videoId, 'v-2');
  // Rule path honors origins too: matching text, no instrument evidence.
  assert.deepEqual(findRuleInstrumentHits('Kanal', ['ES trade'], 'ES deals', undefined, { videoTitlesAreMetadata: false, descriptionIsMetadata: false }), []);
  // Rule hits propagate video IDs to provenance.
  const hits = findRuleInstrumentHits('Kanal', ['ES trade'], '', ['vid-7']);
  assert.equal(hits[0].located.videoId, 'vid-7');
});

test('admission with non-metadata origins records no title/description evidence', async () => {
  // End-to-end through the production source builder + admission: inspection
  // prose and fallback titles must not surface as VIDEO_TITLE/DESCRIPTION in
  // persisted observation evidence.
  const observed: Array<Record<string, unknown>> = [];
  const saved: Array<{ country: string; term: string }> = [];
  const sources = buildLiteralSources(
    'Börsenanalyse LuxX', ['SMC Kompakt'], 'Inspection prose mentioning SMC Group',
    ['vid-x'], { videoTitlesAreMetadata: false, descriptionIsMetadata: false }
  );
  const deps = fakeDeps({ observed, saved });
  const report = await admitNativeCandidates({
    channel: testChannel(), sources,
    parsed: { terminology: ['Börsenanalyse'] },
    baseline: okBaseline(), humanApproved: true, humanObservation: 'HUMAN_APPROVED_CHANNEL', deps,
  });
  assert.equal(report.admitted, 1);
  for (const entry of observed) {
    const ref = (entry.evidence as Record<string, unknown>).sourceRef as Record<string, unknown>;
    assert.ok(ref.kind === 'CHANNEL_NAME', `non-metadata kind leaked: ${String(ref.kind)}`);
  }
});

test('search-query fallback titles never become video titles', () => {
  const channels = extractDiscoveredChannels(
    [{ id: { channelId: 'ch-1' }, snippet: { channelTitle: 'Kanal' } }],
    'CHANNEL', 'dax trading strategie'
  );
  assert.equal(channels.length, 1);
  assert.deepEqual(channels[0].videoTitles, []);
  const withTitle = extractDiscoveredChannels(
    [{ snippet: { channelId: 'ch-2', channelTitle: 'K2', title: 'Real Title' } }],
    'VIDEO', 'dax trading strategie'
  );
  assert.deepEqual(withTitle[0].videoTitles, ['Real Title']);
});

test('extraction caller marks non-metadata origins honestly', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(source, /videoTitlesAreMetadata: false, descriptionIsMetadata: false/);
});

test('source solicitation signals are recorded as evidence without blocking legit terms', () => {
  // A legitimate term quoted in solicitation prose is still admittable; the
  // source spam flags travel as review evidence instead of suppressing it.
  const spammy: LiteralSourceText[] = [{ kind: 'DESCRIPTION', index: 0, text: 'Join my FREE VIP signals group for SMC secrets' }];
  const verdict = classifyNativeCandidate('SMC', spammy, okBaseline(), {});
  assert.equal(verdict.admit, true);
  if (verdict.admit === true) {
    assert.ok(verdict.sourceSpamSignals.length > 0);
    assert.deepEqual(verdict.spamSignals, []);
  }
  const clean: LiteralSourceText[] = [{ kind: 'DESCRIPTION', index: 0, text: 'SMC backtest results' }];
  const cleanVerdict = classifyNativeCandidate('SMC', clean, okBaseline(), {});
  assert.equal(cleanVerdict.admit, true);
  if (cleanVerdict.admit === true) assert.deepEqual(cleanVerdict.sourceSpamSignals, []);
  // Rule path carries the same evidence on its hits.
  const ruleHits = findRuleInstrumentHits('Kanal', [], 'Trade ES, join my VIP signals group');
  assert.equal(ruleHits.length, 1);
  assert.ok(ruleHits[0].sourceSpamSignals.length > 0);
  const ruleClean = findRuleInstrumentHits('Kanal', [], 'Trade ES futures today');
  assert.deepEqual(ruleClean[0].sourceSpamSignals, []);
});

test('quality read is skipped when it cannot affect the transition', async () => {
  // CANDIDATE staying non-eligible: the gate cannot act, so no aggregate query.
  const runner = fakeRunner({
    aggregates: legacyAggregates({ lifecycle_status: 'CANDIDATE', decayed_evidence: 0, distinct_creators: 1, distinct_communities: 1 }),
    quality: { v1: 0, spam: false, novel: false },
  });
  await refreshTerminologyLifecycle(42, undefined, runner as never);
  assert.ok(!runner.calls.some(call => call.text.includes('bool_or')), 'no quality aggregate on the no-op legacy path');
  assert.ok(runner.calls.some(call => call.text.startsWith('INSERT INTO terminology_score_snapshots')));
});

test('planner serves trial terms inside generated queries', () => {
  const candidates = planDiverseQueries({
    country: 'Germany',
    count: 5,
    learnedVocabulary: [],
    existingQueries: [],
    provenTerminology: [{ id: 1, term: 'P2P-Algo', score: 0.9, lifecycle: 'SEARCH_TRIAL' }],
  }) as Array<{ query: string }>;
  const serving = candidates.filter(candidate => candidate.query.includes('P2P-Algo'));
  assert.ok(serving.length >= 1, 'a planned retrieval query must contain the trial term');
});

test('extraction text gate preserves the channel-name-only path', () => {
  // Post-approval enrichment passes no metadata titles/descriptions, but a
  // channel name alone must still reach native admission.
  assert.equal(hasNativeExtractionText('Börsenanalyse LuxX', [], ''), true);
  assert.equal(hasNativeExtractionText('', [], ''), false);
  assert.equal(hasNativeExtractionText('', ['T'], ''), true);
  assert.equal(hasNativeExtractionText('', [], 'short'), false);
  assert.equal(hasNativeExtractionText('', [], 'a description long enough to analyze'), true);
  const source = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.match(source, /hasNativeExtractionText\(channel\.channel_name, effTitles, effDesc\)/);
});

test('provider parse failures are distinct from persistence failures', () => {
  // Malformed model output throws at the parse boundary (caller: warn-and-skip).
  assert.throws(() => parseNativeVocabularyResponse('{broken json} trailing'));
  // No JSON object present: clean undefined, no throw.
  assert.equal(parseNativeVocabularyResponse('plain prose, no object'), undefined);
  // Valid payload parses for admission.
  assert.deepEqual(parseNativeVocabularyResponse('{"terminology": ["SMC"]}'), { terminology: ['SMC'] });
  // Persistence/admission errors must NOT be caught as provider errors: the
  // admission call sits outside the provider try/catch (after `if (parsed)`),
  // so observe/save failures propagate to the caller for retry.
  const source = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  const catchEnd = source.indexOf('if (parsed) {');
  assert.ok(catchEnd > 0);
  assert.ok(source.indexOf('await admitNativeCandidates({') > catchEnd);
});

test('extraction forwards language and locale into the admission helper', () => {
  const source = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.match(source, /locale: languageContext\?\.locale,\n(\s*)humanApproved,/);
  assert.match(source, /language: languageContext\?\.language,\n(\s*)locale: languageContext\?\.locale,/);
});

test('extraction admits only literal, non-spam candidates with observe-first ordering', () => {
  const source = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.match(source, /classifyNativeCandidate\(raw, args\.sources, args\.baseline/);
  assert.match(source, /if \(observation == null\)/);
  assert.match(source, /if \(!observation\.observationInserted\)/);
  assert.match(source, /buildNoveltyBaseline\(/);
  assert.doesNotMatch(source, /\(\) => \[\] as string\[\]/);
});

test('lifecycle refresh consults the trial-entry gate', () => {
  const source = readFileSync(new URL('./terminologyIntelligence.ts', import.meta.url), 'utf8');
  assert.match(source, /evaluateTrialEntry\(\{ novel: quality\.novel, spamConfirmed: quality\.spamConfirmed \}\)/);
});
