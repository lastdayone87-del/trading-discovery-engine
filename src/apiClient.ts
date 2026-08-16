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

const PACIFIC_TIME_ZONE = 'America/Los_Angeles';

function zonedOffsetMs(timestamp: number, timeZone: string): number {
  const rounded = Math.floor(timestamp / 1000) * 1000;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(rounded));
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const representedAsUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  return representedAsUtc - rounded;
}

/** Convert the backend quota-day identifier (YYYY-MM-DD in Pacific time) into the next real reset instant. */
export function nextPacificQuotaResetAt(quotaDay: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(quotaDay || ''));
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const nextLocalMidnight = Date.UTC(year, month - 1, day + 1, 0, 0, 0);
  let candidate = nextLocalMidnight - zonedOffsetMs(nextLocalMidnight, PACIFIC_TIME_ZONE);
  candidate = nextLocalMidnight - zonedOffsetMs(candidate, PACIFIC_TIME_ZONE);
  return new Date(candidate);
}

/**
 * The backend has one aggregate quota ledger, not per-key metering. Older UI code
 * rendered that aggregate as if it were sequential per-key consumption, which
 * produced fake 10,000/10,000 rows. Keep the operational key status, but mark
 * per-key consumption as untracked and turn the quota-day label into the actual
 * next Pacific reset instant before the legacy QueueMonitor renders it.
 */
export function normalizeQueueStatusForDashboard(payload: any): any {
  if (!payload || typeof payload !== 'object' || !payload.quota || typeof payload.quota !== 'object') return payload;
  const quota = { ...payload.quota };
  if (Array.isArray(quota.keyUsage)) {
    quota.keyUsage = quota.keyUsage.map((item: any) => ({ ...item, unitsUsed: '—', limit: 'not tracked' }));
  }
  const nextReset = nextPacificQuotaResetAt(quota.lastReset);
  if (nextReset) quota.lastReset = `next ${nextReset.toLocaleString()}`;
  return { ...payload, quota };
}

function isQueueStatusRequest(input: RequestInfo | URL): boolean {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  return value.includes('/api/queues/status');
}

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
  if (response.ok && isQueueStatusRequest(input) && (response.headers.get('content-type') || '').includes('application/json')) {
    const payload = normalizeQueueStatusForDashboard(await response.clone().json());
    const replacementHeaders = new Headers(response.headers);
    replacementHeaders.set('content-type', 'application/json');
    return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers: replacementHeaders });
  }
  return response;
}
