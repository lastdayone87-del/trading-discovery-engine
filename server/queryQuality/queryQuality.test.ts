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
  admitQueryCandidate,
  buildQueryCandidate,
  candidateHash,
  compositionFamilyFor,
  evaluateQueryComposition,
  isSemanticDuplicate,
  resolveCompositionTier,
  selectionHistoryFor,
  semanticQueryKey,
} from './composition';
import {
  DEFAULT_NON_DORMANT_COUNTRIES,
  getCountryMarketProfile,
  PRODUCTION_CONFIGURED_ACTIVE_COUNTRIES,
} from './profiles';
import { computePosterior, empiricalPrior, PORTFOLIO_RATIO, SELECTOR_C, portfolioContinuationAllowed } from './posterior';
import { selectHierarchicalUcb, portfolioBudget, buildHierarchy } from './selector';
import { deriveQueryFailureState, isQuerySelectable } from './lifecycle';
import { buildQueryQualityVector, buildAttribution, canPromoteToProven, isRewardEligibleQuota, rewardRate } from './accounting';
import { selectQueryCollection } from '../queryPerformance';
import { isQuotaFreeSearchProviderRow, quotaFreeSearchProviderRows } from '../providerAwareRetrieval';
import { decideLifecycle } from '../terminologyIntelligence';
import { buildQueryQualityDashboard, QUERY_QUALITY_DASHBOARD_MAX_ROWS } from './dashboard';
import { compareSelectors, currentUcb1Index, portfolioPullAdmitted, runSelectorSimulation, SERVING_SELECTOR } from './simulator';
import { verifyFrozenBenchmarkVersions } from '../benchmarkPreregV1';
import { AUTONOMOUS_QUERY_AUTHORITY_POLICY_VERSION } from '../autonomousQueryAuthority';
import { CANDIDATE_TRIAGE_POLICY_VERSION } from '../candidateTriage';
import type { SelectorCandidate, SelectorContext, QueryAdmission, QuerySource } from './types';
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

test('Q0: curated country-knowledge terms stay searchable and PROVEN across refresh', () => {
  // `Börsenanalyse` is curated country knowledge, not a phrase from the global
  // or language packs. It must not be demoted on the next lifecycle refresh.
  const gate = isSearchableTradingTerm({
    term: 'Börsenanalyse',
    termType: 'TERMINOLOGY',
    country: 'Germany',
    language: 'de',
  });
  assert.equal(gate.eligible, true);
  const decision = decideLifecycle({
    current: 'PROVEN_SEARCH_TERM',
    decayedEvidence: 10,
    distinctCreators: 5,
    distinctCommunities: 3,
    executions: 6,
    decayedYield: 0.6,
    termType: 'TERMINOLOGY',
    term: 'Börsenanalyse',
    country: 'Germany',
    language: 'de',
  });
  assert.equal(decision.status, 'PROVEN_SEARCH_TERM');
  assert.equal(decision.searchEligible, true);
});

test('Q0: Common-script letters in Japanese terms do not fail the script gate', () => {
  // U+30FC (katakana-hiragana prolonged sound mark) is a Common-script letter.
  // Mapping it to Zzzz made every term containing it script-incompatible and
  // stripped already-learned Japanese terms of search eligibility.
  for (const term of ['トレード', 'デイトレード', 'オーダーフロー']) {
    const gate = isSearchableTradingTerm({ term, termType: 'TERMINOLOGY', country: 'Japan', language: 'ja' });
    assert.equal(gate.eligible, true, `${term}: ${gate.reasons.join(', ')}`);
  }
  // The same German/English vocabulary remains ineligible for Japan: country
  // knowledge is language-scoped, not flattened into a global semantic set.
  const wrongLanguage = isSearchableTradingTerm({ term: 'Börsenanalyse', termType: 'TERMINOLOGY', country: 'Japan', language: 'ja' });
  assert.ok(wrongLanguage.reasons.includes('no-trading-semantics'));
});

test('Q2: reviewed English liquidity-zone phrases keep search eligibility', () => {
  // These are governed reviewed phrases that are absent from the global lists
  // and language packs; dropping them evicted already-learned terms.
  for (const term of ['liquidity zone', 'liquidity zones']) {
    const gate = isSearchableTradingTerm({ term, termType: 'TERMINOLOGY', country: 'United States', language: 'en' });
    assert.equal(gate.eligible, true, `${term}: ${gate.reasons.join(', ')}`);
  }
  // English phrases stay admissible as the universal retrieval language.
  const noDeclaredLanguage = isSearchableTradingTerm({ term: 'liquidity zones', termType: 'TERMINOLOGY', country: 'Germany' });
  assert.equal(noDeclaredLanguage.eligible, true, noDeclaredLanguage.reasons.join(', '));
});

test('Q2: legacy compound rows are admitted on the full query, not the bare primary term', () => {
  // A pre-admission row carries its trading context in `query`; judging the
  // bare `primary_term` made `CAC 40 trading` speculative and got it rejected
  // at run time.
  const decision = admitQueryRecord({
    query: 'CAC 40 trading',
    country: 'France',
    primary_term: 'CAC 40',
    generation_metadata: {},
  });
  assert.equal(decision.eligible, true);
  assert.notEqual(decision.admission.tier, 'SPECULATIVE');
});

test('Q2: legacy rows longer than three query tokens keep admission within a bounded limit', () => {
  // The compatibility atom is the whole stored query, not a normal atom. The
  // 3-token atom ceiling must not reject every pre-admission row of four or
  // more words when the query itself carries governed trading semantics.
  const legacy = admitQueryRecord({
    query: 'CAC 40 trading pour débutants',
    country: 'France',
    primary_term: 'CAC 40',
    generation_metadata: {},
  });
  assert.equal(legacy.eligible, true, legacy.reasonCodes.join(','));
  assert.ok(!legacy.reasonCodes.includes('TOO_MANY_TOKENS'));
  assert.ok(!legacy.reasonCodes.includes('TERM_TOO_MANY_TOKENS'));

  // The bridge is still bounded: an arbitrarily long legacy query fails.
  const overlong = admitQueryRecord({
    query: 'CAC 40 trading pour les débutants français en bourse aujourd hui',
    country: 'France',
    primary_term: 'CAC 40',
    generation_metadata: {},
  });
  assert.equal(overlong.eligible, false);
  assert.ok(overlong.reasonCodes.includes('TERM_TOO_MANY_TOKENS'));
});

test('Q2: producer provenance cannot opt into the legacy token allowance', () => {
  // `origin` is free-form producer metadata. Only the zero-atom compatibility
  // fallback may claim LEGACY_COMPATIBILITY; a normal atom that supplies it
  // must still obey the three-token composition limit.
  const forged = admitQueryRecord({
    query: 'CAC 40 trading pour débutants',
    country: 'France',
    primary_term: 'CAC 40',
    generation_metadata: {
      atoms: [{ term: 'CAC 40 trading pour débutants', role: 'ANCHOR', type: 'TERMINOLOGY', origin: 'LEGACY_COMPATIBILITY' }],
    },
  });
  assert.equal(forged.eligible, false);
  assert.ok(forged.reasonCodes.includes('TOO_MANY_TOKENS'));
});

test('Q2: a mixed candidate cannot borrow the legacy composition limit', () => {
  const mixed = buildQueryCandidate({
    query: 'CAC 40 trading pour débutants bourse',
    country: 'France',
    atoms: [
      { term: 'CAC 40 trading pour débutants', role: 'ANCHOR', type: 'TERMINOLOGY', provenance: 'LEGACY_COMPATIBILITY' },
      { term: 'bourse', role: 'MODIFIER', type: 'TERMINOLOGY', provenance: 'CURATED' },
    ],
    source: 'CURATED',
  });
  const decision = evaluateQueryComposition(mixed);
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasonCodes.includes('TOO_MANY_TOKENS'));
});

