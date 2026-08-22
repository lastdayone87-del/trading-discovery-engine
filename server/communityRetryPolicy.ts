export const COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE = 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE';

export interface CommunityRetryObservation {
  required?: boolean;
  outcome: string;
  retryable: boolean;
  retryAt?: number;
  failureClass?: string;
}

export interface CommunityRetryDirective {
  attemptFree: boolean;
  code: string;
  retryAt?: number;
  reason: string;
}

const ATTEMPT_FREE_CODES = new Set([
  'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE',
  'YOUTUBE_PROVIDERS_COOLING_DOWN',
  'YOUTUBE_PROVIDER_POOL_EXHAUSTED',
  'YOUTUBE_RUNTIME_RATE_PRESSURE',
  'YOUTUBE_RECENT_VIDEO_ACQUISITION_FAILED',
  'PROVIDER_COOLDOWN',
  'PROVIDER_CONCURRENCY_CAP_EXCEEDED',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const ATTEMPT_FREE_CLASSES = new Set(['TIMEOUT', 'RATE_LIMIT', 'TRANSIENT', 'CREDENTIALS_EXHAUSTED']);

export function retryAtFromUnknown(error: any, now = Date.now()): number | undefined {
  const direct = Number(error?.retryAt ?? error?.cause?.retryAt);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const retryAfterMs = Number(error?.retryAfterMs ?? error?.cause?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return now + retryAfterMs;
  return undefined;
}

export function isAttemptFreeCommunityFailure(error: any): boolean {
  if (!error) return false;
  const code = String(error.code ?? error.cause?.code ?? '').toUpperCase();
  const errorClass = String(error.errorClass ?? error.cause?.errorClass ?? '').toUpperCase();
  const status = Number(error.status ?? error.statusCode ?? error.response?.status ?? error.cause?.status);
  return error.retryable === true && (
    ATTEMPT_FREE_CODES.has(code) ||
    ATTEMPT_FREE_CLASSES.has(errorClass) ||
    [408, 425, 429, 500, 502, 503, 504].includes(status)
  );
}

export function communityAcquisitionRetryDirective(
  observations: CommunityRetryObservation[],
): CommunityRetryDirective | undefined {
  const requiredFailures = observations.filter(item => item.required !== false && item.outcome === 'ACQUISITION_FAILED' && item.retryable);
  if (!requiredFailures.length) return undefined;
  const retryTimes = requiredFailures.map(item => Number(item.retryAt)).filter(value => Number.isFinite(value) && value > 0);
  return {
    attemptFree: true,
    code: COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE,
    retryAt: retryTimes.length ? Math.min(...retryTimes) : undefined,
    reason: requiredFailures.map(item => item.failureClass || 'TRANSIENT_ACQUISITION_FAILURE').join(', '),
  };
}

export function attemptFreeDiscordValidation(outcome: string, retryable: boolean): boolean {
  return retryable && outcome !== 'INVALID_OBSERVED';
}
