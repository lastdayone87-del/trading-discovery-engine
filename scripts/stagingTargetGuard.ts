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

/**
 * The query string percent-decoded before inspection. pg-connection-string
 * decodes parameter NAMES (`?%68ost=` selects the host), so checking the raw
 * string would miss encoded overrides. Malformed encodings fail closed.
 */
export function decodedQuery(connectionString: string): string | null {
  const queryIndex = connectionString.indexOf('?');
  if (queryIndex < 0) return '';
  try {
    return decodeURIComponent(connectionString.slice(queryIndex));
  } catch {
    return null;
  }
}

export function hasHostOverrideParam(connectionString: string): boolean {
  const query = decodedQuery(connectionString);
  if (query === null) return true;
  return /(?:^|[?&])host=/i.test(query);
}

/** Every sslmode value present (decoded); pg applies the LAST one. */
export function sslModeParams(connectionString: string): string[] | null {
  const query = decodedQuery(connectionString);
  if (query === null) return null;
  const modes: string[] = [];
  const pattern = /[?&]sslmode=([^&#]*)/gi;
  let match: RegExpExecArray | null;
  try {
    while ((match = pattern.exec(query)) !== null) modes.push(decodeURIComponent(match[1]).toLowerCase());
  } catch {
    return null;
  }
  return modes;
}

export function sslModeParam(connectionString: string): string | null {
  const modes = sslModeParams(connectionString);
  if (modes === null || modes.length === 0) return null;
  return modes[modes.length - 1];
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
    // Conflicting duplicates are refused instead of guessing which value the
    // driver applies — ambiguity must never resolve toward weaker transport.
    const modes = sslModeParams(connectionString);
    if (modes === null) {
      return { ok: false, loopback, host, ssl: undefined, reason: 'undecodable query string' };
    }
    if (new Set(modes).size > 1) {
      return { ok: false, loopback, host, ssl: undefined, reason: `conflicting sslmode parameters (${modes.join(',')})` };
    }
    const mode = modes.length > 0 ? modes[modes.length - 1] : null;
    if (mode !== null && mode !== 'require' && mode !== 'verify-ca' && mode !== 'verify-full') {
      return { ok: false, loopback, host, ssl: undefined, reason: `sslmode=${mode} permits downgraded or plaintext transport` };
    }
    // Explicit verified TLS. Callers pass this object to every pool they open
    // (verified: an explicit `ssl` object overrides any URL-parsed downgrade,
    // including encoded or duplicated parameters), so the opened connection
    // cannot differ from what was validated here.
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
