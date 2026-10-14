/**
 * Shared staging-target verification for the terminology verification scripts.
 *
 * Pure and side-effect free (safe to unit test): decides whether a PostgreSQL
 * connection string may be used, which TLS configuration applies, and nothing
 * else. Callers open their own pools AFTER verification passes — application
 * `getDb()` must never be touched before, because it runs migrations and
 * seedDefaults() (both write).
 */
import { readFileSync } from 'node:fs';
import { lookup as dnsLookupCallback } from 'node:dns';

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

export interface TargetVerdict {
  ok: boolean;
  reason?: string;
  loopback: boolean;
  host: string;
  /** Exact `ssl` value to pass node-postgres. `false` only for loopback. */
  ssl: false | { rejectUnauthorized: boolean } | undefined;
  /** Custom CA file from `sslrootcert`, for the caller to load explicitly. */
  caFile?: string;
}

/** Decoded `sslrootcert` values present (pg applies the last one). */
export function sslRootCertParams(connectionString: string): string[] | null {
  const queryIndex = connectionString.indexOf('?');
  if (queryIndex < 0) return [];
  const values: string[] = [];
  try {
    const query = decodeURIComponent(connectionString.slice(queryIndex));
    const pattern = /[?&]sslrootcert=([^&#]*)/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(query)) !== null) values.push(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
  return values;
}

/**
 * Concrete node-postgres TLS configuration for a passing verdict. A custom CA
 * file is loaded explicitly (never silently dropped); any load failure
 * refuses the connection. The file reader is injectable for unit tests.
 */
export function tlsPoolConfig(
  verdict: Pick<TargetVerdict, 'ssl' | 'caFile'>,
  readFile: (path: string) => string = (path: string): string => readFileSync(path, 'utf8')
): false | { rejectUnauthorized: boolean; ca?: string } | undefined {
  if (verdict.ssl === false || verdict.ssl === undefined) return verdict.ssl;
  if (verdict.caFile === undefined) return verdict.ssl;
  return { rejectUnauthorized: true, ca: readFile(verdict.caFile) };
}

/**
 * Explicitly allowlisted staging target identities. A database CLONE carries
 * the marker row and token with it, so token comparison alone cannot tell a
 * clone from the provisioned staging database. Defaults to loopback only
 * (the tunnel topology); any remote staging host must be listed explicitly
 * via STAGING_TARGET_ALLOWLIST (comma-separated, bracket-tolerant).
 */
export function targetAllowlist(): string[] {
  const raw = process.env.STAGING_TARGET_ALLOWLIST;
  const entries = (raw === undefined ? 'localhost,127.0.0.1,::1' : raw)
    .split(',')
    .map(entry => {
      const trimmed = entry.trim().toLowerCase();
      return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
    })
    .filter(entry => entry !== '');
  return entries;
}

/**
 * Strip every TLS-related query parameter (`sslmode`, `sslcert`, `sslkey`,
 * `sslrootcert`, …). Proven necessary by first-flight capture: in the bundled
 * node-postgres, connection-string parameters OVERRIDE an explicitly supplied
 * `ssl` object (URL `sslmode=disable` won over `{rejectUnauthorized:true}`,
 * and the URL authority won over an explicit host), so a downgrade smuggled
 * through the URL would survive an explicit object. Callers always pair the
 * sanitized string with the verdict's explicit `ssl`, leaving no TLS input
 * except the validated one. Throws on any `host`/`hostaddr` parameter, which
 * must be refused (never silently rewritten) at the verdict layer.
 */
export function sanitizedConnectionString(connectionString: string): string {
  const queryIndex = connectionString.indexOf('?');
  if (queryIndex < 0) return connectionString;
  const base = connectionString.slice(0, queryIndex);
  const query = connectionString.slice(queryIndex + 1);
  const kept: string[] = [];
  for (const pair of query.split('&')) {
    if (!pair) continue;
    let name = pair.split('=', 1)[0];
    try {
      name = decodeURIComponent(name).toLowerCase();
    } catch {
      throw new Error('undecodable connection-string parameter');
    }
    if (name === 'host' || name === 'hostaddr') {
      throw new Error('host query parameter must be refused, never rewritten');
    }
    if (name === 'sslmode' || name.startsWith('ssl')) continue;
    kept.push(pair);
  }
  return kept.length > 0 ? `${base}?${kept.join('&')}` : base;
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
  if (!targetAllowlist().includes(host)) {
    return { ok: false, loopback, host, ssl: undefined, reason: `host '${host}' is not allowlisted for staging targets (STAGING_TARGET_ALLOWLIST)` };
  }
  // Client-certificate parameters must never be silently dropped (which
  // would fail confusingly) nor ingested by throwaway scripts: refuse them
  // outright. Checked on the DECODED query — `%73slcert`-style encodings are
  // honored by the driver and must not slip through a raw-string check.
  const decoded = decodedQuery(connectionString);
  if (decoded !== null && /(?:^|[?&])ssl(cert|key)\s*=/i.test(decoded)) {
    return { ok: false, loopback, host, ssl: undefined, reason: 'client-certificate parameters (sslcert/sslkey) are not supported by staging scripts — refusing instead of dropping them silently' };
  }
  const caFiles = sslRootCertParams(connectionString);
  if (caFiles === null) {
    return { ok: false, loopback, host, ssl: undefined, reason: 'undecodable query string' };
  }
  if (new Set(caFiles).size > 1) {
    return { ok: false, loopback, host, ssl: undefined, reason: 'conflicting sslrootcert parameters' };
  }
  const caFile = caFiles.length > 0 ? caFiles[caFiles.length - 1] : undefined;
  const withCa = caFile !== undefined ? { caFile } : {};
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
    return { ok: true, loopback, host, ssl: { rejectUnauthorized: true }, ...withCa };
  }
  const modes = sslModeParams(connectionString);
  if (modes === null) {
    return { ok: false, loopback, host, ssl: undefined, reason: 'undecodable query string' };
  }
  // An explicitly requested TLS upgrade is honored even on loopback: the
  // URL's request wins over the PGSSL default, so `sslmode=require` never
  // silently becomes plaintext.
  const requestedTls = modes.some(mode => mode === 'require' || mode === 'verify-ca' || mode === 'verify-full');
  if (caFile !== undefined && !requestedTls) {
    return { ok: false, loopback, host, ssl: undefined, reason: 'sslrootcert without a TLS request (sslmode=require) is contradictory — refusing' };
  }
  if (requestedTls) {
    return { ok: true, loopback, host, ssl: { rejectUnauthorized: true }, ...withCa };
  }
  if (loopback && process.env.NODE_ENV === 'production') {
    // No verification-bypass TLS in production mode, even on loopback: a
    // local on-path peer could impersonate the database and receive queries
    // and credentials without presenting a trusted certificate. Request TLS
    // explicitly (sslmode=require) or run outside production mode.
    return { ok: false, loopback, host, ssl: undefined, reason: 'loopback target in production mode without an explicit TLS request — refusing unverified TLS' };
  }
  const ssl =
    process.env.PGSSL === 'disable'
      ? false
      : process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : undefined;
  return { ok: true, loopback, host, ssl, ...withCa };
}

export type DnsLookup = (host: string) => Promise<string[]>;

export function isLoopbackAddress(ip: string): boolean {
  return ip.startsWith('127.') || ip === '::1';
}

function defaultLookup(host: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    dnsLookupCallback(host, { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map(entry => entry.address));
    });
  });
}

