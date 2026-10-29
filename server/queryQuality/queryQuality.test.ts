import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

import { INITIAL_COUNTRY_VOCABULARIES, SUPPORTED_DORMANT_COUNTRIES, SUPPORTED_PRODUCTION_COUNTRIES } from '../../src/data/initial_countries';
import { planDiverseQueries } from '../queryPlanner';
import { isSearchableTradingTerm } from '../terminologySearchability';
import {
  QUERY_SOURCE_REGISTRY,
  admitQueryRecord,
  revalidateQueryRecordAdmission,
  withQueryAdmission,
} from './admission';
import {
  buildQueryCandidate,
  compositionFamilyFor,
  evaluateQueryComposition,
  isSemanticDuplicate,
  resolveCompositionTier,
  semanticQueryKey,
} from './composition';
import {
  DEFAULT_NON_DORMANT_COUNTRIES,
  getCountryMarketProfile,
  PRODUCTION_CONFIGURED_ACTIVE_COUNTRIES,
} from './profiles';
import { computePosterior, empiricalPrior, PORTFOLIO_RATIO, SELECTOR_C } from './posterior';
import { selectHierarchicalUcb, portfolioBudget } from './selector';
import { isQuerySelectable } from './lifecycle';
import { buildQueryQualityVector, buildAttribution, canPromoteToProven } from './accounting';
import { selectQueryCollection } from '../queryPerformance';
import { buildQueryQualityDashboard } from './dashboard';
import { compareSelectors } from './simulator';
import type { SelectorCandidate, SelectorContext, QueryAdmission } from './types';
import { buildCanonicalEvidenceCorpus } from '../evidenceEngine/canonicalEvidencePlane';
import {
  buildContextualComposition,
  isThinRetrievalComposition,
} from '../evidenceEngine/contextualComposition';
import { assessRecognitionState } from '../evidenceEngine/recognitionState';
import { compositionConfirmsTrading } from '../evidenceEngine/decisionPolicy';
import type { EvidenceCollectionReport, EvidenceItem, RawChannelInput } from '../evidenceEngine/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('Q0: the four trace-fixture terms cannot become planner atoms', () => {
  for (const term of ['Free Interviews', 'Subscribe and Like button', 'Épisode 6', '🔴']) {
    const gate = isSearchableTradingTerm({ term, termType: 'TERMINOLOGY' });
    assert.equal(gate.eligible, false, `${term} must be evidence-only`);
    assert.ok(gate.reasons.length > 0);
  }
  assert.equal(isSearchableTradingTerm({ term: 'day trading', termType: 'TERMINOLOGY' }).eligible, true);
  // Reviewed German trading-method terminology remains discoverable; the
  // shape gate still applies to it like any other learned term.
  assert.equal(isSearchableTradingTerm({ term: 'Charttechnik', termType: 'TERMINOLOGY', country: 'Germany', language: 'de' }).eligible, true);
});

test('Q0: curated/country-vocabulary provenance bypasses only the semantic lexicon, not shape gates', () => {
  const curated = buildQueryCandidate({
    query: 'Börsenanalyse',
    country: 'Germany',
    source: 'CURATED',
    atoms: [{ term: 'Börsenanalyse', type: 'TERMINOLOGY', provenance: 'CURATED' }],
  });
  const decision = admitQueryRecord({
    query: 'Börsenanalyse',
    country: 'Germany',
    primary_term: 'Börsenanalyse',
    generation_metadata: { atoms: [{ term: 'Börsenanalyse', type: 'METHOD', origin: 'CURATED' }] },
  });
  assert.equal(decision.admission.tier, 'LICENSED_UNSEEN');
  assert.equal(decision.eligible, true);
  assert.equal(decision.admission.compositionFamily, compositionFamilyFor(curated.atoms));

  const learned = admitQueryRecord({
    query: '🔴',
    country: 'Germany',
    primary_term: '🔴',
    generation_metadata: { atoms: [{ term: '🔴', type: 'TERMINOLOGY', origin: 'LEARNED' }] },
  });
  assert.equal(learned.eligible, false);
  assert.ok(learned.reasonCodes.some(reason => reason.includes('NO_LETTERS') || reason.includes('TOO_SHORT')));
});

test('Q2: every planned query for all 16 production countries is admitted (123/123)', () => {
  let total = 0;
  let admitted = 0;
  for (const country of PRODUCTION_CONFIGURED_ACTIVE_COUNTRIES) {
    const vocabulary = INITIAL_COUNTRY_VOCABULARIES.find(item => item.country === country);
    const planned = planDiverseQueries({
      country,
      count: 8,
      countryVocabulary: vocabulary,
      learnedVocabulary: [],
      existingQueries: [],
    });
    for (const item of planned) {
      total++;
      const result = admitQueryRecord({
        query: item.query,
        country,
        primary_term: item.primaryTerm,
        generation_metadata: item.metadata,
      });
      if (result.eligible) admitted++;
      else assert.fail(`${country} rejected ${item.query}: ${result.reasonCodes.join(',')}`);
    }
  }
  assert.equal(total, 123);
  assert.equal(admitted, 123);
});

