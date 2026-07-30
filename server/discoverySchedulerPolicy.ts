export interface DiscoveryCapacityInput {
  batchSize: number;
  targetQueueDepth: number;
  currentQueueDepth: number;
  dailyBudget: number;
  allocationPercent: number;
  unitsUsed: number;
  unitsReserved: number;
  minutesSinceUtcMidnight: number;
  unitCost?: number;
}

export function calculateDiscoveryCapacity(input: DiscoveryCapacityInput): number {
  const batchSize = Math.max(0, Math.floor(input.batchSize));
  const queueCapacity = Math.max(0, Math.floor(input.targetQueueDepth - input.currentQueueDepth));
  // Workers own the authoritative, race-safe shared-pool reservation directly
  // before provider execution. A second admission gate here used a different
  // durable ledger, so stale query runs could stop production indefinitely.
  return Math.min(batchSize, queueCapacity);
}