/**
 * Resolve a loopback-classified hostname and pin the connection string to a
 * verified loopback IP. Refuses when any resolved address is not loopback
 * (poisoned resolver/hosts file) or when resolution itself fails. Remote
 * targets are returned unchanged — their verified TLS (hostname-checked
 * against the original name) already defeats resolver lies.
 */
export async function pinLoopbackTarget(
  connectionString: string,
  lookup: DnsLookup = defaultLookup
): Promise<{ connectionString: string; address: string }> {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('unparseable connection string — refusing');
  }
  let addrs: string[];
  try {
    addrs = (await lookup(url.hostname)).map(entry => entry.toLowerCase());
  } catch (error) {
    throw new Error(`DNS resolution failed for '${url.hostname}' — refusing (${error instanceof Error ? error.message : String(error)})`);
  }
  if (addrs.length === 0 || !addrs.every(isLoopbackAddress)) {
    throw new Error(`loopback hostname '${url.hostname}' resolves to non-loopback addresses [${addrs.join(',')}] — refusing (possible resolver poisoning)`);
  }
  url.hostname = addrs[0];
  return { connectionString: url.toString(), address: addrs[0] };
}

export interface StagingIdentity {
  token: string;
  serverAddr: string | null;
  dbName: string;
  /** Cluster identifier: a rerouted clone in another cluster fails here even
   * when token, address, and database name all match. */
  sysid: string;
}

/**
 * Re-verify staging identity on a work pool before its first write: the same
 * marker token, server address, and database name the probe verified. A DNS
 * or routing change between the probe and pool creation surfaces here instead
 * of silently writing to a different database.
 */
export async function assertStagingIdentity(
  db: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  expected: StagingIdentity
): Promise<void> {
  const res = await db.query(
    `SELECT (SELECT token FROM staging_proof_marker WHERE note='terminology-e2e-staging') AS token,
            inet_server_addr()::text AS addr, current_database() AS db,
            (SELECT system_identifier::text AS sysid FROM pg_control_system()) AS sysid`
  );
  const row = (res.rows[0] ?? {}) as Record<string, unknown>;
  if (row.token !== expected.token) throw new Error('staging identity re-check failed: marker token mismatch');
  if ((row.addr ?? null) !== expected.serverAddr) {
    throw new Error(`staging identity re-check failed: server address changed (${String(row.addr)} !== ${String(expected.serverAddr)})`);
  }
  if (row.db !== expected.dbName) {
    throw new Error(`staging identity re-check failed: database changed (${String(row.db)} !== ${expected.dbName})`);
  }
  if (String(row.sysid ?? '') !== expected.sysid) {
    throw new Error('staging identity re-check failed: cluster identifier changed (possible reroute to a cloned cluster)');
  }
}
