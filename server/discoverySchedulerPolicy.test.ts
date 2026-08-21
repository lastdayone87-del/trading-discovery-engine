import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDiscoveryCapacity, isBoundedBraveCanaryTarget } from './discoverySchedulerPolicy';

test('caps scheduling by batch and queue capacity', () => {
  assert.equal(calculateDiscoveryCapacity({
    batchSize: 5, targetQueueDepth: 15, currentQueueDepth: 12,
    dailyBudget: 9000, allocationPercent: 70, unitsUsed: 0,
    unitsReserved: 0, minutesSinceUtcMidnight: 0
  }), 3);
});

test('does not let stale quota ledgers stop queue replenishment', () => {
  assert.equal(calculateDiscoveryCapacity({
    batchSize: 5, targetQueueDepth: 15, currentQueueDepth: 0,
    dailyBudget: 9000, allocationPercent: 70, unitsUsed: 6000,
    unitsReserved: 300, minutesSinceUtcMidnight: 1439
  }), 5);
});

test('never overfills the configured queue target', () => {
  assert.equal(calculateDiscoveryCapacity({
    batchSize: 5, targetQueueDepth: 15, currentQueueDepth: 15,
    dailyBudget: 9000, allocationPercent: 70, unitsUsed: 0,
    unitsReserved: 0, minutesSinceUtcMidnight: 720
  }), 0);
});

test('exact one-run Brave Frontier canary admits one run despite a full YouTube queue', () => {
  const fullQueue = {
    batchSize: 5, targetQueueDepth: 15, currentQueueDepth: 15,
    dailyBudget: 9000, allocationPercent: 70, unitsUsed: 0,
    unitsReserved: 0, minutesSinceUtcMidnight: 720
  };
  const target = {
    targetProviderKey: 'brave-search', requiredCapability: 'SEARCH_BRAVE_DIRECT',
    allocationType: 'FRONTIER_CANARY', maxRuns: 1, allowShadowProvider: true
  };
  assert.equal(isBoundedBraveCanaryTarget(target), true);
  assert.equal(calculateDiscoveryCapacity(fullQueue, target), 1);
});

test('every near-miss remains queue-capped and cannot use the Brave exception', () => {
  const fullQueue = {
    batchSize: 5, targetQueueDepth: 15, currentQueueDepth: 15,
    dailyBudget: 9000, allocationPercent: 70, unitsUsed: 0,
    unitsReserved: 0, minutesSinceUtcMidnight: 720
  };
  const base = {
    targetProviderKey: 'brave-search', requiredCapability: 'SEARCH_BRAVE_DIRECT',
    allocationType: 'FRONTIER_CANARY', maxRuns: 1, allowShadowProvider: true
  };
  for (const nearMiss of [
    {...base, targetProviderKey: 'youtube'},
    {...base, requiredCapability: 'SEARCH_YOUTUBE'},
    {...base, allocationType: 'LEGACY'},
    {...base, maxRuns: 2},
    {...base, allowShadowProvider: false},
    {...base, allocationType: undefined}
  ]) {
    assert.equal(isBoundedBraveCanaryTarget(nearMiss), false);
    assert.equal(calculateDiscoveryCapacity(fullQueue, nearMiss), 0);
  }
});
