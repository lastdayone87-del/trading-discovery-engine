import assert from 'node:assert/strict';
import test from 'node:test';
import { triageAutonomousSearchCandidate } from './candidateTriage';
import { creatorLevelCountryEvidence } from './countryValidator';
import { nominationIdentity } from './candidateAdmission/store';
import type { DiscoveredChannelRaw } from './youtube';
import {
  aggregateRelationshipCohort,
  buildRelationshipProvenance,
  isRelationshipCanaryLive,
  planRelationshipExpansion,
  processRelationshipCanaryJob,
  validateRelationshipCanaryPayload,
} from './relationshipCanary';

const UC = (suffix: string) => `UC${suffix.padEnd(22, '0').slice(0, 22)}`;
const genericRaw = (overrides: Partial<DiscoveredChannelRaw> = {}): DiscoveredChannelRaw => ({
  channelId: UC('generic'),
  channelName: 'Mk Kitchen Daily',
  youtubeUrl: 'https://www.youtube.com/channel/UCgeneric',
  description: 'Family recipes and kitchen stories.',
  videoTitles: [],
  matchedDocument: { type: 'PLAYLIST', providerNativeId: 'PLx', title: 'Weeknight dinners', description: 'pasta and soup' },
  ...overrides,
});

// 1. Relationship-derived candidates enter without any keyword match.
test('relationship cohort generic candidate is plausible without keywords', () => {
  const decision = triageAutonomousSearchCandidate(
    genericRaw({
      relationshipProvenance: buildRelationshipProvenance({ cohortId: 'canary-1', kind: 'playlist', depth: 1, parentChannelId: UC('seed'), path: [UC('seed')] }),
    }),
    'automated_query',
    false,
  );
  assert.equal(decision.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.ok(decision.reasonCodes.includes('RELATIONSHIP_DERIVED_HYPOTHESIS'));
  assert.ok(decision.matchedSignals.includes('RELATIONSHIP_PLAYLIST'));
});

// 5. Keyword path unchanged: same generic candidate without marker is withheld.
test('generic candidate without relationship marker stays withheld', () => {
  const decision = triageAutonomousSearchCandidate(genericRaw(), 'automated_query', false);
  assert.equal(decision.disposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
});

// Stale retrieval still wins over relationship markers (safety order preserved).
test('stale video with relationship marker stays withheld', () => {
  const decision = triageAutonomousSearchCandidate(
    genericRaw({
      matchedDocument: { type: 'VIDEO', providerNativeId: 'v1', title: 'x', publishedAt: '2000-01-01T00:00:00Z' },
      relationshipProvenance: buildRelationshipProvenance({ cohortId: 'canary-1', kind: 'featured', depth: 1, path: [UC('seed')] }),
    }),
    'automated_query',
    false,
  );
  assert.equal(decision.disposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
});

// Invalid markers (depth 3, blank cohort) fall through to keyword logic.
test('out-of-bounds relationship markers do not bypass the keyword gate', () => {
  const deep = triageAutonomousSearchCandidate(
    genericRaw({ relationshipProvenance: buildRelationshipProvenance({ cohortId: 'canary-1', kind: 'featured', depth: 3, path: [UC('a'), UC('b')] }) }),
    'automated_query',
    false,
  );
  assert.equal(deep.disposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
});

// 3. Relationship evidence alone never proves trading identity or leaks into country evidence.
test('relationship marker is hypothesis-only and invisible to country attribution', () => {
  const evidence = creatorLevelCountryEvidence({
    channelName: 'Mk Kitchen Daily',
    description: '',
    socialBios: [],
    ...( { relationshipProvenance: buildRelationshipProvenance({ cohortId: 'c', kind: 'featured', depth: 1, path: [] }) } as Record<string, unknown> ),
  } as Parameters<typeof creatorLevelCountryEvidence>[0]);
  assert.ok(!('relationshipProvenance' in evidence));
});

// 4. Corroborated relationship candidates proceed exactly like keyword ones.
test('relationship with keyword text yields the same plausible disposition', () => {
  const keywordOnly = triageAutonomousSearchCandidate(
    genericRaw({ channelName: 'NQ Futures Trader', description: '', matchedDocument: { type: 'CHANNEL', providerNativeId: 'x', title: 'NQ Futures Trader' } }),
    'automated_query',
    false,
  );
  const relationship = triageAutonomousSearchCandidate(
    genericRaw({
      channelName: 'NQ Futures Trader',
      description: '',
      relationshipProvenance: buildRelationshipProvenance({ cohortId: 'c', kind: 'featured', depth: 1, path: [UC('seed')] }),
    }),
    'automated_query',
    false,
  );
  assert.equal(keywordOnly.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.equal(relationship.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
});

// 7. Depth bound enforced at validation and planning.
test('payload validation rejects depth beyond 2', () => {
  assert.throws(
    () => validateRelationshipCanaryPayload({ cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('a') }], maxDepth: 3, maxFanout: 5, maxChannels: 50 }),
    /DEPTH_EXCEEDED/,
  );
  const ok = validateRelationshipCanaryPayload({ cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('a') }], maxDepth: 2, maxFanout: 5, maxChannels: 50 });
  assert.equal(ok.maxDepth, 2);
});

test('planner never emits depth 3 and caps depth-2 parents', () => {
  const l1 = Array.from({ length: 12 }, (_, i) => UC(`l1${i}`));
  const seedOf: Record<string, string> = {};
  for (const id of l1) seedOf[id] = UC('seed');
  const plan = planRelationshipExpansion({ seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 2, maxFanout: 10, depth1ChannelIds: l1, seedOf });
  assert.ok(plan.length <= 5);
  assert.ok(plan.every(item => item.depth === 2));
  const shallow = planRelationshipExpansion({ seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 1, maxFanout: 10, depth1ChannelIds: l1, seedOf });
  assert.equal(shallow.length, 0);
});

// 8. Fanout / cohort bounds enforced.
test('payload validation enforces fanout, seed, and channel caps', () => {
  const base = { cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('a') }], maxDepth: 2, maxFanout: 5, maxChannels: 50 };
  assert.throws(() => validateRelationshipCanaryPayload({ ...base, maxFanout: 11 }), /FANOUT/);
  assert.throws(() => validateRelationshipCanaryPayload({ ...base, seeds: [] }), /SEEDS/);
  assert.throws(
    () => validateRelationshipCanaryPayload({ ...base, seeds: Array.from({ length: 11 }, (_, i) => ({ kind: 'channel', id: UC(`s${i}`) })) }),
    /SEEDS/,
  );
  assert.throws(() => validateRelationshipCanaryPayload({ ...base, seeds: [{ kind: 'channel', id: 'nope' }] }), /CHANNEL_SEED/);
  assert.throws(() => validateRelationshipCanaryPayload({ ...base, cohortId: '' }), /COHORT/);
});

