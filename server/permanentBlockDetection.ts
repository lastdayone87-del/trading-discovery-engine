/**
 * Conclusive permanent access block (terminal/non-retryable).
 *
 * Reason code: PERMANENT_ACCESS_BLOCK.
 *
 * A single 403/999/429/NO_PAGE/network failure is NEVER sufficient by
 * itself (uncertain/current block → retryable). Terminal requires bounded
 * retries to establish permanence with identical evidence:
 *
 * Identical across attempts (all required):
 * - same normalized URL key (timeoutSuppressionKey semantics: trim + https
 *   fallback; trailing-slash variants are distinct targets),
 * - same failureClass HTTP_ERROR,
 * - same httpStatus 401 or 403,
 * - same final registrable host (redirect target did not wander),
 * - zero pages inspected and zero candidates on every attempt,
 * - outcomes FAILED only (no intervening FOUND / success / clean),
 * - >=3 attempts total (current + >=2 priors) within the loaded history
 *   window (existing bounded retry policy; maxAttempts still bounds).
 *
 * Response/content evidence (all required):
 * - block markers present in the CURRENT response body (bounded read on
 *   401/403: cloudflare/cf-chl/__cf_bm/perimeterx/_px/datadome/captcha/
 *   verify-human/access-denied with 403 context),
 * - historical bodies are not persisted, so historical markers cannot be
 *   verified yet: the rule additionally requires the identical-status/class/
 *   URL/zero-evidence history above and fails closed whenever any required
 *   field is missing (legacy history rows without httpStatus/finalUrl never
 *   establish permanence). Persisting per-attempt markers is the telemetry
 *   strengthening path; until then the rule fires only on the full
 *   identical-history + current-markers conjunction, otherwise retryable.
 *
 * Terminal handling (matches login/paywall doctrine):
 * - outcome stays FAILED (or PARTIAL when pages were inspected but coverage
 *   incomplete — never INSPECTED_NO_MATCH; inaccessibility is the opposite
 *   of a clean negative),
 * - retryable:false, visible in trail/dashboard with the terminal reason,
 * - never borrowed as final across URLs (exact-page only),
 * - never owns retry (deterministically permanent set),
 * - channel may still reach FAILED_OPERATIONAL (terminal, no RETRY DUE)
 *   while remaining UNCERTAIN where absence is unproven.
 *
 * Fail-open: any error, missing field, or non-identical history → not
 * permanent (retryable per existing bounded policy).
 */

export const PERMANENT_ACCESS_BLOCK_FAILURE_CLASS = 'PERMANENT_ACCESS_BLOCK';

const BLOCK_MARKER_PATTERN =
  /cf-chl|__cf_bm|cf_clearance|perimeterx|_px3?_|datadome|captcha|verify\s+you\s+are\s+human|access\s+denied|forbidden|request\s+blocked|attention\s+required/i;

export function hasBlockMarkers(body: string): boolean {
  try {
    const text = String(body || '');
    if (text.length === 0) return false;
    return BLOCK_MARKER_PATTERN.test(text);
  } catch {
    return false;
  }
}

function registrableOf(raw: string): string {
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeKey(raw: string): string {
  const url = String(raw || '').trim();
  if (!url) return '';
  return url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;
}

export interface PermanentBlockAttempt {
  requestedUrl?: unknown;
  failureClass?: unknown;
  httpStatus?: unknown;
  finalUrl?: unknown;
  outcome?: unknown;
  pagesInspected?: unknown;
  hasCandidates?: boolean;
  blockMarkers?: boolean;
  observedAt?: unknown;
}

export function isConclusivePermanentBlock(input: {
  current: PermanentBlockAttempt;
  history: PermanentBlockAttempt[];
}): boolean {
  try {
    const current = input.current || {};
    if (current.hasCandidates === true) return false;
    if (String(current.failureClass || '') !== 'HTTP_ERROR') return false;
    const status = Number(current.httpStatus);
    if (status !== 401 && status !== 403) return false;
    if ((Number(current.pagesInspected) || 0) !== 0) return false;
    if (current.blockMarkers !== true) return false;
    const key = normalizeKey(String(current.requestedUrl || ''));
    if (!key) return false;
    const finalReg = registrableOf(String(current.finalUrl || ''));
    if (!finalReg) return false;
    const priors = (Array.isArray(input.history) ? input.history : []).filter(row => {
      if (normalizeKey(String(row.requestedUrl || '')) !== key) return false;
      if (String(row.failureClass || '') !== 'HTTP_ERROR') return false;
      if (Number(row.httpStatus) !== status) return false;
      if (String(row.outcome || '') !== 'ACQUISITION_FAILED') return false;
      if ((Number(row.pagesInspected) || 0) !== 0) return false;
      if (row.hasCandidates === true) return false;
      const rowFinal = registrableOf(String(row.finalUrl || ''));
      if (!rowFinal || rowFinal !== finalReg) return false;
      return true;
    });
    return priors.length >= 2;
  } catch {
    return false;
  }
}
