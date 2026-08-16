import type { ChannelRecord, DiscoverySource } from '../src/types';

const DEFAULT_MACHINE_NON_TRADING_RECONSIDER_HOURS = 24;

function machineNonTradingReconsiderAfterMs(): number {
  const configured = Number(process.env.MACHINE_NON_TRADING_RECONSIDER_HOURS ?? DEFAULT_MACHINE_NON_TRADING_RECONSIDER_HOURS);
  const hours = Number.isFinite(configured) ? Math.max(1, configured) : DEFAULT_MACHINE_NON_TRADING_RECONSIDER_HOURS;
  return hours * 60 * 60 * 1000;
}

export function machineNonTradingRediscoveryEligible(existing: ChannelRecord, now = Date.now()): boolean {
  const machineNonTrading = existing.trading_status === 'NON_TRADING' || existing.scan_status === 'SKIPPED_NON_TRADING';
  if (!machineNonTrading) return false;

  // Human and country-policy decisions remain authoritative. Only a machine
  // semantic rejection can age back into autonomous reconsideration.
  if (existing.trading_status === 'HUMAN_REJECTED' || existing.country_status === 'REJECTED' || existing.scan_status === 'SKIPPED_EXCLUDED') {
    return false;
  }

  if (!existing.last_checked) return true;
  const checkedAt = Date.parse(existing.last_checked);
  if (!Number.isFinite(checkedAt)) return false;
  return now - checkedAt >= machineNonTradingReconsiderAfterMs();
}

/**
 * Decide whether discovery should preserve an existing row before any expensive
 * country/trading/community work begins.
 *
 * Human and country-policy terminal decisions remain immutable to ordinary
 * discovery. Machine NON_TRADING decisions are different: after a bounded
 * cooling period, a fresh autonomous rediscovery may pass through the current
 * retrieval firewall again. The search hit itself is not creator evidence; it
 * merely earns the channel another chance to collect fresh independent creator
 * evidence if the current retrieval-admission policy still finds a plausible
 * trading hypothesis.
 */
export function shouldPreserveExistingChannel(
  existing: ChannelRecord,
  source: DiscoverySource,
  isManualScan: boolean,
  now = Date.now()
): boolean {
  // Keep the explicit Stage-1 serving/evaluation separation visible: ordinary
  // discovery follows preservation policy; the recheck lane is the deliberate
  // operator override.
  if (source !== 'recheck') {
    const hardTerminal =
      existing.country_status === 'REJECTED' ||
      existing.trading_status === 'HUMAN_REJECTED' ||
      existing.scan_status === 'SKIPPED_EXCLUDED';
    if (hardTerminal) return true;

    const machineNonTrading = existing.trading_status === 'NON_TRADING' || existing.scan_status === 'SKIPPED_NON_TRADING';
    if (machineNonTrading) {
      const autonomousRediscovery = source === 'automated_query' || String(source) === 'autonomous';
      if (autonomousRediscovery && !isManualScan && machineNonTradingRediscoveryEligible(existing, now)) {
        return false;
      }
      return true;
    }

    return !isManualScan && (
      existing.trading_status === 'TRADING_CONFIRMED' ||
      existing.scan_status === 'COMPLETED'
    );
  }

  return false;
}
