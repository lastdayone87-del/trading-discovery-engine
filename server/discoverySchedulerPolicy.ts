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

export interface BoundedBraveCanaryTarget {
  targetProviderKey?: unknown;
  requiredCapability?: unknown;
  allocationType?: unknown;
  maxRuns?: unknown;
  allowShadowProvider?: unknown;
}

export function isBoundedBraveCanaryTarget(target?: BoundedBraveCanaryTarget): boolean {
  return target?.targetProviderKey === 'brave-search'
    && target.requiredCapability === 'SEARCH_BRAVE_DIRECT'
    && target.allocationType === 'FRONTIER_CANARY'
    && Number(target.maxRuns) === 1
    && target.allowShadowProvider === true;
}

export function calculateDiscoveryCapacity(input: DiscoveryCapacityInput, target?: BoundedBraveCanaryTarget): number {
  const batchSize = Math.max(0, Math.floor(input.batchSize));
  if (isBoundedBraveCanaryTarget(target)) return Math.min(1, batchSize || 1);
  const queueCapacity = Math.max(0, Math.floor(input.targetQueueDepth - input.currentQueueDepth));
  // Workers own the authoritative, race-safe shared-pool reservation directly
  // before provider execution. A second admission gate here used a different
  // durable ledger, so stale query runs could stop production indefinitely.
  return Math.min(batchSize, queueCapacity);
}
