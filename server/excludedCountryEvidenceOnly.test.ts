import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshTerminologyLifecycle, getPlannerTerminology } from './terminologyIntelligence';
import { recomputeNativeEvidenceProjection } from './countryNativeIntelligence';
import { buildFrontierProposal, generateCountryNativeProposals, persistFrontierProposals } from './discoveryProposalGenerators';
import { materializeExternalOsintProposals, persistExternalOsintProposal } from './externalOsint';
import { generateMultilingualActions } from './persistentResearchController';
import { excludedCountrySqlPredicate, findCountryExclusionWithAliases, readExcludedCountries } from './countryExclusion';
import { countryAliasResolutionJson, countryIdentityResolution } from './countryInference';
import { addExcludedCountryGuarded } from './countryExclusionRules';
import { getNeighborhoodCandidates } from './discoveryFrontierAllocator';
import { evaluateTrialGate } from './discoveryFrontierTrials';

// Excluded-country guardrails: excluded markets are evidence-only. These
// tests drive every path that could make an excluded country search-eligible
// or materialize its evidence (lifecycle promotion and revocation, planner
// serving, native proposal projections, country-native proposal generation
// and persistence, external OSINT, concept-graph multilingual actions,
// allocation of previously persisted pending proposals, and trial
// authorization) through a recording fake runner and assert that the path
// fails closed. Controls with a non-excluded market prove the guards are
// specific to the exclusion list and do not disable the underlying behavior.
//
// The concurrency test at the bottom emulates PostgreSQL transaction-scoped
// advisory locks to prove the check-then-write protocol: a policy writer
// cannot commit an exclusion between a guarded read (no match) and the
// guarded write.

type Row = Record<string, any>;
type Handler = { match: RegExp; respond: (sql: string, params?: any[]) => { rows: Row[]; rowCount?: number } };

function makeRunner(handlers: Handler[]) {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  return {
    calls,
    async query(sql: string, params?: any[]) {
      calls.push({ sql, params });
      for (const h of handlers) if (h.match.test(sql)) return h.respond(sql, params);
      return { rows: [] as Row[] };
    }
  };
}

// The exclusion read is matched exactly: SQL that merely mentions
// excluded_countries (the in-query prefilter, the lock statement) must never
// satisfy the read handler through a substring match.
const READ_EXCLUSIONS = /^SELECT country_name, reason FROM excluded_countries$/;

const excludedGermany: Handler = {
  match: READ_EXCLUSIONS,
  respond: () => ({ rows: [{ country_name: 'Germany', reason: 'regulatory prohibition' }] })
};
const excludedPakistan: Handler = {
  match: READ_EXCLUSIONS,
  respond: () => ({ rows: [{ country_name: 'Pakistan', reason: 'regulatory prohibition' }] })
};
const noExclusions: Handler = { match: READ_EXCLUSIONS, respond: () => ({ rows: [] }) };
const throwingExclusions: Handler = {
  match: READ_EXCLUSIONS,
  respond: () => { throw new Error('exclusion-read-failed'); }
};
const malformedExclusions: Handler = { match: READ_EXCLUSIONS, respond: () => ({} as any) };
const noNativeQuality: Handler = { match: /qualityVersion/, respond: () => ({ rows: [{ v1: 0, spam: false, novel: false }] }) };
const noLifecycleEvents: Handler = {
  match: /SELECT event_type, reason FROM terminology_lifecycle_events/,
  respond: () => ({ rows: [] })
};
const lifecycleTerm = (over: Row): Handler => ({
  match: /FROM canonical_trading_terms t LEFT JOIN LATERAL/,
  respond: () => ({
    rows: [{ id: 42, country: 'Germany', canonical_term: 'DAX', normalized_term: 'dax', term_type: 'TERMINOLOGY', trust_tier: 2, human_approved: 0, ...over }]
  })
});

// Legacy decision grants SEARCH_TRIAL (creators/communities/evidence clear the
// trial bar) while the row is already search_eligible.
const STALE_ELIGIBLE = { lifecycle_status: 'SEARCH_TRIAL', search_eligible: true, distinct_creators: 5, distinct_communities: 3, human_approved: 2, decayed_evidence: 9.5, executions: 2, decayed_yield: 0.4 };
// Legacy decision would promote OBSERVED -> SEARCH_TRIAL; the row is not eligible.
const TRIAL_READY_NOT_ELIGIBLE = { lifecycle_status: 'OBSERVED', search_eligible: false, distinct_creators: 4, distinct_communities: 2, human_approved: 1, decayed_evidence: 6, executions: 0, decayed_yield: 0 };

test('excluded-country refresh revokes stale search eligibility and records the policy reason', async () => {
  const runner = makeRunner([excludedGermany, noNativeQuality, noLifecycleEvents, lifecycleTerm(STALE_ELIGIBLE)]);
  await refreshTerminologyLifecycle(42, undefined, runner);
  const revokes = runner.calls.filter(c => /UPDATE canonical_trading_terms SET lifecycle_status=\$2,search_eligible=false/.test(c.sql));
  assert.equal(revokes.length, 1);
  assert.deepEqual(revokes[0].params, [42, 'SEARCH_TRIAL', 2]);
  // The legacy apply (which would keep search_eligible=true) must not run.
  assert.equal(runner.calls.filter(c => /SET lifecycle_status=\$2,search_eligible=\$3/.test(c.sql)).length, 0);
  const events = runner.calls.filter(c => /INSERT INTO terminology_lifecycle_events/.test(c.sql));
  assert.equal(events.length, 1);
  assert.equal(events[0].params[3], 'ELIGIBILITY_CHANGE');
  assert.match(String(events[0].params[4]), /excluded-country: evidence-only \(Germany: regulatory prohibition\)/);
  const snapshot = runner.calls.find(c => /INSERT INTO terminology_score_snapshots/.test(c.sql));
  assert.equal(snapshot?.params[6], 'SEARCH_TRIAL');
  // Serialization protocol: the shared policy lock is taken before the
  // exclusion read, and the read precedes the guarded revocation.
  const lockIndex = runner.calls.findIndex(c => /pg_advisory_xact_lock_shared/.test(c.sql));
  const readIndex = runner.calls.findIndex(c => READ_EXCLUSIONS.test(c.sql));
  const updateIndex = runner.calls.findIndex(c => /UPDATE canonical_trading_terms SET lifecycle_status=\$2,search_eligible=false/.test(c.sql));
  assert.ok(lockIndex >= 0 && lockIndex < readIndex && readIndex < updateIndex,
    `policy lock (${lockIndex}) must precede the exclusion read (${readIndex}), which must precede the revocation (${updateIndex})`);
});

test('excluded-country refresh blocks trial entry without writing search eligibility', async () => {
  const runner = makeRunner([excludedGermany, noNativeQuality, noLifecycleEvents, lifecycleTerm(TRIAL_READY_NOT_ELIGIBLE)]);
  await refreshTerminologyLifecycle(42, undefined, runner);
  // No UPDATE at all: neither a revoke (row was not eligible) nor an apply.
  assert.equal(runner.calls.filter(c => /UPDATE canonical_trading_terms/.test(c.sql)).length, 0);
  const events = runner.calls.filter(c => /INSERT INTO terminology_lifecycle_events/.test(c.sql));
  assert.equal(events.length, 1);
  assert.equal(events[0].params[2], 'OBSERVED');
  assert.match(String(events[0].params[4]), /excluded-country: evidence-only \(Germany: regulatory prohibition\)/);
  const snapshot = runner.calls.find(c => /INSERT INTO terminology_score_snapshots/.test(c.sql));
  assert.equal(snapshot?.params[6], 'OBSERVED');
});

