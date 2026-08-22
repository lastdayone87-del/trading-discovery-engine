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
