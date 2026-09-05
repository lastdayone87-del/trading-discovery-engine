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
import type { RelationshipCanarySummary } from './relationshipCanary';

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
      claimQuota: async () => true,
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
      claimQuota: async () => true,
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
      claimQuota: async () => true,
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
      claimQuota: async () => true,
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
      claimQuota: async () => true,
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
      claimQuota: async () => true,
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
      claimQuota: async () => false,
      log: () => {},
    },
  );
  assert.equal(summary.status, 'QUOTA_EXHAUSTED');
  assert.equal(fetches, 0);
  assert.equal(summary.nominations, 0);
});

// F7: denied claims halt expansion gracefully (e.g. allowance consumed).
test('denied atomic claims stop traversal without failing the job', async () => {
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
      claimQuota: async () => false,
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

// Atomic claim tests run against a minimal in-memory quota store that honors
// transactions: BEGIN chains (serializing concurrent claims exactly like the
// advisory lock does in Postgres), SUM respects the day bound, INSERT upserts
// per (operation_type, operation_id). Statement order is asserted so the lock
// provably precedes the spend check.
const makeQuotaStore = () => {
  const rows = new Map<string, { units: number; status: string; reserved_at: string; consumed_at: string | null }>();
  const statements: string[] = [];
  let mutex: Promise<void> = Promise.resolve();
  let releaseTxn: (() => void) | null = null;
  const query = async (text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    statements.push(text.trim().split('\n')[0].slice(0, 60));
    const head = text.trim().toUpperCase();
    if (head === 'BEGIN') {
      let release!: () => void;
      const prev = mutex;
      mutex = new Promise<void>(resolve => { release = resolve; });
      await prev;
      releaseTxn = release;
      return { rows: [] };
    }
    if (head === 'COMMIT' || head === 'ROLLBACK') {
      releaseTxn?.();
      releaseTxn = null;
      return { rows: [] };
    }
    if (text.includes('pg_advisory_xact_lock')) return { rows: [{}] };
    if (text.includes('SUM(units)')) {
      // Mirrors production semantics exactly: live RESERVED rows always count
      // (staleness is the sweeper's job, as in tryReserveQuota); CONSUMED rows
      // count only inside the active quota day.
      const dayStart = String(values[0]);
      let sum = 0;
      for (const row of rows.values()) {
        if (row.status === 'RESERVED') sum += row.units;
        else if (row.status === 'CONSUMED' && (row.consumed_at || row.reserved_at) >= dayStart) sum += row.units;
      }
      return { rows: [{ spent: sum }] };
    }
    if (text.includes('AS own')) {
      const opId = String(values[0]);
      const dayStart = String(values[1]);
      const key = `RELATIONSHIP_CANARY|${opId}`;
      const row = rows.get(key);
      // Same active-day predicate as the aggregate: only rows contributing to
      // `used` may be subtracted for upsert retries.
      const active = row && (row.status === 'RESERVED' || (row.status === 'CONSUMED' && (row.consumed_at || row.reserved_at) >= dayStart));
      return { rows: [{ own: active ? row.units : 0 }] };
    }
    if (text.includes('INSERT INTO quota_reservations')) {
      const [opId, units] = values as [string, number];
      const status = /status='CONSUMED'/.test(text.split('ON CONFLICT')[0]) ? 'CONSUMED' : 'RESERVED';
      const now = new Date().toISOString();
      const key = `RELATIONSHIP_CANARY|${opId}`;
      const existing = rows.get(key);
      if (existing) {
        existing.units = units;
        existing.status = status;
        if (status === 'CONSUMED') existing.consumed_at = now;
      } else {
        rows.set(key, { units, status, reserved_at: now, consumed_at: status === 'CONSUMED' ? now : null });
      }
      return { rows: [] };
    }
    throw new Error(`unexpected statement: ${text.slice(0, 80)}`);
  };
  return { query, statements, rows };
};

const DAY = '2026-09-04T07:00:00.000Z';

// Claim locks before checking spend (the race guard), then inserts atomically.
test('atomic claim serializes check-and-insert behind the advisory lock', async () => {
  const { claimRelationshipCanaryQuota } = await import('./relationshipCanary');
  const store = makeQuotaStore();
  const first = await claimRelationshipCanaryQuota({ db: store, operationId: 'op-a', units: 6, allowance: 10, dayStartIso: DAY });
  assert.equal(first.allowed, true);
  assert.equal(first.used, 0);
  const lockIdx = store.statements.findIndex(s => s.includes('pg_advisory_xact_lock'));
  const sumIdx = store.statements.findIndex(s => s.includes('SUM(units)'));
  const insertIdx = store.statements.findIndex(s => s.includes('INSERT INTO quota_reservations'));
  assert.ok(lockIdx >= 0 && lockIdx < sumIdx && sumIdx < insertIdx);
  const second = await claimRelationshipCanaryQuota({ db: store, operationId: 'op-b', units: 5, allowance: 10, dayStartIso: DAY });
  assert.equal(second.allowed, false);
  assert.equal(second.used, 6);
});

// Concurrent cohorts cannot jointly exceed the allowance.
test('concurrent claims share one hard aggregate bound', async () => {
  const { claimRelationshipCanaryQuota } = await import('./relationshipCanary');
  const store = makeQuotaStore();
  const attempt = (op: string) => claimRelationshipCanaryQuota({ db: store, operationId: op, units: 10, allowance: 10, dayStartIso: DAY });
  const [a, b] = await Promise.all([attempt('cohort-a:fetch'), attempt('cohort-b:fetch')]);
  assert.equal([a.allowed, b.allowed].filter(Boolean).length, 1);
  const total = await claimRelationshipCanaryQuota({ db: store, operationId: 'probe', units: 1, allowance: 10, dayStartIso: DAY });
  assert.equal(total.allowed, false);
  assert.equal(total.used, 10);
});

// Three simultaneous cohorts: exactly the allowance spends, no more.
test('three concurrent cohorts split one allowance without excess', async () => {
  const { claimRelationshipCanaryQuota } = await import('./relationshipCanary');
  const store = makeQuotaStore();
  const results = await Promise.all([1, 2, 3].map(i =>
    claimRelationshipCanaryQuota({ db: store, operationId: `op-${i}`, units: 4, allowance: 10, dayStartIso: DAY }),
  ));
  const allowed = results.filter(r => r.allowed).length;
  assert.ok(allowed >= 1 && allowed <= 2);
  const probe = await claimRelationshipCanaryQuota({ db: store, operationId: 'probe', units: 1, allowance: 10, dayStartIso: DAY });
  let spent = 0;
  for (const row of store.rows.values()) spent += row.units;
  assert.ok(spent <= 10);
  assert.equal(probe.allowed, spent + 1 <= 10);
});

// Sequential cohorts: completed consumption blocks the next full allocation.
test('completed consumption blocks the next full allocation same-day', async () => {
  const { claimRelationshipCanaryQuota } = await import('./relationshipCanary');
  const store = makeQuotaStore();
  const cohortA = await claimRelationshipCanaryQuota({ db: store, operationId: 'a:fetch', units: 10, allowance: 10, dayStartIso: DAY, consumeImmediately: true });
  assert.equal(cohortA.allowed, true);
  const cohortB = await claimRelationshipCanaryQuota({ db: store, operationId: 'b:fetch', units: 10, allowance: 10, dayStartIso: DAY });
  assert.equal(cohortB.allowed, false);
  assert.equal(cohortB.used, 10);
});

// Retrying the same operation never double-counts.
test('repeat claims on one operation id count once', async () => {
  const { claimRelationshipCanaryQuota } = await import('./relationshipCanary');
  const store = makeQuotaStore();
  await claimRelationshipCanaryQuota({ db: store, operationId: 'op-retry', units: 6, allowance: 10, dayStartIso: DAY });
  const again = await claimRelationshipCanaryQuota({ db: store, operationId: 'op-retry', units: 6, allowance: 10, dayStartIso: DAY });
  assert.equal(again.allowed, true);
  assert.equal(again.used, 6);
});

// Next-day reset: previous-day consumption does not leak forward.
test('previous-day consumption resets with the quota day', async () => {
  const { claimRelationshipCanaryQuota } = await import('./relationshipCanary');
  const store = makeQuotaStore();
  store.rows.set('RELATIONSHIP_CANARY|old', {
    units: 10, status: 'CONSUMED',
    reserved_at: '2026-09-03T06:00:00.000Z', consumed_at: '2026-09-03T06:05:00.000Z',
  });
  const fresh = await claimRelationshipCanaryQuota({ db: store, operationId: 'new', units: 10, allowance: 10, dayStartIso: DAY });
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.used, 0);
});

// Zero allowance spends nothing.
test('zero allowance denies every claim', async () => {
  const { claimRelationshipCanaryQuota } = await import('./relationshipCanary');
  const store = makeQuotaStore();
  const denied = await claimRelationshipCanaryQuota({ db: store, operationId: 'op', units: 1, allowance: 0, dayStartIso: DAY });
  assert.equal(denied.allowed, false);
});

// Worker-level sequential proof through the real claim path.
test('cohort B cannot re-spend cohort A consumed allocation', async () => {
  const { processRelationshipCanaryJob, claimRelationshipCanaryQuota } = await import('./relationshipCanary');
  const store = makeQuotaStore();
  const DAY_ISO = DAY;
  const boundClaim = (allowance: number) => async (operationId: string, units: number, opts?: { consumeImmediately?: boolean }) =>
    (await claimRelationshipCanaryQuota({ db: store, operationId, units, allowance, dayStartIso: DAY_ISO, consumeImmediately: opts?.consumeImmediately })).allowed;
  const base = {
    settings: { enabled: true, killSwitch: false, quotaPercent: 10 },
    dailyBudget: 100000,
    checkCountryAllowed: async () => {},
    reserveQuota: async () => true,
    finishQuota: async () => {},
    log: () => {},
  };
  // Allowance 310: cohort A spends 1 (fetch) + 305 (downstream earmark) = 306.
  const cohortA = await processRelationshipCanaryJob(
    { id: 'job-a', payload: { cohortId: 'cohort-a', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 1, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      ...base,
      claimQuota: boundClaim(310),
      fetchFeaturedChannels: async () => ({ observations: [{ featuredChannelId: UC('found') }] }),
      nominate: async () => ({ id: 'n1' }),
      ingest: async () => {},
    },
  );
  assert.equal(cohortA.status, 'COMPLETED');
  assert.equal(cohortA.nominations, 1);
  // Cohort B later the same day: 306 already spent, its first fetch (307th
  // unit) exceeds 310 only after... 306+1=307 <= 310 allowed; admission needs
  // 307+305=612 > 310, so traversal may start but no admission completes.
  const cohortB = await processRelationshipCanaryJob(
    { id: 'job-b', payload: { cohortId: 'cohort-b', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 1, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      ...base,
      claimQuota: boundClaim(310),
      fetchFeaturedChannels: async () => ({ observations: [{ featuredChannelId: UC('found') }] }),
      nominate: async () => ({ id: 'n1' }),
      ingest: async () => {},
    },
  );
  assert.equal(cohortB.nominations, 0);
  let total = 0;
  for (const row of store.rows.values()) total += row.units;
  assert.ok(total <= 310);
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

// Downstream estimate denied: traversal proceeds but no admission occurs.
test('downstream budget denial skips admission without failing traversal', async () => {
  let fetches = 0;
  let ingested = 0;
  const summary = await processRelationshipCanaryJob(
    { id: 'job-1', payload: { cohortId: 'c', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed') }], maxDepth: 1, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      settings: { enabled: true, killSwitch: false, quotaPercent: 10 },
      dailyBudget: 100000,
      checkCountryAllowed: async () => {},
      fetchFeaturedChannels: async () => { fetches++; return { observations: [{ featuredChannelId: UC('found') }] }; },
      nominate: async () => ({ id: 'n1' }),
      ingest: async () => { ingested++; },
      reserveQuota: async () => true,
      finishQuota: async () => {},
      claimQuota: async (_op, units) => units <= 5,
      log: () => {},
    },
  );
  assert.equal(fetches, 1);
  assert.equal(ingested, 0);
  assert.equal(summary.nominations, 0);
  assert.equal(summary.downstreamCapped, 1);
  assert.equal(summary.status, 'COMPLETED');
});

// Previous-day own rows must not subsidize today's allowance.
test('stale own-row cannot bypass the current-day allowance', async () => {
  const { claimRelationshipCanaryQuota } = await import('./relationshipCanary');
  const store = makeQuotaStore();
  store.rows.set('RELATIONSHIP_CANARY|stale-op', {
    units: 10, status: 'CONSUMED',
    reserved_at: '2026-09-03T06:00:00.000Z', consumed_at: '2026-09-03T06:05:00.000Z',
  });
  // Allowance 10, already 0 used today; retrying the stale op for 10 more
  // must count fully (its old units are not in `used`) — and a second, fresh
  // operation must then see the full 10 as spent.
  const retry = await claimRelationshipCanaryQuota({ db: store, operationId: 'stale-op', units: 10, allowance: 10, dayStartIso: DAY });
  assert.equal(retry.allowed, true);
  const next = await claimRelationshipCanaryQuota({ db: store, operationId: 'fresh-op', units: 1, allowance: 10, dayStartIso: DAY });
  assert.equal(next.allowed, false);
  assert.equal(next.used, 10);
});

// Killed-queued runs drain: the claim gate never filters on settings (the
// worker itself returns KILLED with zero spend), so disabling the canary
// cannot strand pending runs to fire on a later re-enable.
test('canary jobs stay claimable while disabled for inert drain', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('server/queueManager.ts', 'utf8');
  const gate = source.slice(
    source.indexOf('Relationship-canary expansion is always claimable'),
    source.indexOf('TERM_HARVEST', source.indexOf('Relationship-canary expansion is always claimable')),
  );
  assert.match(gate, /claimableTypes\.push\('RELATIONSHIP_CANARY_EXPANSION'\)/);
  assert.doesNotMatch(gate, /getAppSetting\('relationship_canary_enabled'/);
  assert.doesNotMatch(gate, /kill_switch/);
});

// Failure classification: stable codes, never secret material.
test('provider failures classify to safe non-secret codes', async () => {
  const { classifyRelationshipCanaryFailure } = await import('./relationshipCanary');
  assert.equal(classifyRelationshipCanaryFailure(new Error('YouTube featured-channel inspection requires an API key.')), 'NO_YOUTUBE_API_KEY');
  assert.equal(classifyRelationshipCanaryFailure(new Error('YouTube providers cooling down')), 'PROVIDER_POOL_UNAVAILABLE');
  assert.equal(classifyRelationshipCanaryFailure(new Error('QUOTA_EXHAUSTED for key')), 'QUOTA_EXHAUSTED');
  assert.equal(classifyRelationshipCanaryFailure(new Error('429 too many requests')), 'QUOTA_EXHAUSTED');
  assert.equal(classifyRelationshipCanaryFailure(new Error('INVALID_FEATURED_CHANNEL_PROVIDER_INPUT')), 'INVALID_INPUT');
  assert.equal(classifyRelationshipCanaryFailure(new Error('socket hangup')), 'PROVIDER_CALL_FAILED');
  assert.equal(classifyRelationshipCanaryFailure('plain string failure'), 'PROVIDER_CALL_FAILED');
});

// Redaction: credentials never reach persisted logs; telemetry survives.
test('log scrubber redacts credentials and caps length', async () => {
  const { sanitizeCanaryLogText } = await import('./relationshipCanary');
  const dirty = 'fetch https://youtube.googleapis.com/v3/x?part=snippet&key=AIzaFakeKey123 failed Bearer abc.DEF_ghi quota 10 blocked 2';
  const clean = sanitizeCanaryLogText(dirty);
  assert.ok(!clean.includes('AIzaFakeKey123'));
  assert.ok(!clean.includes('abc.DEF_ghi'));
  assert.ok(clean.includes('quota 10'));
  assert.ok(clean.includes('[REDACTED]'));
  assert.equal(sanitizeCanaryLogText('x'.repeat(500), 200).length, 200);
  assert.equal(
    sanitizeCanaryLogText('api_key=supersecret-value here'),
    'api_key=[REDACTED] here',
  );
});

// Attempt-log entry shape: counts + sanitized failures, no secrets.
test('attempt-log entry carries observable summary without secrets', async () => {
  const { relationshipCanaryAttemptLog } = await import('./relationshipCanary');
  const entry = relationshipCanaryAttemptLog({
    cohortId: 'c1', status: 'COMPLETED', seedsAttempted: 3, depth1Channels: 0, depth2Fetches: 0,
    nominations: 0, ingested: 0, channelsCapped: 0, downstreamCapped: 0,
    failures: ['channel:UCx:boom'], failureCodes: ['PROVIDER_CALL_FAILED'], quotaUnits: 3,
  });
  assert.equal(entry.cohortId, 'c1');
  assert.deepEqual(entry.failures, ['channel:UCx:boom']);
  assert.deepEqual(entry.failureCodes, ['PROVIDER_CALL_FAILED']);
  assert.ok(!JSON.stringify(entry).includes('AIza'));
});

// Persistence targets the open attempt row and never throws.
test('summary persistence appends to the unfinished attempt only', async () => {
  const { persistRelationshipCanarySummary, relationshipCanaryAttemptLog } = await import('./relationshipCanary');
  const calls: Array<{ text: string; values: unknown[] }> = [];
  await persistRelationshipCanarySummary(
    (async (text: string, values?: unknown[]) => { calls.push({ text, values: values || [] }); return { rows: [] }; }) as never,
    'job-9',
    {
      cohortId: 'c1', status: 'COMPLETED', seedsAttempted: 1, depth1Channels: 0, depth2Fetches: 0,
      nominations: 0, ingested: 0, channelsCapped: 0, downstreamCapped: 0,
      failures: [], failureCodes: [], quotaUnits: 0,
    },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /UPDATE job_attempts SET logs = logs \|\|/);
  assert.match(calls[0].text, /finished_at IS NULL/);
  assert.equal(calls[0].values[0], 'job-9');
  const logged = JSON.parse(String((calls[0].values[1] as string)));
  assert.equal(logged.cohortId, 'c1');
  assert.deepEqual(Object.keys(relationshipCanaryAttemptLog({
    cohortId: 'x', status: 'KILLED', seedsAttempted: 0, depth1Channels: 0, depth2Fetches: 0,
    nominations: 0, ingested: 0, channelsCapped: 0, downstreamCapped: 0, failures: [], failureCodes: [], quotaUnits: 0,
  })).sort(), Object.keys(logged).sort());
  // A failing persistence layer resolves (observability never fails the job).
  await persistRelationshipCanarySummary(
    (async () => { throw new Error('db down'); }) as never,
    'job-9',
    {
      cohortId: 'c1', status: 'COMPLETED', seedsAttempted: 0, depth1Channels: 0, depth2Fetches: 0,
      nominations: 0, ingested: 0, channelsCapped: 0, downstreamCapped: 0,
      failures: [], failureCodes: [], quotaUnits: 0,
    },
  );
});

// Pre-dispatch provider failure is visible end to end (no silent COMPLETED).
test('pre-dispatch provider failure surfaces classified in the attempt log', async () => {
  const { processRelationshipCanaryJob, persistRelationshipCanarySummary } = await import('./relationshipCanary');
  const logged: unknown[] = [];
  const summary = await processRelationshipCanaryJob(
    { id: 'job-9', payload: { cohortId: 'c1', targetCountry: 'US', seeds: [{ kind: 'channel', id: UC('seed') }, { kind: 'channel', id: UC('seed2') }, { kind: 'channel', id: UC('seed3') }], maxDepth: 1, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      settings: { enabled: true, killSwitch: false, quotaPercent: 10 },
      dailyBudget: 100000,
      checkCountryAllowed: async () => {},
      fetchFeaturedChannels: async () => { throw new Error('YouTube featured-channel inspection requires an API key.'); },
      nominate: async () => { throw new Error('must not nominate without provider data'); },
      ingest: async () => { throw new Error('must not ingest without provider data'); },
      reserveQuota: async () => true,
      finishQuota: async () => {},
      claimQuota: async () => true,
      log: () => {},
    } as never,
  );
  assert.equal(summary.failures.length, 3);
  assert.deepEqual(summary.failureCodes, ['NO_YOUTUBE_API_KEY', 'NO_YOUTUBE_API_KEY', 'NO_YOUTUBE_API_KEY']);
  assert.equal(summary.nominations, 0);
  await persistRelationshipCanarySummary(
    (async (text: string, values?: unknown[]) => { logged.push(JSON.parse(String((values || [])[1]))); return { rows: [] }; }) as never,
    'job-9',
    summary,
  );
  assert.equal(logged.length, 1);
  assert.deepEqual((logged[0] as Record<string, unknown>).failureCodes, ['NO_YOUTUBE_API_KEY', 'NO_YOUTUBE_API_KEY', 'NO_YOUTUBE_API_KEY']);
});

// Real provider path: with no configured keys the real fetcher fails closed
// before any network call, with the production no-key classification.
test('real provider path fails closed pre-dispatch when no keys exist', async () => {
  const { getYouTubeKeyPool } = await import('./db');
  if (getYouTubeKeyPool().length > 0) return;
  const { fetchYouTubeFeaturedChannels } = await import('./youtube');
  const { classifyRelationshipCanaryFailure } = await import('./relationshipCanary');
  await assert.rejects(fetchYouTubeFeaturedChannels(UC('seed'), 5), /API key/);
  try {
    await fetchYouTubeFeaturedChannels(UC('seed'), 5);
    assert.fail('must throw without keys');
  } catch (error) {
    assert.equal(classifyRelationshipCanaryFailure(error), 'NO_YOUTUBE_API_KEY');
  }
});

// Pool-capacity messages from production classify as pool-unavailable.
test('production pool messages classify as pool unavailable', async () => {
  const { classifyRelationshipCanaryFailure } = await import('./relationshipCanary');
  assert.equal(
    classifyRelationshipCanaryFailure(new Error('YouTube provider pool became unavailable before request dispatch.')),
    'PROVIDER_POOL_UNAVAILABLE',
  );
  assert.equal(
    classifyRelationshipCanaryFailure(new Error('No eligible YouTube provider is available at request dispatch.')),
    'PROVIDER_POOL_UNAVAILABLE',
  );
});

// Nomination/ingestion failures carry the non-provider admission code.
test('admission failures record ADMISSION_FAILED, not provider codes', async () => {
  const { processRelationshipCanaryJob } = await import('./relationshipCanary');
  const summary = await processRelationshipCanaryJob(
    { id: 'job-9', payload: { cohortId: 'c1', targetCountry: 'US', seeds: [{ kind: 'playlist', id: 'PLseedlist' }], maxDepth: 1, maxFanout: 5, maxChannels: 50 } },
    async () => {},
    {
      settings: { enabled: true, killSwitch: false, quotaPercent: 10 },
      dailyBudget: 100000,
      checkCountryAllowed: async () => {},
      fetchPlaylistChannels: async () => [{ channelId: UC('admitme'), channelName: 'Admit Me', description: 'd', videoTitles: ['v'] }],
      nominate: async () => ({ id: 'n1' }),
      ingest: async () => { throw new Error('ingestion pipeline exploded'); },
      reserveQuota: async () => true,
      finishQuota: async () => {},
      claimQuota: async () => true,
      log: () => {},
    },
  );
  assert.equal(summary.failures.length, 1);
  assert.deepEqual(summary.failureCodes, ['ADMISSION_FAILED']);
});

// Lowercase/mixed-case bearer schemes redact like canonical Bearer.
test('bearer redaction is case-insensitive', async () => {
  const { sanitizeCanaryLogText } = await import('./relationshipCanary');
  assert.ok(!sanitizeCanaryLogText('authorization: bearer secret-token-xyz').includes('secret-token-xyz'));
  assert.ok(!sanitizeCanaryLogText('Authorization: BEARER tok123').includes('tok123'));
  assert.ok(sanitizeCanaryLogText('authorization: bearer secret-token-xyz').includes('[REDACTED]'));
});

// Attempt binding: stale workers cannot write into newer retries.
test('summary persistence binds to the exact attempt number', async () => {
  const { persistRelationshipCanarySummary } = await import('./relationshipCanary');
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = (async (text: string, values?: unknown[]) => {
    calls.push({ text, values: values || [] });
    return { rows: [] };
  }) as never;
  const summary = {
    cohortId: 'c1', status: 'COMPLETED' as const, seedsAttempted: 1, depth1Channels: 0, depth2Fetches: 0,
    nominations: 0, ingested: 0, channelsCapped: 0, downstreamCapped: 0,
    failures: [] as string[], failureCodes: [] as string[], quotaUnits: 0,
  };
  await persistRelationshipCanarySummary(query, 'job-9', { ...summary }, 4);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /attempt_number=\$3/);
  assert.deepEqual([calls[0].values[0], calls[0].values[2]], ['job-9', 4]);
  // Without an attempt number the legacy open-row targeting still applies.
  await persistRelationshipCanarySummary(query, 'job-9', { ...summary });
  assert.match(calls[1].text, /finished_at IS NULL/);
  assert.ok(!calls[1].text.includes('attempt_number'));
});

// Dispatcher wiring: run worker → persist summary → complete job, in order.
// A pre-dispatch provider failure ends up observable instead of COMPLETED
// with empty logs.
test('dispatcher persists pre-dispatch failure before completing the job', async () => {
  const { handleRelationshipCanaryExpansionJob } = await import('./queueManager');
  const events: string[] = [];
  let persisted: { jobId: string; summary: Record<string, unknown>; attempt?: number } | null = null;
  await handleRelationshipCanaryExpansionJob(
    { id: 'job-9', attempts: 3, payload: { cohortId: 'c1' } },
    {
      runCanary: async (job) => {
        events.push(`run:${job.id}`);
        return {
          cohortId: 'c1', status: 'COMPLETED', seedsAttempted: 3, depth1Channels: 0, depth2Fetches: 0,
          nominations: 0, ingested: 0, channelsCapped: 0, downstreamCapped: 0,
          failures: [
            'channel:UCa:YouTube featured-channel inspection requires an API key.',
            'channel:UCb:YouTube featured-channel inspection requires an API key.',
            'channel:UCc:YouTube featured-channel inspection requires an API key.',
          ],
          failureCodes: ['NO_YOUTUBE_API_KEY', 'NO_YOUTUBE_API_KEY', 'NO_YOUTUBE_API_KEY'],
          quotaUnits: 0,
        };
      },
      persistSummary: async (jobId, summary, attempt) => {
        events.push(`persist:${jobId}`);
        persisted = { jobId, summary: summary as unknown as Record<string, unknown>, attempt };
      },
      completeAttempt: async (input) => {
        events.push(`complete:${input.jobId}#${input.attemptNumber}`);
        return { completed: true };
      },
    },
    { workerId: 'worker-1', attemptNumber: 3 },
  );
  // Persist-before-complete ordering is what makes failures observable.
  assert.deepEqual(events, ['run:job-9', 'persist:job-9', 'complete:job-9#3']);
  assert.ok(persisted);
  assert.equal((persisted as unknown as { jobId: string }).jobId, 'job-9');
  assert.equal((persisted as unknown as { attempt?: number }).attempt, 3);
  const summary = (persisted as unknown as { summary: Record<string, unknown> }).summary;
  assert.equal((summary.failures as string[]).length, 3);
  assert.deepEqual(summary.failureCodes, ['NO_YOUTUBE_API_KEY', 'NO_YOUTUBE_API_KEY', 'NO_YOUTUBE_API_KEY']);
  assert.equal(summary.nominations, 0);
});

// The dispatcher branch delegates to the helper (no parallel wiring).
test('dispatcher routes canary jobs through the persist-before-complete helper', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('server/queueManager.ts', 'utf8');
  assert.match(source, /job\.type==='RELATIONSHIP_CANARY_EXPANSION'\)\{\s*await handleRelationshipCanaryExpansionJob\(job, undefined, \{ workerId, attemptNumber: job\.attempts \}\);return true;/);
});

// Stale-worker race: fake queue lifecycle mirroring claim/recover semantics
// (PENDING→PROCESSING+attempts+1+lock, recovery→PENDING+unlock+fail-open-rows).
const makeLifecycleStore = () => {
  const job = { status: 'PENDING', attempts: 0, locked_by: null as string | null };
  const attempts: Array<{ attempt_number: number; status: string; finished_at: string | null; logs: unknown[] }> = [];
  const api = {
    job,
    attempts,
    claim(workerId: string) {
      if (job.status !== 'PENDING') return null;
      job.status = 'PROCESSING';
      job.locked_by = workerId;
      job.attempts += 1;
      attempts.push({ attempt_number: job.attempts, status: 'PROCESSING', finished_at: null, logs: [] });
      return { attempts: job.attempts };
    },
    recover() {
      if (job.status !== 'PROCESSING') return;
      job.status = 'PENDING';
      job.locked_by = null;
      for (const row of attempts) {
        if (!row.finished_at) {
          row.status = 'FAILED';
          row.finished_at = 'recovered';
        }
      }
    },
    query: (async (text: string, values: unknown[] = []) => {
      const t = text.replace(/\s+/g, ' ');
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(t.trim())) return { rows: [] };
      if (t.includes('UPDATE jobs SET') && t.includes('attempts=$2 AND locked_by=$3')) {
        const [id, attempt, worker] = values as [string, number, string];
        if (id === 'job-9' && job.status === 'PROCESSING' && job.attempts === attempt && job.locked_by === worker) {
          job.status = 'COMPLETED';
          job.locked_by = null;
          return { rows: [{ id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (t.includes('UPDATE job_attempts SET logs = logs ||')) {
        const withAttempt = t.includes('attempt_number=$3');
        const row = attempts.find(a => !a.finished_at && (!withAttempt || a.attempt_number === (values[2] as number)));
        if (row) row.logs.push(JSON.parse(String(values[1])));
        return { rows: [] };
      }
      if (t.includes('UPDATE job_attempts SET status=')) {
        const row = attempts.find(a => a.attempt_number === (values[1] as number) && !a.finished_at);
        if (row) {
          row.status = 'COMPLETED';
          row.finished_at = 'now';
        }
        return { rows: [] };
      }
      throw new Error(`unexpected statement: ${text.slice(0, 100)}`);
    }) as never,
  };
  return api;
};

const cannedSummary = (tag: string): {
  cohortId: string; status: 'COMPLETED'; seedsAttempted: number; depth1Channels: number; depth2Fetches: number;
  nominations: number; ingested: number; channelsCapped: number; downstreamCapped: number;
  failures: string[]; failureCodes: string[]; quotaUnits: number;
} => ({
  cohortId: 'c1', status: 'COMPLETED', seedsAttempted: 1, depth1Channels: 0, depth2Fetches: 0,
  nominations: 0, ingested: 0, channelsCapped: 0, downstreamCapped: 0,
  failures: [`${tag}:boom`], failureCodes: ['PROVIDER_CALL_FAILED'], quotaUnits: 0,
});

// The dangerous race, step by step: stale Worker A must not complete Worker
// B's retry, and B must still complete normally afterwards.
test('stale canary worker cannot complete a newer retry', async () => {
  const { handleRelationshipCanaryExpansionJob, completeRelationshipCanaryAttempt, persistRelationshipCanarySummary } = await import('./queueManager').then(async (qm) => ({
    handleRelationshipCanaryExpansionJob: qm.handleRelationshipCanaryExpansionJob,
    ...(await import('./relationshipCanary')),
  }));
  const store = makeLifecycleStore();
  const q = store.query;
  const wired = (tag: string) => ({
    runCanary: async () => cannedSummary(tag),
    persistSummary: (jobId: string, summary: RelationshipCanarySummary, attempt?: number) =>
      persistRelationshipCanarySummary(q, jobId, summary, attempt),
    completeAttempt: (input: { jobId: string; attemptNumber: number; workerId: string }) =>
      completeRelationshipCanaryAttempt(q, input),
  });

  // Worker A claims attempt 1, then goes stale; recovery requeues.
  const claimA = store.claim('worker-A');
  assert.equal(claimA?.attempts, 1);
  store.recover();
  assert.equal(store.job.status, 'PENDING');
  // Worker B claims attempt 2 and starts work.
  const claimB = store.claim('worker-B');
  assert.equal(claimB?.attempts, 2);
  // Worker A finishes late: persist targets only attempt 1 (already failed),
  // and conditional completion refuses (ownership lost).
  const staleResult = await handleRelationshipCanaryExpansionJob(
    { id: 'job-9', attempts: 1, payload: {} },
    wired('stale-A'),
    { workerId: 'worker-A', attemptNumber: 1 },
  );
  assert.deepEqual(staleResult, { completed: false });
  assert.equal(store.job.status, 'PROCESSING');
  assert.equal(store.job.attempts, 2);
  assert.equal(store.job.locked_by, 'worker-B');
  assert.deepEqual(store.attempts[1].logs, []);
  // Worker B remains the valid owner and completes normally.
  const freshResult = await handleRelationshipCanaryExpansionJob(
    { id: 'job-9', attempts: 2, payload: {} },
    wired('fresh-B'),
    { workerId: 'worker-B', attemptNumber: 2 },
  );
  assert.deepEqual(freshResult, { completed: true });
  assert.equal(store.job.status, 'COMPLETED');
  assert.equal(store.attempts[1].status, 'COMPLETED');
  assert.ok(store.attempts[1].finished_at);
  assert.equal(store.attempts[1].logs.length, 1);
  // Attempt 1 keeps its recovery lifecycle state (FAILED), untouched by B.
  assert.equal(store.attempts[0].status, 'FAILED');
});

// Ownership mismatch variants: wrong worker, wrong attempt, non-processing.
test('conditional completion rejects mismatched ownership', async () => {
  const { completeRelationshipCanaryAttempt } = await import('./relationshipCanary');
  const store = makeLifecycleStore();
  const q = store.query;
  store.claim('worker-A');
  assert.deepEqual(await completeRelationshipCanaryAttempt(q, { jobId: 'job-9', attemptNumber: 1, workerId: 'worker-B' }), { completed: false });
  assert.deepEqual(await completeRelationshipCanaryAttempt(q, { jobId: 'job-9', attemptNumber: 2, workerId: 'worker-A' }), { completed: false });
  assert.deepEqual(await completeRelationshipCanaryAttempt(q, { jobId: 'job-other', attemptNumber: 1, workerId: 'worker-A' }), { completed: false });
  assert.equal(store.job.status, 'PROCESSING');
  assert.deepEqual(await completeRelationshipCanaryAttempt(q, { jobId: 'job-9', attemptNumber: 1, workerId: 'worker-A' }), { completed: true });
  assert.equal(store.job.status, 'COMPLETED');
});

// Normal path: claim → run → persist → conditional complete, in order.
test('normal canary run completes its own attempt with observable logs', async () => {
  const { handleRelationshipCanaryExpansionJob, completeRelationshipCanaryAttempt, persistRelationshipCanarySummary } = await import('./queueManager').then(async (qm) => ({
    handleRelationshipCanaryExpansionJob: qm.handleRelationshipCanaryExpansionJob,
    ...(await import('./relationshipCanary')),
  }));
  const store = makeLifecycleStore();
  const q = store.query;
  const events: string[] = [];
  store.claim('worker-A');
  const result = await handleRelationshipCanaryExpansionJob(
    { id: 'job-9', attempts: 1, payload: {} },
    {
      runCanary: async () => { events.push('run'); return cannedSummary('ok'); },
      persistSummary: async (jobId: string, summary: RelationshipCanarySummary, attempt?: number) => {
        events.push('persist');
        await persistRelationshipCanarySummary(q, jobId, summary, attempt);
      },
      completeAttempt: async (input) => {
        events.push('complete');
        return completeRelationshipCanaryAttempt(q, input);
      },
    },
    { workerId: 'worker-A', attemptNumber: 1 },
  );
  assert.deepEqual(result, { completed: true });
  assert.deepEqual(events, ['run', 'persist', 'complete']);
  assert.equal(store.job.status, 'COMPLETED');
  assert.equal(store.attempts[0].logs.length, 1);
});
