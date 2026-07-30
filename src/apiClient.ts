/** Authenticated dashboard transport. Existing reviewer-token storage is retained
 * during the Phase 1 compatibility window; operator-token takes precedence. */
export function operatorToken(): string {
  return localStorage.getItem('operator-token') || localStorage.getItem('review-token') || '';
}

export function setOperatorToken(token: string): void {
  const normalized = token.trim();
  if (normalized) localStorage.setItem('operator-token', normalized);
  else localStorage.removeItem('operator-token');
}

export const AUTH_REQUIRED_EVENT = 'trading-engine:auth-required';

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = operatorToken();
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('X-Request-Id')) headers.set('X-Request-Id', crypto.randomUUID());
  const response = await fetch(input, { ...init, headers });
  // A 403 proves the stored credential was authenticated but lacks the role for
  // one action. Do not tear down an otherwise valid dashboard session.
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT, {
      detail: { status: response.status, hasToken: Boolean(token) }
    }));
  }
  return response;
}