// 9. Kill switch matrix + worker inertness.
test('kill-switch predicate defaults to inert', () => {
  assert.equal(isRelationshipCanaryLive({ enabled: false, killSwitch: true }), false);
  assert.equal(isRelationshipCanaryLive({ enabled: true, killSwitch: true }), false);
  assert.equal(isRelationshipCanaryLive({ enabled: false, killSwitch: false }), false);
  assert.equal(isRelationshipCanaryLive({ enabled: true, killSwitch: false }), true);
});

test('killed canary performs zero provider spend', async () => {
  let fetches = 0;
  const summary = await processRelationshipCanaryJob(
    { id: 'job-1', payload: { cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 2, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      settings: { enabled: false, killSwitch: true, quotaPercent: 1 },
      fetchFeaturedChannels: async () => { fetches++; return { observations: [] }; },
      log: () => {},
    },
  );
  assert.equal(summary.status, 'KILLED');
  assert.equal(fetches, 0);
  assert.equal(summary.nominations, 0);
});

// 10. Duplicates do not multiply: same channel+parent shares a nomination key.
test('nomination identity dedupes identical relationship observations', () => {
  const base = {
    channelId: UC('dup'),
    sourceType: 'FEATURED_CHANNEL',
    query: UC('seed'),
    country: 'US',
    retrievalLane: 'FEATURED_CHANNEL',
    resultRank: 1,
    matchedDocument: { type: 'EXTERNAL', providerNativeId: UC('dup') },
    rawObservation: { sourceChannelId: UC('seed'), cohortId: 'c' },
  } as const;
  const first = nominationIdentity({ ...base });
  const second = nominationIdentity({ ...base });
  assert.equal(first.key, second.key);
  const otherParent = nominationIdentity({ ...base, query: UC('other'), rawObservation: { sourceChannelId: UC('other'), cohortId: 'c' } });
  assert.notEqual(first.key, otherParent.key);
});

// 10b. Worker visited-set: same channel from two seeds ingested once.
test('worker ingests duplicate channels once across seeds', async () => {
  const ingested: string[] = [];
  const dup = UC('dupchan');
  const summary = await processRelationshipCanaryJob(
    { id: 'job-1', payload: { cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed1') }, { kind: 'channel', id: UC('seed2') }], maxDepth: 1, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      settings: { enabled: true, killSwitch: false, quotaPercent: 1 },
      dailyBudget: 10000,
      checkCountryAllowed: async () => {},
      fetchFeaturedChannels: async () => ({ observations: [{ featuredChannelId: dup }] }),
      nominate: async () => ({ id: 'n1' }),
      ingest: async (raw) => { ingested.push(raw.channelId); },
      reserveQuota: async () => true,
      finishQuota: async () => {},
      log: () => {},
    },
  );
  assert.deepEqual(ingested, [dup]);
  assert.equal(summary.nominations, 1);
});

// 11. Per-seed isolation preserves siblings and job ownership semantics.
test('seed failure is isolated; siblings proceed and job completes with record', async () => {
  const ingested: string[] = [];
  const good = UC('goodchan');
  const summary = await processRelationshipCanaryJob(
    { id: 'job-1', payload: { cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('badseed') }, { kind: 'channel', id: UC('goodseed') }], maxDepth: 1, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      settings: { enabled: true, killSwitch: false, quotaPercent: 1 },
      dailyBudget: 10000,
      checkCountryAllowed: async () => {},
      fetchFeaturedChannels: async (sourceChannelId: string) => {
        if (sourceChannelId === UC('badseed')) throw new Error('provider boom');
        return { observations: [{ featuredChannelId: good }] };
      },
      nominate: async () => ({ id: 'n1' }),
      ingest: async (raw) => { ingested.push(raw.channelId); },
      reserveQuota: async () => true,
      finishQuota: async () => {},
      log: () => {},
    },
  );
  assert.deepEqual(ingested, [good]);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.status, 'COMPLETED');
});

