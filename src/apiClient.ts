/** Authenticated dashboard transport. Existing reviewer-token storage is retained
 * during the Phase 1 compatibility window; operator-token takes precedence. */
export function operatorToken(): string {
  return localStorage.getItem('operator-token') || localStorage.getItem('review-token') || '';
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = operatorToken();
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('X-Request-Id')) headers.set('X-Request-Id', crypto.randomUUID());
  return fetch(input, { ...init, headers });
}
