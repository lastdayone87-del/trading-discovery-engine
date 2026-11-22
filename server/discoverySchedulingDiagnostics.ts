const SCHEDULING_ERROR_MESSAGE_LIMIT = 400;
const CREDENTIAL_ASSIGNMENT = /((?:key|token|secret|password|authorization|bearer)\s*[=:]\s*)[^\s,;]+/gi;
const BEARER_CREDENTIAL = /Bearer\s+[^\s,;]+/gi;
const GOOGLE_API_KEY = /AIza[0-9A-Za-z_-]{10,}/g;
const STRUCTURAL_MESSAGE_CODE = /^[A-Z][A-Z0-9_]{2,}$/;

export interface SchedulingErrorDiagnostics {
  errorCode?: string;
  errorMessageCode?: string;
  /** Full bounded/redacted detail for production logs, never the scheduler report. */
  logMessage?: string;
}

function structuralMessageCode(message: string): string {
  const first = message.trim().split(/[:\s]/, 1)[0]?.toUpperCase() || '';
  return STRUCTURAL_MESSAGE_CODE.test(first) ? first.slice(0, 80) : 'UNSTRUCTURED_ERROR';
}

/**
 * Scheduler failures need more detail than the stable reason class, but the
 * scheduler report must not become a payload dump. This helper returns a
 * SQLSTATE/error code, a structural message token such as
 * `PHASE9_TREATMENT_CHANGED_PHASE8_NEIGHBORHOOD`, and a bounded/redacted
 * message for logs. Only the structural fields enter durable diagnostics.
 */
export function schedulingErrorDiagnostics(error: unknown): SchedulingErrorDiagnostics {
  const record = error as { code?: unknown; message?: unknown } | null;
  const rawMessage = typeof record?.message === 'string' ? record.message : '';
  const rawCode = typeof record?.code === 'string' ? record.code : '';
  const redacted = rawMessage
    .replace(GOOGLE_API_KEY, '[REDACTED_API_KEY]')
    .replace(BEARER_CREDENTIAL, 'Bearer [REDACTED]')
    .replace(CREDENTIAL_ASSIGNMENT, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SCHEDULING_ERROR_MESSAGE_LIMIT);
  return {
    ...(rawCode ? { errorCode: rawCode.slice(0, 64) } : {}),
    ...(redacted ? { errorMessageCode: structuralMessageCode(redacted) } : {}),
    ...(redacted ? { logMessage: redacted } : {}),
  };
}
