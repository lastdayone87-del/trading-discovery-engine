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
  const rel = (channelId: string, kind: string, depth: number) => ({ channelId, sourceType: 'FEATURED_CHANNEL', cohortId: 'c1', kind, depth });
  const nominations = [
    rel(UC('a1'), 'featured', 1),
    rel(UC('a1'), 'featured', 1),
    rel(UC('a2'), 'playlist', 1),
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
  assert.equal(metrics.rejectedOrUncertain, 1);
  assert.equal(metrics.duplicationRate, 4 / 3);
  assert.equal(metrics.quotaUnits, 12);
  assert.equal(metrics.costPerConfirm, 6);
  const empty = aggregateRelationshipCohort('c1', [], [], 0);
  assert.equal(empty.costPerConfirm, null);
  assert.equal(empty.duplicationRate, 0);
});
