export interface LowAudienceGateResult {
  shouldSkipDeepEnrichment: boolean;
  subscriberCountNumber?: number;
  reasonCode: 'LOW_AUDIENCE_SKIP' | 'SUFFICIENT_AUDIENCE_PROCEED' | 'SUBSCRIBER_COUNT_UNAVAILABLE';
}

export function parseSubscriberCountNumber(raw?: string): number | undefined {
  if (!raw) return undefined;
  const normalized = String(raw).trim().toUpperCase();
  if (!normalized || normalized === 'HIDDEN' || normalized === 'UNAVAILABLE' || normalized === 'UNKNOWN' || normalized === 'N/A' || normalized === 'NA') return undefined;

  const compact = normalized.replace(/,/g, '');
  const numeric = compact.match(/^(\d+)$/);
  const subscribers = compact.match(/^(\d+)\s+SUBSCRIBERS?$/);
  const thousands = compact.match(/^(\d+(?:\.\d+)?)\s*K(?:\s+SUBSCRIBERS?)?$/);
  const millions = compact.match(/^(\d+(?:\.\d+)?)\s*M(?:\s+SUBSCRIBERS?)?$/);
  const finite = (value: number): number | undefined => Number.isFinite(value) ? value : undefined;
  if (numeric) return finite(parseInt(numeric[1], 10));
  if (subscribers) return finite(parseInt(subscribers[1], 10));
  if (thousands) return finite(Math.round(parseFloat(thousands[1]) * 1000));
  if (millions) return finite(Math.round(parseFloat(millions[1]) * 1000000));
  return undefined;
}

/**
 * Accept a subscriber value only when it is a parseable count. Channel handles
 * ('@name'), digit-free text, and other non-count values must never be stored
 * in `subscriber_count`: the low-audience gate treats them as unknown and
 * fail-opens, so a poisoned value hides a genuinely small channel.
 */
export function sanitizeSubscriberCountText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).replace(/\u00a0/g, ' ').trim();
  if (!text || text.startsWith('@')) return undefined;
  if (!/\d/.test(text)) return undefined;
  const count = parseSubscriberCountNumber(text);
  if (count === undefined || !Number.isFinite(count)) return undefined;
  return text;
}

/**
 * Low-Audience Budget Gate (Phase 7):
 * Configurable subscriber threshold gate (default: 30 subscribers).
 * 0-29 known subscribers: stored and marked low-audience skip; deep crawl/enrichment is skipped.
 * 30+ subscribers or hidden/unavailable: proceeds normally.
 */
export function evaluateLowAudienceGate(rawSubscriberCount?: string, threshold = 30): LowAudienceGateResult {
  const count = parseSubscriberCountNumber(rawSubscriberCount);
  if (count === undefined) {
    return { shouldSkipDeepEnrichment: false, reasonCode: 'SUBSCRIBER_COUNT_UNAVAILABLE' };
  }
  if (count < threshold) {
    return { shouldSkipDeepEnrichment: true, subscriberCountNumber: count, reasonCode: 'LOW_AUDIENCE_SKIP' };
  }
  return { shouldSkipDeepEnrichment: false, subscriberCountNumber: count, reasonCode: 'SUFFICIENT_AUDIENCE_PROCEED' };
}

/**
 * A fresh known-low audience result may update a preserved completed row so
 * the stored record remains auditable but leaves the normal operator corpus.
 * Unknown audience data never qualifies, and non-completed workflow states
 * remain visible to their owning workflow instead of being hidden here.
 */
export function shouldReclassifyPreservedCompletedChannel(
  existingScanStatus: string | undefined,
  gate: LowAudienceGateResult,
  tradingStatus?: string | null,
): boolean {
  // A confirmed trading classification is permanent under ordinary
  // rediscovery. A later low subscriber observation may be recorded, but it
  // must not move a confirmed channel into the low-audience skip lane.
  if (tradingStatus === 'TRADING_CONFIRMED') return false;
  return existingScanStatus === 'COMPLETED' && gate.shouldSkipDeepEnrichment;
}