test('non-excluded markets keep the legacy promotion path (guard control)', async () => {
  const runner = makeRunner([noExclusions, noNativeQuality, noLifecycleEvents, lifecycleTerm(TRIAL_READY_NOT_ELIGIBLE)]);
  await refreshTerminologyLifecycle(42, undefined, runner);
  const applies = runner.calls.filter(c => /SET lifecycle_status=\$2,search_eligible=\$3/.test(c.sql));
  assert.equal(applies.length, 1);
  assert.deepEqual(applies[0].params, [42, 'SEARCH_TRIAL', true, 2]);
  assert.equal(runner.calls.filter(c => /excluded-country/.test(String(c.params?.[4] || ''))).length, 0);
});

test('excluded-country guard takes precedence over the native gate without duplicate events', async () => {
  const nativeBlockingQuality: Handler = { match: /qualityVersion/, respond: () => ({ rows: [{ v1: 1, spam: false, novel: false }] }) };
  const runner = makeRunner([excludedGermany, nativeBlockingQuality, noLifecycleEvents, lifecycleTerm(STALE_ELIGIBLE)]);
  await refreshTerminologyLifecycle(42, undefined, runner);
  const events = runner.calls.filter(c => /INSERT INTO terminology_lifecycle_events/.test(c.sql));
  assert.equal(events.length, 1);
  assert.match(String(events[0].params[4]), /excluded-country: evidence-only/);
  assert.equal(events.filter(e => /quality-gate/.test(String(e.params[4]))).length, 0);
  assert.equal(runner.calls.filter(c => /UPDATE canonical_trading_terms SET lifecycle_status=\$2,search_eligible=false/.test(c.sql)).length, 1);
});

test('a failing exclusion read aborts the refresh instead of promoting (fail closed)', async () => {
  const runner = makeRunner([throwingExclusions, noNativeQuality, noLifecycleEvents, lifecycleTerm(TRIAL_READY_NOT_ELIGIBLE)]);
  await assert.rejects(refreshTerminologyLifecycle(42, undefined, runner), /exclusion-read-failed/);
  assert.equal(runner.calls.filter(c => /INSERT INTO terminology_lifecycle_events/.test(c.sql)).length, 0);
  assert.equal(runner.calls.filter(c => /UPDATE canonical_trading_terms/.test(c.sql)).length, 0);
});

test('a malformed exclusion read aborts the refresh instead of promoting (fail closed)', async () => {
  const runner = makeRunner([malformedExclusions, noNativeQuality, noLifecycleEvents, lifecycleTerm(TRIAL_READY_NOT_ELIGIBLE)]);
  await assert.rejects(refreshTerminologyLifecycle(42, undefined, runner), /EXCLUDED_COUNTRIES_READ_MALFORMED/);
  assert.equal(runner.calls.filter(c => /INSERT INTO terminology_lifecycle_events/.test(c.sql)).length, 0);
  assert.equal(runner.calls.filter(c => /UPDATE canonical_trading_terms/.test(c.sql)).length, 0);
});

test('excluded-country policy reason is recorded once (idempotent)', async () => {
  const alreadyRecorded: Handler = {
    match: /SELECT event_type, reason FROM terminology_lifecycle_events/,
    respond: () => ({ rows: [{ event_type: 'ELIGIBILITY_CHANGE', reason: 'excluded-country: evidence-only (Germany: regulatory prohibition)' }] })
  };
  const runner = makeRunner([excludedGermany, noNativeQuality, alreadyRecorded, lifecycleTerm(TRIAL_READY_NOT_ELIGIBLE)]);
  await refreshTerminologyLifecycle(42, undefined, runner);
  assert.equal(runner.calls.filter(c => /INSERT INTO terminology_lifecycle_events/.test(c.sql)).length, 0);
  assert.equal(runner.calls.filter(c => /UPDATE canonical_trading_terms/.test(c.sql)).length, 0);
});

// Executions clear the demotion bar (>= 5) and yield falls below the demotion
// threshold (< 0.08): the legacy decision DEMOTES a currently-eligible term.
const DEMOTING_STALE_ELIGIBLE = { ...STALE_ELIGIBLE, executions: 6, decayed_yield: 0.05 };

test('demotion-following exclusion revocation records a DEMOTION event with the demoted status', async () => {
  const runner = makeRunner([excludedGermany, noNativeQuality, noLifecycleEvents, lifecycleTerm(DEMOTING_STALE_ELIGIBLE)]);
  await refreshTerminologyLifecycle(42, undefined, runner);
  const updates = runner.calls.filter(c => /UPDATE canonical_trading_terms SET lifecycle_status=\$2,search_eligible=false/.test(c.sql));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params, [42, 'DEMOTED', 3]);
  const events = runner.calls.filter(c => /INSERT INTO terminology_lifecycle_events/.test(c.sql));
  assert.equal(events.length, 1);
  assert.equal(events[0].params[2], 'DEMOTED', 'to_status must be the demoted lifecycle state');
  assert.equal(events[0].params[3], 'DEMOTION', 'an exclusion-driven revoke that follows a yield demotion is a DEMOTION event');
});

test('a re-run of the demotion-following exclusion guard stays idempotent', async () => {
  const alreadyDemoted: Handler = {
    match: /SELECT event_type, reason FROM terminology_lifecycle_events/,
    respond: () => ({ rows: [{ event_type: 'DEMOTION', reason: 'excluded-country: evidence-only (Germany: regulatory prohibition)' }] })
  };
  const runner = makeRunner([excludedGermany, noNativeQuality, alreadyDemoted, lifecycleTerm(DEMOTING_STALE_ELIGIBLE)]);
  await refreshTerminologyLifecycle(42, undefined, runner);
  assert.equal(runner.calls.filter(c => /INSERT INTO terminology_lifecycle_events/.test(c.sql)).length, 0);
});

test('excluded-country refresh revokes eligibility for legacy ISO-alias country rows', async () => {
  // Legacy rows may carry an ISO alias ('DE') rather than the canonical name
  // stored in the exclusion list ('Germany').
  const runner = makeRunner([excludedGermany, noNativeQuality, noLifecycleEvents, lifecycleTerm({ ...STALE_ELIGIBLE, country: 'DE' })]);
  await refreshTerminologyLifecycle(42, undefined, runner);
  const revokes = runner.calls.filter(c => /UPDATE canonical_trading_terms SET lifecycle_status=\$2,search_eligible=false/.test(c.sql));
  assert.equal(revokes.length, 1, 'an ISO-alias row must be revoked when the canonical name is excluded');
});

test('planner serving returns nothing for an excluded market even when eligible rows exist', async () => {
  let planQueried = false;
  const runner = makeRunner([
    excludedGermany,
    { match: /FROM canonical_trading_terms t LEFT JOIN terminology_performance/, respond: () => { planQueried = true; return { rows: [{ id: 1, term: 'DAX', lifecycle_status: 'SEARCH_TRIAL', score: 0.5 }] }; } }
  ]);
  const rows = await getPlannerTerminology('Germany', runner, { isKillSwitchActive: async () => false });
  assert.deepEqual(rows, []);
  assert.equal(planQueried, false);
});

