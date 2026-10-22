/**
 * Loopback HTTP proxy for the rendered browser tier.
 *
 * Chromium resolves hostnames itself, so a Playwright route handler can only
 * preflight a URL; it cannot pin the address Chromium connects to. This proxy
 * performs one DNS lookup per connection, rejects the connection if any
 * answer is non-public, and connects to the selected address directly. The
 * browser therefore never gets a second DNS answer it could be rebound to.
 *
 * HTTPS is tunnelled with CONNECT, so the origin TLS certificate and SNI are
 * preserved; only the TCP destination is pinned. Plain HTTP proxy requests are
 * rewritten to the origin path and sent to the pinned address. Ports are
 * restricted to 80/443 because this proxy exists only for public web pages.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isPublicIpAddress } from './publicDestination';

export type BrowserProxyLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface BrowserEgressProxy {
  url: string;
  close(): Promise<void>;
}

export interface BrowserEgressProxyOptions {
  lookup?: BrowserProxyLookup;
  dnsTimeoutMs?: number;
}

const PUBLIC_PORTS = new Set([80, 443]);
const DEFAULT_DNS_TIMEOUT_MS = 3_000;

const defaultLookup: BrowserProxyLookup = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

function boundedDns<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), timeoutMs);
    work.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Resolve once, reject mixed/private answers, and return the one address the
 * proxy will connect to. The lookup result is never cached. */
export async function resolvePinnedPublicAddress(
  hostname: string,
  lookup: BrowserProxyLookup = defaultLookup,
  timeoutMs: number = DEFAULT_DNS_TIMEOUT_MS,
): Promise<{ address: string; family: number }> {
  const host = normalizeHostname(hostname);
  if (!host) throw new Error('INVALID_HOST');
  if (isIP(host)) {
    if (!isPublicIpAddress(host)) throw new Error('BLOCKED_DESTINATION');
    return { address: host, family: isIP(host) === 6 ? 6 : 4 };
  }
  const addresses = await boundedDns(lookup(host), timeoutMs);
  if (!addresses.length || addresses.some(entry => !isPublicIpAddress(entry.address))) {
    throw new Error('BLOCKED_DESTINATION');
  }
  const first = addresses[0];
  return { address: first.address, family: first.family };
}

function deny(response: ServerResponse, message = 'Blocked destination'): void {
  if (!response.headersSent) response.writeHead(403, { 'content-type': 'text/plain' });
  response.end(message);
}

function parseHttpTarget(rawUrl: string | undefined): URL | undefined {
  if (!rawUrl || !/^http:\/\//i.test(rawUrl)) return undefined;
  try {
    const target = new URL(rawUrl);
    if (target.protocol !== 'http:') return undefined;
    return target;
  } catch {
    return undefined;
  }
}

function originPort(target: URL, fallback: number): number {
  return target.port ? Number(target.port) : fallback;
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  lookup: BrowserProxyLookup,
  dnsTimeoutMs: number,
): Promise<void> {
  const target = parseHttpTarget(req.url);
  if (!target) {
    deny(res, 'Invalid proxy request');
    return;
  }
  const port = originPort(target, 80);
  if (!PUBLIC_PORTS.has(port)) {
    deny(res, 'Blocked destination port');
    return;
  }
  let pinned: { address: string; family: number };
  try {
    pinned = await resolvePinnedPublicAddress(target.hostname, lookup, dnsTimeoutMs);
  } catch {
    deny(res);
    return;
  }
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: target.host };
  delete headers['proxy-connection'];
  delete headers['proxy-authorization'];
  const upstream = httpRequest({
    host: pinned.address,
    port,
    family: pinned.family,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers,
  });
  upstream.once('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Upstream request failed');
  });
  upstream.once('response', upstreamRes => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  // The rendered crawler does not need WebSockets. Reject an upgrade instead
  // of leaving the client connected to a response that never arrives.
  upstream.once('upgrade', (_upstreamRes, upstreamSocket) => {
    upstreamSocket.destroy();
    if (!res.headersSent) res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('WebSocket upgrade blocked');
  });
  req.pipe(upstream);
}

/** Parse a CONNECT authority without letting a scheme's default-port rule
 * erase an explicit port. `https:` preserves an explicit :80; the bare host
 * still defaults to 443. Userinfo, paths, queries, fragments, and whitespace
 * are rejected rather than normalized into a different host. */
export function parseConnectAuthority(
  authority: string | undefined,
): { hostname: string; port: number } | undefined {
  const raw = authority?.trim();
  if (!raw || /[\/?#@\s]/.test(raw)) return undefined;
  try {
    const target = new URL(`https://${raw}`);
    if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
      return undefined;
    }
    return {
      hostname: target.hostname,
      port: target.port ? Number(target.port) : 443,
    };
  } catch {
    return undefined;
  }
}

async function handleConnect(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  lookup: BrowserProxyLookup,
  dnsTimeoutMs: number,
): Promise<void> {
  // The client can disconnect while DNS is in flight. Keep an error listener
  // attached for that window so the socket error cannot become unhandled.
  clientSocket.once('error', () => clientSocket.destroy());
  const target = parseConnectAuthority(req.url);
  if (!target) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const port = target.port;
  if (!PUBLIC_PORTS.has(port)) {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  let pinned: { address: string; family: number };
  try {
    pinned = await resolvePinnedPublicAddress(target.hostname, lookup, dnsTimeoutMs);
  } catch {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = netConnect({ host: pinned.address, port, family: pinned.family });
  if (clientSocket.destroyed) {
    upstream.destroy();
    return;
  }
  const closeBoth = (): void => {
    clientSocket.destroy();
    upstream.destroy();
  };
  upstream.once('connect', () => {
    if (clientSocket.destroyed) {
      upstream.destroy();
      return;
    }
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.once('error', () => {
    if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  clientSocket.once('error', closeBoth);
  upstream.once('close', () => { if (!clientSocket.destroyed) clientSocket.end(); });
  clientSocket.once('close', () => { if (!upstream.destroyed) upstream.destroy(); });
}

/** Start a loopback proxy. The browser is configured to use it for every
 * HTTP(S) connection; it has no bypass list except the explicit Chromium
 * `<-loopback>` override supplied by the crawler. */
export async function startBrowserEgressProxy(
  options: BrowserEgressProxyOptions = {},
): Promise<BrowserEgressProxy> {
  const lookup = options.lookup ?? defaultLookup;
  const dnsTimeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  const sockets = new Set<Duplex>();
  const server: Server = createServer((req, res) => {
    void handleHttpRequest(req, res, lookup, dnsTimeoutMs).catch(() => deny(res));
  });
  server.on('connect', (req, socket, head) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    void handleConnect(req, socket, head, lookup, dnsTimeoutMs).catch(() => {
      if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new Error('PROXY_LISTEN_FAILED');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
