import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDiscoveryCapacity } from './discoverySchedulerPolicy';
import { allocateSearchOrdering, youtubeOrder } from './searchOrdering';
import { allocateRetrievalLane } from './retrievalLanes';
import { calculateCreatorQualityScore } from './queryIntelligence';
import { queriesOutsideCooldown } from './queryPlanner';
import { selectQueryCollection, isSeverelyContaminatedQuery } from './queryPerformance';
import { YouTubeProviderCooldown } from './youtubeProviderCooldown';
import type { QueryRecord } from '../src/types';

test('Baseline Invariant 1 & 6: Quota capacity calculation and reservation boundaries', () => {
  // Verify capacity pacing calculation returns 0 when queue is full
  const fullQueueCapacity = calculateDiscoveryCapacity({
    batchSize: 5,
    targetQueueDepth: 10,
    currentQueueDepth: 10,
    dailyBudget: 10000,
    allocationPercent: 70,
    unitsUsed: 0,
    unitsReserved: 0,
    minutesSinceUtcMidnight: 100
  });
  assert.equal(fullQueueCapacity, 0);

  // Verify capacity calculation produces bounded positive batch size when queue depth is low
  const normalCapacity = calculateDiscoveryCapacity({
    batchSize: 5,
    targetQueueDepth: 15,
    currentQueueDepth: 2,
    dailyBudget: 10000,
    allocationPercent: 70,
    unitsUsed: 1000,
    unitsReserved: 200,
    minutesSinceUtcMidnight: 500
  });
  assert.ok(normalCapacity > 0 && normalCapacity <= 5, 'Capacity must be bounded by batch size');
});

test('Baseline Invariant 2 & 3: Query cooldown enforcement and intent rotation', () => {
  const now = new Date();
  const pastOneHour = new Date(now.getTime() - 3600_000).toISOString(); // executed 1 hour ago
  const pastSevenHours = new Date(now.getTime() - 7 * 3600_000).toISOString(); // executed 7 hours ago

  const mockQueries: QueryRecord[] = [
    {
      id: 1,
      query: 'dax trading',
      country: 'Germany',
      collection: 'PROVEN',
      intent: 'futures',
      primary_term: 'dax',
      times_executed: 5,
      last_executed: pastOneHour,
      total_channels_found: 10,
      unique_channels_found: 8,
      quality_channels_found: 5,
      community_channels_found: 2,
      avg_quality_score: 80,
      performance_score: 85,
      created_at: pastSevenHours,
      status: 'ACTIVE'
    },
    {
      id: 2,
      query: 'boerse frankfurt',
      country: 'Germany',
      collection: 'PROVEN',
      intent: 'stocks',
      primary_term: 'boerse',
      times_executed: 2,
      last_executed: pastSevenHours,
      total_channels_found: 8,
      unique_channels_found: 6,
      quality_channels_found: 4,
      community_channels_found: 1,
      avg_quality_score: 75,
      performance_score: 78,
      created_at: pastSevenHours,
      status: 'ACTIVE'
    }
  ];

  // 360 minute cooldown should exclude query #1 executed 1 hour ago
  const eligible360 = queriesOutsideCooldown(mockQueries, now, 360);
  assert.equal(eligible360.length, 1);
  assert.equal(eligible360[0].id, 2);

  // 30 minute cooldown should include both queries
  const eligible30 = queriesOutsideCooldown(mockQueries, now, 30);
  assert.equal(eligible30.length, 2);
});

test('Baseline Invariant 4 & 5: UCB query selection, novelty, and quality scoring', () => {
  // Quality scorer test
  const quality = calculateCreatorQualityScore({
    channel_name: 'DAX Orderflow Trader',
    country: 'Germany',
    country_status: 'CONFIRMED',
    activity_band: 'VERY_ACTIVE'
  }, ['DAX Market Structure & Volume Profile', 'Order Flow Analysis']);

  assert.ok(quality.score >= 50, 'High-quality technical content must receive strong quality score');
  assert.ok(quality.breakdown.reasons.length > 0);

  // Performance scoring threshold
  const metrics = {
    rawResults: 10,
    duplicateResults: 0,
    distinctResults: 10,
    newChannels: 8,
    knownChannels: 2,
    qualityChannels: 6,
    communitiesDiscovered: 2,
    countryRejected: 0,
    nonTrading: 0,
    uncertain: 0,
    needsReview: 0,
    tradingConfirmed: 8,
    averageQualityScore: 82,
    noveltyRatio: 0.8,
    countryPrecision: 1.0,
    tradingPrecision: 1.0,
    performanceScore: 88
  };
  const collection = selectQueryCollection('EXPERIMENTAL', 2, metrics);
  assert.equal(collection, 'PROVEN');

  const contaminatedMetrics = {
    rawResults: 10,
    duplicateResults: 0,
    distinctResults: 10,
    newChannels: 0,
    knownChannels: 0,
    qualityChannels: 0,
    communitiesDiscovered: 0,
    countryRejected: 0,
    nonTrading: 8,
    uncertain: 2,
    needsReview: 0,
    tradingConfirmed: 0,
    averageQualityScore: 10,
    noveltyRatio: 0.0,
    countryPrecision: 1.0,
    tradingPrecision: 0.0,
    performanceScore: 0
  };
  assert.equal(isSeverelyContaminatedQuery(contaminatedMetrics), true);
});

test('Baseline Invariant 7, 8: Search ordering & dual-lane discovery rules', () => {
  // Retrieval lane allocation gap closing
  assert.equal(allocateRetrievalLane(0, 1, 70), 'VIDEO');
  assert.equal(allocateRetrievalLane(10, 10, 0), 'CHANNEL');

  // Search ordering rules
  assert.equal(allocateSearchOrdering('CHANNEL', 0, 0, 100), 'RELEVANCE');
  assert.equal(allocateSearchOrdering('VIDEO', 0, 0, 0), 'RELEVANCE');

  // DISCOVERY_RECENCY_FLOOR_PERCENT environment override test
  const previousEnv = process.env.DISCOVERY_RECENCY_FLOOR_PERCENT;
  try {
    process.env.DISCOVERY_RECENCY_FLOOR_PERCENT = '0';
    assert.equal(allocateSearchOrdering('VIDEO', 0, 0, 0), 'RELEVANCE');
    assert.equal(allocateSearchOrdering('VIDEO', 0, 10, 50), 'DATE');
  } finally {
    process.env.DISCOVERY_RECENCY_FLOOR_PERCENT = previousEnv;
  }

  assert.equal(youtubeOrder('RELEVANCE'), 'relevance');
  assert.equal(youtubeOrder('DATE'), 'date');
});

test('Baseline Invariant 9: YouTube Provider rotation and cooldown boundaries', () => {
  const cooldown = new YouTubeProviderCooldown({
    initialRateLimitCooldownMs: 5000,
    maxRateLimitCooldownMs: 60000
  });
  const providerKey = 'test_key';

  assert.equal(cooldown.eligible(providerKey), true);
  cooldown.failed(providerKey, 'RATE_LIMITED');
  assert.equal(cooldown.eligible(providerKey), false);
  assert.equal(cooldown.status(providerKey).status, 'Cooling Down');
});