test('planner serving is unchanged for a non-excluded market (guard control)', async () => {
  const runner = makeRunner([
    noExclusions,
    { match: /FROM canonical_trading_terms t LEFT JOIN terminology_performance/, respond: () => ({ rows: [{ id: 1, term: 'S&P 500', lifecycle_status: 'SEARCH_TRIAL', score: 0.5 }] }) }
  ]);
  const rows = await getPlannerTerminology('United States', runner, { isKillSwitchActive: async () => false });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { id: 1, term: 'S&P 500', score: 0.5, lifecycle: 'SEARCH_TRIAL' });
});

test('planner serving returns nothing for an ISO alias of an excluded market', async () => {
  let planQueried = false;
  const runner = makeRunner([
    excludedGermany,
    { match: /FROM canonical_trading_terms t LEFT JOIN terminology_performance/, respond: () => { planQueried = true; return { rows: [{ id: 1, term: 'DAX', lifecycle_status: 'SEARCH_TRIAL', score: 0.5 }] }; } }
  ]);
  const rows = await getPlannerTerminology('DE', runner, { isKillSwitchActive: async () => false });
  assert.deepEqual(rows, []);
  assert.equal(planQueried, false);
});

test('planner serving re-checks the live policy table: an exclusion committed after the read is still honored', async () => {
  // Interleaving the guard read cannot see: the read runs first and observes
  // an empty list, then the exclusion commits, then the serving query runs.
  // The in-query predicate must reject the market even though the stale read
  // allowed it - this is the check-then-serve window.
  let committed: Array<{ country_name: string; reason: string }> = [];
  const runner = makeRunner([
    { match: READ_EXCLUSIONS, respond: () => ({ rows: committed }) },
    { match: /FROM canonical_trading_terms t LEFT JOIN terminology_performance/, respond: (sql, params) => {
      const aliasMap = (params?.[1] ? JSON.parse(String(params[1])) : {}) as Record<string, string>;
      const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');
      committed = [{ country_name: 'Germany', reason: 'regulatory prohibition' }];
      // A query without the live policy predicate just serves the row (the
      // real database still has it search_eligible until the next lifecycle
      // refresh), which is exactly the check-then-serve bug this locks out.
      if (!/excluded_countries excluded/.test(sql)) return { rows: [{ id: 1, term: 'DAX', lifecycle_status: 'SEARCH_TRIAL', score: 0.5 }] };
      const stored = norm('Germany');
      const resolved = aliasMap[stored] ?? stored;
      const excluded = committed.some(e => norm(e.country_name) === stored || norm(e.country_name) === resolved);
      return { rows: excluded ? [] : [{ id: 1, term: 'DAX', lifecycle_status: 'SEARCH_TRIAL', score: 0.5 }] };
    } }
  ]);
  const rows = await getPlannerTerminology('Germany', runner, { isKillSwitchActive: async () => false });
  assert.deepEqual(rows, [], 'a policy commit between the read and the serving query must still block serving');
  const served = runner.calls.find(c => /FROM canonical_trading_terms t/.test(c.sql));
  assert.match(served!.sql, /excluded_countries excluded/);
  assert.match(served!.sql, /\$2::jsonb/);
});

test('planner serving aborts when the exclusion read fails (fail closed)', async () => {
  await assert.rejects(
    getPlannerTerminology('Germany', makeRunner([throwingExclusions]), { isKillSwitchActive: async () => false }),
    /exclusion-read-failed/
  );
});

test('country-native proposal generation fails closed for an excluded market', async () => {
  const runner = makeRunner([
    excludedGermany,
    { match: /country_native_evidence_projections/, respond: () => ({ rows: [{ canonical_term_id: 1 }] }) }
  ]);
  const proposals = await generateCountryNativeProposals('Germany', 10, { runner });
  assert.deepEqual(proposals, []);
  // Only the exclusion read ran: no eligible-projection query, no fallback.
  assert.equal(runner.calls.length, 1);
});

test('country-native proposal generation still runs for non-excluded markets (guard control)', async () => {
  let eligibleQueried = false;
  const runner = makeRunner([
    noExclusions,
    { match: /country_native_evidence_projections/, respond: () => { eligibleQueried = true; return { rows: [] }; } }
  ]);
  const proposals = await generateCountryNativeProposals('United States', 10, { runner });
  assert.equal(eligibleQueried, true);
  assert.ok(proposals.length > 0); // static bootstrap fallback remains available
});

test('country-native generation fails closed for ISO aliases of excluded markets', async () => {
  const runner = makeRunner([
    excludedPakistan,
    { match: /country_native_evidence_projections/, respond: () => ({ rows: [{ canonical_term_id: 1 }] }) }
  ]);
  const proposals = await generateCountryNativeProposals('PK', 10, { runner });
  assert.deepEqual(proposals, []);
  assert.equal(runner.calls.length, 1);
});

test('country-native generation fails closed when the exclusion read fails', async () => {
  const proposals = await generateCountryNativeProposals('Germany', 10, { runner: makeRunner([throwingExclusions]) });
  assert.deepEqual(proposals, []);
});

test('country-native generation fails closed when the database (and therefore exclusion status) is unavailable', async () => {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const proposals = await generateCountryNativeProposals('Germany', 10);
    assert.deepEqual(proposals, [], 'no static seeds may be emitted while exclusion status is unknown');
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = original;
  }
});

const seedProposal = (country: string) => buildFrontierProposal({
  proposalFamily: 'COUNTRY_NATIVE',
  country,
  concept: 'DAX trading',
  sourceProvenance: `bootstrap_vocabulary:static_bootstrap:${country === 'Germany' ? 'de' : 'us'}`,
  supportingEvidence: { provenanceType: 'bootstrap_vocabulary' },
  confidence: 0.6,
  noveltyRationale: 'static seed'
});

test('the materialization route cannot persist static seeds for an excluded market', async () => {
  const runner = makeRunner([
    excludedGermany,
    { match: /INSERT INTO frontier_discovery_proposals/, respond: () => ({ rows: [], rowCount: 1 }) }
  ]);
  const inserted = await persistFrontierProposals([seedProposal('Germany')], { runner });
  assert.equal(inserted, 0);
  assert.equal(runner.calls.some(c => /INSERT INTO frontier_discovery_proposals/.test(c.sql)), false);
  const lockIndex = runner.calls.findIndex(c => /pg_advisory_xact_lock_shared/.test(c.sql));
  const readIndex = runner.calls.findIndex(c => READ_EXCLUSIONS.test(c.sql));
  assert.ok(lockIndex >= 0 && lockIndex < readIndex, 'the exclusion check runs under the shared policy lock');
});

test('the materialization route still persists static seeds for non-excluded markets (guard control)', async () => {
  const runner = makeRunner([
    noExclusions,
    { match: /INSERT INTO frontier_discovery_proposals/, respond: () => ({ rows: [], rowCount: 1 }) }
  ]);
  const inserted = await persistFrontierProposals([seedProposal('United States')], { runner });
  assert.equal(inserted, 1);
});

test('OSINT proposals do not materialize for an excluded market', async () => {
  const runner = makeRunner([
    excludedGermany,
    { match: /INSERT INTO discovery_neighborhoods/, respond: () => ({ rows: [], rowCount: 1 }) }
  ]);
  const ok = await persistExternalOsintProposal({ country: 'Germany', language: 'de', concept: 'DAX', supportingEvidence: {}, targetDimensions: {} } as any, runner);
  assert.equal(ok, false);
  // Shared policy lock + exclusion read only; no writes.
  assert.equal(runner.calls.length, 2);
  assert.match(runner.calls[0].sql, /pg_advisory_xact_lock_shared/);
  assert.match(runner.calls[1].sql, /FROM excluded_countries/);
});

