/**
 * Shared staging-target verification for the terminology verification scripts.
 *
 * Pure and side-effect free (safe to unit test): decides whether a PostgreSQL
 * connection string may be used, which TLS configuration applies, and nothing
 * else. Callers open their own pools AFTER verification passes — application
 * `getDb()` must never be touched before, because it runs migrations and
 * seedDefaults() (both write).
 */
export interface TargetVerdict {
  ok: boolean;
  reason?: string;
  loopback: boolean;
  host: string;
  /** Exact `ssl` value to pass node-postgres. `false` only for loopback. */
  ssl: false | { rejectUnauthorized: boolean } | undefined;
}

/** Hostname exactly as the pool will resolve it (brackets stripped). */
export function parseTargetHost(connectionString: string): string {
  let host = '';
  try {
    host = new URL(connectionString).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host;
}

export function hasHostOverrideParam(connectionString: string): boolean {
  const queryIndex = connectionString.indexOf('?');
  if (queryIndex < 0) return false;
  return /(?:^|[?&])host=/i.test(connectionString.slice(queryIndex));
}

export function sslModeParam(connectionString: string): string | null {
  const match = /[?&]sslmode=([^&#]*)/i.exec(connectionString);
  return match ? decodeURIComponent(match[1]).toLowerCase() : null;
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Fail-closed verdict for a staging target. Refusals:
 * - empty hostname (kills implicit-socket / `?host=` bypass classes);
 * - any explicit `host` query parameter (pool must resolve the authority host);
 * - non-loopback without TLS (PGSSL=disable never applies off loopback);
 * - non-loopback with a downgradable sslmode (only require/verify-ca/verify-full).
 * Verified TLS (rejectUnauthorized) is enforced for every non-loopback target;
 * bypass configurations are refused rather than downgraded.
 */
export function verifyStagingTarget(connectionString: string): TargetVerdict {
  const host = parseTargetHost(connectionString);
  if (host === '') {
    return { ok: false, loopback: false, host, ssl: undefined, reason: 'empty authority hostname — refusing implicit/default host resolution' };
  }
  if (hasHostOverrideParam(connectionString)) {
    return { ok: false, loopback: false, host, ssl: undefined, reason: 'explicit host query parameter — pool must resolve the authority host' };
  }
  const loopback = isLoopbackHost(host);
  if (!loopback) {
    const mode = sslModeParam(connectionString);
    if (mode !== null && mode !== 'require' && mode !== 'verify-ca' && mode !== 'verify-full') {
      return { ok: false, loopback, host, ssl: undefined, reason: `sslmode=${mode} permits downgraded or plaintext transport` };
    }
    return { ok: true, loopback, host, ssl: { rejectUnauthorized: true } };
  }
  const ssl =
    process.env.PGSSL === 'disable'
      ? false
      : process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : undefined;
  return { ok: true, loopback, host, ssl };
}
