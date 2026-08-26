export type ProviderCapacityReason =
  | 'ALL_KEYS_COOLING_DOWN'
  | 'ALL_KEYS_DAILY_QUOTA_EXHAUSTED'
  | 'PROVIDER_RUNTIME_RATE_PRESSURE'
  | 'PROVIDER_QUOTA_ALLOCATION_EXHAUSTED'
  | 'PROVIDER_COOLDOWN'
  | 'PROVIDER_CONCURRENCY_CAP'
  | 'PROVIDER_CAPACITY_UNKNOWN';

export interface ProviderCapacityDiagnostic {
  reason: ProviderCapacityReason;
  retryable: boolean;
  retryAt?: string;
}

/**
 * A query-run outcome is deliberately separate from provider capacity. A
 * successful empty response is data, while an all-provider failure is an
 * operational outcome and must never be learned as a zero-result query.
 */
export type ProviderRunOutcome =
  | 'SUCCESS_NON_EMPTY'
  | 'SUCCESS_EMPTY'
  | 'RECOVERED_AFTER_PROVIDER_FAILURE'
  | 'FAILED_ALL_PROVIDERS'
  | 'FAILED_AFTER_PROVIDER_RESPONSE'
  | 'DEFERRED_PROVIDER_CAPACITY'
  | 'FAILED_PROVIDER_RESPONSE';

export function classifyProviderRunOutcome(input: {
  rawResults: number;
  providerRequestsAttempted: number;
  providerRequestsSucceeded: number;
  providerRequestsFailed: number;
  providerRateLimited: number;
  capacityDeferred?: boolean;
  terminalFailure?: boolean;
}): ProviderRunOutcome {
  const rawResults = Math.max(0, Number(input.rawResults) || 0);
  const attempted = Math.max(0, Number(input.providerRequestsAttempted) || 0);
  const succeeded = Math.max(0, Number(input.providerRequestsSucceeded) || 0);
  const failed = Math.max(0, Number(input.providerRequestsFailed) || 0);
  const rateLimited = Math.max(0, Number(input.providerRateLimited) || 0);

  if (input.capacityDeferred) return 'DEFERRED_PROVIDER_CAPACITY';
  if (input.terminalFailure) {
    if (succeeded > 0) return 'FAILED_AFTER_PROVIDER_RESPONSE';
    if (attempted > 0 && failed + rateLimited >= attempted) return 'FAILED_ALL_PROVIDERS';
    return 'FAILED_PROVIDER_RESPONSE';
  }
  if (succeeded > 0) {
    return failed + rateLimited > 0
      ? 'RECOVERED_AFTER_PROVIDER_FAILURE'
      : rawResults > 0 ? 'SUCCESS_NON_EMPTY' : 'SUCCESS_EMPTY';
  }
  return attempted > 0 && failed + rateLimited >= attempted
    ? 'FAILED_ALL_PROVIDERS'
    : 'FAILED_PROVIDER_RESPONSE';
}

function finiteTimestamp(value: unknown): string | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return new Date(numeric).toISOString();
}

export function classifyProviderCapacityFailure(error: unknown): ProviderCapacityDiagnostic | undefined {
  const candidate = error as { code?: unknown; retryAt?: unknown; retryAfterMs?: unknown; errorClass?: unknown } | null;
  const code = String(candidate?.code || '').toUpperCase();
  const errorClass = String(candidate?.errorClass || '').toUpperCase();
  const retryAt = finiteTimestamp(candidate?.retryAt);
  if (code === 'YOUTUBE_PROVIDERS_COOLING_DOWN') return { reason: 'ALL_KEYS_COOLING_DOWN', retryable: true, retryAt };
  if (code === 'YOUTUBE_PROVIDER_POOL_EXHAUSTED') return { reason: 'ALL_KEYS_DAILY_QUOTA_EXHAUSTED', retryable: true, retryAt };
  if (code === 'YOUTUBE_RUNTIME_RATE_PRESSURE' || errorClass === 'RATE_LIMIT') return { reason: 'PROVIDER_RUNTIME_RATE_PRESSURE', retryable: true, retryAt };
  if (code === 'QUOTA_ALLOCATION_EXHAUSTED') return { reason: 'PROVIDER_QUOTA_ALLOCATION_EXHAUSTED', retryable: true, retryAt };
  if (code === 'PROVIDER_COOLDOWN') return { reason: 'PROVIDER_COOLDOWN', retryable: true, retryAt };
  if (code === 'PROVIDER_CONCURRENCY_CAP_EXCEEDED') return { reason: 'PROVIDER_CONCURRENCY_CAP', retryable: true, retryAt };
  return undefined;
}