test('Q2: every planned query for all production countries is admitted', () => {
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
    assert.ok(planned.length > 0, `${country} produced no planned queries`);
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
  assert.ok(total >= 123, `expected at least the previous planner inventory, got ${total}`);
  assert.equal(admitted, total);
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

const candidate = (id: number, family: string, runs = 3, confirmed = 1, timesExecuted = 0): SelectorCandidate => ({
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
  timesExecuted,
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

test('Q4: exhausted portfolio budget cannot be exceeded by coverage or cold-start branches', () => {
  const cold = candidate(1, 'family:A', 0, 0);
  const coverageDebt = { coverageCells: ['de', 'de-new'], coveredCells: ['de'] };
  const exhausted = selectHierarchicalUcb([cold], selectorContext({ portfolioUnitsUsed: 15, ...coverageDebt }));
  assert.equal(exhausted.strategy, 'NO_ELIGIBLE_QUERY');
  assert.equal(exhausted.queryId, null);
  assert.ok(exhausted.reasonCodes.includes('PORTFOLIO_BUDGET_EXHAUSTED'));
  assert.ok(exhausted.reasonCodes.includes('FAIL_CLOSED'));

  const coldStartExhausted = selectHierarchicalUcb([cold], selectorContext({ portfolioUnitsUsed: 15 }));
  assert.equal(coldStartExhausted.strategy, 'NO_ELIGIBLE_QUERY');
  assert.ok(coldStartExhausted.reasonCodes.includes('PORTFOLIO_BUDGET_EXHAUSTED'));

  const remaining = selectHierarchicalUcb([cold], selectorContext({ portfolioUnitsUsed: 14, ...coverageDebt }));
  assert.equal(remaining.strategy, 'UCB_PORTFOLIO');
  assert.ok(remaining.queryId);
});

test('Q4: exhausted official budget permits quota-free exploration when the registry offers InnerTube', () => {
  const cold = [candidate(1, 'family:A', 0, 0), candidate(2, 'family:B', 0, 0)];
  const first = selectHierarchicalUcb(cold, selectorContext({
    portfolioUnitsUsed: 15,
    quotaFreeProviderAvailable: true,
  }));
  assert.equal(first.strategy, 'UCB_PORTFOLIO');
  assert.ok(first.queryId);
  assert.ok(first.reasonCodes.includes('QUOTA_FREE_EXPLORATION'));
  assert.ok(first.reasonCodes.includes('MINIMUM_SAMPLE_NOT_MET'));
  assert.ok(!first.reasonCodes.includes('PORTFOLIO_BUDGET_EXHAUSTED'));
  assert.match(first.reason, /Quota-free provider capacity/);

  // Deterministic: the same exhausted-budget pool and capability always yield
  // the same immature arm. The lifetime execution count is only a diversity
  // counter here, never a random or recency fallback.
  const second = selectHierarchicalUcb(cold, selectorContext({
    portfolioUnitsUsed: 15,
    quotaFreeProviderAvailable: true,
  }));
  assert.deepEqual(first, second);

  // A mature arm still exploits even though the official floor is exhausted;
  // the free path only replaces the fail-closed immature branch.
  const mature = selectHierarchicalUcb([candidate(3, 'family:A', 4, 4)], selectorContext({
    portfolioUnitsUsed: 15,
    quotaFreeProviderAvailable: true,
  }));
  assert.equal(mature.strategy, 'UCB_EXPLOITATION');
  assert.ok(mature.reasonCodes.includes('MATURE_SAMPLE'));
});

test('Q4: quota-free exploration rotates to the least-attempted immature arm', () => {
  const context = selectorContext({
    portfolioUnitsUsed: 15,
    quotaFreeProviderAvailable: true,
  });
  const first = selectHierarchicalUcb([
    candidate(1, 'family:A', 0, 0, 0),
    candidate(2, 'family:B', 0, 0, 0),
  ], context);
  assert.equal(first.queryId, 1);

  // Completing the free run leaves counts.runs unchanged (zero-quota runs are
  // excluded from maturity), but advances the lifetime execution counter. The
  // next free decision must move to the other immature arm instead of
  // repeating the same dud after cooldown.
  const second = selectHierarchicalUcb([
    candidate(1, 'family:A', 0, 0, 1),
    candidate(2, 'family:B', 0, 0, 0),
  ], context);
  assert.equal(second.queryId, 2);
  assert.ok(second.reasonCodes.includes('QUOTA_FREE_EXPLORATION'));
});

test('Q4: exhausted official budget blocks exploration when only paid/official providers exist', () => {
  const cold = candidate(1, 'family:A', 0, 0);
  const paidOnly = selectHierarchicalUcb([cold], selectorContext({
    portfolioUnitsUsed: 15,
    quotaFreeProviderAvailable: false,
  }));
  assert.equal(paidOnly.strategy, 'NO_ELIGIBLE_QUERY');
  assert.equal(paidOnly.queryId, null);
  assert.ok(paidOnly.reasonCodes.includes('PORTFOLIO_BUDGET_EXHAUSTED'));
  assert.ok(paidOnly.reasonCodes.includes('NO_QUOTA_FREE_PROVIDER'));
  assert.ok(paidOnly.reasonCodes.includes('FAIL_CLOSED'));
  assert.ok(!paidOnly.reasonCodes.includes('QUOTA_FREE_EXPLORATION'));

  // The optional capability defaults to false for callers that cannot prove a
  // registry-backed free provider, preserving the old fail-closed contract.
  const unknown = selectHierarchicalUcb([cold], selectorContext({ portfolioUnitsUsed: 15 }));
  assert.equal(unknown.strategy, 'NO_ELIGIBLE_QUERY');
  assert.ok(unknown.reasonCodes.includes('PORTFOLIO_BUDGET_EXHAUSTED'));
});

test('Q4: zero-quota free-provider runs cannot mature an arm or supply reward', () => {
  // The decayed-count SQL excludes zero-quota runs entirely, so a free-only
  // arm has no maturity sample. Selection must still treat it as immature even
  // when quota-free exploration is available.
  const freeOnlyHistory = {
    ...candidate(1, 'family:A'),
    counts: { confirmed: 5, quality: 4, quotaUnits: 0, runs: 0 },
  };
  const decision = selectHierarchicalUcb([freeOnlyHistory], selectorContext({
    portfolioUnitsUsed: 15,
    quotaFreeProviderAvailable: true,
  }));
  assert.ok(decision.reasonCodes.includes('QUOTA_FREE_EXPLORATION'));
  assert.ok(decision.reasonCodes.includes('MINIMUM_SAMPLE_NOT_MET'));
  assert.ok(!decision.reasonCodes.includes('MATURE_SAMPLE'));

  // A zero-quota run cannot contribute creators to a per-100-quota reward it
  // never paid for.
  const reward = rewardRate(buildQueryQualityVector({
    rawResults: 8, distinctResults: 8, newConfirmedCreators: 8, quotaUsed: 0,
  }));
  assert.equal(reward.eligible, false);
  assert.ok(reward.reasonCodes.includes('ZERO_QUOTA_EXCLUDED'));
  assert.equal(reward.rate, 0);

  const dbCore = readFileSync(join(__dirname, '..', 'dbCore.ts'), 'utf8');
  assert.match(dbCore, /AND GREATEST\(0,qr\.quota_used\)>0/);
});

test('Q4: quota-free capability is derived from the allocation provider registry, not a stale flag', () => {
  // Only the exact row shape ordinary allocation can select grants capacity.
  assert.equal(isQuotaFreeSearchProviderRow({
    mode: 'ACTIVE',
    quota_domain: 'YOUTUBE_INNERTUBE_FREE',
    capabilities: ['SEARCH_YOUTUBE'],
  }), true);
  assert.equal(isQuotaFreeSearchProviderRow({
    mode: 'ACTIVE',
    quota_domain: 'YOUTUBE_INNERTUBE_FREE',
    capabilities: '["SEARCH_YOUTUBE"]',
  }), true);
  assert.equal(isQuotaFreeSearchProviderRow({
    mode: 'ACTIVE',
    quota_domain: 'YOUTUBE_DATA_API',
    capabilities: ['SEARCH_YOUTUBE'],
  }), false);
  assert.equal(isQuotaFreeSearchProviderRow({
    mode: 'PAUSED',
    quota_domain: 'YOUTUBE_INNERTUBE_FREE',
    capabilities: ['SEARCH_YOUTUBE'],
  }), false);
  assert.equal(isQuotaFreeSearchProviderRow({
    mode: 'ACTIVE',
    quota_domain: 'YOUTUBE_INNERTUBE_FREE',
    capabilities: ['SEARCH_BRAVE_DIRECT'],
  }), false);

  const dbCore = readFileSync(join(__dirname, '..', 'dbCore.ts'), 'utf8');
  const helperStart = dbCore.indexOf('export async function isQuotaFreeProviderAvailable');
  const helperEnd = dbCore.indexOf('export async function reservePortfolioContinuationPage', helperStart);
  assert.ok(helperStart > 0 && helperEnd > helperStart);
  const helper = dbCore.slice(helperStart, helperEnd);
  assert.match(helper, /FROM discovery_provider_registry/);
  assert.match(helper, /mode='ACTIVE'/);
  assert.match(helper, /capabilities \? 'SEARCH_YOUTUBE'/);
  assert.match(helper, /isQuotaFreeSearchProviderRow/);
  // Neither configuration env nor the execution-time free-run flag may stand
  // in for an actual ACTIVE registry row.
  assert.doesNotMatch(helper, /process\.env/);
  assert.doesNotMatch(helper, /quotaFreeInnertubeProvider/);

  const intelligence = readFileSync(join(__dirname, '..', 'queryIntelligence.ts'), 'utf8');
  assert.match(intelligence, /isQuotaFreeProviderAvailable\(\)/);
  assert.match(intelligence, /quotaFreeProviderAvailable,/);
});

test('Q4: quota-free selection carries a scheduling requirement that cannot fall back to official', () => {
  const official = {
    provider_key: 'youtube-search', mode: 'ACTIVE',
    quota_domain: 'YOUTUBE_DATA_API', capabilities: ['SEARCH_YOUTUBE'],
  };
  const free = {
    provider_key: 'youtube-innertube', mode: 'ACTIVE',
    quota_domain: 'YOUTUBE_INNERTUBE_FREE', capabilities: ['SEARCH_YOUTUBE'],
  };
  // The scheduler's rotation pool must contain only free capacity when the
  // decision required it; a paid-only pool yields nothing and must fail closed.
  assert.deepEqual(quotaFreeSearchProviderRows([official, free]).map(row => row.provider_key), ['youtube-innertube']);
  assert.deepEqual(quotaFreeSearchProviderRows([official]), []);

  const intelligence = readFileSync(join(__dirname, '..', 'queryIntelligence.ts'), 'utf8');
  assert.match(intelligence, /quotaFreeRequired: selector\.reasonCodes\.includes\('QUOTA_FREE_EXPLORATION'\)/);

  const discovery = readFileSync(join(__dirname, '..', 'autonomousDiscovery.ts'), 'utf8');
  assert.match(discovery, /quotaFreeRequired: selected\.quotaFreeRequired === true/);

  // The experiment wrapper reconstructs serving-selector results for its
  // control arm and both fallbacks. Every reconstruction must carry the
  // scheduling requirement, otherwise an exhausted-portfolio control run
  // would rotate back to the official provider.
  const experiments = readFileSync(join(__dirname, '..', 'querySelectionExperiments.ts'), 'utf8');
  assert.match(experiments, /quotaFreeRequired\?: boolean;/);
  assert.equal((experiments.match(/quotaFreeRequired: base\.quotaFreeRequired/g) || []).length, 3);

  const dbCore = readFileSync(join(__dirname, '..', 'dbCore.ts'), 'utf8');
  assert.match(dbCore, /const allocationRows = candidate\.quotaFreeRequired/);
  assert.match(dbCore, /quotaFreeSearchProviderRows\(rotationRes\.rows\)/);
  assert.match(dbCore, /QUOTA_FREE_PROVIDER_UNAVAILABLE/);
  assert.match(dbCore, /QUOTA_FREE_PROVIDER_REQUIRED/);
  assert.match(dbCore, /QUOTA_FREE_PROVIDER_CANNOT_SERVE_DATE_ORDERING/);
  // A quota-free ordering-window treatment cannot be served by InnerTube,
  // which ignores the job-payload window. Fail closed rather than persist a
  // treatment observation that executed unwindowed.
  assert.match(dbCore, /QUOTA_FREE_PROVIDER_CANNOT_SERVE_ORDERING_WINDOW/);
  assert.match(dbCore, /candidate\.experiment\?\.ordering\?\.arm === 'TREATMENT'[\s\S]{0,80}windowApplied/);
  // Quota-free draws are pinned to RELEVANCE before ordering allocation and
  // skip the canary treatment that could switch them to DATE; the DATE guard
  // remains only as fail-closed defence. The registry row must be the full
  // ACTIVE SEARCH_YOUTUBE free shape, not just any zero-cost domain.
  assert.match(dbCore, /const controlSearchOrdering: SearchOrdering = candidate\.quotaFreeRequired\s*\n\s*\? 'RELEVANCE'/);
  assert.match(dbCore, /candidate\.quotaFreeRequired\s*\n\s*\? \{ authorized: false, reason: 'QUOTA_FREE_EXPLORATION_RELEVANCE_ONLY' \}/);
  assert.match(dbCore, /eligibleProvider\.rows\[0\]\?\.mode !== 'ACTIVE'/);
  // A normal (non-required) allocation keeps its historical fail-open default
  // only; a required free allocation never falls back to official.
  assert.match(dbCore, /if \(candidate\.quotaFreeRequired\) await failStep\('quota_free_provider_allocation', error\);/);
});

test('Q4: a mature proven pool exploits even while portfolio budget remains', () => {
  // Production never supplies attestations, so the old `tier !== ATTESTED_EXACT`
  // test put every mature query in the portfolio pool and let high-variance
  // arms win indefinitely. Mature arms without coverage debt must exploit.
  const mature = [candidate(1, 'family:A', 4, 4), candidate(2, 'family:B', 4, 2)];
  const decision = selectHierarchicalUcb(mature, selectorContext({
    portfolioUnitsUsed: 0,
    coverageCells: ['Germany|de|DE_EQUITIES|family:A'],
    coveredCells: ['Germany|de|DE_EQUITIES|family:A'],
  }));
  assert.equal(decision.strategy, 'UCB_EXPLOITATION');
  assert.ok(decision.queryId);

  // Coverage debt is still an explicit portfolio reason, even for a mature arm:
  // the arm occupying the uncovered cell remains portfolio-eligible.
  const coverageDebt = selectHierarchicalUcb([candidate(1, 'family:B', 4, 4)], selectorContext({
    portfolioUnitsUsed: 0,
    coverageCells: ['Germany|de|DE_EQUITIES|family:B'],
    coveredCells: ['Germany|de|DE_EQUITIES|family:A'],
  }));
  assert.equal(coverageDebt.strategy, 'UCB_PORTFOLIO');
});

test('Q4: share caps are achievable for homogeneous and balanced pools', () => {
  const sourced = (id: number, family: string, source: QuerySource) => {
    const base = candidate(id, family);
    return { ...base, admission: { ...base.admission!, source } };
  };

  // A single family/source has a 1.0 share; the configured caps must not turn
  // that into a permanent NO_ELIGIBLE_QUERY.
  const singleFamily = selectHierarchicalUcb([sourced(1, 'family:A', 'CURATED')], selectorContext({
    familyShare: { 'family:A': 1 },
    sourceShare: { CURATED: 1 },
  }));
  assert.equal(singleFamily.strategy, 'UCB_EXPLOITATION');
  assert.equal(singleFamily.queryId, 1);

  // Two families at exactly 50/50 are at the effective cap, not over it.
  const balanced = selectHierarchicalUcb([sourced(1, 'family:A', 'CURATED'), sourced(2, 'family:B', 'CURATED')], selectorContext({
    familyShare: { 'family:A': 0.5, 'family:B': 0.5 },
    sourceShare: { CURATED: 1 },
  }));
  assert.ok(balanced.queryId, 'a balanced two-family pool must still select');

  // A genuinely dominant family remains capped when a viable alternative
  // exists, so the fix does not silently disable diversity.
  const dominant = selectHierarchicalUcb([sourced(1, 'family:A', 'CURATED'), sourced(2, 'family:B', 'CURATED')], selectorContext({
    familyShare: { 'family:A': 0.9, 'family:B': 0.1 },
    sourceShare: { CURATED: 1 },
  }));
  assert.equal(dominant.queryId, 2, 'the uncapped alternative family is selected');

  // L-shaped split (family A source X, family A source Y, family B source X):
  // every candidate is over one cap, but selection relaxes the weakest cap
  // instead of halting forever.
  const lShape = selectHierarchicalUcb([
    sourced(1, 'family:A', 'CURATED'),
    sourced(2, 'family:A', 'LEARNED_TERMINOLOGY'),
    sourced(3, 'family:B', 'CURATED'),
  ], selectorContext({
    familyShare: { 'family:A': 0.7, 'family:B': 0.3 },
    sourceShare: { CURATED: 0.7, LEARNED_TERMINOLOGY: 0.3 },
  }));
  assert.equal(lShape.strategy, 'UCB_EXPLOITATION');
  assert.equal(lShape.queryId, 2, 'the only candidate under the source cap is selected');
});

test('Q4: hierarchy pools history from rows that are not executable this call', () => {
  const target = { ...candidate(9, 'family:A', 0, 0), counts: { confirmed: 0, quality: 0, quotaUnits: 0, runs: 0 } };
  // A sibling from the same family/country/market/language ran well but is
  // cooling down, so it is absent from the executable candidate set.
  const sibling = {
    ...candidate(8, 'family:A', 4, 4),
    counts: { confirmed: 4, quality: 2, quotaUnits: 2, runs: 4 },
  };
  const prior = { mean: 0.05, strength: 2 };
  const hierarchy = buildHierarchy([target, sibling]);
  const withHistory = selectHierarchicalUcb([target], selectorContext({
    prior,
    hierarchy,
    portfolioUnitsUsed: 0,
  }));
  const withoutHistory = selectHierarchicalUcb([target], selectorContext({
    prior,
    portfolioUnitsUsed: 0,
  }));
  assert.ok(withHistory.posterior);
  assert.ok(withoutHistory.posterior);
  assert.ok(
    withHistory.posterior.mean > withoutHistory.posterior.mean + 0.5,
    'the sibling family history must inform the new surface prior',
  );
  // The candidate's own counts are removed from each stratum, so history
  // belongs to the rest of the accounting window, not to the arm itself.
  const expected = computePosterior(target.counts, prior, {
    total: sibling.counts,
    family: sibling.counts,
    country: sibling.counts,
    market: sibling.counts,
    language: sibling.counts,
  }, SELECTOR_C, 4);
  assert.ok(Math.abs(withHistory.posterior.mean - expected.mean) < 1e-12);
});

test('Q5: zero-quota runs are excluded from the promotion denominator', () => {
  assert.equal(isRewardEligibleQuota(0), false);
  assert.equal(isRewardEligibleQuota(0.5), true);
  assert.equal(isRewardEligibleQuota(Number.NaN), false);
});

test('Q3: derived consecutive failures drive lifecycle backoff; provider failures are exempt', () => {
  const now = new Date('2026-01-01T00:20:00.000Z');
  const failed = (completedAt: string, failureKind: string) => ({ status: 'FAILED', completedAt, failureKind });
  const state = deriveQueryFailureState([
    failed('2026-01-01T00:10:00.000Z', 'INVALID_QUERY'),
    failed('2026-01-01T00:05:00.000Z', 'INVALID_QUERY'),
    { status: 'COMPLETED', completedAt: '2026-01-01T00:00:00.000Z', failureKind: null },
  ], now);
  assert.equal(state.consecutiveFailures, 2);
  assert.equal(state.backoffUntil, '2026-01-01T00:25:00.000Z');
  const blocked = isQuerySelectable({
    record: { id: 1, query: 'q', collection: 'EXPERIMENTAL', status: 'ACTIVE', last_executed: null },
    now: now.toISOString(),
    cooldownMinutes: 0,
    consecutiveFailures: state.consecutiveFailures,
    backoffUntil: state.backoffUntil,
  });
  assert.ok(blocked.reasonCodes.includes('FAILURE_BACKOFF_ACTIVE'));

  // Three or more failures are a timed backoff, not a permanent ban: once the
  // persisted backoff ends the query is selectable again and can reset its
  // streak with a successful run.
  const recovered = isQuerySelectable({
    record: { id: 1, query: 'q', collection: 'EXPERIMENTAL', status: 'ACTIVE', last_executed: null },
    now: '2026-01-01T00:25:01.000Z',
    cooldownMinutes: 0,
    consecutiveFailures: 5,
    backoffUntil: '2026-01-01T00:25:00.000Z',
  });
  assert.equal(recovered.selectable, true);
  assert.deepEqual(recovered.reasonCodes, []);

  assert.deepEqual(deriveQueryFailureState([
    failed('2026-01-01T00:10:00.000Z', 'PROVIDER_FAILURE'),
    failed('2026-01-01T00:05:00.000Z', 'INVALID_QUERY'),
  ], now), { consecutiveFailures: 0, backoffUntil: null });
  // A vanished job row is orchestration state, not query-quality evidence.
  assert.deepEqual(deriveQueryFailureState([
    failed('2026-01-01T00:10:00.000Z', 'ORPHANED_FAILED_JOB_STATE'),
    failed('2026-01-01T00:05:00.000Z', 'INVALID_QUERY'),
  ], now), { consecutiveFailures: 0, backoffUntil: null });
  // A completed job that lost its finalizer is the same operational class.
  assert.deepEqual(deriveQueryFailureState([
    failed('2026-01-01T00:10:00.000Z', 'ORPHANED_COMPLETED_JOB_STATE'),
    failed('2026-01-01T00:05:00.000Z', 'INVALID_QUERY'),
  ], now), { consecutiveFailures: 0, backoffUntil: null });
  assert.deepEqual(deriveQueryFailureState([
    { status: 'COMPLETED', completedAt: '2026-01-01T00:10:00.000Z', failureKind: null },
    failed('2026-01-01T00:05:00.000Z', 'INVALID_QUERY'),
  ], now), { consecutiveFailures: 0, backoffUntil: null });
  assert.deepEqual(deriveQueryFailureState([
    failed('2026-01-01T00:10:00.000Z', 'INVALID_QUERY'),
    failed('2026-01-01T00:05:00.000Z', 'INVALID_QUERY'),
    failed('2026-01-01T00:00:00.000Z', 'INVALID_QUERY'),
  ], now), { consecutiveFailures: 3, backoffUntil: '2026-01-01T00:25:00.000Z' });

  const exhausted = isQuerySelectable({
    record: { id: 1, query: 'q', collection: 'EXPERIMENTAL', status: 'ACTIVE', last_executed: null },
    now: now.toISOString(),
    cooldownMinutes: 0,
    consecutiveFailures: 3,
    backoffUntil: '2026-01-01T00:25:00.000Z',
  });
  assert.ok(exhausted.reasonCodes.includes('FAILURE_BACKOFF_ACTIVE'));
  assert.ok(!exhausted.reasonCodes.includes('REPEATED_FAILURE_BACKOFF'));
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
  // The reservation SQL refuses a query with an active run. The selector must
  // apply the same hard gate or it repeatedly selects an unreservable query.
  const active = isQuerySelectable({
    record: base,
    now: '2026-01-01T00:00:00.000Z',
    cooldownMinutes: 0,
    activeRunCount: 1,
  });
  assert.equal(active.selectable, false);
  assert.ok(active.reasonCodes.includes('ACTIVE_RUN_EXISTS'));
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
  // Deferred results were never evaluated and must not dilute the duplicate
  // share: 5 duplicates of 15 evaluated results, not of 20 raw results.
  const deferred = buildQueryQualityVector({
    rawResults: 20,
    distinctResults: 10,
    duplicateResults: 5,
    newChannels: 7,
    newConfirmedCreators: 3,
    newQualityCreators: 2,
    quotaUsed: 200,
  });
  assert.equal(deferred.duplicateRatio, 5 / 15);
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
  assert.equal(dashboard.totals.targetMarketPrecision, 1);
});

test('Q6: a selected country reports its own spend without replacing the shared budget decision', () => {
  const shared = buildQueryQualityDashboard({
    generatedAt: '2026-01-01T00:00:00.000Z',
    portfolio: { dailyQuotaUnits: 100, portfolioUnitsReserved: 15, portfolioUnitsUsed: 20, countryUnitsUsed: 2 },
    rows: [],
  });
  // The shared reservation is authoritative: other countries already spent
  // past it even though this country only used 2 units.
  assert.equal(shared.portfolio.portfolioUnitsUsed, 20);
  assert.equal(shared.portfolio.countryUnitsUsed, 2);
  assert.equal(shared.portfolio.withinBudget, false);

  const withoutCountry = buildQueryQualityDashboard({
    generatedAt: '2026-01-01T00:00:00.000Z',
    portfolio: { dailyQuotaUnits: 100, portfolioUnitsReserved: 15, portfolioUnitsUsed: 2 },
    rows: [],
  });
  assert.equal(withoutCountry.portfolio.countryUnitsUsed, null);
  assert.equal(withoutCountry.portfolio.withinBudget, true);
});

test('Q6: unmeasured market/language metrics report unknown, never 100%', () => {
  const vector = buildQueryQualityVector({
    rawResults: 10, distinctResults: 10, newChannels: 4, newConfirmedCreators: 2,
    newQualityCreators: 1, quotaUsed: 100,
  });
  assert.equal(vector.targetMarketPrecision, null);
  assert.equal(vector.languageMatchRate, null);
  const dashboard = buildQueryQualityDashboard({
    generatedAt: '2026-01-01T00:00:00.000Z',
    portfolio: { dailyQuotaUnits: 100, portfolioUnitsReserved: 15, portfolioUnitsUsed: 12 },
    rows: [{
      runId: 'run-unmeasured', queryId: 1, query: 'day trading', country: 'Germany', status: 'COMPLETED',
      selectionStrategy: 'UCB_EXPLOITATION', selectionReason: 'selected', quotaUsed: 100,
      completedAt: '2026-01-01T00:00:00.000Z', qualityVector: vector, admission: null,
    }],
  });
  assert.equal(dashboard.totals.targetMarketPrecision, null);
});

test('Q6: zero-quota runs are separate, stop coverage is completed-only, compatibility markers are not rejections', () => {
  const zeroQuota = buildQueryQualityVector({
    rawResults: 5, distinctResults: 5, newChannels: 2, newConfirmedCreators: 2,
    newQualityCreators: 1, quotaUsed: 0,
  });
  const healthy = buildQueryQualityVector({
    rawResults: 10, distinctResults: 10, newChannels: 2, newConfirmedCreators: 1,
    newQualityCreators: 1, quotaUsed: 100,
  });
  const dashboard = buildQueryQualityDashboard({
    generatedAt: '2026-01-01T00:00:00.000Z',
    portfolio: { dailyQuotaUnits: 100, portfolioUnitsReserved: 15, portfolioUnitsUsed: 1 },
    rows: [
      { runId: 'zero', queryId: 1, query: 'free query', country: 'Germany', status: 'COMPLETED', selectionStrategy: 'COLD_START_GENERATION', selectionReason: 'selected', stopReason: 'MAX_PAGES_REACHED', quotaUsed: 0, qualityVector: zeroQuota },
      { runId: 'healthy', queryId: 2, query: 'day trading', country: 'Germany', status: 'COMPLETED', selectionStrategy: 'UCB_EXPLOITATION', selectionReason: 'selected', stopReason: 'MAX_PAGES_REACHED', quotaUsed: 100, qualityVector: healthy, admission: { eligible: true, reasonCodes: [], tier: 'LICENSED_UNSEEN' } },
      { runId: 'marker', queryId: 3, query: 'legacy', country: 'Germany', status: 'COMPLETED', selectionStrategy: 'UCB_EXPLOITATION', selectionReason: 'selected', quotaUsed: 100, qualityVector: null, admission: { eligible: false, reasonCodes: ['LEGACY_UNSCOPED_ADMISSION_COMPATIBILITY'] } },
      { runId: 'rejected', queryId: 4, query: 'CAC 40', country: 'Germany', status: 'COMPLETED', selectionStrategy: 'UCB_EXPLOITATION', selectionReason: 'selected', stopReason: 'COUNTRY_REJECTED', quotaUsed: 100, qualityVector: null, admission: { eligible: false, reasonCodes: ['SPECULATIVE_EVIDENCE_ONLY', 'LEGACY_UNSCOPED_ADMISSION_COMPATIBILITY'] } },
      // A pending row can carry a stale stop reason; coverage is over completed rows only.
      { runId: 'pending', queryId: 5, query: 'pending', country: 'Germany', status: 'RUNNING', selectionStrategy: 'UCB_PORTFOLIO', selectionReason: 'selected', stopReason: 'MAX_PAGES_REACHED', quotaUsed: 0, qualityVector: null },
    ],
  });
  assert.equal(dashboard.totals.accountedRuns, 2);
  assert.equal(dashboard.totals.rewardEligibleRuns, 1);
  assert.equal(dashboard.totals.zeroQuotaRuns, 1);
  assert.equal(dashboard.totals.newConfirmedCreators, 1);
  assert.equal(dashboard.totals.zeroQuotaNewConfirmedCreators, 2);
  assert.equal(dashboard.totals.zeroQuotaNewQualityCreators, 1);
  assert.equal(dashboard.totals.quotaUnits, 1);
  assert.equal(dashboard.selection.stopReasons.find(item => item.reason === 'MAX_PAGES_REACHED')?.count, 2);
  assert.equal(dashboard.selection.stopReasons.find(item => item.reason === 'COUNTRY_REJECTED')?.count, 1);
  assert.equal(dashboard.selection.stopReasonCoverage, 3 / 4);
  assert.deepEqual(dashboard.selection.admissionRejections, [{ reason: 'SPECULATIVE_EVIDENCE_ONLY', count: 1 }]);
});

test('Q8: frozen benchmark guard requires authority v3 and triage v5, rejects older drift', () => {
  assert.equal(AUTONOMOUS_QUERY_AUTHORITY_POLICY_VERSION, 'autonomous-query-authority-v3');
  assert.equal(CANDIDATE_TRIAGE_POLICY_VERSION, 'candidate-triage-v5-latin-market-finance');
  assert.doesNotThrow(() => verifyFrozenBenchmarkVersions());
  assert.throws(
    () => verifyFrozenBenchmarkVersions({ candidateTriage: 'candidate-triage-v4-contextual-admission' }),
    /BENCHMARK_PREREG_VERSION_DRIFT: .*candidateTriage/,
  );
  assert.throws(
    () => verifyFrozenBenchmarkVersions({ autonomousQueryAuthority: 'autonomous-query-authority-v2' }),
    /BENCHMARK_PREREG_VERSION_DRIFT: .*autonomousQueryAuthority/,
  );
});

test('Q5/Q6: production wiring uses accounting-window spend, derived failure state and run-level reward', () => {
  const intelligence = readFileSync(join(__dirname, '..', 'queryIntelligence.ts'), 'utf8');
  assert.match(intelligence, /getQueryQuotaSpendRows\(country\)/);
  assert.match(intelligence, /getQueryFailureStates\(country\)/);
  // A failed terminal run can still retain quota_reserved/quota_used. Both
  // spend reads must include it or the selector can re-spend consumed budget.
  const dbCore = readFileSync(join(__dirname, '..', 'dbCore.ts'), 'utf8');
  const spendQuery = dbCore.slice(
    dbCore.indexOf('export async function getQueryQuotaSpendRows'),
    dbCore.indexOf('/** In-flight (scheduled/running/retrying) uses per primary term. */'),
  );
  assert.match(spendQuery, /status IN \('SCHEDULED','RUNNING','RETRYING','COMPLETED','FAILED'\)/);
  assert.match(dbCore, /const PORTFOLIO_UNITS_SQL=.*status IN \('SCHEDULED','RUNNING','RETRYING','COMPLETED','FAILED'\)/);
  // The shared fragment must not contain a statement terminator: the
  // country-scoped caller appends " AND ..." to it, so an embedded ";" would
  // produce invalid SQL (the ";" after the template literal is TS syntax).
  assert.doesNotMatch(dbCore, /PORTFOLIO_UNITS_SQL=`[^`]*;/);
  assert.match(intelligence, /getQueryRunReward\(attribution\.queryRunId\)/);
  assert.match(intelligence, /consecutiveFailures: failure\?\.consecutiveFailures/);
  // Promotion and hierarchy learning use the same eligibility as serving and
  // the dashboard: zero-quota runs cannot supply samples or strata, and the
  // promotion prior must come from peers rather than the arm's own data.
  assert.match(intelligence, /isRewardEligibleQuota\(currentRun\.quotaUnits\)/);
  assert.match(intelligence, /getQueryQualityDecayedCounts\(country, undefined, DECAY_HALF_LIFE_DAYS\)/);
  assert.match(intelligence, /getQueryQualityDecayedCounts\(queryRecord\.country, undefined, DECAY_HALF_LIFE_DAYS\)/);
  assert.match(intelligence, /const prior = empiricalPrior\(peerArms/);
  const performanceSource = readFileSync(join(__dirname, '..', 'queryPerformance.ts'), 'utf8');
  assert.match(performanceSource, /providerRequestsFailed \|\| 0\) > 0/);
  assert.match(intelligence, /isCollectionChangeEligible\(attribution\)/);
  assert.match(intelligence, /buildHierarchy\(hierarchyCandidates\)/);
  assert.match(intelligence, /hierarchy,\n\s+coverageCells,/);
  // Share totals must be seeded from every query in the accounting window,
  // before the eligible-only candidate projection.
  const spendStart = intelligence.indexOf('Share accounting covers every query');
  const eligibleStart = intelligence.indexOf('for (const query of eligible) {');
  assert.ok(spendStart > 0);
  assert.ok(eligibleStart > spendStart);

  assert.match(dbCore, /selection_strategy IN \('UCB_PORTFOLIO','UCB1_EXPLORATION','COLD_START_GENERATION'\)/);
  assert.match(dbCore, /SELECT query,country,generation_metadata FROM query_library/);
  assert.match(dbCore, /\{history,now:new Date\(\)\.toISOString\(\)\}/);
  // Hot-path history is aggregated in SQL (one row per query), decayed there,
  // and can be narrowed to a single query id.
  assert.match(dbCore, /export async function getQueryQualityDecayedCounts/);
  assert.match(dbCore, /power\(0\.5::float8/);
  assert.match(dbCore, /GROUP BY qr\.query_id/);
  assert.match(dbCore, /\$3::int IS NULL OR qr\.query_id=\$3/);
  // The dashboard must use the configured bounded ratio, not a hard-coded 15%.
  assert.match(dbCore, /portfolioUnitsReserved:dailyQuotaUnits\*boundedPortfolioRatio\(configuredRatio\)/);
  // Measured target-market truth and an explicit unknown language metric.
  // The filter also requires persistence/novelty, so allow those predicates
  // before the target-market check instead of pinning the exact clause order.
  assert.match(dbCore, /COUNT\(DISTINCT s\.channel_id\) FILTER \(\s*WHERE s\.persisted AND NOT s\.was_known AND s\.country_outcome IN \('CONFIRMED','LIKELY'\)/);
  assert.match(dbCore, /languageMatchedConfirmed: null/);
  // Target-market precision is the explicit CONFIRMED/LIKELY sighting count;
  // unresolved creators must report 0%, not 100% by subtraction.
  assert.match(dbCore, /COUNT\(DISTINCT s\.channel_id\) FILTER \(\s*WHERE s\.persisted AND s\.country_outcome IN \('CONFIRMED','LIKELY'\)\)::int AS target_market_confirmed/);
  assert.match(dbCore, /targetMarketConfirmed: Number\(sightingTruth\.rows\[0\]\?\.target_market_confirmed \|\| 0\)/);
  // Portfolio spend is UTC-day scoped and includes active runs scheduled
  // before midnight; a completion qualifies even when the schedule did not.
  assert.match(dbCore, /scheduled_at>=\(date_trunc\('day',now\(\) AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC'\)/);
  assert.match(dbCore, /OR status IN \('SCHEDULED','RUNNING','RETRYING'\)/);
  assert.match(dbCore, /OR completed_at>=\(date_trunc\('day',now\(\) AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC'\)/);
  // Only the official Data API consumes quota units; InnerTube/YouTube.js are free.
  assert.match(dbCore, /costDomain==='YOUTUBE_DATA_API' \? 100 : 0/);
  // Reward is in-scope only: UNCERTAIN/no-country sightings may not earn
  // credit even when they pass the general funnel as TRADING_CONFIRMED.
  assert.ok(!dbCore.includes("country_outcome<>'REJECTED'"));
  assert.match(dbCore, /persisted AND NOT cs\.was_known AND cs\.country_outcome IN \('CONFIRMED','LIKELY'\) AND cs\.funnel_outcome='TRADING_CONFIRMED'/);
  assert.match(dbCore, /persisted AND NOT s\.was_known AND s\.country_outcome IN \('CONFIRMED','LIKELY'\) AND s\.funnel_outcome='TRADING_CONFIRMED'/);
  // Rate-limit-only recovered runs are partial retrievals too: only an absent
  // outcome (legacy) or an explicit SUCCESS outcome may enter reward history.
  assert.match(dbCore, /COALESCE\(qr\.performance_details->>'providerRunOutcome',''\) = '' OR qr\.performance_details->>'providerRunOutcome' LIKE 'SUCCESS%'/);
  assert.match(dbCore, /\(metrics\.providerRateLimited \|\| 0\) > 0/);

  const experiments = readFileSync(join(__dirname, '..', 'querySelectionExperiments.ts'), 'utf8');
  // The experiment pool obeys the exact execution-time authority gate, and it
  // is applied before intent rotation so a rejected treatment candidate cannot
  // consume the opportunity or silently fall back to control.
  const authorityIndex = experiments.indexOf('evaluateAutonomousQueryAuthority(query, {');
  const rotationIndex = experiments.indexOf('rotateAwayFromMostRecentIntent(eligible, queries)');
  assert.ok(authorityIndex >= 0, 'experiment pool must run the execution authority gate');
  assert.ok(rotationIndex > authorityIndex, 'authority gate must run before intent rotation');

  const persistentResearch = readFileSync(join(__dirname, '..', 'persistentResearch.ts'), 'utf8');
  assert.match(persistentResearch, /export async function rejectResearchAction/);
  assert.match(persistentResearch, /revalidateQueryRecordAdmission\(queryRecord/);
  // Rejection is owner-scoped so a stale caller cannot settle a reservation
  // that another worker now holds.
  assert.match(persistentResearch, /reserved_by=\$3/);
  assert.match(persistentResearch, /return \{actionId:action\.id,queryRecord,reservationOwner:owner\}/);

  const autonomousDiscovery = readFileSync(join(__dirname, '..', 'autonomousDiscovery.ts'), 'utf8');
  assert.match(autonomousDiscovery, /if \(research\) \{\s*await rejectResearchAction\(/);
  assert.match(autonomousDiscovery, /research\.reservationOwner/);

  const engine = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'QueryIntelligenceEngine.tsx'), 'utf8');
  assert.match(engine, /qualityDashboardError/);
  assert.match(engine, /setQualityDashboardError/);
  assert.match(engine, />\s*Retry\s*</);
  // One failed sibling projection must not discard a healthy quality response.
  assert.match(engine, /apiFetch\(qualityUrl\)\.catch\(\(\) => null\)/);

  const queueManager = readFileSync(join(__dirname, '..', 'queueManager.ts'), 'utf8');
  assert.match(queueManager, /queryRunId: args\.queryRunId,\s*persist: false/);
  // Continuation reservations use the same quota-domain test as scheduling.
  assert.match(queueManager, /reservePortfolioContinuationPage\(\{[\s\S]*?providerQuotaUnits: allocatedProvider\.costDomain==='YOUTUBE_DATA_API' \? 100 : 0/);
  // A failed continuation transaction rolls back the release issued through
  // that client, so the reservation must be released again independently.
  assert.match(queueManager, /if \(incPageReservationId && !continuationCommitted\) \{[\s\S]*?releaseIncrementalTreatmentPageReservation/);
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

test('Q6: dashboard slices to the row limit and reports truncation honestly', () => {
  const rows = Array.from({ length: QUERY_QUALITY_DASHBOARD_MAX_ROWS + 1 }, (_, index) => ({
    runId: `run-${index}`,
    queryId: index,
    query: `query ${index}`,
    country: 'Germany',
    status: 'COMPLETED',
    selectionStrategy: 'UCB_EXPLOITATION',
    selectionReason: 'selected',
    stopReason: 'MAX_PAGES_REACHED',
    quotaUsed: 100,
    completedAt: '2026-01-01T00:00:00.000Z',
    performanceScore: 50,
    qualityVector: buildQueryQualityVector({
      rawResults: 1, distinctResults: 1, newChannels: 0, newConfirmedCreators: 0,
      newQualityCreators: 0, quotaUsed: 100,
    }),
  }));
  const input = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    portfolio: { dailyQuotaUnits: 1000, portfolioUnitsReserved: 150, portfolioUnitsUsed: 0 },
  };

  const truncated = buildQueryQualityDashboard({ ...input, rows });
  assert.equal(truncated.rowLimit, QUERY_QUALITY_DASHBOARD_MAX_ROWS);
  assert.equal(truncated.rows.length, QUERY_QUALITY_DASHBOARD_MAX_ROWS);
  assert.equal(truncated.truncated, true);
  // Totals describe the visible window, not the discarded extra row.
  assert.equal(truncated.totals.runs, QUERY_QUALITY_DASHBOARD_MAX_ROWS);

  // The route fetches limit + 1, so an exactly-full window is not truncated.
  const exact = buildQueryQualityDashboard({
    ...input,
    rows: rows.slice(0, QUERY_QUALITY_DASHBOARD_MAX_ROWS),
  });
  assert.equal(exact.rows.length, QUERY_QUALITY_DASHBOARD_MAX_ROWS);
  assert.equal(exact.truncated, false);
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

test('Q8: a live scope promotion may admit a registered dormant country', () => {
  const record = (metadata: Record<string, unknown>) => ({
    query: 'Nikkei day trading',
    country: 'Japan',
    primary_term: 'Nikkei',
    generation_metadata: {
      queryTemplate: 'COMPACT_PAIR',
      atoms: [
        { term: 'Nikkei', type: 'INSTRUMENT', origin: 'CURATED' },
        { term: 'day trading', type: 'METHOD', origin: 'CURATED' },
      ],
      ...metadata,
    },
  });
  const dormant = admitQueryRecord(record({}));
  assert.equal(dormant.eligible, false);
  assert.ok(dormant.reasonCodes.includes('COUNTRY_NOT_PRODUCTION_CONFIGURED'));

  const promoted = admitQueryRecord(record({ scopePromoted: true }));
  assert.equal(promoted.eligible, true);
  assert.equal(promoted.admission.source, 'COUNTRY_VOCABULARY');

  // Execution-time revalidation honours the live marker without re-hardcoding
  // the country into the production fixture.
  const stored = withQueryAdmission(record({ scopePromoted: true }).generation_metadata, promoted.admission);
  const revalidated = revalidateQueryRecordAdmission({
    ...record({ scopePromoted: true }),
    generation_metadata: stored,
  });
  assert.equal(revalidated.eligible, true);
  assert.equal(revalidated.admission.candidateHash, promoted.admission.candidateHash);
});

test('Q2: governed sources cannot be spoofed by inherited template keys', () => {
  const record = (metadata: Record<string, unknown>) => ({
    query: 'DAX day trading',
    country: 'Germany',
    primary_term: 'DAX',
    generation_metadata: {
      atoms: [
        { term: 'DAX', type: 'INSTRUMENT', origin: 'CURATED' },
        { term: 'day trading', type: 'METHOD', origin: 'CURATED' },
      ],
      ...metadata,
    },
  });
  for (const template of ['constructor', 'toString', '__proto__']) {
    const decision = admitQueryRecord(record({ queryTemplate: template }));
    assert.equal(typeof decision.admission.source, 'string');
    assert.ok(Object.hasOwn(QUERY_SOURCE_REGISTRY, decision.admission.source));
    assert.equal(decision.admission.source, 'LEARNED_TERMINOLOGY');
  }
  // A persisted research allocation keeps its own source instead of being
  // charged to the standalone organic template.
  const research = admitQueryRecord(record({
    queryTemplate: 'ORGANIC_STANDALONE',
    persistentResearchActionId: 'action-1',
  }));
  assert.equal(research.admission.source, 'PERSISTENT_RESEARCH');
});

test('Q2: a country-native override covers only the approved local surface', () => {
  const record = (anchorEligibility: string) => ({
    query: 'ドル円 デイトレード',
    country: 'Japan',
    primary_term: 'デイトレード',
    generation_metadata: {
      queryTemplate: 'ANCHOR_LEARNED',
      scopePromoted: true,
      countryNativeAllocation: { decisionId: 'decision-1' },
      learnedTerm: 'デイトレード',
      atoms: [
        {
          term: 'デイトレード', type: 'TERMINOLOGY', role: 'ANCHOR', origin: 'LEARNED',
          retrievalPolicy: { eligibility: anchorEligibility },
        },
        { term: 'ドル円', type: 'INSTRUMENT', origin: 'LEARNED' },
      ],
    },
  });

  const approved = admitQueryRecord(record('STANDALONE'));
  const approvedProvenance = Object.fromEntries(approved.candidate.atoms.map(atom => [atom.term, atom.provenance]));
  assert.equal(approvedProvenance['デイトレード'], 'COUNTRY_VOCABULARY');
  assert.equal(approvedProvenance['ドル円'], 'LEARNED');

  // Without an independently authorized anchor the allocation must not
  // whitelist every atom in the row.
  const unapproved = admitQueryRecord(record('CONTEXT_REQUIRED'));
  for (const atom of unapproved.candidate.atoms) assert.equal(atom.provenance, 'LEARNED');
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
  // Thompson arms must be sampled once per decision, before sorting. Sampling
  // inside a comparator makes the winner depend on comparison order.
  assert.doesNotMatch(source, /sort\(\(a, b\) => thompsonSample\(/);
  assert.match(source, /const sampled = scored\.map\(item => \(\{[\s\S]*?sample: thompsonSample\(item\.posterior, rng\)/);
});

function rawInput(overrides: Partial<RawChannelInput>): RawChannelInput {
  const input: RawChannelInput = { channel_name: 'Fixture', description: '', country: 'Germany', ...overrides };
  input.evidence_corpus = buildCanonicalEvidenceCorpus(input);
  return input;
}

test('C5: future-dated uploads are never counted as recent evidence', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const input = rawInput({
    channel_name: 'Day Trading Pro',
    description: 'Day trading education with risk management.',
    videos: [
      { id: 'past', title: 'Day trading setup', published_at: '2025-12-01T00:00:00.000Z' },
      { id: 'future', title: 'Day trading review', published_at: '2030-01-01T00:00:00.000Z' },
    ],
  });
  const composition = buildContextualComposition(input, undefined, now);
  const familyId = (text: string) => input.evidence_corpus!.find(document => document.text === text)!.sourceFamilyId;
  const byId = new Map(composition.familyClassifications.map(family => [family.sourceFamilyId, family.recent]));
  assert.equal(byId.get(familyId('Day trading setup')), true);
  assert.equal(byId.get(familyId('Day trading review')), false);
  assert.equal(composition.recentTradingFamilies, 1);
});

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

test('C5: only parseable publish dates count as known temporal coverage', () => {
  const malformed = rawInput({
    channel_name: 'Alpha Trading',
    description: 'Day trading, order flow and risk management education.',
    videos: [{ id: 'bad-date', title: 'Order flow trading setup', published_at: 'not-a-date' }],
  });
  assert.equal(buildContextualComposition(malformed).temporalCoverage, 'UNKNOWN');

  // A syntactically ISO-shaped but impossible calendar day must not count.
  // Date.parse normalizes 2024-02-31 to March 2, so presence alone is unsafe.
  const impossible = rawInput({
    channel_name: 'Alpha Trading',
    description: 'Day trading, order flow and risk management education.',
    videos: [{ id: 'impossible-date', title: 'Order flow trading setup', published_at: '2024-02-31T00:00:00.000Z' }],
  });
  assert.equal(buildContextualComposition(impossible).temporalCoverage, 'UNKNOWN');

  const valid = rawInput({
    channel_name: 'Alpha Trading',
    description: 'Day trading, order flow and risk management education.',
    videos: [{ id: 'good-date', title: 'Order flow trading setup', published_at: '2026-01-01T00:00:00.000Z' }],
  });
  assert.equal(buildContextualComposition(valid).temporalCoverage, 'KNOWN');
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

test('Q2: a source- or provenance-only change invalidates the admission hash', () => {
  const make = (source: QuerySource, provenance: 'CURATED' | 'LEARNED') => buildQueryCandidate({
    query: 'DAX day trading',
    country: 'Germany',
    source,
    atoms: [
      { term: 'DAX', type: 'INSTRUMENT', provenance },
      { term: 'day trading', type: 'CONCEPT', provenance },
    ],
    relation: 'COMPACT_PAIR',
  });
  const baseline = make('CURATED', 'CURATED');
  const sourceChanged = make('LEARNED_TERMINOLOGY', 'CURATED');
  const provenanceChanged = make('CURATED', 'LEARNED');
  assert.notEqual(candidateHash(baseline), candidateHash(sourceChanged));
  assert.notEqual(candidateHash(baseline), candidateHash(provenanceChanged));
});

test('Q2: composition evaluation is pure and hashes the derived tier', () => {
  const candidate = buildQueryCandidate({
    query: 'DAX day trading',
    country: 'Germany',
    source: 'CURATED',
    atoms: [
      { term: 'DAX', type: 'INSTRUMENT', provenance: 'CURATED' },
      { term: 'day trading', type: 'TERMINOLOGY', provenance: 'CURATED' },
    ],
    relation: 'ANCHOR_MODIFIER',
  });
  // A stale producer-supplied tier must not survive the gate.
  candidate.tier = 'SPECULATIVE';
  const decision = evaluateQueryComposition(candidate, {});
  assert.equal(decision.tier, 'LICENSED_UNSEEN');
  assert.equal(candidate.tier, 'SPECULATIVE');

  const admission = admitQueryCandidate(candidate, {});
  assert.equal(admission.candidateHash, candidateHash(candidate, decision.tier));
  assert.notEqual(admission.candidateHash, candidateHash(candidate));
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

test('Q2: mutually duplicate persisted rows have one stable selection winner', () => {
  const rows = [
    { id: 41, query: 'DAX day trading', country: 'Germany' },
    { id: 42, query: 'trading day DAX', country: 'Germany' },
  ];
  const record = (query: string) => heldOutRecord('Germany', query, [
    { term: 'DAX', type: 'INSTRUMENT' }, { term: 'day trading', type: 'METHOD' },
  ], { relation: 'COMPACT_PAIR' });
  const rawHistory = (id: number) => rows
    .filter(row => row.id !== id)
    .map(row => ({ query: row.query, country: row.country }));

  // Both persisted rows suppress each other without the stable-winner rule.
  assert.ok(admitQueryRecord(record('DAX day trading'), { history: rawHistory(41) }).reasonCodes.includes('SEMANTIC_DUPLICATE'));
  assert.ok(admitQueryRecord(record('trading day DAX'), { history: rawHistory(42) }).reasonCodes.includes('SEMANTIC_DUPLICATE'));

  // The lowest id wins; the loser still sees the winner and stays rejected.
  const winner = admitQueryRecord(record('DAX day trading'), { history: selectionHistoryFor(rows[0], rows) });
  assert.equal(winner.eligible, true);
  const loser = admitQueryRecord(record('trading day DAX'), { history: selectionHistoryFor(rows[1], rows) });
  assert.equal(loser.eligible, false);
  assert.ok(loser.reasonCodes.includes('SEMANTIC_DUPLICATE'));

  // Input order from the database is not trusted to define the winner.
  assert.deepEqual(selectionHistoryFor(rows[0], [...rows].reverse()), []);
  assert.deepEqual(selectionHistoryFor(rows[1], [...rows].reverse()), [{ query: 'DAX day trading', country: 'Germany' }]);
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

  // The writer list alone would still pass if dbCore gained a second direct
  // INSERT outside upsertQueryRecord. Locate every insert and require it to
  // sit in the one function that admits first and persists the admission.
  const dbCoreSource = readFileSync(join(serverDir, 'dbCore.ts'), 'utf8');
  const insertOffsets = [...dbCoreSource.matchAll(/INSERT\s+INTO\s+query_library/giu)].map(match => match.index ?? -1);
  assert.equal(insertOffsets.length, 1, 'dbCore must have exactly one query_library insert site');
  const functionStart = dbCoreSource.lastIndexOf('export async function', insertOffsets[0]);
  const functionEnd = dbCoreSource.indexOf('\nexport ', insertOffsets[0]);
  const writerBody = dbCoreSource.slice(functionStart, functionEnd === -1 ? undefined : functionEnd);
  assert.match(writerBody, /export async function upsertQueryRecord/);
  assert.match(writerBody, /admitQueryRecord\(/);
  assert.match(writerBody, /withQueryAdmission\(/);
});

test('Q6: batch query generation loads country history once, not per candidate', () => {
  const dbCore = readFileSync(join(__dirname, '..', 'dbCore.ts'), 'utf8');
  assert.match(dbCore, /history\?:QueryDuplicateHistoryItem\[\]/);
  assert.match(dbCore, /options\.history/);
  const intelligence = readFileSync(join(__dirname, '..', 'queryIntelligence.ts'), 'utf8');
  const start = intelligence.indexOf('export async function generateCandidateQueriesForCountry');
  const end = intelligence.indexOf('\nexport async function', start + 1);
  assert.ok(start >= 0 && end > start);
  const batch = intelligence.slice(start, end);
  assert.match(batch, /const history = existingQueries\.map/);
  assert.match(batch, /\}, \{ history \}\)/);
  assert.match(batch, /history\.push\(/);
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
  // Only the healthy run's quota is a reward denominator; degraded/failed
  // spend must not make them look like zero-yield eligible runs.
  assert.equal(dashboard.totals.quotaUnits, 1);
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

test('Q5: explicit market/language counts are honest; absent input is unknown, not a proxy', () => {
  const measured = buildQueryQualityVector({
    rawResults: 10, distinctResults: 10, newChannels: 3, newConfirmedCreators: 2,
    newQualityCreators: 1, quotaUsed: 100, targetMarketConfirmed: 0, languageMatchedConfirmed: 0,
  });
  assert.equal(measured.targetMarketPrecision, 0);
  assert.equal(measured.languageMatchRate, 0);

  // Unmeasured metrics must not be filled with invented proxies (0.8 and
  // 100% respectively) that make the run look better than the evidence.
  const unmeasured = buildQueryQualityVector({
    rawResults: 10, distinctResults: 10, duplicateResults: 0, newChannels: 3, newConfirmedCreators: 2,
    newQualityCreators: 1, quotaUsed: 100, countryRejected: 2,
  });
  assert.equal(unmeasured.targetMarketPrecision, null);
  assert.equal(unmeasured.languageMatchRate, null);
});




test('Q1: prototype country keys fail closed instead of returning Object.prototype members', () => {
  const fallback = getCountryMarketProfile('constructor');
  assert.equal(fallback.country, 'constructor');
  assert.deepEqual(fallback.languages, []);
  assert.deepEqual(fallback.markets, []);
  assert.equal(fallback.primaryMarket, 'UNKNOWN');
  // The fallback must be a usable profile shape, not `Function`.
  assert.ok(Array.isArray(fallback.languages));
});

test('Q4: a fractional portfolio remainder cannot cover the next official run', () => {
  const cold = candidate(1, 'family:A', 0, 0);
  const belowReservation = selectHierarchicalUcb([cold], selectorContext({ portfolioUnitsUsed: 14.5 }));
  assert.equal(belowReservation.strategy, 'NO_ELIGIBLE_QUERY');
  assert.equal(belowReservation.queryId, null);
  assert.ok(belowReservation.reasonCodes.includes('PORTFOLIO_BUDGET_EXHAUSTED'));

  const exactReservation = selectHierarchicalUcb([cold], selectorContext({ portfolioUnitsUsed: 14 }));
  assert.equal(exactReservation.strategy, 'UCB_PORTFOLIO');
  assert.equal(exactReservation.queryId, 1);
});

test('Q4: continuation is authorized page by page against the shared portfolio floor', () => {
  // A pagination ceiling larger than the whole portfolio floor must not make
  // cold-start selection impossible: one remaining unit is enough to select.
  assert.equal(portfolioContinuationAllowed({ portfolioUnitsUsed: 14, portfolioUnitsReserved: 15 }), true);
  assert.equal(portfolioContinuationAllowed({ portfolioUnitsUsed: 15, portfolioUnitsReserved: 15 }), false);
  // Fractional artifacts from quota/100 conversion stay admissible.
  assert.equal(portfolioContinuationAllowed({ portfolioUnitsUsed: 14.0000000001, portfolioUnitsReserved: 15 }), true);
  // Malformed input fails closed instead of opening the budget.
  assert.equal(portfolioContinuationAllowed({ portfolioUnitsUsed: Number.NaN, portfolioUnitsReserved: 15 }), false);
  assert.equal(portfolioContinuationAllowed({ portfolioUnitsUsed: 0, portfolioUnitsReserved: Number.POSITIVE_INFINITY }), false);
  assert.equal(portfolioContinuationAllowed({ portfolioUnitsUsed: 0, portfolioUnitsReserved: 15, nextPageUnits: 0 }), false);

  const selector = readFileSync(join(__dirname, 'selector.ts'), 'utf8');
  // The pagination ceiling is not a selection input any more.
  assert.ok(!selector.includes('portfolioRunUnits'));
  const queue = readFileSync(join(__dirname, '..', 'queueManager.ts'), 'utf8');
  assert.match(queue, /reservePortfolioContinuationPage\(\{/);
  assert.match(queue, /pageNumber: pageNumber \+ 1/);
  assert.match(queue, /Number\.isFinite\(configuredMaxPages\)/);
  const dbCore = readFileSync(join(__dirname, '..', 'dbCore.ts'), 'utf8');
  // The first page is checked atomically at the scheduling boundary, under
  // the same lock as continuation pages, so concurrent selectors cannot both
  // spend the last unit.
  assert.match(dbCore, /const portfolioRunStrategy = \[/);
  assert.match(dbCore, /nextPageUnits: scheduledProviderUnits \/ 100/);
  assert.match(dbCore, /reservationReasonCode: 'PORTFOLIO_BUDGET_EXHAUSTED'/);
  // The skip must settle any frontier allocation in the same transaction.
  assert.match(dbCore, /releaseAllocationDecision\(candidate\.frontierDecisionId, 'PORTFOLIO_BUDGET_EXHAUSTED', client\)/);
});

test('Q4: simulator portfolio admission is quota-weighted, not pull-weighted', () => {
  // A first pull is bounded by the projected daily capacity, not admitted at
  // 100% of its own spend.
  assert.equal(portfolioPullAdmitted({ portfolioQuotaUnits: 0, totalQuota: 0, quotaUnits: 3, portfolioRatio: 0.15 }), false);
  assert.equal(portfolioPullAdmitted({ portfolioQuotaUnits: 0, totalQuota: 0, quotaUnits: 3, portfolioRatio: 0.15, baselineQuotaUnits: 100 }), true);
  // 14 of 100 units used; a 3-unit pull projects 17/103 > 15%.
  assert.equal(portfolioPullAdmitted({ portfolioQuotaUnits: 14, totalQuota: 100, quotaUnits: 3, portfolioRatio: 0.15 }), false);
  // 14 of 100 used; a 1-unit pull projects 15/101 <= 15%.
  assert.equal(portfolioPullAdmitted({ portfolioQuotaUnits: 14, totalQuota: 100, quotaUnits: 1, portfolioRatio: 0.15 }), true);
});

test('Q4: simulator UCB1 baseline clamps the normalized score and uses portfolio-wide executions', () => {
  assert.equal(currentUcb1Index(100, 0, 1), 1 + 0.8 * Math.sqrt(Math.log(2)));
  assert.equal(currentUcb1Index(0.5, 3, 9), 0.5 + 0.8 * Math.sqrt(Math.log(10) / 4));
  assert.ok(currentUcb1Index(0.5, 3, 9) < currentUcb1Index(0.5, 3, 90));
});

test('Q4: only the serving selector applies the simulator portfolio floor', () => {
  assert.equal(SERVING_SELECTOR, 'hierarchical_ucb_c2');
  const source = readFileSync(join(__dirname, 'simulator.ts'), 'utf8');
  // Applying the serving floor to the UCB1/TS counterfactuals would replace
  // their own pick on admitted pulls and confound the comparison.
  assert.match(source, /const portfolioApplies = portfolio && selector === SERVING_SELECTOR;/);
  assert.match(source, /chooseArm\(selector, uncapped\.length \? uncapped : country\.arms, aggregates, priorFor\(aggregates\), rng, portfolioApplies, c\)/);
  // Raw confirmed-per-quota yield is normalized to production's [0,1]
  // performance-score axis before clamping, keeping the exploitation signal.
  assert.match(source, /arm\.lastRate = quotaUnits > 0\s*\?\s*Math\.min\(1, confirmed \/ quotaUnits \/ SIM_MAX_ARM_RATE\)/);
});

test('Q8: simulator cold-start cursor forces each country before index play', () => {
  // One pull per country: the cursor, not posterior/index play, must choose
  // the arm, so every country contributes exactly its first arm.
  const metrics = runSelectorSimulation({ scenario: 'cold_start', seeds: 3, pulls: 16 }, 'hierarchical_ucb_c2');
  assert.equal(metrics.coverage, 16);
  assert.equal(metrics.distinctArms, 16);
  const source = readFileSync(join(__dirname, 'simulator.ts'), 'utf8');
  assert.match(source, /const coldStartArm = !config\.portfolioRatio && country\.cursor === 0/);
  assert.match(source, /if \(coldStartArm\) country\.cursor = 1/);
  assert.match(source, /const arm = coldStartArm\s*\|\| chooseArm\(/);
});

test('Q8: non-stationary simulator decays arm and hierarchy counts lazily', () => {
  const source = readFileSync(join(__dirname, 'simulator.ts'), 'utf8');
  assert.match(source, /const decayHalfLifePulls = Math\.max\(10, Math\.floor\(pulls \* 0\.1\)\)/);
  assert.match(source, /if \(!stationary && step > 0\) \{[\s\S]*?decayAggregates\(aggregates, Math\.pow\(0\.5, 1 \/ decayHalfLifePulls\)\)/);
  assert.match(source, /for \(const arm of country\.arms\) decayArmCounts\(arm, step, decayHalfLifePulls\)/);
  // Arms are decayed lazily when their country is visited, never twice for the
  // same step; hierarchy totals are decayed once per step.
  assert.match(source, /function decayArmCounts\([\s\S]*?if \(step <= arm\.decayStep\) return;[\s\S]*?arm\.decayStep = step;/);
  const metrics = runSelectorSimulation({ scenario: 'non_stationary', seeds: 3, pulls: 64 }, 'hierarchical_ucb_c2');
  assert.equal(metrics.coverage, 16);
});

test('Q6: dashboard duplicate share is aggregated over evaluated result counts', () => {
  const first = buildQueryQualityVector({
    rawResults: 10, distinctResults: 5, duplicateResults: 5,
    newConfirmedCreators: 1, quotaUsed: 100,
  });
  const second = buildQueryQualityVector({
    rawResults: 10, distinctResults: 9, duplicateResults: 1,
    newConfirmedCreators: 1, quotaUsed: 100,
  });
  const dashboard = buildQueryQualityDashboard({
    generatedAt: '2026-01-01T00:00:00.000Z',
    portfolio: { dailyQuotaUnits: 100, portfolioUnitsReserved: 15, portfolioUnitsUsed: 2 },
    rows: [
      { runId: 'a', queryId: 1, query: 'a', country: 'Germany', status: 'COMPLETED', selectionStrategy: 'UCB_EXPLOITATION', selectionReason: 'selected', quotaUsed: 100, qualityVector: first },
      { runId: 'b', queryId: 2, query: 'b', country: 'Germany', status: 'COMPLETED', selectionStrategy: 'UCB_EXPLOITATION', selectionReason: 'selected', quotaUsed: 100, qualityVector: second },
    ],
  });
  // (5 + 1) duplicates / (10 + 10) evaluated = 0.30. Weighting by distinct
  // results would report 0.243.
  assert.ok(Math.abs(dashboard.totals.duplicateRatio - 0.3) < 1e-12);
});

test('Q2: country-native allocations keep their explicit source despite ANCHOR_LEARNED', () => {
  const result = admitQueryRecord({
    query: 'DAX day trading',
    country: 'Germany',
    primary_term: 'DAX',
    generation_metadata: {
      queryTemplate: 'ANCHOR_LEARNED',
      learnedTerm: 'day trading',
      countryNativeAllocation: { decisionId: 'decision-1', proposalId: 'proposal-1' },
      atoms: [
        { term: 'DAX', type: 'INSTRUMENT', origin: 'CURATED' },
        { term: 'day trading', type: 'METHOD', origin: 'LEARNED' },
      ],
    },
  });
  assert.equal(result.admission.source, 'COUNTRY_VOCABULARY');
});

test('Q0: malformed provenance cannot bypass trading-semantics admission', () => {
  const record = (origin: string) => admitQueryRecord({
    query: 'Wetterbericht',
    country: 'Germany',
    primary_term: 'Wetterbericht',
    generation_metadata: { queryTemplate: 'SINGLE_ATOM', atoms: [{ term: 'Wetterbericht', type: 'TERMINOLOGY', origin }] },
  });
  assert.equal(record('CURATED').eligible, true);
  for (const origin of ['NOT_CURATED', 'UNCURATED', 'LEARNED']) {
    const result = record(origin);
    assert.equal(result.eligible, false, origin);
    assert.ok(result.reasonCodes.includes('TERM_NO_TRADING_SEMANTICS'), origin);
  }
});

test('Q0: an unlabeled row cannot claim the CURATED semantics exemption', () => {
  const result = admitQueryRecord({
    query: 'Wetterbericht',
    country: 'Germany',
    primary_term: 'Wetterbericht',
    generation_metadata: { queryTemplate: 'SINGLE_ATOM' },
  });
  assert.equal(result.admission.source, 'LEARNED_TERMINOLOGY');
  assert.equal(result.eligible, false);
  assert.ok(result.reasonCodes.includes('TERM_NO_TRADING_SEMANTICS'));
});

test('Q2: registered but dormant countries cannot reach selection', () => {
  const dormant = heldOutRecord('Italy', 'FTSE MIB day trading', [
    { term: 'FTSE MIB', type: 'INSTRUMENT' }, { term: 'day trading', type: 'METHOD' },
  ], { relation: 'COMPACT_PAIR' });
  const decision = admitQueryRecord(dormant);
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasonCodes.includes('COUNTRY_NOT_PRODUCTION_CONFIGURED'));
});

test('Q2d: a stored SEMANTIC_DUPLICATE rejection survives revalidation without history', () => {
  const record = {
    query: 'DAX day trading',
    country: 'Germany',
    primary_term: 'DAX',
    generation_metadata: {
      queryTemplate: 'ANCHOR_LEARNED',
      atoms: [
        { term: 'DAX', type: 'INSTRUMENT', origin: 'CURATED' },
        { term: 'day trading', type: 'METHOD', origin: 'CURATED' },
      ],
    },
  };
  const stored = admitQueryRecord(record, { history: [{ query: 'trading DAX day', country: 'Germany' }] });
  assert.equal(stored.eligible, false);
  assert.ok(stored.reasonCodes.includes('SEMANTIC_DUPLICATE'));

  // Execution-time authority has no history: preserving the stored rejection
  // is the fail-closed behavior.
  const unchecked = revalidateQueryRecordAdmission({
    ...record,
    generation_metadata: withQueryAdmission(record.generation_metadata, stored.admission),
  });
  assert.equal(unchecked.eligible, false);
  assert.ok(unchecked.reasonCodes.includes('SEMANTIC_DUPLICATE'));

  // An explicit current history recheck may release the row.
  const rechecked = revalidateQueryRecordAdmission({
    ...record,
    generation_metadata: withQueryAdmission(record.generation_metadata, stored.admission),
  }, { history: [] });
  assert.equal(rechecked.eligible, true);
  assert.ok(!rechecked.reasonCodes.includes('SEMANTIC_DUPLICATE'));
});

test('C5: recency-specific mixed composition keeps its distinct reason', () => {
  const composition = buildContextualComposition({
    channel_name: 'Fixture',
    description: '',
    evidence_corpus: [
      { field: 'video_title', text: 'day trading strategy', sourceFamilyId: 'trading', publishedAt: '2024-01-01T00:00:00.000Z' },
      { field: 'video_title', text: 'makeup tutorial', sourceFamilyId: 'beauty', publishedAt: '2025-12-01T00:00:00.000Z' },
    ],
  } as RawChannelInput, undefined, new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(composition.focus, 'MIXED');
  assert.ok(composition.reasonCodes.includes('RECENT_ALTERNATIVE_OUTPUT_CONFLICTS_WITH_TRADING_HISTORY'));
  assert.ok(!composition.reasonCodes.includes('TRADING_AND_ALTERNATIVE_CONFLICT'));
});

test('Q2: CDL anchored bootstrap templates admit without granting PR557 provenance', () => {
  const record = (template: string, origin: 'FREE_SIGNAL' | 'DEMAND_SIGNAL', modifier: string) => ({
    query: `order flow ${modifier}`,
    country: 'Germany',
    primary_term: 'order flow',
    generation_metadata: {
      queryTemplate: template,
      atoms: [
        { term: 'order flow', type: 'METHOD', origin: 'CURATED', role: 'ANCHOR' },
        { term: modifier, type: 'CONCEPT', origin, role: 'MODIFIER' },
      ],
    },
  });

  for (const [template, origin, modifier] of [
    ['ANCHOR_FREE_SIGNAL', 'FREE_SIGNAL', 'futures'],
    ['ANCHOR_DEMAND_SIGNAL', 'DEMAND_SIGNAL', 'futures'],
  ] as const) {
    const decision = admitQueryRecord(record(template, origin, modifier));
    assert.equal(decision.eligible, true, `${template} must pass the admission gates: ${decision.reasonCodes.join(', ')}`);
    assert.equal(decision.candidate.relation, 'ANCHOR_MODIFIER', `${template} needs a licensed anchor relation`);
    assert.equal(decision.candidate.atoms[1]?.provenance, origin, 'bootstrap atoms keep their own provenance');
    assert.notEqual(decision.candidate.atoms[1]?.provenance, 'PR557', 'candidate vocabulary must still pass the semantic lexicon');
  }
});