test('Q2: source registry has no direct-write producer and admission is deterministic', () => {
  for (const [source, entry] of Object.entries(QUERY_SOURCE_REGISTRY)) {
    assert.equal(entry.directWriteAllowed, false, `${source} must not bypass admission`);
    assert.ok(entry.producer.length > 0);
  }
  const record = {
    query: 'CAC 40 trading',
    country: 'France',
    primary_term: 'CAC 40',
    generation_metadata: {
      atoms: [
        { term: 'CAC 40', type: 'INSTRUMENT', origin: 'CURATED' },
        { term: 'trading', type: 'METHOD', origin: 'CURATED' },
      ],
      queryTemplate: 'COMPACT_PAIR',
      preferredLanguage: 'fr',
    },
  };
  const first = admitQueryRecord(record);
  const second = admitQueryRecord(record);
  assert.equal(first.admission.candidateHash, second.admission.candidateHash);
  assert.deepEqual(first.admission.policyVersions, second.admission.policyVersions);
  assert.ok(first.admission.candidateHash.length > 0);

  const stored = withQueryAdmission(record.generation_metadata, first.admission);
  const backfilled = revalidateQueryRecordAdmission({ ...record, generation_metadata: stored });
  assert.equal(backfilled.eligible, true);
  assert.equal(backfilled.storedAdmission?.candidateHash, first.admission.candidateHash);
});

test('Q2d: stale admission policy/registry drift is revalidated and rejected or marked stale', () => {
  const record = {
    query: 'CAC 40 trading',
    country: 'France',
    primary_term: 'CAC 40',
    generation_metadata: {
      atoms: [
        { term: 'CAC 40', type: 'INSTRUMENT', origin: 'CURATED' },
        { term: 'trading', type: 'METHOD', origin: 'CURATED' },
      ],
      queryTemplate: 'COMPACT_PAIR',
    },
  };
  const fresh = admitQueryRecord(record);
  const stale: QueryAdmission = fresh.admission;
  stale.policyVersions = { ...stale.policyVersions, composition: 'query-composition-stale' };
  const revalidated = revalidateQueryRecordAdmission({
    ...record,
    generation_metadata: withQueryAdmission(record.generation_metadata, stale),
  });
  assert.equal(revalidated.revalidated, true);
  assert.ok(revalidated.reasonCodes.includes('STALE_ADMISSION_REVALIDATED'));
  assert.notEqual(revalidated.admission.policyVersions.composition, 'query-composition-stale');
});

test('Q4: posterior index is mean + c*SD, capped; c is fixed at 2.0', () => {
  assert.equal(SELECTOR_C, 2);
  assert.equal(PORTFOLIO_RATIO, 0.15);
  const posterior = computePosterior(
    { confirmed: 3, quality: 2, quotaUnits: 4, runs: 4 },
    { mean: 0.05, strength: 2 },
    {},
    SELECTOR_C,
  );
  assert.equal(posterior.ucb, Math.min(4, posterior.mean + SELECTOR_C * posterior.sd));
  const capped = computePosterior(
    { confirmed: 100, quality: 80, quotaUnits: 1, runs: 1 },
    { mean: 0.05, strength: 2 },
    {},
    SELECTOR_C,
    4,
  );
  assert.ok(capped.ucb <= 4);
});

const candidate = (id: number, family: string, runs = 3, confirmed = 1): SelectorCandidate => ({
  queryId: id,
  query: `query ${id}`,
  collection: 'EXPERIMENTAL',
  country: 'Germany',
  language: 'de',
  market: 'DE_EQUITIES',
  compositionFamily: family,
  tier: 'LICENSED_UNSEEN',
  primaryTerm: `query ${id}`,
  counts: { confirmed, quality: 0, quotaUnits: 4, runs },
  admission: {
    version: 'query-admission-v1',
    candidateHash: `hash-${id}`,
    eligible: true,
    tier: 'LICENSED_UNSEEN',
    reasonCodes: [],
    compositionFamily: family,
    country: 'Germany',
    language: 'de',
    market: 'DE_EQUITIES',
    source: 'CURATED',
    admittedAt: '2026-01-01T00:00:00.000Z',
    policyVersions: { composition: 'query-composition-v1', admission: 'query-admission-v1' },
  },
});

const selectorContext = (overrides: Partial<SelectorContext> = {}): SelectorContext => ({
  country: 'Germany',
  now: '2026-01-01T00:00:00.000Z',
  c: SELECTOR_C,
  maxIndex: 4,
  minSample: 2,
  portfolioRatio: PORTFOLIO_RATIO,
  totalDailyQuotaUnits: 100,
  portfolioUnitsUsed: 100,
  familyShare: {},
  familyCap: 0.45,
  queryCap: 1,
  countryShare: {},
  countryCap: 1,
  sourceShare: {},
  sourceCap: 0.6,
  prior: empiricalPrior([{ confirmed: 3, quality: 2, quotaUnits: 4, runs: 4 }]),
  halfLifeDays: 30,
  coverageCells: ['de'],
  coveredCells: ['de'],
  ...overrides,
});

