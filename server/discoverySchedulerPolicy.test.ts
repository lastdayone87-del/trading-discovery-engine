import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDiscoveryCapacity } from './discoverySchedulerPolicy';

test('caps scheduling by batch, queue, and paced quota capacity', () => {
  assert.equal(calculateDiscoveryCapacity({
    batchSize: 5, targetQueueDepth: 15, currentQueueDepth: 12,
    dailyBudget: 9000, allocationPercent: 70, unitsUsed: 0,
    unitsReserved: 0, minutesSinceUtcMidnight: 0
  }), 3);
});

test('does not schedule when autonomous quota is already reserved', () => {
  assert.equal(calculateDiscoveryCapacity({
    batchSize: 5, targetQueueDepth: 15, currentQueueDepth: 0,
    dailyBudget: 9000, allocationPercent: 70, unitsUsed: 6000,
    unitsReserved: 300, minutesSinceUtcMidnight: 1439
  }), 0);
});

test('never overfills the configured queue target', () => {
  assert.equal(calculateDiscoveryCapacity({
    batchSize: 5, targetQueueDepth: 15, currentQueueDepth: 15,
    dailyBudget: 9000, allocationPercent: 70, unitsUsed: 0,
    unitsReserved: 0, minutesSinceUtcMidnight: 720
  }), 0);
});
