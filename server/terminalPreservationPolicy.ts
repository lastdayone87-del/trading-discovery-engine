import type { ChannelRecord, DiscoverySource } from '../src/types';

const DEFAULT_MACHINE_NON_TRADING_RECONSIDER_HOURS = 24;

function machineNonTradingReconsiderAfterMs(): number {
  const configured = Number(process.env.MACHINE_NON_TRADING_RECONSIDER_HOURS ?? DEFAULT_MACHINE_NON_TRADING_RECONSIDER_HOURS);
  const hours = Number.isFinite(configured) ? Math.max(1, configured) : DEFAULT_MACHINE_NON_TRADING_RECONSIDER_HOURS;
  return hours * 60 * 60 * 1000;
}


/** Confirmed trading classification is a permanent terminal state. */
export function isPermanentTradingConfirmation(status: string | null | undefined): boolean {
  return status === 'TRADING_CONFIRMED';
}

/**
 * Ordinary discovery must not classify, enrich, or downgrade a channel whose
 * trading classification was already confirmed. Explicit operator rechecks /
 * force-rescans (isManualScan=true) are the audited correction lane and are
 * deliberately outside this guard.
 */
export function shouldShortCircuitConfirmedRediscovery(
  channel: Pick<ChannelRecord, 'trading_status'> | null | undefined,
  isManualScan: boolean,
): boolean {
  return !isManualScan && isPermanentTradingConfirmation(channel?.trading_status);
}


/**
 * A confirmed channel must not keep an active enrichment marker once ordinary
 * rediscovery is short-circuited. Terminal review/failure markers are kept.
 */
export function terminalScanStatusForConfirmedRediscovery(
  scanStatus: ChannelRecord['scan_status'],
  hasActiveEnrichmentJob: boolean,
): ChannelRecord['scan_status'] {
  // A live job owns the active marker; only an abandoned pending marker is
  // projected completed. LOCKED is owned by the stale-lock recovery sweep:
  // the inline pipeline can set it without a job row, so it is never treated
  // as abandoned here.
  if (hasActiveEnrichmentJob) return scanStatus;
  return scanStatus === 'ENRICHMENT_PENDING' || scanStatus === 'ENRICHING'
    ? 'COMPLETED'
    : scanStatus;
}


/**
 * A confirmed trading row is not reclassified, but an unresolved creator
 * country still needs the deterministic Gate-1 pass. This is country policy,
 * not trading reclassification, and spends no semantic/YouTube quota.
 */
export function shouldRevalidateConfirmedCountry(
  channel: Pick<ChannelRecord, 'trading_status' | 'country_status'> | null | undefined,
  isManualScan: boolean,
): boolean {
  return !isManualScan
    && channel?.trading_status === 'TRADING_CONFIRMED'
    && channel?.country_status === 'UNCERTAIN';
}


/** The bounded Discord pass may bypass COMPLETED preservation, but never
 * country-terminal or confirmed rows. */
export function shouldBypassPreservationForDiscordEvidence(
  channel: Pick<ChannelRecord, 'trading_status' | 'country_status' | 'scan_status'> | null | undefined,
  forceClassification: boolean,
): boolean {
  return forceClassification === true
    && channel?.trading_status === 'UNCERTAIN'
    && channel?.country_status !== 'REJECTED'
    && channel?.scan_status !== 'SKIPPED_EXCLUDED';
}

/**
 * A country-only evidence pass must not downgrade a previously resolved
 * country decision to UNCERTAIN just because this pass found nothing new.
 */
export function shouldPreserveResolvedCountry(
  existingStatus: string | null | undefined,
  incomingStatus: string | null | undefined,
): boolean {
  const resolved = (value: string | null | undefined) =>
    value === 'CONFIRMED' || value === 'LIKELY' || value === 'REJECTED';
  return resolved(existingStatus) && !resolved(incomingStatus);
}

export interface CountryPolicySnapshot {
  countryStatus?: string | null;
  country?: string | null;
  tradingStatus?: string | null;
  scanStatus?: string | null;
}

/** Map a raw channels row (snake_case columns) to the policy snapshot shape. */
export function countryPolicySnapshotFromRow(
  row: { country_status?: string | null; country?: string | null; trading_status?: string | null; scan_status?: string | null } | null | undefined,
): CountryPolicySnapshot | null {
  if (!row) return null;
  return {
    countryStatus: row.country_status ?? null,
    country: row.country ?? null,
    ...(row.trading_status !== undefined ? { tradingStatus: row.trading_status ?? null } : {}),
    ...(row.scan_status !== undefined ? { scanStatus: row.scan_status ?? null } : {}),
  };
}

/** Compare a channel's locked country policy with the snapshot a slower pass read. */
export function countryPolicySnapshotMatches(
  locked: CountryPolicySnapshot | null | undefined,
  expected: CountryPolicySnapshot,
): boolean {
  if (!locked) return false;
  if (String(locked.countryStatus || '') !== String(expected.countryStatus || '')) return false;
  if (String(locked.country || '') !== String(expected.country || '')) return false;
  if (expected.tradingStatus !== undefined
    && String(locked.tradingStatus || '') !== String(expected.tradingStatus || '')) return false;
  if (expected.scanStatus !== undefined
    && String(locked.scanStatus || '') !== String(expected.scanStatus || '')) return false;
  return true;
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
 *
 * IMPORTANT: an existing row whose country is still UNCERTAIN is not a
 * country-terminal decision. It must be allowed back through Gate 1 so fresh
 * first-party channel evidence (including the About/bio) can be resolved before
 * the row is preserved. Otherwise a previously admitted excluded-country
 * creator can remain permanently hidden behind a stale UNCERTAIN country state.
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
    // TRADING_CONFIRMED is permanent under ordinary rediscovery, including
    // rows whose creator country is still UNCERTAIN. Country exclusion remains
    // a separate serving-policy concern; it must not be resolved by
    // reclassifying the creator's trading status or spending semantic quota.
    if (shouldShortCircuitConfirmedRediscovery(existing, isManualScan)) return true;
    const hardTerminal =
      existing.country_status === 'REJECTED' ||
      existing.trading_status === 'HUMAN_REJECTED' ||
      existing.scan_status === 'SKIPPED_EXCLUDED';
    if (hardTerminal) return true;

    // Country uncertainty is explicitly non-terminal. Re-run Gate 1 so the
    // current creator evidence can resolve the country and apply exclusions.
    // A TRADING_CONFIRMED row with UNCERTAIN country is short-circuited above
    // and handled by shouldRevalidateConfirmedCountry, which fetches country
    // evidence without reclassifying trading.
    if (existing.country_status === 'UNCERTAIN') return false;

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