// Quota exhaustion stops fetching without failing the job.
test('quota exhaustion halts expansion gracefully', async () => {
  let fetches = 0;
  const summary = await processRelationshipCanaryJob(
    { id: 'job-1', payload: { cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 2, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      settings: { enabled: true, killSwitch: false, quotaPercent: 1 },
      dailyBudget: 10000,
      checkCountryAllowed: async () => {},
      fetchFeaturedChannels: async () => { fetches++; return { observations: [] }; },
      reserveQuota: async () => false,
      finishQuota: async () => {},
      log: () => {},
    },
  );
  assert.equal(summary.status, 'QUOTA_EXHAUSTED');
  assert.equal(fetches, 0);
});

// 12. Cohort metrics distinguish every required dimension.
test('cohort metrics aggregate relationship vs keyword evidence', () => {
  const rel = (channelId: string, kind: string, depth: number, keywordBaseline: 'WOULD_ADMIT' | 'WOULD_WITHHOLD' = 'WOULD_WITHHOLD') => (
    { channelId, sourceType: 'FEATURED_CHANNEL', cohortId: 'c1', kind, depth, keywordBaseline }
  );
  const nominations = [
    rel(UC('a1'), 'featured', 1),
    rel(UC('a1'), 'featured', 1),
    rel(UC('a2'), 'playlist', 1, 'WOULD_ADMIT'),
    rel(UC('a3'), 'featured', 2),
    { channelId: UC('a2'), sourceType: 'automated_query', cohortId: null, kind: null, depth: null },
    { channelId: UC('other'), sourceType: 'automated_query', cohortId: null, kind: null, depth: null },
  ];
  const channels = [
    { channelId: UC('a1'), tradingStatus: 'TRADING_CONFIRMED' },
    { channelId: UC('a2'), tradingStatus: 'TRADING_CONFIRMED' },
    { channelId: UC('a3'), tradingStatus: 'UNCERTAIN' },
  ];
  const metrics = aggregateRelationshipCohort('c1', nominations, channels, 12);
  assert.equal(metrics.nominations, 4);
  assert.equal(metrics.uniqueChannels, 3);
  assert.deepEqual(metrics.byKind, { featured: 3, playlist: 1 });
  assert.deepEqual(metrics.byDepth, { '1': 3, '2': 1 });
  assert.equal(metrics.confirmed, 2);
  assert.equal(metrics.relationshipOnlyConfirms, 1);
  assert.equal(metrics.keywordOverlapConfirms, 1);
  assert.equal(metrics.zeroKeywordConfirms, 1);
  assert.equal(metrics.unknownBaselineChannels, 0);
  assert.equal(metrics.rejectedOrUncertain, 1);
  assert.equal(metrics.duplicationRate, 0.25);
  assert.equal(metrics.quotaUnits, 12);
  assert.equal(metrics.costPerConfirm, 6);
  const empty = aggregateRelationshipCohort('c1', [], [], 0);
  assert.equal(empty.costPerConfirm, null);
  assert.equal(empty.duplicationRate, 0);
  assert.equal(empty.zeroKeywordConfirms, 0);
});

test('duplication rate is a true duplicate proportion', () => {
  const one = (channelId: string) => ({ channelId, sourceType: 'FEATURED_CHANNEL', cohortId: 'c1', kind: 'featured', depth: 1 });
  const unique = aggregateRelationshipCohort('c1', [one(UC('u1')), one(UC('u2')), one(UC('u3'))], []);
  assert.equal(unique.duplicationRate, 0);
  const single = aggregateRelationshipCohort('c1', [one(UC('u1'))], []);
  assert.equal(single.duplicationRate, 0);
  const duped = aggregateRelationshipCohort('c1', [one(UC('u1')), one(UC('u1')), one(UC('u1')), one(UC('u2'))], []);
  assert.equal(duped.duplicationRate, 0.5);
});

// Corroboration boundary: triage yields hypothesis structure only — no verdict
// fields capable of establishing trading identity.
test('relationship triage result carries hypothesis structure, never a verdict', () => {
  const decision = triageAutonomousSearchCandidate(
    genericRaw({
      relationshipProvenance: buildRelationshipProvenance({ cohortId: 'c', kind: 'featured', depth: 1, path: [UC('seed')] }),
    }),
    'automated_query',
    false,
  );
  assert.deepEqual(Object.keys(decision).sort(), ['disposition', 'matchedSignals', 'reasonCodes']);
  assert.equal(decision.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
});

// Observational keyword baseline uses the existing predicate without routing.
test('keyword baseline observes admission without affecting it', async () => {
  const { observeKeywordBaseline } = await import('./candidateTriage');
  const generic = observeKeywordBaseline(genericRaw(), 'automated_query');
  assert.equal(generic.baseline, 'WOULD_WITHHOLD');
  const keyworded = observeKeywordBaseline(
    genericRaw({ channelName: 'NQ Futures Trader', matchedDocument: { type: 'CHANNEL', providerNativeId: 'x', title: 'NQ Futures Trader' } }),
    'automated_query',
  );
  assert.equal(keyworded.baseline, 'WOULD_ADMIT');
  // Same generic candidate WITH a marker is still admitted by relationship
  // while its baseline says the old funnel would withhold it.
  const admitted = triageAutonomousSearchCandidate(
    genericRaw({ relationshipProvenance: buildRelationshipProvenance({ cohortId: 'c', kind: 'playlist', depth: 2, path: [UC('a'), UC('b')] }) }),
    'automated_query',
    false,
  );
  assert.equal(admitted.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
  assert.equal(generic.baseline, 'WOULD_WITHHOLD');
});

// Worker records the observational baseline on every nomination.
test('worker persists keyword baseline per nomination without branching on it', async () => {
  const seen: Record<string, unknown>[] = [];
  await processRelationshipCanaryJob(
    { id: 'job-1', payload: { cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'playlist', id: 'PLseedlist' }], maxDepth: 1, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      settings: { enabled: true, killSwitch: false, quotaPercent: 1 },
      dailyBudget: 10000,
      checkCountryAllowed: async () => {},
      fetchPlaylistChannels: async () => [{ channelId: UC('plchan'), channelName: 'Quiet Kitchen', description: 'soup', videoTitles: ['soup sunday'] }],
      nominate: async (input) => { seen.push(input.rawObservation); return { id: 'n1' }; },
      ingest: async () => {},
      reserveQuota: async () => true,
      finishQuota: async () => {},
      log: () => {},
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].keywordBaseline, 'WOULD_WITHHOLD');
  assert.equal(seen[0].cohortId, 'c');
  assert.equal(seen[0].relationshipDepth, 1);
});

// F4: another relationship cohort is still relationship discovery — never
// keyword overlap. Only explicit WOULD_ADMIT baselines count as overlap.
test('other-cohort nominations do not contaminate keyword overlap', () => {
  const metrics = aggregateRelationshipCohort(
    'c1',
    [
      { channelId: UC('solo'), sourceType: 'FEATURED_CHANNEL', cohortId: 'c1', kind: 'featured', depth: 1, keywordBaseline: 'WOULD_WITHHOLD' },
      { channelId: UC('solo'), sourceType: 'FEATURED_CHANNEL', cohortId: 'c2', kind: 'featured', depth: 1, keywordBaseline: 'WOULD_WITHHOLD' },
      { channelId: UC('admt'), sourceType: 'PLAYLIST', cohortId: 'c1', kind: 'playlist', depth: 1, keywordBaseline: 'WOULD_ADMIT' },
    ],
    [
      { channelId: UC('solo'), tradingStatus: 'TRADING_CONFIRMED' },
      { channelId: UC('admt'), tradingStatus: 'TRADING_CONFIRMED' },
    ],
    0,
  );
  assert.equal(metrics.confirmed, 2);
  assert.equal(metrics.relationshipOnlyConfirms, 1);
  assert.equal(metrics.keywordOverlapConfirms, 1);
  assert.equal(metrics.zeroKeywordConfirms, 1);
  assert.equal(metrics.unknownBaselineChannels, 0);
});

// F5: missing/null/malformed baselines are UNKNOWN — never definitive.
test('unknown baselines are exposed separately and never confirm either way', () => {
  const metrics = aggregateRelationshipCohort(
    'c1',
    [
      { channelId: UC('m1'), sourceType: 'FEATURED_CHANNEL', cohortId: 'c1', kind: 'featured', depth: 1 },
      { channelId: UC('m2'), sourceType: 'FEATURED_CHANNEL', cohortId: 'c1', kind: 'featured', depth: 1, keywordBaseline: null },
      { channelId: UC('m3'), sourceType: 'FEATURED_CHANNEL', cohortId: 'c1', kind: 'featured', depth: 1, keywordBaseline: 'MAYBE' as never },
      { channelId: UC('m4'), sourceType: 'FEATURED_CHANNEL', cohortId: 'c1', kind: 'featured', depth: 1, keywordBaseline: 'WOULD_WITHHOLD' },
    ],
    [
      { channelId: UC('m1'), tradingStatus: 'TRADING_CONFIRMED' },
      { channelId: UC('m2'), tradingStatus: 'TRADING_CONFIRMED' },
      { channelId: UC('m3'), tradingStatus: 'TRADING_CONFIRMED' },
      { channelId: UC('m4'), tradingStatus: 'TRADING_CONFIRMED' },
    ],
    0,
  );
  assert.equal(metrics.confirmed, 4);
  assert.equal(metrics.zeroKeywordConfirms, 1);
  assert.equal(metrics.keywordOverlapConfirms, 0);
  assert.equal(metrics.unknownBaselineChannels, 3);
});

// F3: channel cap bounds traversal work, not just admission.
test('maxChannels stops provider traversal at the boundary', async () => {
  let fetches = 0;
  const summary = await processRelationshipCanaryJob(
    { id: 'job-1', payload: { cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 2, maxFanout: 5, maxChannels: 1 } },
    async () => {},
    {
      settings: { enabled: true, killSwitch: false, quotaPercent: 10 },
      dailyBudget: 10000,
      checkCountryAllowed: async () => {},
      fetchFeaturedChannels: async () => { fetches++; return { observations: [{ featuredChannelId: UC('c1') }, { featuredChannelId: UC('c2') }] }; },
      nominate: async () => ({ id: 'n1' }),
      ingest: async () => {},
      reserveQuota: async () => true,
      finishQuota: async () => {},
      readReservedUnits: async () => 0,
      log: () => {},
    },
  );
  assert.equal(fetches, 1);
  assert.equal(summary.nominations, 1);
  assert.equal(summary.depth2Fetches, 0);
});

// F6: identical seeds expand once; seeds reached as discoveries are not re-expanded.
test('duplicate seeds and seed-as-discovery expand exactly once', async () => {
  let fetches = 0;
  const seen: string[] = [];
  const seed = UC('seedx');
  await processRelationshipCanaryJob(
    { id: 'job-1', payload: { cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'channel', id: seed }, { kind: 'channel', id: seed }], maxDepth: 2, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      settings: { enabled: true, killSwitch: false, quotaPercent: 10 },
      dailyBudget: 10000,
      checkCountryAllowed: async () => {},
      fetchFeaturedChannels: async (sourceChannelId: string) => {
        fetches++;
        seen.push(sourceChannelId);
        // Echo the seed itself plus one new channel: both must be deduped.
        return { observations: [{ featuredChannelId: seed }, { featuredChannelId: UC('newchan') }] };
      },
      nominate: async () => ({ id: 'n1' }),
      ingest: async () => {},
      reserveQuota: async () => true,
      finishQuota: async () => {},
      readReservedUnits: async () => 0,
      log: () => {},
    },
  );
  assert.deepEqual(seen, [seed, UC('newchan')]);
  assert.equal(fetches, 2);
});

test('seed identity normalizes across relationship-key representations', () => {
  const seed = UC('seedx');
  const plan = planRelationshipExpansion({
    seeds: [{ kind: 'channel', id: seed }],
    maxDepth: 2,
    maxFanout: 10,
    depth1ChannelIds: [seed, UC('other')],
    seedOf: { [seed]: seed, [UC('other')]: seed },
  });
  assert.deepEqual(plan.map(item => item.targetId), [UC('other')]);
});

// F7: quota allowance math.
test('quota allowance is a real bounded share of the daily budget', async () => {
  const { relationshipCanaryQuotaAllowance } = await import('./relationshipCanary');
  assert.equal(relationshipCanaryQuotaAllowance(1000, 0), 0);
  assert.equal(relationshipCanaryQuotaAllowance(1000, 1), 10);
  assert.equal(relationshipCanaryQuotaAllowance(2000, 10), 200);
  assert.equal(relationshipCanaryQuotaAllowance(2000, 100), 2000);
  assert.equal(relationshipCanaryQuotaAllowance(0, 10), 0);
});

// F7: zero-percent canary performs zero provider spend.
test('zero quota allowance halts before any fetch', async () => {
  let fetches = 0;
  const summary = await processRelationshipCanaryJob(
    { id: 'job-1', payload: { cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 2, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      settings: { enabled: true, killSwitch: false, quotaPercent: 0 },
      dailyBudget: 10000,
      checkCountryAllowed: async () => {},
      fetchFeaturedChannels: async () => { fetches++; return { observations: [] }; },
      reserveQuota: async () => true,
      finishQuota: async () => {},
      readReservedUnits: async () => 0,
      log: () => {},
    },
  );
  assert.equal(summary.status, 'QUOTA_EXHAUSTED');
  assert.equal(fetches, 0);
  assert.equal(summary.nominations, 0);
});

// F7: concurrent cohorts share one allocation via reserved baseline.
test('reserved baseline from other cohorts counts against the allocation', async () => {
  let fetches = 0;
  const summary = await processRelationshipCanaryJob(
    { id: 'job-1', payload: { cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 1, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      settings: { enabled: true, killSwitch: false, quotaPercent: 1 },
      dailyBudget: 10000,
      checkCountryAllowed: async () => {},
      fetchFeaturedChannels: async () => { fetches++; return { observations: [] }; },
      reserveQuota: async () => true,
      finishQuota: async () => {},
      readReservedUnits: async () => 999999,
      log: () => {},
    },
  );
  assert.equal(summary.status, 'QUOTA_EXHAUSTED');
  assert.equal(fetches, 0);
});

// F1: endpoint authorization policy (inventory + middleware behavior).
test('relationship-canary run endpoint is registered admin-only', async () => {
  const { routePolicyInventory, operatorAuthorization } = await import('./operatorAuth');
  const entry = routePolicyInventory.find(
    item => item.method === 'POST' && new RegExp(item.pattern).test('/api/relationship-canary/run'),
  );
  assert.ok(entry, 'route policy entry must exist or middleware rejects with ROUTE_POLICY_MISSING');
  assert.equal(entry?.policy, 'admin');

  const run = (
    role: 'admin' | 'operator' | undefined,
    path = '/api/relationship-canary/run',
    method = 'POST',
  ): Promise<{ next: boolean; status?: number; code?: string }> => new Promise(resolve => {
    const handler = operatorAuthorization(async () => {}, {
      NODE_ENV: 'test',
      ADMIN_API_TOKEN: 'admin-token',
      OPERATOR_API_TOKEN: 'operator-token',
    } as NodeJS.ProcessEnv);
    const token = role === 'admin' ? 'admin-token' : role === 'operator' ? 'operator-token' : undefined;
    const req = {
      method, path, baseUrl: '', query: {},
      header: (name: string) => (name.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined),
    };
    let status = 0;
    let code = '';
    const res = {
      status: (code_: number) => { status = code_; return res; },
      json: (body: Record<string, unknown>) => { code = String(body.code || ''); resolve({ next: false, status, code }); },
      setHeader: () => {},
      once: () => {},
    };
    handler(req as never, res as never, () => resolve({ next: true }));
  });

  assert.deepEqual(await run('admin'), { next: true });
  const denied = await run('operator');
  assert.equal(denied.next, false);
  assert.equal(denied.status, 403);
  const anonymous = await run(undefined);
  assert.equal(anonymous.next, false);
  assert.equal(anonymous.status, 401);
  const missing = await run('admin', '/api/definitely-not-a-route');
  assert.equal(missing.next, false);
  assert.equal(missing.status, 404);
  assert.equal(missing.code, 'ROUTE_POLICY_MISSING');
  // Unrelated routes keep existing behavior (operator read still passes).
  assert.deepEqual(await run('operator', '/api/browser-capability', 'GET'), { next: true });
});

// F2: daily idempotency never reopens terminal runs (narrow preventReopen use).
test('canary enqueue is idempotent per cohort/day and never reopens runs', async () => {
  const { enqueueRelationshipCanaryRun } = await import('./queueManager');
  const calls: Array<{ type: string; payload: unknown; opts: Record<string, unknown> }> = [];
  const enqueueJob = (async (type: string, payload: unknown, opts: Record<string, unknown>) => {
    calls.push({ type, payload, opts });
    return { id: `job-${calls.length}` };
  }) as never;
  const input = { cohortId: 'c9', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 2, maxFanout: 5, maxChannels: 50 };
  const allowCountry = { enqueueJob, checkCountryAllowed: async () => {} };
  const first = await enqueueRelationshipCanaryRun(input, allowCountry);
  assert.equal(first.cohortId, 'c9');
  assert.equal(calls.length, 1);
  // Narrowly scoped reopen guard: completed/failed rows are returned as-is,
  // never reset to PENDING (existing enqueueJob preventReopen semantics).
  assert.equal(calls[0].opts.preventReopen, true);
  assert.equal(calls[0].type, 'RELATIONSHIP_CANARY_EXPANSION');
  // Idempotency key is cohort+day scoped: same cohort/day shares it, anything
  // else is independent.
  const keyOf = (opts: Record<string, unknown>) => String(opts.idempotencyKey || '');
  const second = await enqueueRelationshipCanaryRun(input, allowCountry);
  assert.equal(keyOf(calls[1].opts), keyOf(calls[0].opts));
  assert.equal(second.cohortId, 'c9');
  const other = await enqueueRelationshipCanaryRun({ ...input, cohortId: 'c10' }, allowCountry);
  assert.notEqual(keyOf(calls[2].opts), keyOf(calls[0].opts));
  assert.equal(other.cohortId, 'c10');
  // Invalid payloads never reach the queue.
  await assert.rejects(enqueueRelationshipCanaryRun({ cohortId: '', targetCountry: 'US', seeds: [] }, allowCountry), /COHORT|SEEDS/);
  assert.equal(calls.length, 3);
});

// Spent-units query: consumed same-day rows count, old rows excluded, single SUM.
test('spent-units query counts reserved plus same-day consumed exactly once', async () => {
  const { relationshipCanarySpentUnitsQuery } = await import('./relationshipCanary');
  const query = relationshipCanarySpentUnitsQuery('2026-09-04T07:00:00.000Z');
  assert.match(query.text, /operation_type='RELATIONSHIP_CANARY'/);
  assert.match(query.text, /status='RESERVED'/);
  assert.match(query.text, /status='CONSUMED'/);
  assert.match(query.text, /consumed_at/);
  assert.deepEqual(query.values, ['2026-09-04T07:00:00.000Z']);
  // Single aggregate over mutually exclusive statuses: no double counting.
  assert.equal((query.text.match(/SUM\(units\)/g) || []).length, 1);
});

// Sequential same-day cohorts share one allocation (the quota finding scenario).
test('cohort B cannot re-spend cohort A consumed allocation', async () => {
  const { processRelationshipCanaryJob } = await import('./relationshipCanary');
  const live = {
    settings: { enabled: true, killSwitch: false, quotaPercent: 1 },
    dailyBudget: 1000,
    checkCountryAllowed: async () => {},
  };
  const runCohort = (cohortId: string, reservedBaseline: number) => processRelationshipCanaryJob(
    { id: 'job-1', payload: { cohortId, targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 1, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      ...live,
      fetchFeaturedChannels: async () => ({ observations: [{ featuredChannelId: UC('found') }] }),
      nominate: async () => ({ id: 'n1' }),
      ingest: async () => {},
      reserveQuota: async () => true,
      finishQuota: async () => {},
      readReservedUnits: async () => reservedBaseline,
      log: () => {},
    },
  );
  // Allowance at 1% of 1000 = 10. Cohort A spends its full share.
  const cohortA = await runCohort('cohort-a', 0);
  assert.equal(cohortA.status, 'COMPLETED');
  // Cohort B later the same day sees A's 10 consumed units in its baseline
  // and halts before any fetch: no second full allocation.
  const spent = 10;
  const cohortB = await runCohort('cohort-b', spent);
  assert.equal(cohortB.status, 'QUOTA_EXHAUSTED');
  assert.equal(cohortB.nominations, 0);
  // Partial baseline still permits the remainder: 6 used of 10 allows a
  // 1-unit fetch but records honest spend.
  let fetches = 0;
  const cohortC = await processRelationshipCanaryJob(
    { id: 'job-1', payload: { cohortId: 'cohort-c', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 1, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      ...live,
      fetchFeaturedChannels: async () => { fetches++; return { observations: [] }; },
      reserveQuota: async () => true,
      finishQuota: async () => {},
      readReservedUnits: async () => 6,
      log: () => {},
    },
  );
  assert.equal(fetches, 1);
  assert.equal(cohortC.status, 'COMPLETED');
});

// Excluded countries never launch or spend.
test('excluded target country is rejected at enqueue and execution', async () => {
  const { enqueueRelationshipCanaryRun } = await import('./queueManager');
  const blocked = new Error('excluded');
  await assert.rejects(
    enqueueRelationshipCanaryRun(
      { cohortId: 'c', targetCountry: 'XX', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 1, maxFanout: 5, maxChannels: 50 },
      { enqueueJob: (async () => { throw new Error('must not enqueue'); }) as never, checkCountryAllowed: async () => { throw blocked; } },
    ),
    /excluded/,
  );
  let fetches = 0;
  await assert.rejects(
    processRelationshipCanaryJob(
      { id: 'job-1', payload: { cohortId: 'c', targetCountry: 'XX', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 1, maxFanout: 5, maxChannels: 50 } },
      async () => {},
      {
        settings: { enabled: true, killSwitch: false, quotaPercent: 10 },
        dailyBudget: 10000,
        checkCountryAllowed: async () => { throw blocked; },
        fetchFeaturedChannels: async () => { fetches++; return { observations: [] }; },
        log: () => {},
      },
    ),
    /excluded/,
  );
  assert.equal(fetches, 0);
});

// Consumer wiring: SEARCH pool continuously claims the canary type.
test('SEARCH pool claims canary jobs through the existing tick lifecycle', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('server/queueManager.ts', 'utf8');
  assert.match(source, /startWorkerPool\('SEARCH_YOUTUBE'[\s\S]*?'RELATIONSHIP_CANARY_EXPANSION'/);
});