test('OSINT proposals still materialize for non-excluded markets (guard control)', async () => {
  const runner = makeRunner([
    noExclusions,
    { match: /FROM canonical_trading_terms/, respond: () => ({ rows: [] }) },
    { match: /INSERT INTO discovery_neighborhoods/, respond: () => ({ rows: [], rowCount: 1 }) },
    { match: /INSERT INTO frontier_discovery_proposals/, respond: () => ({ rows: [], rowCount: 1 }) }
  ]);
  const ok = await persistExternalOsintProposal({ country: 'United States', language: 'en', concept: 'ETF', targetNeighborhoodKey: 'us-en-etf-test-neighborhood', supportingEvidence: {}, targetDimensions: {} } as any, runner);
  assert.equal(ok, true);
  assert.ok(runner.calls.some(c => /INSERT INTO discovery_neighborhoods/.test(c.sql)));
});

test('OSINT materialization fills the bounded selection with allowed markets despite excluded aggregates', async () => {
  // The selector walks country/family buckets in sorted order ('Germany'
  // before 'United States'), so with a global cap of one an excluded
  // aggregate would consume the only slot and the allowed market would never
  // be attempted. Excluded aggregates must be filtered out before the
  // bounded selection, not after it.
  const osintObservation = (country: string, id: string): any => ({
    observationId: id, sourceId: `src-${id}`, sourceFamily: 'PUBLIC_COMMUNITY',
    fetchedAt: '2026-10-17T00:00:00.000Z', observedAt: '2026-10-17T00:00:00.000Z',
    country, locale: 'en-US', language: 'en', script: 'Latn', surface: `surface ${country}`,
    canonicalConcept: 'ETF', extractionMethod: 'manual', extractionVersion: 'v1',
    confidence: 0.9, reliability: 0.9, relevance: 0.9, supportingEvidence: {}, contentChecksum: `sum-${id}`, correlationKey: `corr-${id}`
  });
  const runner = makeRunner([
    excludedGermany,
    { match: /pg_advisory_xact_lock_shared/, respond: () => ({ rows: [] }) },
    { match: /FROM canonical_trading_terms/, respond: () => ({ rows: [] }) },
    { match: /INSERT INTO discovery_neighborhoods/, respond: () => ({ rows: [], rowCount: 1 }) },
    { match: /INSERT INTO frontier_discovery_proposals/, respond: () => ({ rows: [{ id: 1 }], rowCount: 1 }) }
  ]);
  const count = await materializeExternalOsintProposals({
    enabled: true,
    observations: [osintObservation('Germany', 'g1'), osintObservation('Germany', 'g2'), osintObservation('United States', 'u1'), osintObservation('United States', 'u2')],
    caps: { global: 1, perSourceFamily: 1, perCountry: 1 },
    runner,
    now: new Date('2026-10-18T00:00:00Z')
  });
  assert.equal(count, 1, 'the allowed market must materialize instead of being starved by the excluded aggregate');
  const inserts = runner.calls.filter(c => /INSERT INTO frontier_discovery_proposals/.test(c.sql));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params?.[1], 'United States', 'only the allowed market may consume the bounded selection');
});

test('OSINT materialization skips the policy read when no aggregate is eligible', async () => {
  const osintEligible = (country: string, id: string): any => ({
    observationId: id, sourceId: `src-${id}`, sourceFamily: 'PUBLIC_COMMUNITY',
    fetchedAt: '2026-10-17T00:00:00.000Z', observedAt: '2026-10-17T00:00:00.000Z',
    country, locale: 'en-US', language: 'en', script: 'Latn', surface: `surface ${country}`,
    canonicalConcept: 'ETF', extractionMethod: 'manual', extractionVersion: 'v1',
    confidence: 0.9, reliability: 0.9, relevance: 0.9, supportingEvidence: {}, contentChecksum: `sum-${id}`, correlationKey: `corr-${id}`
  });
  const runner = makeRunner([excludedGermany]);
  // A single observation per country fails independence, so nothing is
  // eligible: the exclusion list must not be read at all.
  const count = await materializeExternalOsintProposals({
    enabled: true,
    observations: [osintEligible('Germany', 'g1')],
    caps: { global: 1, perSourceFamily: 1, perCountry: 1 },
    runner,
    now: new Date('2026-10-18T00:00:00Z')
  });
  assert.equal(count, 0);
  assert.equal(runner.calls.length, 0, 'no policy read when nothing is eligible to select');
});

test('OSINT persistence fails closed for an ISO alias of an excluded market', async () => {
  const runner = makeRunner([
    excludedGermany,
    { match: /INSERT INTO discovery_neighborhoods/, respond: () => ({ rows: [], rowCount: 1 }) }
  ]);
  const ok = await persistExternalOsintProposal({ country: 'DE', language: 'de', concept: 'DAX', supportingEvidence: {}, targetDimensions: {} } as any, runner);
  assert.equal(ok, false);
  assert.equal(runner.calls.some(c => /INSERT INTO/.test(c.sql)), false);
});

test('OSINT persistence aborts when the exclusion read is malformed (fail closed)', async () => {
  const runner = makeRunner([
    malformedExclusions,
    { match: /INSERT INTO discovery_neighborhoods/, respond: () => ({ rows: [], rowCount: 1 }) }
  ]);
  await assert.rejects(
    persistExternalOsintProposal({ country: 'United States', language: 'en', concept: 'ETF', supportingEvidence: {}, targetDimensions: {} } as any, runner),
    /EXCLUDED_COUNTRIES_READ_MALFORMED/
  );
  assert.equal(runner.calls.some(c => /INSERT INTO/.test(c.sql)), false);
});

const projectionTerm: Handler = {
  match: /FROM canonical_trading_terms[\s\S]{0,80}FOR UPDATE/,
  respond: () => ({ rows: [{ id: 99, canonical_term: 'DAX', normalized_term: 'dax', country: 'Germany', language: 'de', concept_id: null }] })
};
const projectionObservations: Handler = {
  match: /FROM terminology_observations o/,
  respond: () => ({
    rows: [{
      id: 11, source_creator_country: 'Germany', target_market_country: 'Germany', locale: 'de',
      is_code_switched: false, code_switch_type: 'NONE', native_evidence_status: 'BOOTSTRAP_SEED',
      source_provenance_family: 'COUNTRY_VOCABULARY', community_fingerprint: 'community-a',
      source_channel_id: 'chan-1', observed_at: new Date('2026-10-01T00:00:00Z'),
      trading_status: 'TRADING', quality_score: 0.9
    }]
  })
};

test('native evidence projection stays evidence-only: policy is enforced at serving time, never persisted', async () => {
  // Exclusion is a serving decision. Persisting it into the eligibility flag
  // would keep a market hidden after its exclusion is removed until the next
  // recompute, so the projection must not read or embed policy at all.
  const runner = makeRunner([excludedGermany, projectionTerm, projectionObservations]);
  const projection = await recomputeNativeEvidenceProjection(99, runner);
  assert.equal(projection?.nativeProposalEligible, true, 'eligibility stays evidence-derived even while the market is excluded');
  const upsert = runner.calls.find(c => /INSERT INTO country_native_evidence_projections/.test(c.sql));
  assert.ok(upsert);
  assert.equal(upsert?.params?.[27], true);
  assert.equal(
    runner.calls.filter(c => /^SELECT country_name, reason FROM excluded_countries$/.test(c.sql)).length,
    0,
    'projection recompute must not couple policy into persisted evidence flags'
  );
});