test('Q4: selector is deterministic, has no random/least-executed fallback, and logs posterior + c', () => {
  const candidates = [candidate(1, 'family:A'), candidate(2, 'family:B', 1, 1)];
  const first = selectHierarchicalUcb(candidates, selectorContext());
  const second = selectHierarchicalUcb(candidates, selectorContext());
  assert.deepEqual(first, second);
  assert.ok(first.queryId === 1 || first.queryId === 2);
  assert.equal(first.c, 2);
  assert.ok(first.posterior);
  assert.ok(first.candidateSetHash.length > 0);
  assert.ok(first.reason.includes('c 2.0'));
  assert.ok(!('mathRandom' in first));

  const source = readFileSync(join(__dirname, 'selector.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/.*$/gmu, '');
  assert.ok(!source.includes('Math.random'), 'serving selector must not use Math.random');
  assert.ok(!source.includes('least-executed'));
});

test('Q4: portfolio budget is bounded to the 10–20% band and triggers coverage selection', () => {
  assert.deepEqual(portfolioBudget(100, 0.15), { units: 15, ratio: 0.15 });
  assert.equal(portfolioBudget(100, 0.01).ratio, 0.1);
  assert.equal(portfolioBudget(100, 0.9).ratio, 0.2);
  const candidates = [candidate(1, 'family:A'), candidate(2, 'family:B', 0, 0)];
  const decision = selectHierarchicalUcb(candidates, selectorContext({
    portfolioUnitsUsed: 0,
    coverageCells: ['de', 'de-new'],
    coveredCells: ['de'],
  }));
  assert.equal(decision.strategy, 'UCB_PORTFOLIO');
  assert.ok(decision.reasonCodes.includes('PORTFOLIO_BUDGET_RESERVED'));
});

test('Q3/Q4: lifecycle gates reject REJECTED, cooldown, same-tick and speculative candidates', () => {
  const base = {
    id: 1,
    query: 'q',
    collection: 'EXPERIMENTAL' as const,
    status: 'ACTIVE' as const,
    last_executed: null,
    primary_term: 'q',
  };
  assert.equal(isQuerySelectable({ record: base, now: '2026-01-01T00:00:00.000Z', cooldownMinutes: 360 }).selectable, true);
  assert.ok(isQuerySelectable({ record: { ...base, collection: 'REJECTED' }, now: '2026-01-01T00:00:00.000Z', cooldownMinutes: 360 }).reasonCodes.includes('REJECTED_COLLECTION'));
  assert.ok(isQuerySelectable({ record: { ...base, last_executed: '2025-12-31T23:59:30.000Z' }, now: '2026-01-01T00:00:00.000Z', cooldownMinutes: 360 }).reasonCodes.includes('SAME_TICK_REEXECUTION'));
  assert.ok(isQuerySelectable({
    record: base,
    now: '2026-01-01T00:00:00.000Z',
    cooldownMinutes: 360,
    admission: { ...candidate(1, 'family:A').admission!, tier: 'SPECULATIVE' },
  }).reasonCodes.includes('NO_CURRENT_ADMISSION'));
});

test('Q4c: zero-confirm cannot be PROVEN; promotion needs LCB and minimum runs', () => {
  const metrics = {
    rawResults: 10, distinctResults: 10, duplicateResults: 0, knownChannels: 0, newChannels: 8,
    countryRejected: 0, nonTrading: 0, uncertain: 0, needsReview: 0, tradingConfirmed: 8,
    qualityChannels: 6, communitiesDiscovered: 2, averageQualityScore: 80, noveltyRatio: 0.8,
    countryPrecision: 1, tradingPrecision: 1, performanceScore: 88,
  };
  const guarded = canPromoteToProven({
    completedRuns: 2, minRuns: 2, lcb: 0.2, threshold: 0.5, newConfirmedCreators: 8, duplicateRatio: 0, invalidQueryRate: 0,
  });
  assert.equal(guarded.eligible, false);
  assert.ok(guarded.reasonCodes.includes('LCB_BELOW_PROMOTION_THRESHOLD'));
  const eligible = canPromoteToProven({
    completedRuns: 2, minRuns: 2, lcb: 0.8, threshold: 0.5, newConfirmedCreators: 8, duplicateRatio: 0, invalidQueryRate: 0,
  });
  assert.equal(eligible.eligible, true);
  const zero = canPromoteToProven({
    completedRuns: 3, minRuns: 2, lcb: 2, threshold: 0.5, newConfirmedCreators: 0, duplicateRatio: 0, invalidQueryRate: 0,
  });
  assert.equal(zero.eligible, false);
  assert.ok(zero.reasonCodes.includes('ZERO_CONFIRM_CANNOT_PROVE'));
  // Legacy call without a guard still cannot prove a zero-confirm run.
  assert.equal(selectQueryCollection('EXPERIMENTAL', 2, { ...metrics, tradingConfirmed: 0 }), 'EXPERIMENTAL');
});

test('Q5: quality vector is result-level and attribution carries the full path', () => {
  const vector = buildQueryQualityVector({
    rawResults: 20,
    distinctResults: 12,
    duplicateResults: 8,
    newChannels: 7,
    newConfirmedCreators: 3,
    newQualityCreators: 2,
    quotaUsed: 200,
    targetMarketConfirmed: 10,
    languageMatchedConfirmed: 3,
  });
  assert.equal(vector.quotaUnits, 2);
  assert.equal(vector.confirmedNewCreatorsPer100Quota, 1.5);
  assert.equal(vector.qualityNewCreatorsPer100Quota, 1);
  assert.equal(vector.duplicateRatio, 0.4);
  const attribution = buildAttribution({
    termSense: 'order flow',
    relation: 'ANCHOR_MODIFIER',
    compositionFamily: 'family:INSTRUMENT+TERMINOLOGY',
    surface: 'order flow futures',
    country: 'United States',
    market: 'US_EQUITIES_FUTURES',
    language: 'en',
    vector,
  });
  assert.equal(attribution.termSense, 'order flow');
  assert.equal(attribution.relation, 'ANCHOR_MODIFIER');
  assert.equal(attribution.compositionFamily, 'family:INSTRUMENT+TERMINOLOGY');
  assert.equal(attribution.surface, 'order flow futures');
});

test('Q6: dashboard counts only accounted vectors and reports missing data honestly', () => {
  const vector = buildQueryQualityVector({
    rawResults: 10, distinctResults: 10, newChannels: 4, newConfirmedCreators: 2,
    newQualityCreators: 1, quotaUsed: 100, targetMarketConfirmed: 10,
  });
  const dashboard = buildQueryQualityDashboard({
    generatedAt: '2026-01-01T00:00:00.000Z',
    portfolio: { dailyQuotaUnits: 100, portfolioUnitsReserved: 15, portfolioUnitsUsed: 12 },
    rows: [
      {
        runId: 'run-1', queryId: 1, query: 'day trading', country: 'Germany', status: 'COMPLETED',
        selectionStrategy: 'UCB_EXPLOITATION', selectionReason: 'selected', stopReason: 'MAX_PAGES_REACHED',
        quotaUsed: 100, completedAt: '2026-01-01T00:00:00.000Z', performanceScore: 80,
        qualityVector: vector,
        admission: { tier: 'LICENSED_UNSEEN', compositionFamily: 'family:TERMINOLOGY', reasonCodes: [] },
      },
      {
        runId: 'run-2', queryId: 2, query: 'legacy', country: 'Germany', status: 'COMPLETED',
        selectionStrategy: 'UCB_PORTFOLIO', selectionReason: 'selected', stopReason: null,
        quotaUsed: 100, completedAt: '2026-01-01T00:00:00.000Z', performanceScore: 20,
        qualityVector: null,
        admission: { tier: 'SPECULATIVE', compositionFamily: 'family:TERMINOLOGY', reasonCodes: ['SPECULATIVE_EVIDENCE_ONLY'] },
      },
      {
        runId: 'run-3', queryId: 3, query: 'pending', country: 'Germany', status: 'RUNNING',
        selectionStrategy: 'COLD_START_GENERATION', selectionReason: 'selected', quotaUsed: 0,
        qualityVector: null, admission: null,
      },
    ],
  });
  assert.equal(dashboard.totals.completedRuns, 2);
  assert.equal(dashboard.totals.accountedRuns, 1);
  assert.equal(dashboard.totals.unaccountedCompletedRuns, 1);
  assert.equal(dashboard.totals.newConfirmedCreators, 2);
  assert.equal(dashboard.totals.zeroConfirmRuns, 0);
  assert.equal(dashboard.selection.stopReasonCoverage, 0.5);
  assert.equal(dashboard.portfolio.withinBudget, true);
  assert.deepEqual(dashboard.selection.stopReasons[0], { reason: 'MAX_PAGES_REACHED', count: 1 });
});

test('Q6: portfolio over-budget is conspicuous, not hidden', () => {
  const dashboard = buildQueryQualityDashboard({
    generatedAt: '2026-01-01T00:00:00.000Z',
    portfolio: { dailyQuotaUnits: 100, portfolioUnitsReserved: 15, portfolioUnitsUsed: 20 },
    rows: [],
  });
  assert.equal(dashboard.portfolio.withinBudget, false);
  assert.equal(dashboard.portfolio.portfolioShareUsed, 0.2);
});

test('Q8: registry contracts stay 20 supported / 5 dormant / 15 default / 16 production', () => {
  assert.equal(SUPPORTED_PRODUCTION_COUNTRIES.length, 20);
  assert.equal(SUPPORTED_DORMANT_COUNTRIES.length, 5);
  assert.equal(DEFAULT_NON_DORMANT_COUNTRIES.length, 15);
  assert.equal(PRODUCTION_CONFIGURED_ACTIVE_COUNTRIES.length, 16);
  assert.ok(PRODUCTION_CONFIGURED_ACTIVE_COUNTRIES.includes('Norway'));
  for (const absent of ['Italy', 'Japan', 'Spain', 'United Arab Emirates']) {
    assert.ok(!(PRODUCTION_CONFIGURED_ACTIVE_COUNTRIES as readonly string[]).includes(absent));
  }
});

test('Q8: corrected hierarchical TS is an offline comparator and UCB c=2 is non-inferior in the seeded sample', () => {
  const scenarios = ['sparse', 'medium', 'rich', 'cold_start', 'cold_countries', 'non_stationary', 'depletion', 'many_arms'] as const;
  for (const scenario of scenarios) {
    let ucbYield = 0;
    let tsYield = 0;
    for (let seed = 30; seed < 38; seed++) {
      const comparison = compareSelectors({ scenario, seeds: seed, pulls: 600 });
      ucbYield += comparison.hierarchical_ucb_c2.meanYield;
      tsYield += comparison.hierarchical_ts.meanYield;
      assert.equal(comparison.hierarchical_ucb_c2.coverage, 16);
      assert.ok(comparison.hierarchical_ucb_c2.maxFamilyShare <= 0.151, `${scenario} max family share ${comparison.hierarchical_ucb_c2.maxFamilyShare}`);
      assert.ok(comparison.hierarchical_ucb_c2.maxCountryShare <= 0.066, `${scenario} max country share ${comparison.hierarchical_ucb_c2.maxCountryShare}`);
    }
    const relativeDifference = (ucbYield - tsYield) / Math.max(1e-9, tsYield);
    assert.ok(relativeDifference >= -0.01, `${scenario} UCB c=2 under-performed TS by ${(relativeDifference * 100).toFixed(2)}%`);
  }
  const source = readFileSync(join(__dirname, 'simulator.ts'), 'utf8');
  assert.ok(source.includes('offline selector comparison'));
});

function rawInput(overrides: Partial<RawChannelInput>): RawChannelInput {
  const input: RawChannelInput = { channel_name: 'Fixture', description: '', country: 'Germany', ...overrides };
  input.evidence_corpus = buildCanonicalEvidenceCorpus(input);
  return input;
}

test('C5: title-only and retrieval-only inputs never confirm; alternative composition rejects', () => {
  const titleOnly = rawInput({ channel_name: 'Day Trading Pro', description: '' });
  const titleComposition = buildContextualComposition(titleOnly);
  assert.equal(titleComposition.focus, 'INSUFFICIENT_COVERAGE');
  assert.equal(compositionConfirmsTrading(titleComposition), false);

  const queryOnly = rawInput({
    channel_name: 'Day Trading Pro',
    description: '',
    search_match_context: { type: 'VIDEO', title: 'Day trading for beginners' },
  });
  const queryComposition = buildContextualComposition(queryOnly);
  assert.equal(queryComposition.focus, 'QUERY_ONLY');
  assert.equal(isThinRetrievalComposition(queryOnly, queryComposition), true);
  assert.equal(compositionConfirmsTrading(queryComposition), false);

  const alternative = rawInput({
    channel_name: 'Music Channel',
    description: 'Official music videos and artist interviews.',
    videos: [
      { id: 'music-1', title: 'Official music video', published_at: '2026-01-01T00:00:00.000Z' },
      { id: 'music-2', title: 'Official audio and lyrics', published_at: '2026-01-01T00:00:00.000Z' },
    ],
  });
  const alternativeComposition = buildContextualComposition(alternative);
  assert.equal(alternativeComposition.focus, 'ALTERNATIVE_DOMINANT');
  assert.equal(alternativeComposition.explicitCreatorAlternative, true);
  assert.equal(compositionConfirmsTrading(alternativeComposition), false);

  const evidence: EvidenceItem[] = [];
  const collection: EvidenceCollectionReport = {
    sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false, fieldsPresent: [], reasonCodes: [], providers: [],
    terminalNegativeSufficiency: { status: 'SUFFICIENT', creatorLevelCoverage: true, independentSourceFamilies: 2, independentObservations: 2, reasonCodes: [] },
  };
  const nonTrading = assessRecognitionState({
    composition: alternativeComposition, evidence, collection, lifecycleAction: 'REJECT', semanticAvailable: true, hasCreatorContext: true,
  });
  assert.equal(nonTrading.state, 'DECISIVE_NON_TRADING');
  assert.equal(nonTrading.semanticPolicy, 'SKIP');
});

test('C5/C6: explicit creator trading statement confirms; recognition state is deterministic', () => {
  const trading = rawInput({
    channel_name: 'Alpha Trading',
    description: 'Day trading, order flow and risk management education.',
    videos: [
      { id: 'trade-1', title: 'Order flow trading setup', published_at: '2026-01-01T00:00:00.000Z' },
    ],
  });
  const composition = buildContextualComposition(trading);
  assert.equal(composition.focus, 'TRADING_DOMINANT');
  assert.ok(composition.nonTitleTierAFamilies >= 1);
  assert.equal(compositionConfirmsTrading(composition), true);

  const substantive: EvidenceItem = {
    id: 'ev-1', source: 'channel_metadata', polarity: 'POSITIVE', category: 'METHODOLOGY_CONCEPT',
    fact: 'Day trading', rawMatches: ['day trading'], confidence: 90, reliability: 'HIGH',
    reliabilityMultiplier: 1, rawWeight: 30, finalWeight: 30,
    provenance: { fields: [{ field: 'channel_bio' }] }, timestamp: '2026-01-01T00:00:00.000Z',
  } as EvidenceItem;
  const collection: EvidenceCollectionReport = {
    sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false, fieldsPresent: ['channel_bio'], reasonCodes: [], providers: [],
  };
  const first = assessRecognitionState({
    composition, evidence: [substantive], collection, lifecycleAction: 'CONFIRM', semanticAvailable: true, hasCreatorContext: true,
  });
  const second = assessRecognitionState({
    composition, evidence: [substantive], collection, lifecycleAction: 'CONFIRM', semanticAvailable: true, hasCreatorContext: true,
  });
  assert.deepEqual(first, second);
  assert.equal(first.state, 'DECISIVE_TRADING');
  assert.equal(first.semanticPolicy, 'SKIP');
});

test('C6: query-only recognition skips semantic and blocks terminal rejection', () => {
  const queryOnly = rawInput({
    channel_name: 'Trading Search Result',
    description: '',
    search_match_context: { type: 'VIDEO', title: 'day trading' },
  });
  const composition = buildContextualComposition(queryOnly);
  const assessment = assessRecognitionState({
    composition,
    evidence: [],
    collection: { sufficiency: 'MISSING', sparseMetadata: true, degraded: false, fieldsPresent: [], reasonCodes: [], providers: [] },
    lifecycleAction: 'REJECT',
    semanticAvailable: true,
    hasCreatorContext: false,
  });
  assert.equal(assessment.state, 'QUERY_ONLY');
  assert.equal(assessment.semanticPolicy, 'SKIP');
  assert.ok(assessment.gaps.includes('QUERY_ONLY_EVIDENCE'));
});

function heldOutRecord(
  country: string,
  query: string,
  atoms: Array<{ term: string; type: string; country?: string; language?: string }>,
  options: { relation?: string; history?: Array<{ query: string; country: string; aliasOf?: string }> } = {},
) {
  return {
    query,
    country,
    primary_term: atoms[0]?.term,
    generation_metadata: {
      ...(options.relation ? { queryTemplate: options.relation } : {}),
      atoms: atoms.map(atom => ({ ...atom, origin: 'CURATED' })),
    },
  };
}

test('Q2: held-out licensed-unseen compositions are admitted; invalid held-out compositions fail closed', () => {
  const valid = [
    heldOutRecord('Germany', 'DAX day trading', [
      { term: 'DAX', type: 'INSTRUMENT' }, { term: 'day trading', type: 'METHOD' },
    ], { relation: 'COMPACT_PAIR' }),
    heldOutRecord('France', 'CAC 40 trading', [
      { term: 'CAC 40', type: 'INSTRUMENT' }, { term: 'trading', type: 'METHOD' },
    ], { relation: 'COMPACT_PAIR' }),
    heldOutRecord('Netherlands', 'AEX opties', [
      { term: 'AEX', type: 'INSTRUMENT' }, { term: 'opties', type: 'METHOD' },
    ], { relation: 'COMPACT_PAIR' }),
    heldOutRecord('Belgium', 'BEL 20 aandelen', [
      { term: 'BEL 20', type: 'INSTRUMENT' }, { term: 'aandelen', type: 'METHOD' },
    ], { relation: 'COMPACT_PAIR' }),
    heldOutRecord('United States', 'SPY options flow', [
      { term: 'SPY', type: 'INSTRUMENT' }, { term: 'options flow', type: 'METHOD' },
    ], { relation: 'COMPACT_PAIR' }),
    heldOutRecord('United Kingdom', 'FTSE spread betting', [
      { term: 'FTSE', type: 'INSTRUMENT' }, { term: 'spread betting', type: 'METHOD' },
    ], { relation: 'COMPACT_PAIR' }),
    heldOutRecord('Canada', 'TSX day trading', [
      { term: 'TSX', type: 'INSTRUMENT' }, { term: 'day trading', type: 'METHOD' },
    ], { relation: 'COMPACT_PAIR' }),
    heldOutRecord('Sweden', 'OMXS30 day trading', [
      { term: 'OMXS30', type: 'INSTRUMENT' }, { term: 'day trading', type: 'METHOD' },
    ], { relation: 'COMPACT_PAIR' }),
    heldOutRecord('Singapore', 'STI CFD trading', [
      { term: 'STI', type: 'INSTRUMENT' }, { term: 'CFD trading', type: 'METHOD' },
    ], { relation: 'COMPACT_PAIR' }),
    heldOutRecord('Germany', 'order flow', [
      { term: 'order flow', type: 'METHOD', country: 'GLOBAL' },
    ]),
  ];
  let admitted = 0;
  for (const record of valid) {
    const decision = admitQueryRecord(record);
    if (decision.eligible) admitted++;
    else assert.fail(`valid held-out composition rejected: ${record.query} (${decision.reasonCodes.join(',')})`);
  }
  assert.ok(admitted / valid.length >= 0.9, `only ${admitted}/${valid.length} valid held-out compositions admitted`);

  const invalid: Array<{ label: string; decision: ReturnType<typeof admitQueryRecord> }> = [
    { label: 'too many tokens', decision: admitQueryRecord(heldOutRecord('Germany', 'DAX day trading live futures', [
      { term: 'DAX', type: 'INSTRUMENT' }, { term: 'day trading', type: 'METHOD' },
    ])) },
    { label: 'bare short ticker', decision: admitQueryRecord(heldOutRecord('United States', 'SPY', [
      { term: 'SPY', type: 'INSTRUMENT' },
    ])) },
    { label: 'cross-country atom', decision: admitQueryRecord(heldOutRecord('Germany', 'DAX day trading', [
      { term: 'DAX', type: 'INSTRUMENT', country: 'France' }, { term: 'day trading', type: 'METHOD' },
    ])) },
    { label: 'language mismatch', decision: admitQueryRecord(heldOutRecord('Germany', 'DAX day trading', [
      { term: 'DAX', type: 'INSTRUMENT', language: 'fr' }, { term: 'day trading', type: 'METHOD' },
    ])) },
    { label: 'unlicensed relation', decision: (() => {
      const candidate = buildQueryCandidate({
        query: 'DAX day trading',
        country: 'Germany',
        atoms: [{ term: 'DAX', type: 'INSTRUMENT' }, { term: 'day trading', type: 'TERMINOLOGY' }],
        source: 'CURATED',
        relation: 'RANDOM_LINK',
      });
      const evaluated = evaluateQueryComposition(candidate);
      return {
        eligible: evaluated.eligible,
        reasonCodes: evaluated.reasonCodes,
      } as unknown as ReturnType<typeof admitQueryRecord>;
    })() },
    { label: 'unknown learned term', decision: admitQueryRecord({
      query: 'quatsch handel',
      country: 'Germany',
      primary_term: 'quatsch',
      generation_metadata: { atoms: [{ term: 'quatsch', type: 'TERMINOLOGY', origin: 'LEARNED' }] },
    }) },
    { label: 'ambiguous instrument pair', decision: admitQueryRecord(heldOutRecord('Germany', 'DAX MDAX', [
      { term: 'DAX', type: 'INSTRUMENT' }, { term: 'MDAX', type: 'INSTRUMENT' },
    ])) },
    { label: 'CTA-only surface', decision: admitQueryRecord(heldOutRecord('Germany', 'subscribe', [
      { term: 'subscribe', type: 'METHOD' },
    ])) },
    { label: 'episode label', decision: admitQueryRecord(heldOutRecord('Germany', 'Episode 6', [
      { term: 'Episode 6', type: 'METHOD' },
    ])) },
    { label: 'URL/handle surface', decision: admitQueryRecord(heldOutRecord('Germany', 'www.example.de', [
      { term: 'www.example.de', type: 'METHOD' },
    ])) },
  ];
  for (const item of invalid) {
    assert.equal(item.decision.eligible, false, `${item.label} must not be admitted`);
    assert.ok(item.decision.reasonCodes.length > 0, `${item.label} must explain rejection`);
  }
});

test('Q2: tier resolution derives ATTESTED_EXACT, LICENSED_UNSEEN and SPECULATIVE from evidence', () => {
  const candidate = buildQueryCandidate({
    query: 'DAX day trading',
    country: 'Germany',
    source: 'CURATED',
    atoms: [{ term: 'DAX', type: 'INSTRUMENT' }, { term: 'day trading', type: 'TERMINOLOGY', role: 'MODIFIER' }],
  });
  const profile = getCountryMarketProfile('Germany');
  const attestations = candidate.atoms.map((atom, index) => ({
    id: `attestation-${index}`,
    term: atom.term,
    normalizedTerm: atom.sense.normalizedTerm,
    country: profile.country,
    language: profile.languages[0],
    market: profile.primaryMarket,
    sourceFamilyId: `source-${index}`,
    observedAt: '2026-01-01T00:00:00.000Z',
    kind: 'EXACT' as const,
  }));
  assert.equal(resolveCompositionTier(candidate, { attestations }), 'ATTESTED_EXACT');
  assert.equal(resolveCompositionTier(candidate, {}), 'LICENSED_UNSEEN');
  const speculative = buildQueryCandidate({
    query: 'Charttechnik quatsch',
    country: 'Germany',
    source: 'LEARNED_TERMINOLOGY',
    atoms: [{ term: 'Charttechnik', type: 'TERMINOLOGY', role: 'ANCHOR' }, { term: 'quatsch', type: 'TERMINOLOGY' }],
  });
  assert.equal(resolveCompositionTier(speculative, {}), 'SPECULATIVE');
});

test('Q2: exact, reordered, alias and near-duplicate compositions are suppressed; cross-country is not deduped', () => {
  const record = heldOutRecord('Germany', 'DAX day trading', [
    { term: 'DAX', type: 'INSTRUMENT' }, { term: 'day trading', type: 'METHOD' },
  ], { relation: 'COMPACT_PAIR' });

  const exact = admitQueryRecord(record, { history: [{ query: 'DAX day trading', country: 'Germany' }] });
  assert.equal(exact.eligible, false);
  assert.ok(exact.reasonCodes.includes('SEMANTIC_DUPLICATE'));

  const reordered = admitQueryRecord(record, { history: [{ query: 'trading DAX day', country: 'Germany' }] });
  assert.equal(reordered.eligible, false);
  assert.ok(reordered.reasonCodes.includes('SEMANTIC_DUPLICATE'));

  const alias = admitQueryRecord(record, { history: [{ query: 'DAX handel', aliasOf: 'DAX day trading', country: 'Germany' }] });
  assert.equal(alias.eligible, false);
  assert.ok(alias.reasonCodes.includes('SEMANTIC_DUPLICATE'));

  // The same surface in another country is a different search market.
  const crossCountry = admitQueryRecord(record, { history: [{ query: 'DAX day trading', country: 'France' }] });
  assert.equal(crossCountry.eligible, true);

  assert.equal(semanticQueryKey('DAX  day   trading'), 'dax day trading');
  // A generic suffix is close enough to be a near-duplicate in one market...
  assert.equal(isSemanticDuplicate('DAX day trading futures live', [
    { query: 'DAX day trading futures', country: 'Germany' },
  ], 'Germany'), true);
  // ...but never across markets.
  assert.equal(isSemanticDuplicate('DAX day trading futures live', [
    { query: 'DAX day trading futures', country: 'France' },
  ], 'Germany'), false);
});

test('Q2: cross-country and cross-language atoms are rejected unless explicitly global', () => {
  const crossCountry = admitQueryRecord(heldOutRecord('Germany', 'DAX day trading', [
    { term: 'DAX', type: 'INSTRUMENT', country: 'France' }, { term: 'day trading', type: 'METHOD', country: 'Germany' },
  ]));
  assert.equal(crossCountry.eligible, false);
  assert.ok(crossCountry.reasonCodes.includes('CROSS_COUNTRY_ATOM'));
  // Atom scope survives admission instead of being silently rewritten.
  assert.equal(crossCountry.candidate.atoms[0].sense.country, 'France');

  const globalAtom = admitQueryRecord(heldOutRecord('Germany', 'order flow', [
    { term: 'order flow', type: 'METHOD', country: 'GLOBAL' },
  ]));
  assert.equal(globalAtom.eligible, true);

  const wrongLanguage = admitQueryRecord(heldOutRecord('Germany', 'DAX day trading', [
    { term: 'DAX', type: 'INSTRUMENT', language: 'fr' }, { term: 'day trading', type: 'METHOD' },
  ]));
  assert.equal(wrongLanguage.eligible, false);
  assert.ok(wrongLanguage.reasonCodes.includes('LANGUAGE_MISMATCH'));
  assert.equal(wrongLanguage.candidate.atoms[0].sense.language, 'fr');

  const frenchCandidate = buildQueryCandidate({
    query: 'CAC 40 trading',
    country: 'Germany',
    language: 'fr',
    atoms: [{ term: 'CAC 40', type: 'INSTRUMENT' }, { term: 'trading', type: 'TERMINOLOGY' }],
    source: 'CURATED',
  });
  const decision = evaluateQueryComposition(frenchCandidate);
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasonCodes.includes('LANGUAGE_MISMATCH'));
});

test('Q2: query_library writes go only through the admission chokepoint', () => {
  const serverDir = join(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  };
  walk(serverDir);
  assert.ok(files.length > 100, 'server source scan must not silently become empty');

  const writers = files
    .filter(file => !file.endsWith('.test.ts'))
    .filter(file => /INSERT\s+INTO\s+query_library/iu.test(readFileSync(file, 'utf8')))
    .map(file => basename(file))
    .sort();
  // dbCore is the single admitted writer. db.legacy is an unimported SQLite
  // shim kept for history; the next assertion proves it is dead code.
  assert.deepEqual(writers, ['db.legacy.ts', 'dbCore.ts']);
  const legacyImporters = files.filter(file => /from\s+['"]\.\/db\.legacy['"]/u.test(readFileSync(file, 'utf8')));
  assert.deepEqual(legacyImporters, [], 'db.legacy must stay unreachable');
});

test('Q6: provider-degraded and failed runs stay visible but never enter reward totals', () => {
  const healthy = buildQueryQualityVector({
    rawResults: 10, distinctResults: 10, newChannels: 4, newConfirmedCreators: 2,
    newQualityCreators: 1, quotaUsed: 100,
  });
  const degraded = buildQueryQualityVector({
    rawResults: 0, distinctResults: 0, newChannels: 0, newConfirmedCreators: 0,
    newQualityCreators: 0, quotaUsed: 100, providerDegraded: true,
  });
  const failed = buildQueryQualityVector({
    rawResults: 0, distinctResults: 0, newChannels: 0, newConfirmedCreators: 0,
    newQualityCreators: 0, quotaUsed: 100, failed: true,
  });
  const dashboard = buildQueryQualityDashboard({
    generatedAt: '2026-01-01T00:00:00.000Z',
    portfolio: { dailyQuotaUnits: 100, portfolioUnitsReserved: 15, portfolioUnitsUsed: 0 },
    rows: [
      { runId: 'healthy', queryId: 1, query: 'day trading', country: 'Germany', status: 'COMPLETED', selectionStrategy: 'UCB_EXPLOITATION', selectionReason: 'selected', stopReason: 'MAX_PAGES_REACHED', quotaUsed: 100, qualityVector: healthy },
      { runId: 'degraded', queryId: 2, query: 'order flow', country: 'Germany', status: 'COMPLETED', selectionStrategy: 'UCB_PORTFOLIO', selectionReason: 'selected', stopReason: 'PROVIDER_DEGRADED', quotaUsed: 100, qualityVector: degraded },
      { runId: 'failed', queryId: 3, query: 'CAC 40', country: 'Germany', status: 'COMPLETED', selectionStrategy: 'UCB_EXPLOITATION', selectionReason: 'selected', stopReason: 'PROVIDER_FAILURE', quotaUsed: 100, qualityVector: failed },
      { runId: 'legacy', queryId: 4, query: 'legacy', country: 'Germany', status: 'COMPLETED', selectionStrategy: 'UCB_EXPLOITATION', selectionReason: 'selected', quotaUsed: 100, qualityVector: null },
    ],
  });
  assert.equal(dashboard.totals.accountedRuns, 3);
  assert.equal(dashboard.totals.rewardEligibleRuns, 1);
  assert.equal(dashboard.totals.providerDegradedRuns, 1);
  assert.equal(dashboard.totals.unaccountedCompletedRuns, 1);
  assert.equal(dashboard.totals.newConfirmedCreators, 2);
  assert.equal(dashboard.totals.zeroConfirmRuns, 0);
  assert.equal(dashboard.totals.zeroConfirmShare, 0);
  // Degraded rows are still listed, not hidden, and remain accounted.
  assert.equal(dashboard.rows.filter(row => row.accounted).length, 3);
});

test('Q3/Q4: rejected and admission-ineligible candidates never reach quota', () => {
  const rejected = { ...candidate(90, 'family:REJECTED'), collection: 'REJECTED' as const };
  const ineligibleAdmission = candidate(91, 'family:INELIGIBLE');
  ineligibleAdmission.admission = { ...ineligibleAdmission.admission!, eligible: false };
  const noEligible = selectHierarchicalUcb([rejected, ineligibleAdmission], selectorContext());
  assert.equal(noEligible.strategy, 'NO_ELIGIBLE_QUERY');
  assert.equal(noEligible.queryId, null);
  assert.ok(noEligible.reasonCodes.includes('NO_ELIGIBLE_QUERY'));

  const mixed = selectHierarchicalUcb([rejected, ineligibleAdmission, candidate(1, 'family:A')], selectorContext());
  assert.equal(mixed.queryId, 1);
  assert.ok(mixed.strategy === 'UCB_EXPLOITATION' || mixed.strategy === 'UCB_PORTFOLIO');

  assert.equal(isQuerySelectable({
    record: { id: 90, query: 'rejected', collection: 'REJECTED', status: 'ACTIVE', last_executed: null },
    now: '2026-01-01T00:00:00.000Z',
    cooldownMinutes: 360,
    admission: rejected.admission,
  }).selectable, false);
});

test('Q5: explicit zero market/language counts are honest measurements, not missing data', () => {
  const measured = buildQueryQualityVector({
    rawResults: 10, distinctResults: 10, newChannels: 3, newConfirmedCreators: 2,
    newQualityCreators: 1, quotaUsed: 100, targetMarketConfirmed: 0, languageMatchedConfirmed: 0,
  });
  assert.equal(measured.targetMarketPrecision, 0);
  assert.equal(measured.languageMatchRate, 0);

  const proxied = buildQueryQualityVector({
    rawResults: 10, distinctResults: 10, duplicateResults: 0, newChannels: 3, newConfirmedCreators: 2,
    newQualityCreators: 1, quotaUsed: 100, countryRejected: 2,
  });
  assert.equal(proxied.targetMarketPrecision, 0.8);
  assert.equal(proxied.languageMatchRate, 1);
});



