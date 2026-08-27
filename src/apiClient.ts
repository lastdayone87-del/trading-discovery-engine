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

/** Normalize only dashboard presentation; durable queue and quota values come from the backend projection. */
export function normalizeQueueStatusForDashboard(payload: any): any {
  if (!payload || typeof payload !== 'object') return payload;
  const quota = payload.quota && typeof payload.quota === 'object' ? { ...payload.quota } : payload.quota;
  if (quota && typeof quota === 'object') {
    const nextReset = nextPacificQuotaResetAt(quota.lastReset);
    if (nextReset) quota.lastReset = `next ${nextReset.toLocaleString()}`;
  }
  const queues = payload.queues && typeof payload.queues === 'object'
    ? {
        ...payload.queues,
        communityRetry: {
          duePending: 0,
          dueBrowserBlocked: 0,
          dueReconciliationBlocked: 0,
          dueClaimable: 0,
          processing: 0,
          staleProcessing: 0,
          oldestDueAt: null,
          oldestProcessingAt: null,
          ...(payload.queues.communityRetry && typeof payload.queues.communityRetry === 'object' ? payload.queues.communityRetry : {})
        }
      }
    : payload.queues;
  return { ...payload, ...(quota && typeof quota === 'object' ? { quota } : {}), ...(queues && typeof queues === 'object' ? { queues } : {}) };
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
