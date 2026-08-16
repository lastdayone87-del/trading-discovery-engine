import { getNextYouTubeQuotaResetAt } from './youtubeQuotaDay';

/** Retry signal for quota allocation capacity, not a processing failure. */
export class QuotaAllocationExhaustedError extends Error {
  readonly code = 'QUOTA_ALLOCATION_EXHAUSTED';

  constructor(
    public readonly allocation: 'MANUAL' | 'ENRICHMENT' | 'AUTONOMOUS',
    public readonly retryAt: number = getNextYouTubeQuotaResetAt()
  ) {
    super(`${allocation} YouTube quota allocation is exhausted; retry is scheduled for ${new Date(retryAt).toISOString()}.`);
    this.name = 'QuotaAllocationExhaustedError';
  }
}

/** @deprecated YouTube quota resets at Pacific midnight, not UTC midnight. */
export function nextUtcQuotaReset(now = new Date()): number {
  return getNextYouTubeQuotaResetAt(now);
}

export function isQuotaCapacityError(error: unknown): error is QuotaAllocationExhaustedError {
  return error instanceof QuotaAllocationExhaustedError || (error as any)?.code === 'QUOTA_ALLOCATION_EXHAUSTED';
}
