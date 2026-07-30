/** Retry signal for quota allocation capacity, not a processing failure. */
export class QuotaAllocationExhaustedError extends Error {
  readonly code = 'QUOTA_ALLOCATION_EXHAUSTED';

  constructor(
    public readonly allocation: 'MANUAL' | 'ENRICHMENT' | 'AUTONOMOUS',
    public readonly retryAt: number = nextUtcQuotaReset()
  ) {
    super(`${allocation} YouTube quota allocation is exhausted; retry is scheduled for ${new Date(retryAt).toISOString()}.`);
    this.name = 'QuotaAllocationExhaustedError';
  }
}

export function nextUtcQuotaReset(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

export function isQuotaCapacityError(error: unknown): error is QuotaAllocationExhaustedError {
  return error instanceof QuotaAllocationExhaustedError || (error as any)?.code === 'QUOTA_ALLOCATION_EXHAUSTED';
}
