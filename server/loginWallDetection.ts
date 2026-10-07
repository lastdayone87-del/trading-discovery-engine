/**
 * Confirmed login-wall detection (pure, no fetch).
 *
 * A confirmed login wall requires STRONG conjunction:
 * - requested URL redirects to a login/auth destination (requested != final),
 *   AND
 * - content evidence from ALREADY-FETCHED html confirms a login/auth wall.
 *
 * URL-only `/login` never confirms (misses redirects one way, fabricates
 * blocks on successes/assets/fragments the other). HTTP status alone never
 * confirms (429 vs 200 split necessary but 200 bucket mixes walls + ordinary
 * pages). FOUND/candidate-retained rows never become login walls (callers
 * exclude FOUND first).
 *
 * Fail-open: missing/errored inputs → not confirmed.
 */

const LOGIN_PATH_PATTERN = /(?:\/|^)(?:login|signin|sign-in|auth|account\/login|users\/sign_in|login\.php)(?:\/|$|[?#])/i;

function normalizeHostPath(raw: string): { host: string; path: string } | null {
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname || '/' };
  } catch {
    return null;
  }
}

export function isLoginFinalPath(finalUrl: string): boolean {
  const parsed = normalizeHostPath(finalUrl);
  if (!parsed) return false;
  return LOGIN_PATH_PATTERN.test(parsed.path);
}

function hasLoginFormMarkers(html: string): boolean {
  const body = String(html || '');
  if (body.length === 0) return false;
  // A password field alone proves nothing about the gate: registration and
  // signup forms also carry one. Require INDEPENDENT login/access-gate
  // evidence beyond the password input itself (which trivially contains the
  // word "password", so it must never satisfy the second check on its own).
  if (!/type\s*=\s*["']password["']/i.test(body)) return false;
  return (
    // Form posting to a login/session endpoint (register/signup/join actions
    // do not match: only login|signin|sign-in|/session).
    /<form[^>]*action\s*=\s*["'][^"']*(login|signin|sign-in|\/session)[^"']*["']/i.test(body) ||
    // Login-labeled submit control or button.
    /type\s*=\s*["']submit["'][^>]*value\s*=\s*["'][^"']*(log\s?in|sign\s?in)/i.test(body) ||
    /<button[^>]*>\s*(log\s?in|sign\s?in)\b/i.test(body) ||
    // Forgot-password affordance exists only on login gates.
    /forgot\s+(your\s+)?password/i.test(body) ||
    // Explicit gate phrasing ("Log in to continue", "Sign in below").
    /(log\s?in|sign\s?in)\s+(to|with|using|via|below|here)/i.test(body)
  );
}

/**
 * Confirmed login wall: redirect-to-login + content markers + HTTP 200-ish.
 * 429/401/403/5xx are rate-limit/block (retryable), never confirmed login.
 * Assets (non-HTML already filtered upstream) and FOUND rows excluded by caller.
 */
export function isConfirmedLoginWall(input: {
  requestedUrl?: unknown;
  finalUrl?: unknown;
  html?: unknown;
  httpStatus?: unknown;
  hasCandidates?: boolean;
}): boolean {
  try {
    if (input.hasCandidates === true) return false;
    const requested = String(input.requestedUrl || '');
    const final = String(input.finalUrl || '');
    if (!requested || !final) return false;
    if (requested === final) return false;
    const status = Number(input.httpStatus);
    if (Number.isFinite(status)) {
      if (status === 429 || status === 401 || status === 403 || status >= 500) return false;
      if (status !== 200 && (status < 200 || status >= 300)) return false;
    }
    if (!isLoginFinalPath(final)) return false;
    // Requested asset paths (css/js/image/font) are infra, not walls.
    if (/\.(css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot)(?:$|[?#])/i.test(requested)) {
      return false;
    }
    return hasLoginFormMarkers(String(input.html || ''));
  } catch {
    return false;
  }
}

export const LOGIN_WALL_FAILURE_CLASS = 'LOGIN_WALL';
export const PAYWALL_FAILURE_CLASS = 'PAYWALL_WALL';

function hasPaywallMarkers(html: string): boolean {
  const body = String(html || '');
  if (body.length === 0) return false;
  // isAccessibleForFree:false is an active machine-readable barrier on its own,
  // in plain or quoted JSON-LD form ("isAccessibleForFree": false).
  const structuredBarrier = /["']?isAccessibleForFree["']?\s*:\s*false/i.test(body);
  // Class-based paywall UI must be ACTIVE: incidental/disabled/hidden UI
  // (e.g. class="paywall-disabled") combined with payment text elsewhere must
  // never read as a live wall. A disabled-qualified paywall marker anywhere
  // makes the evidence ambiguous → fail closed to retryable/incomplete, even
  // when active phrasing ("subscribe to continue") appears elsewhere on the
  // page (it may live inside the inactive template).
  let activeClassBarrier = false;
  let disabledPaywallPresent = false;
  try {
    const classAttrs = body.match(/class\s*=\s*["'][^"']*["']/gi) || [];
    for (const attr of classAttrs) {
      if (!/paywall/i.test(attr)) continue;
      if (/disabled|hidden|inactive|removed|\boff\b/i.test(attr)) {
        disabledPaywallPresent = true;
        continue;
      }
      activeClassBarrier = true;
    }
  } catch { activeClassBarrier = false; }
  const textualBarrier =
    /subscribe\s+to\s+continue/i.test(body) || /subscription\s+required/i.test(body);
  if (!structuredBarrier && disabledPaywallPresent) return false;
  if (!structuredBarrier && !activeClassBarrier && !textualBarrier) return false;
  return /subscri|subscription|payment|pay\s+to|premium|members?\s+only|billing/i.test(body);
}

/**
 * Confirmed paywall/subscription wall: strong content evidence proving the
 * underlying content cannot be accessed without payment. Requires BOTH a
 * paywall marker AND a payment/subscription keyword in already-fetched html.
 * Single status codes, truncations, or generic blocks never confirm.
 * FOUND/candidate-retained rows never become paywalls (callers exclude FOUND).
 * Fail-open: missing/errored inputs → not confirmed.
 */
export function isConfirmedPaywall(input: {
  finalUrl?: unknown;
  html?: unknown;
  hasCandidates?: boolean;
}): boolean {
  try {
    if (input.hasCandidates === true) return false;
    const final = String(input.finalUrl || '');
    if (!final) return false;
    if (/\.(css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot)(?:$|[?#])/i.test(final)) return false;
    return hasPaywallMarkers(String(input.html || ''));
  } catch {
    return false;
  }
}