test('native evidence projection keeps proposal eligibility for non-excluded markets (guard control)', async () => {
  const runner = makeRunner([noExclusions, projectionTerm, projectionObservations]);
  const projection = await recomputeNativeEvidenceProjection(99, runner);
  assert.equal(projection?.nativeProposalEligible, true);
});

test('allocation candidates exclude an excluded target country without serving stale pending proposals', async () => {
  let neighborhoodQueried = false;
  const runner = makeRunner([
    excludedGermany,
    { match: /FROM discovery_neighborhoods n/, respond: () => { neighborhoodQueried = true; return { rows: [{ neighborhood_key: 'de-de-dax', country: 'Germany', proposal_id: 'prop-germany', proposal_family: 'EXTERNAL_OSINT' }] }; } }
  ]);
  const candidates = await getNeighborhoodCandidates('Germany', new Date(), runner);
  assert.deepEqual(candidates, []);
  assert.equal(neighborhoodQueried, false, 'no candidate query may run for an excluded target country');
});

test('allocation candidates drop rows for excluded countries while keeping allowed markets', async () => {
  const rows = [
    { neighborhood_key: 'de-de-dax', country: 'Germany', proposal_id: 'prop-germany', proposal_family: 'EXTERNAL_OSINT', dimensions: {} },
    { neighborhood_key: 'us-en-sp500', country: 'United States', proposal_id: null, proposal_family: null, dimensions: {} }
  ];
  const runner = makeRunner([
    excludedGermany,
    { match: /FROM discovery_neighborhoods n/, respond: () => ({ rows }) }
  ]);
  const candidates = await getNeighborhoodCandidates(undefined, new Date(), runner);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].country, 'United States');
  assert.equal(candidates[0].proposalId, undefined, 'the excluded market pending proposal must not be served');
});

test('allocation candidate loading aborts when the exclusion read fails (fail closed)', async () => {
  await assert.rejects(getNeighborhoodCandidates('Germany', new Date(), makeRunner([throwingExclusions])), /exclusion-read-failed/);
});

const killSwitchEnabled: Handler = { match: /app_settings/, respond: () => ({ rows: [{ setting_value: 'true' }] }) };
const trialGateProposalRow: Row = {
  proposal_id: 'prop-1', dedup_key: 'dedup-1', proposal_family: 'EXTERNAL_OSINT', country: 'Germany', language: 'de',
  concept: 'DAX', target_neighborhood_key: null, target_dimensions: {}, source_provenance: 'osint:x',
  supporting_evidence: {}, confidence: 0.5, novelty_rationale: 'n', trial_status: 'PENDING', expires_at: null
};

test('trial authorization rejects a pending proposal whose country is excluded', async () => {
  const runner = makeRunner([
    killSwitchEnabled,
    { match: /FROM frontier_discovery_proposals/, respond: () => ({ rows: [trialGateProposalRow] }) },
    excludedGermany
  ]);
  const gate = await evaluateTrialGate('prop-1', 100, runner);
  assert.equal(gate.eligible, false);
  assert.match(gate.reason, /excluded/i);
});

test('trial authorization still admits a healthy proposal for an allowed market (guard control)', async () => {
  const runner = makeRunner([
    killSwitchEnabled,
    { match: /FROM frontier_discovery_proposals/, respond: () => ({ rows: [{ ...trialGateProposalRow, country: 'United States' }] }) },
    noExclusions,
    { match: /frontier_canary_trials/, respond: () => ({ rows: [] }) }
  ]);
  const gate = await evaluateTrialGate('prop-1', 100, runner);
  assert.equal(gate.eligible, true);
});

const germanSurface = (i: number) => ({ concept_id: 1000 + i, surface_id: 2000 + i, literal: `DAX${i}`, normalized: `dax${i}`, language: 'de', script: 'Latn', locale: 'de-DE', country: 'Germany', sense_id: 3000 + i, source_ids: [`artifact-de-${i}`, `artifact-de2-${i}`] });
const usSurface = (i: number) => ({ concept_id: 4000 + i, surface_id: 5000 + i, literal: `S&P 500 futures ${i}`, normalized: `s&p 500 futures ${i}`, language: 'en', script: 'Latn', locale: 'en-US', country: 'United States', sense_id: 6000 + i, source_ids: [`artifact-us-${i}`, `artifact-us2-${i}`] });

test('concept-graph multilingual actions never materialize for an excluded market', async () => {
  const runner = makeRunner([
    excludedGermany,
    { match: /concept_market_affinities/, respond: () => ({ rows: [{ concept_id: 1, surface_id: 2, literal: 'DAX', normalized: 'dax', language: 'de', script: 'Latn', locale: 'de-DE', country: 'Germany', sense_id: 3, source_ids: ['artifact-a', 'artifact-b'] }] }) },
    { match: /research_programs/, respond: () => ({ rows: [{ id: 1, scope: '{}' }] }) }
  ]);
  const count = await generateMultilingualActions('2026-10-18T00:00:00Z', runner);
  assert.equal(count, 0);
  assert.equal(runner.calls.some(c => /INSERT INTO/.test(c.sql)), false);
});

test('concept-graph multilingual actions still materialize for non-excluded markets (guard control)', async () => {
  const runner = makeRunner([
    noExclusions,
    { match: /concept_market_affinities/, respond: () => ({ rows: [usSurface(0)] }) },
    { match: /research_programs/, respond: () => ({ rows: [{ id: 1, scope: '{}' }] }) },
    { match: /INSERT INTO discovery_hypotheses/, respond: () => ({ rows: [{ id: 7 }], rowCount: 1 }) },
    { match: /INSERT INTO discovery_actions/, respond: () => ({ rows: [{ id: 8 }], rowCount: 1 }) }
  ]);
  const count = await generateMultilingualActions('2026-10-18T00:00:00Z', runner);
  assert.equal(count, 1);
  assert.ok(runner.calls.some(c => /INSERT INTO discovery_actions/.test(c.sql)));
});

test('JS-side alias filtering still protects the bounded page window when rows slip the SQL predicate', async () => {
  // The fake ignores the query's exclusion predicate, simulating rows the SQL
  // layer missed (spellings beyond the alias universe). The in-code matcher
  // must still keep them out of the batch, and pagination must walk past
  // their window to reach the eligible rows behind them.
  const corpus = [...Array.from({ length: 205 }, (_, i) => germanSurface(i)), usSurface(0), usSurface(1)];
  const offsets: number[] = [];
  const runner = makeRunner([
    excludedGermany,
    { match: /concept_market_affinities/, respond: (_sql, params) => { const offset = Number(params?.[2] ?? 0); const limit = Number(params?.[1] ?? 200); offsets.push(offset); return { rows: corpus.slice(offset, offset + limit) }; } },
    { match: /research_programs/, respond: () => ({ rows: [{ id: 1, scope: '{}' }] }) },
    { match: /INSERT INTO discovery_hypotheses/, respond: () => ({ rows: [{ id: 7 }], rowCount: 1 }) },
    { match: /INSERT INTO discovery_actions/, respond: () => ({ rows: [{ id: 8 }], rowCount: 1 }) }
  ]);
  const count = await generateMultilingualActions('2026-10-18T00:00:00Z', runner);
  assert.ok(count >= 1, 'eligible rows beyond the exclusion window must be processed');
  assert.deepEqual(offsets, [0, 200], 'bounded pagination: two windows cover 205 excluded rows followed by eligible rows');
  assert.ok(runner.calls.some(c => /INSERT INTO discovery_actions/.test(c.sql)));
});

