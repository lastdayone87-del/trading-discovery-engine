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
  const unitCost = Math.max(1, input.unitCost ?? 100);
  const batchSize = Math.max(0, Math.floor(input.batchSize));
  const queueCapacity = Math.max(0, Math.floor(input.targetQueueDepth - input.currentQueueDepth));
  const allocationBudget = Math.max(0, Math.floor(input.dailyBudget * input.allocationPercent / 100));
  const dayFraction = Math.min(1, Math.max(0, input.minutesSinceUtcMidnight / 1440));
  // Permit one configured batch as a restart/cold-start burst, then pace the
  // remainder linearly through the UTC quota day.
  const pacedBudget = Math.min(allocationBudget, Math.floor(allocationBudget * dayFraction) + batchSize * unitCost);
  const quotaCapacity = Math.max(0, Math.floor((pacedBudget - input.unitsUsed - input.unitsReserved) / unitCost));
  return Math.min(batchSize, queueCapacity, quotaCapacity);
}
