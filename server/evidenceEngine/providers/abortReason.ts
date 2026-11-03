/**
 * A caller aborts a semantic attempt for two different reasons: its own
 * cancellation (for example a superseded request) or the attempt deadline
 * expiring. Both set `signal.reason`, but only the deadline is a provider
 * TIMEOUT. Classify from the reason before falling back to CANCELLED so
 * telemetry and failure taxonomy stay accurate.
 */
export function abortReasonClass(signal?: AbortSignal): string | undefined {
  return (signal?.reason as { errorClass?: string } | undefined)?.errorClass;
}

export function abortedByDeadline(signal?: AbortSignal): boolean {
  return signal?.aborted === true && abortReasonClass(signal) === 'TIMEOUT';
}