test('alias-form excluded rows are rejected in SQL and cannot consume page slots', async () => {
  // 1005 rows stored as the ISO alias 'DE' while 'Germany' is excluded. If
  // they were only filtered in code they would exhaust the entire former
  // five-page budget (1000 rows) and the two eligible US rows behind them
  // would never be reached. The emulated database applies the query's own
  // predicate: match the live policy table using the alias-resolution map
  // parameter ($4), so alias rows are removed before LIMIT/OFFSET.
  const germanAliasRow = (i: number): Row => ({ ...germanSurface(i), country: 'DE' });
  const corpus: Row[] = [...Array.from({ length: 1005 }, (_, i) => germanAliasRow(i)), usSurface(0), usSurface(1)];
  const offsets: number[] = [];
  const runner = makeRunner([
    excludedGermany,
    { match: /concept_market_affinities/, respond: (sql, params) => {
      const aliasMap = (params?.[3] ? JSON.parse(String(params[3])) : {}) as Record<string, string>;
      const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');
      const excluded = (country: string) => {
        const stored = norm(country);
        const resolved = aliasMap[stored] ?? stored;
        return norm('Germany') === stored || norm('Germany') === resolved;
      };
      const offset = Number(params?.[2] ?? 0);
      const limit = Number(params?.[1] ?? 200);
      offsets.push(offset);
      return { rows: corpus.filter(row => !excluded(String(row.country))).slice(offset, offset + limit) };
    } },
    { match: /research_programs/, respond: () => ({ rows: [{ id: 1, scope: '{}' }] }) },
    { match: /INSERT INTO discovery_hypotheses/, respond: () => ({ rows: [{ id: 7 }], rowCount: 1 }) },
    { match: /INSERT INTO discovery_actions/, respond: () => ({ rows: [{ id: 8 }], rowCount: 1 }) }
  ]);
  const count = await generateMultilingualActions('2026-10-18T00:00:00Z', runner);
  assert.equal(count, 2, 'the eligible batch must be filled despite >1000 alias-form excluded rows');
  assert.deepEqual(offsets, [0], 'alias rows must be rejected before the window: one page fills the batch');
  const paged = runner.calls.find(c => /concept_market_affinities/.test(c.sql));
  assert.match(paged!.sql, /excluded_countries excluded/, 'the query must filter against the live policy table');
  assert.match(paged!.sql, /\$4::jsonb/, 'the statement must carry the alias resolution map');
  assert.equal(JSON.parse(String(paged!.params?.[3])).de, 'germany', "SQL alias resolution must map 'de' to 'germany', matching the in-code matcher");
});

test('modeled localized variants resolve for exclusion matching in code and in the SQL map', () => {
  // The domicile layer already models localized/exonym spellings
  // (BARE_COUNTRY_NAME_VARIANTS). Exclusion identity shares that universe, or
  // a stored "Côte d'Ivoire" row would slip past an 'Ivory Coast' policy.
  const ivoryCoast = { country_name: 'Ivory Coast', reason: 'regulatory prohibition' };
  assert.ok(findCountryExclusionWithAliases("Côte d'Ivoire", [ivoryCoast]), 'localized spelling must match');
  assert.ok(findCountryExclusionWithAliases('cote divoire', [ivoryCoast]), 'plain-ASCII variant must match');
  assert.ok(findCountryExclusionWithAliases('Česká republika', [{ country_name: 'Czechia', reason: 'regulatory prohibition' }]), 'diacritic variant must match');
  assert.equal(findCountryExclusionWithAliases('Germany', [ivoryCoast]), null, 'other markets stay allowed');
  const map = JSON.parse(countryAliasResolutionJson()) as Record<string, string>;
  assert.equal(map["côte d'ivoire"], 'ivory coast', 'the SQL map must resolve localized variants too');
  assert.equal(map['česká republika'], 'czechia');
  assert.equal(map['de'], 'germany');
});

test('the shared identity-resolution table is frozen: importers cannot corrupt either matcher', () => {
  const resolution = countryIdentityResolution();
  assert.ok(Object.isFrozen(resolution), 'the resolution universe backing both matchers must be immutable');
  assert.throws(
    () => { (resolution as Record<string, string>)['de'] = 'france'; },
    TypeError,
    'mutation attempts must fail instead of silently redirecting exclusion matching'
  );
  assert.equal(countryIdentityResolution()['de'], 'germany');
  assert.equal(findCountryExclusionWithAliases('DE', [{ country_name: 'Germany', reason: 'x' }])?.country, 'Germany');
});

test('pagination has a hard page backstop: a window that never advances cannot loop unbounded', async () => {
  // Pathological runner: every window returns a full page of excluded rows
  // that only the JS matcher drops (a SQL/JS mismatch deeper than the
  // modeled identity universe). The loop must stop at the backstop instead
  // of issuing full-window queries forever.
  const offsets: number[] = [];
  const runner = makeRunner([
    excludedGermany,
    { match: /concept_market_affinities/, respond: (_sql, params) => { offsets.push(Number(params?.[2] ?? 0)); return { rows: Array.from({ length: 200 }, (_, i) => ({ ...germanSurface(i), surface_id: 8000 + i })) }; } },
    { match: /research_programs/, respond: () => ({ rows: [{ id: 1, scope: '{}' }] }) }
  ]);
  const count = await generateMultilingualActions('2026-10-18T00:00:00Z', runner);
  assert.equal(count, 0, 'no allowed surface exists in the pathological corpus');
  assert.equal(offsets.length, 100, 'the hard backstop ends the scan after 100 windows');
  assert.equal(offsets[99], 99 * 200);
});

test('pagination order is total: ties cannot skip or duplicate eligible surfaces across offset pages', async () => {
  // 205 excluded German rows and 2 eligible US rows share one
  // (concept, locale) bucket, with the US rows straddling the 200-row page
  // boundary. Under a non-total ORDER BY (c.id, s.locale only) PostgreSQL is
  // free to resolve the tie differently for each offset query, so an eligible
  // row that sits near the boundary can be skipped (or repeated). The fake
  // emulates exactly that freedom - insertion order for offset 0, reversed
  // insertion order afterwards - so this test fails if the pagination order
  // loses any grouping-key tiebreaker.
  const tieRow = (idx: number, country: string, surfaceId: number): Row => ({
    concept_id: 1, surface_id: surfaceId, literal: `tie ${surfaceId}`, normalized: `tie ${surfaceId}`,
    language: country === 'United States' ? 'en' : 'de', script: 'Latn', locale: 'en-US',
    country, sense_id: 9000 + idx, source_ids: [`artifact-tie-${idx}`, `artifact-tie2-${idx}`], __idx: idx
  });
  const corpus: Row[] = [
    ...Array.from({ length: 199 }, (_, i) => tieRow(i, 'Germany', 1000 + i)),
    tieRow(199, 'United States', 5000),
    tieRow(200, 'United States', 5001),
    ...Array.from({ length: 6 }, (_, i) => tieRow(201 + i, 'Germany', 1200 + i))
  ];
  const orderField = (key: string, row: Row) =>
    key === 'c.id' ? row.concept_id : key === 's.locale' ? row.locale : key === 's.id' ? row.surface_id : key === 'a.country' ? row.country : key === 'cs.id' ? row.sense_id : undefined;
  const offsets: number[] = [];
  const runner = makeRunner([
    excludedGermany,
    { match: /concept_market_affinities/, respond: (sql, params) => {
      const order = (sql.match(/ORDER BY (.+?) LIMIT/) || [])[1]?.split(',').map(k => k.trim()) ?? [];
      const offset = Number(params?.[2] ?? 0);
      const limit = Number(params?.[1] ?? 200);
      offsets.push(offset);
      const rows = [...corpus].sort((a, b) => {
        for (const key of order) {
          const av = orderField(key, a), bv = orderField(key, b);
          if (av !== bv) return av < bv ? -1 : 1;
        }
        // Reached only for rows the ORDER BY leaves tied: the cross-page
        // freedom PostgreSQL has (and that must never be reachable).
        return offset === 0 ? a.__idx - b.__idx : b.__idx - a.__idx;
      });
      return { rows: rows.slice(offset, offset + limit) };
    } },
    { match: /research_programs/, respond: () => ({ rows: [{ id: 1, scope: '{}' }] }) },
    { match: /INSERT INTO discovery_hypotheses/, respond: () => ({ rows: [{ id: 7 }], rowCount: 1 }) },
    { match: /INSERT INTO discovery_actions/, respond: () => ({ rows: [{ id: 8 }], rowCount: 1 }) }
  ]);
  const count = await generateMultilingualActions('2026-10-18T00:00:00Z', runner);
  assert.equal(count, 2, 'both eligible surfaces must survive pagination when the ORDER BY is total');
  assert.deepEqual(offsets, [0, 200], 'bounded pagination: two windows cover the tie bucket');
  const paged = runner.calls.find(c => /concept_market_affinities/.test(c.sql));
  assert.match(paged!.sql, /ORDER BY c\.id,s\.locale,s\.id,a\.country,cs\.id LIMIT \$2 OFFSET \$3/, 'every GROUP BY key must act as an ordering tiebreaker so offset pages are deterministic');
});

