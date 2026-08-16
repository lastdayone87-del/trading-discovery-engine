export interface LowAudienceGateResult {
  shouldSkipDeepEnrichment: boolean;
  subscriberCountNumber?: number;
  reasonCode: 'LOW_AUDIENCE_SKIP' | 'SUFFICIENT_AUDIENCE_PROCEED' | 'SUBSCRIBER_COUNT_UNAVAILABLE';
}

export function parseSubscriberCountNumber(raw?: string): number | undefined {
  if (!raw) return undefined;
  const normalized = String(raw).trim().toUpperCase();
  if (!normalized || normalized === 'HIDDEN' || normalized === 'UNAVAILABLE') return undefined;

  if (/^\d+$/.test(normalized)) return parseInt(normalized, 10);
  if (/^[\d.]+\s*K$/.test(normalized)) return Math.round(parseFloat(normalized) * 1000);
  if (/^[\d.]+\s*M$/.test(normalized)) return Math.round(parseFloat(normalized) * 1000000);
  return undefined;
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
