import type { ChannelRecord, DiscoverySource } from '../src/types';

/**
 * Decide whether discovery should preserve an existing row before any expensive
 * country/trading/community work begins.
 *
 * Terminal decisions are authoritative for ordinary discovery, including
 * operator-initiated manual search. The explicit `recheck` lane is the only
 * supported override because it is a deliberate semantic refresh.
 */
export function shouldPreserveExistingChannel(
  existing: ChannelRecord,
  source: DiscoverySource,
  isManualScan: boolean
): boolean {
  const terminal =
    existing.country_status === 'REJECTED' ||
    existing.trading_status === 'NON_TRADING' ||
    existing.trading_status === 'HUMAN_REJECTED' ||
    existing.scan_status === 'SKIPPED_EXCLUDED' ||
    existing.scan_status === 'SKIPPED_NON_TRADING';

  if (terminal) return source !== 'recheck';

  return !isManualScan && (
    existing.trading_status === 'TRADING_CONFIRMED' ||
    existing.scan_status === 'COMPLETED'
  );
}