test('concept-graph action generation aborts when the exclusion read fails (fail closed)', async () => {
  const runner = makeRunner([
    throwingExclusions,
    { match: /concept_market_affinities/, respond: () => ({ rows: [usSurface(0)] }) },
    { match: /research_programs/, respond: () => ({ rows: [{ id: 1, scope: '{}' }] }) }
  ]);
  await assert.rejects(generateMultilingualActions('2026-10-18T00:00:00Z', runner), /exclusion-read-failed/);
  assert.equal(runner.calls.some(c => /INSERT INTO/.test(c.sql)), false);
});

test('malformed exclusion reads are rejected, never treated as no exclusions', async () => {
  await assert.rejects(readExcludedCountries({ query: async () => ({}) as any }), /EXCLUDED_COUNTRIES_READ_MALFORMED/);
  await assert.rejects(readExcludedCountries({ query: async () => ({ rows: null }) as any }), /EXCLUDED_COUNTRIES_READ_MALFORMED/);
  await assert.rejects(readExcludedCountries({ query: async () => ({ rows: [{}] }) }), /EXCLUDED_COUNTRIES_READ_MALFORMED/);
  await assert.rejects(readExcludedCountries({ query: async () => ({ rows: [{ country_name: '', reason: 'x' }] }) }), /EXCLUDED_COUNTRIES_READ_MALFORMED/);
  await assert.rejects(readExcludedCountries({ query: async () => ({ rows: [{ country_name: 'Germany' }] }) }), /EXCLUDED_COUNTRIES_READ_MALFORMED/);
  // A legitimate empty row set stays a valid, empty policy.
  assert.deepEqual(await readExcludedCountries({ query: async () => ({ rows: [] }) }), []);
});

test('exclusion matching resolves ISO aliases on the input identity', () => {
  const exclusions = [{ country_name: 'Pakistan', reason: 'regulatory prohibition' }];
  assert.equal(findCountryExclusionWithAliases('PK', exclusions)?.country, 'Pakistan');
  assert.equal(findCountryExclusionWithAliases('pk', exclusions)?.country, 'Pakistan');
  assert.equal(findCountryExclusionWithAliases('Pakistan', exclusions)?.country, 'Pakistan');
  assert.equal(findCountryExclusionWithAliases(null, exclusions), null);
  assert.equal(findCountryExclusionWithAliases('India', exclusions), null, 'allowed countries stay allowed');
});

test('a blank exclusion name is rejected before the write can fail every guarded read closed', async () => {
  const runner = makeRunner([{ match: /INSERT INTO excluded_countries/, respond: () => ({ rows: [], rowCount: 1 }) }]);
  for (const blank of ['', '   ', '\u00a0']) {
    await assert.rejects(
      addExcludedCountryGuarded(runner as any, { country_name: blank, reason: 'regulatory prohibition' }),
      /EXCLUDED_COUNTRY_NAME_REQUIRED/
    );
  }
  assert.equal(runner.calls.length, 0, 'no advisory lock and no insert may run for an unreadable name');
});

test('an exclusion row stored in an alias or localized form is canonicalized on the stored side too', async () => {
  const storedAlias = [{ country_name: 'DE', reason: 'regulatory prohibition' }];
  assert.equal(findCountryExclusionWithAliases('Germany', storedAlias)?.country, 'DE', 'canonical candidate must match a stored ISO alias');
  assert.equal(findCountryExclusionWithAliases('de', storedAlias)?.country, 'DE');
  assert.equal(
    findCountryExclusionWithAliases('Ivory Coast', [{ country_name: "Côte d'Ivoire", reason: 'regulatory prohibition' }])?.country,
    "Côte d'Ivoire",
    'stored localized variant must match the canonical candidate'
  );
  assert.equal(findCountryExclusionWithAliases('France', storedAlias), null, 'other markets stay allowed');
  // The guarded write path applies the same stored-side identity.
  const runner = makeRunner([
    { match: READ_EXCLUSIONS, respond: () => ({ rows: storedAlias }) },
    { match: /INSERT INTO frontier_discovery_proposals/, respond: () => ({ rows: [], rowCount: 1 }) }
  ]);
  const inserted = await persistFrontierProposals([seedProposal('Germany')], { runner });
  assert.equal(inserted, 0, 'an alias-form policy row must still block the canonical market');
  assert.equal(runner.calls.some(c => /INSERT INTO frontier_discovery_proposals/.test(c.sql)), false);
});

