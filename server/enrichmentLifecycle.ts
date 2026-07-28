import type { ScanStatus, TradingStatus } from '../src/types';

export interface UncertainLifecycleState {
  scanStatus: ScanStatus;
  tradingStatus: TradingStatus;
  shouldEnqueue: boolean;
}

export function resolveUncertainLifecycle(isEnrichmentPass: boolean): UncertainLifecycleState {
  return isEnrichmentPass
    ? { scanStatus: 'NEEDS_REVIEW', tradingStatus: 'NEEDS_REVIEW', shouldEnqueue: false }
    : { scanStatus: 'ENRICHMENT_PENDING', tradingStatus: 'UNCERTAIN', shouldEnqueue: true };
}
