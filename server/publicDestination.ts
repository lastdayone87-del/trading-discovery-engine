/**
 * Shared public-destination guard for every server-side fetch that can be
 * influenced by creator-supplied links.
 *
 * The crawler is allowed to reach arbitrary public websites, but it must never
 * be able to reach the application's own network, the cloud metadata service,
 * loopback, link-local, or other reserved address space. URL syntax alone is
 * not enough: a public-looking hostname can resolve to a private address, and
 * DNS can change between the admission check and the connection.
 *
 * This module is deliberately transport-free so admission policies can use the
 * synchronous IP check without pulling in the HTTP stack. `isPublicInternetUrl`
 * is the async pre-flight check; the crawler also pins the resolved address at
 * connection time in `pinnedExternalFetch.ts` to close the DNS-rebinding gap.
 */
import { lookup } from 'node:dns/promises';

export type DnsResolver = (hostname: string) => Promise<string[]>;

/** Resolve every A/AAAA answer. Callers decide whether all answers are safe. */
export async function defaultDnsResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(record => record.address);
}

function parseIpv4Octets(value: string): number[] | null {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  return octets.every(octet => octet >= 0 && octet <= 255) ? octets : null;
}

function isPublicIpv4Octets(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // deprecated 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/**
 * Parse an IPv6 address into eight 16-bit groups. Supports `::` compression
 * and a dotted IPv4 tail. Returns null for malformed input.
 */
function parseIpv6Groups(value: string): number[] | null {
  let text = value.toLowerCase().replace(/^\[(.*)\]$/, '$1').split('%')[0];
  if (!text.includes(':')) return null;
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    if (lastColon < 0) return null;
    const octets = parseIpv4Octets(text.slice(lastColon + 1));
    if (!octets) return null;
    text = `${text.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups = [...head, ...tail];
  if (halves.length === 2) {
    const missing = 8 - groups.length;
    if (missing < 1) return null;
    groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const parsed = groups.map(group => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN));
  return parsed.some(Number.isNaN) ? null : parsed;
}

function ipv4FromHextets(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isPublicIpv6Groups(groups: number[]): boolean {
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = groups;

  // IPv4-mapped (::ffff:0:0/96) and IPv4-translated (::ffff:0:0/96
  // variants): judge the embedded IPv4 address, never the wrapper.
  if (first === 0 && second === 0 && third === 0 && fourth === 0) {
    if (fifth === 0 && sixth === 0xffff) {
      return isPublicIpv4Octets(ipv4FromHextets(seventh, eighth));
    }
    if (fifth === 0xffff && sixth === 0) {
      return isPublicIpv4Octets(ipv4FromHextets(seventh, eighth));
    }
    // IPv4-compatible (::a.b.c.d) and all other ::/8 forms are deprecated or
    // special-purpose. Fail closed.
    return false;
  }

  // NAT64 well-known prefix: judge the embedded IPv4 target. Local-use
  // 64:ff9b:1::/48 is not a public unicast destination.
  if (first === 0x64 && second === 0xff9b) {
    if (third === 0 && fourth === 0) {
      return isPublicIpv4Octets(ipv4FromHextets(seventh, eighth));
    }
    return false;
  }

  // 100::/64 discard-only.
  if (first === 0x100 && second === 0 && third === 0 && fourth === 0) return false;

  // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID,
  // AMT, AS112, etc.). 2001:db8::/32 documentation is outside /23.
  if (first === 0x2001 && second <= 0x01ff) return false;
  if (first === 0x2001 && second === 0x0db8) return false;

  // 6to4 (2002::/16) embeds an IPv4 address; route selection is outside this
  // process and can reach non-public IPv4 space. Fail closed.
  if (first === 0x2002) return false;

  // 3fff::/20 documentation, 5f00::/16 SRv6 SIDs.
  if (first === 0x3fff && (second & 0xf000) === 0) return false;
  if (first === 0x5f00) return false;

  // Unique-local, link-local/site-local (including deprecated fec0::/10),
  // and multicast.
  if (first >= 0xfc00 && first <= 0xfdff) return false;
  if (first >= 0xfe80 && first <= 0xfeff) return false;
  if (first >= 0xff00) return false;

  // Only 2000::/3 is global unicast. Everything else (including unspecified,
  // loopback, IPv4-compatible, and reserved 0000::/8) was handled above or is
  // not a public destination.
  return first >= 0x2000 && first <= 0x3fff;
}

/**
 * True only for globally routable unicast addresses. Everything else —
 * loopback, link-local, private, carrier-grade NAT, documentation,
 * multicast, reserved, unspecified — is non-public. Unparsable input fails
 * closed (false). IPv4-mapped/translated IPv6 is judged by its inner address.
 */
export function isPublicIpAddress(host: string): boolean {
  const value = String(host || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const v4 = parseIpv4Octets(value);
  if (v4) return isPublicIpv4Octets(v4);
  const v6 = parseIpv6Groups(value);
  if (v6) return isPublicIpv6Groups(v6);
  return false;
}

export function isPrivateOrReservedIp(host: string): boolean {
  return !isPublicIpAddress(host);
}

export type PublicDestinationReason =
  | 'PUBLIC'
  | 'INVALID_URL'
  | 'NON_HTTP_SCHEME'
  | 'NON_PUBLIC_ADDRESS'
  | 'DNS_RESOLUTION_FAILED'
  | 'DNS_TIMEOUT'
  | 'NON_PUBLIC_RESOLVED_ADDRESS';

/** A stalled resolver must not outlive the caller's own fetch budget. The
 * default is deliberately short: all crawler/profiler fetches already carry a
 * bounded transport timeout, and a lookup that cannot answer within this
 * window is a retryable network failure, not permission to wait forever. */
export const PUBLIC_DESTINATION_DNS_TIMEOUT_MS = 3_000;

export interface PublicDestinationDecision {
  allowed: boolean;
  reason: PublicDestinationReason;
  hostname?: string;
  addresses?: string[];
}

/**
 * Resolve and validate a URL before any request touches it.
 *
 * Every returned address must be public. A hostname that resolves to a mix of
 * public and private answers is rejected entirely: selecting one public answer
 * would leave a rebinding opportunity, and a mixed answer is itself suspicious.
 * Resolution failure fails closed.
 */
export async function assessPublicDestination(
  raw: string,
  resolve: DnsResolver = defaultDnsResolve,
  timeoutMs: number = PUBLIC_DESTINATION_DNS_TIMEOUT_MS,
): Promise<PublicDestinationDecision> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { allowed: false, reason: 'INVALID_URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'NON_HTTP_SCHEME', hostname: parsed.hostname };
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) return { allowed: false, reason: 'INVALID_URL' };

  // IP literals are judged directly; the WHATWG parser leaves brackets on
  // IPv6 hostnames, which isPublicIpAddress strips.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
    return isPublicIpAddress(hostname)
      ? { allowed: true, reason: 'PUBLIC', hostname }
      : { allowed: false, reason: 'NON_PUBLIC_ADDRESS', hostname };
  }

  let addresses: string[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = resolve(hostname);
    const effectiveTimeout = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : undefined;
    const deadline = effectiveTimeout === undefined
      ? lookup
      : new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`DNS lookup for ${hostname} exceeded ${effectiveTimeout}ms`) as NodeJS.ErrnoException;
          error.code = 'ETIMEDOUT';
          reject(error);
        }, effectiveTimeout);
        timer.unref?.();
      });
    addresses = await Promise.race([lookup, deadline]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return {
      allowed: false,
      reason: code === 'ETIMEDOUT' ? 'DNS_TIMEOUT' : 'DNS_RESOLUTION_FAILED',
      hostname,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!addresses.length) return { allowed: false, reason: 'DNS_RESOLUTION_FAILED', hostname };
  if (addresses.some(address => !isPublicIpAddress(address))) {
    return { allowed: false, reason: 'NON_PUBLIC_RESOLVED_ADDRESS', hostname, addresses };
  }
  return { allowed: true, reason: 'PUBLIC', hostname, addresses };
}

/** Boolean convenience wrapper used by admission and redirect guards. */
export async function isPublicInternetUrl(
  raw: string,
  resolve: DnsResolver = defaultDnsResolve,
  timeoutMs: number = PUBLIC_DESTINATION_DNS_TIMEOUT_MS,
): Promise<boolean> {
  return (await assessPublicDestination(raw, resolve, timeoutMs)).allowed;
}
