import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshTerminologyLifecycle, getPlannerTerminology } from './terminologyIntelligence';
import { recomputeNativeEvidenceProjection } from './countryNativeIntelligence';
import { generateCountryNativeProposals } from './discoveryProposalGenerators';
import { persistExternalOsintProposal } from './externalOsint';
import { generateMultilingualActions } from './persistentResearchController';

// Excluded-country guardrails: excluded markets are evidence-only. These
// tests drive every path that could make an excluded country search-eligible
// (lifecycle promotion, planner serving, native proposal projections,
// country-native proposals, external OSINT, concept-graph multilingual
// actions) through a recording fake runner and assert that the path fails
// closed. Controls with a non-excluded market prove the guards are specific
// to the exclusion list and do not disable the underlying behavior.

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

const excludedGermany: Handler = {
  match: /FROM excluded_countries/,
  respond: () => ({ rows: [{ country_name: 'Germany', reason: 'regulatory prohibition' }] })
};
const noExclusions: Handler = { match: /FROM excluded_countries/, respond: () => ({ rows: [] }) };
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

test('a failing exclusion read aborts the refresh instead of promoting (fail closed)', async () => {
  const readonlyFailure: Handler = { match: /FROM excluded_countries/, respond: () => { throw new Error('exclusion-read-failed'); } };
  const runner = makeRunner([readonlyFailure, noNativeQuality, noLifecycleEvents, lifecycleTerm(TRIAL_READY_NOT_ELIGIBLE)]);
  await assert.rejects(refreshTerminologyLifecycle(42, undefined, runner), /exclusion-read-failed/);
  assert.equal(runner.calls.filter(c => /INSERT INTO terminology_lifecycle_events/.test(c.sql)).length, 0);
  assert.equal(runner.calls.filter(c => /UPDATE canonical_trading_terms/.test(c.sql)).length, 0);
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

test('OSINT proposals do not materialize for an excluded market', async () => {
  const runner = makeRunner([
    excludedGermany,
    { match: /INSERT INTO discovery_neighborhoods/, respond: () => ({ rows: [], rowCount: 1 }) }
  ]);
  const ok = await persistExternalOsintProposal({ country: 'Germany', language: 'de', concept: 'DAX', supportingEvidence: {}, targetDimensions: {} } as any, runner);
  assert.equal(ok, false);
  assert.equal(runner.calls.length, 1);
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

test('native evidence projection suppresses proposal eligibility for an excluded market', async () => {
  const runner = makeRunner([excludedGermany, projectionTerm, projectionObservations]);
  const projection = await recomputeNativeEvidenceProjection(99, runner);
  assert.equal(projection?.nativeProposalEligible, false);
  const upsert = runner.calls.find(c => /INSERT INTO country_native_evidence_projections/.test(c.sql));
  assert.ok(upsert);
  assert.equal(upsert?.params?.[27], false);
});

test('native evidence projection keeps proposal eligibility for non-excluded markets (guard control)', async () => {
  const runner = makeRunner([noExclusions, projectionTerm, projectionObservations]);
  const projection = await recomputeNativeEvidenceProjection(99, runner);
  assert.equal(projection?.nativeProposalEligible, true);
});

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