test('the SQL prefilter resolves stored policy rows through the same identity map (parity lock)', () => {
  const sql = excludedCountrySqlPredicate('n.country', '$3');
  assert.match(sql, /excluded_countries excluded/);
  assert.match(sql, /\$3::jsonb ->> lower\(regexp_replace\(trim\(excluded\.country_name\)/, 'the stored policy row must be resolved through the alias map');
  assert.match(sql, /\$3::jsonb ->> lower\(regexp_replace\(trim\(n\.country\)/, 'the candidate column must be resolved through the alias map');
  assert.equal(sql.includes(' OR '), false, 'a single canonical-vs-canonical comparison covers both sides');
});

test('a standalone pg.Client runner is reused, never mistaken for a Pool (pool ownership)', async () => {
  // A standalone Client exposes connect() but is itself the queryable:
  // checking it out would call connect() on the caller's client and then try
  // to release() a Client (which has no release). connect() must never run.
  const connectMustNotBeCalled = () => { throw new Error('connect() must not be called on a caller-supplied client'); };

  const frontierRunner: any = makeRunner([
    noExclusions,
    { match: /INSERT INTO frontier_discovery_proposals/, respond: () => ({ rows: [], rowCount: 1 }) }
  ]);
  frontierRunner.connect = connectMustNotBeCalled;
  assert.equal(await persistFrontierProposals([seedProposal('United States')], { runner: frontierRunner }), 1);
  assert.ok(frontierRunner.calls.some(c => /INSERT INTO frontier_discovery_proposals/.test(c.sql)));

  const osintRunner: any = makeRunner([
    noExclusions,
    { match: /FROM canonical_trading_terms/, respond: () => ({ rows: [] }) },
    { match: /INSERT INTO discovery_neighborhoods/, respond: () => ({ rows: [], rowCount: 1 }) },
    { match: /INSERT INTO frontier_discovery_proposals/, respond: () => ({ rows: [], rowCount: 1 }) }
  ]);
  osintRunner.connect = connectMustNotBeCalled;
  const persisted = await persistExternalOsintProposal({ country: 'United States', language: 'en', concept: 'ETF', targetNeighborhoodKey: 'us-en-etf-client', supportingEvidence: {}, targetDimensions: {} } as any, osintRunner);
  assert.equal(persisted, true);
  assert.ok(osintRunner.calls.some(c => /INSERT INTO frontier_discovery_proposals/.test(c.sql)));

  const actionRunner: any = makeRunner([
    noExclusions,
    { match: /concept_market_affinities/, respond: () => ({ rows: [usSurface(0)] }) },
    { match: /research_programs/, respond: () => ({ rows: [{ id: 1, scope: '{}' }] }) },
    { match: /INSERT INTO discovery_hypotheses/, respond: () => ({ rows: [{ id: 7 }], rowCount: 1 }) },
    { match: /INSERT INTO discovery_actions/, respond: () => ({ rows: [{ id: 8 }], rowCount: 1 }) }
  ]);
  actionRunner.connect = connectMustNotBeCalled;
  assert.equal(await generateMultilingualActions('2026-10-18T00:00:00Z', actionRunner), 1);
  assert.ok(actionRunner.calls.some(c => /INSERT INTO discovery_actions/.test(c.sql)));
});

test('a connect-only pool double is still checked out under the guarded write (pool discipline unchanged)', async () => {
  const statements: string[] = [];
  let released = 0;
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (/INSERT INTO frontier_discovery_proposals/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
    release: () => { released += 1; }
  };
  let checkedOut = 0;
  const pool: any = { connect: async () => { checkedOut += 1; return client; } };
  const inserted = await persistFrontierProposals([seedProposal('United States')], { runner: pool });
  assert.equal(inserted, 1);
  assert.equal(checkedOut, 1, 'the pool must hand out exactly one client');
  assert.equal(released, 1, 'the checked-out client must be released');
  assert.equal(statements[0], 'BEGIN', 'the guarded write must own a transaction on the checked-out client');
  assert.ok(statements.includes('COMMIT'));
});

// ---------------------------------------------------------------------------
// Concurrency: an exclusion committed mid-write cannot bypass a guarded check
// ---------------------------------------------------------------------------

type LockRegistry = { shared: number; exclusive: boolean };

// Bounded cooperative wait (same 3s deadline used by the advisory-lock waits
// below): a regression that stalls the guarded write before the protected
// insert must fail the suite, never hang it.
const waitFor = async (condition: () => boolean, timeoutMessage: string) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 3000) throw new Error(timeoutMessage);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
};

function makePolicySession(registry: LockRegistry, exclusionStore: Row[], name: string, order: string[], pause: { armed: boolean; reached: boolean; resume: () => void; gate: Promise<void> }) {
  let heldShared = 0;
  let heldExclusive = false;
  return {
    async query(sql: string, params?: any[]) {
      if (/^BEGIN$/.test(sql)) return { rows: [] };
      if (/^COMMIT$/.test(sql) || /^ROLLBACK$/.test(sql)) {
        if (heldExclusive) { registry.exclusive = false; heldExclusive = false; }
        registry.shared -= heldShared; heldShared = 0;
        return { rows: [] };
      }
      if (/pg_advisory_xact_lock_shared/.test(sql)) {
        await waitFor(() => !registry.exclusive, `${name}: advisory lock wait timed out`);
        registry.shared += 1; heldShared += 1;
        return { rows: [] };
      }
      if (/pg_advisory_xact_lock\(/.test(sql)) {
        await waitFor(() => !registry.exclusive && registry.shared === 0, `${name}: advisory lock wait timed out`);
        registry.exclusive = true; heldExclusive = true;
        return { rows: [] };
      }
      if (READ_EXCLUSIONS.test(sql)) return { rows: exclusionStore.map(row => ({ ...row })) };
      if (/INSERT INTO excluded_countries/.test(sql)) {
        exclusionStore.push({ country_name: params?.[0], reason: params?.[1] });
        order.push(`${name}:exclusion-insert`);
        return { rows: [], rowCount: 1 };
      }
      if (/FROM canonical_trading_terms/.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO discovery_neighborhoods/.test(sql)) {
        if (pause.armed) { pause.armed = false; pause.reached = true; await pause.gate; }
        order.push(`${name}:neighborhood-insert`);
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO frontier_discovery_proposals/.test(sql)) {
        order.push(`${name}:proposal-insert`);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    }
  };
}

test('an exclusion committed mid-write cannot bypass the guarded check (advisory-lock protocol)', async () => {
  const registry: LockRegistry = { shared: 0, exclusive: false };
  const exclusionStore: Row[] = [];
  const order: string[] = [];
  let resume: () => void = () => {};
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const pause = { armed: true, reached: false, resume, gate };

  const guarded = makePolicySession(registry, exclusionStore, 'guard', order, pause);
  const writer = makePolicySession(registry, exclusionStore, 'writer', order, { armed: false, reached: false, resume: () => {}, gate: Promise.resolve() });
  const proposal = {
    country: 'Germany', language: 'de', concept: 'DAX', targetNeighborhoodKey: 'de-de-dax-race',
    supportingEvidence: { evidenceRevision: '1' }, targetDimensions: {}, dedupKey: 'race-dedup',
    sourceProvenance: 'osint:race', confidence: 0.5, noveltyRationale: 'race', trialStatus: 'PENDING',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString()
  } as any;

  await guarded.query('BEGIN');
  const guardedWrite = persistExternalOsintProposal(proposal, guarded as any);
  await waitFor(() => pause.reached, 'guarded write never reached the protected insert');

  // The guarded write has read the (empty) exclusion list and holds the shared
  // policy lock. Start the policy writer: it must block on the exclusive lock.
  await writer.query('BEGIN');
  const policyWrite = addExcludedCountryGuarded(writer as any, { country_name: 'Germany', reason: 'regulatory prohibition' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(registry.shared, 1, 'guarded write must hold the shared policy lock across check and write');
  assert.equal(registry.exclusive, false, 'policy writer must not hold the exclusive lock while a guarded write is in flight');
  assert.equal(order.length, 0, 'no write may have committed between the guarded check and the guarded write');

  // Release the guarded write: it commits first; only then can the exclusion commit.
  pause.resume();
  assert.equal(await guardedWrite, true, 'guarded proposal persists under the pre-change policy');
  await guarded.query('COMMIT');
  await policyWrite;
  await writer.query('COMMIT');
  assert.deepEqual(order, ['guard:neighborhood-insert', 'guard:proposal-insert', 'writer:exclusion-insert'],
    'the exclusion commits strictly after the guarded write that checked before the change');

  // A guarded write started after the policy change sees the exclusion and fails closed.
  await guarded.query('BEGIN');
  const blocked = await persistExternalOsintProposal({ ...proposal, dedupKey: 'race-dedup-2' }, guarded as any);
  await guarded.query('COMMIT');
  assert.equal(blocked, false, 'a guarded write started after the change must observe the exclusion');
  assert.equal(order.length, 3, 'the blocked guarded write performed no writes');
});
