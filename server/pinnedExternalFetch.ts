/**
 * Connection-time DNS pinning for the public web crawler.
 *
 * `isPublicInternetUrl` is a pre-flight DNS check, but the HTTP client resolves
 * the hostname again when it connects. That leaves a DNS-rebinding window:
 * an attacker can answer the pre-flight query with a public address and the
 * connection query with a private one. This wrapper makes the connection
 * resolver perform the same public-address check on every answer and pins the
 * returned address for that connection. A private, mixed, or empty answer
 * fails the request before a socket is opened.
 *
 * Only the production global-`fetch` path is wrapped; it is replaced with
 * undici's fetch so the dispatcher and fetch implementation always come from
 * one version. Tests and callers that inject a fetch implementation are
 * responsible for their own transport; they can still exercise the URL/redirect
 * guard through the optional resolver parameters.
 */
import { createRequire } from 'node:module';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isPublicIpAddress } from './publicDestination';

const require = createRequire(
  typeof __filename === 'string' ? __filename : `${process.cwd()}/package.json`,
);

interface PinnedDispatcher {
  close?: () => Promise<void>;
}

interface AgentConstructor {
  new (options: Record<string, unknown>): PinnedDispatcher;
}

interface UndiciModule {
  Agent: AgentConstructor;
  fetch: (input: RequestInfo | URL, init?: RequestInit & { dispatcher?: PinnedDispatcher }) => Promise<Response>;
}

let undiciModule: UndiciModule | undefined;

function loadUndici(): UndiciModule {
  if (!undiciModule) {
    // Lazy require keeps the heavy HTTP-client type graph out of the
    // application's type-check path and guarantees the dispatcher and fetch
    // implementation come from the same undici version.
    undiciModule = require('undici') as UndiciModule;
  }
  return undiciModule;
}

type LookupAddress = { address: string; family: number };
type LookupAll = (hostname: string, options: Record<string, unknown>) => Promise<LookupAddress[]>;
type LookupCallback = (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

function blockedLookupError(hostname: string): NodeJS.ErrnoException {
  const error = new Error(`Blocked non-public DNS answer for ${hostname}`) as NodeJS.ErrnoException;
  error.code = 'ESSRFBLOCKED';
  return error;
}

async function defaultLookupAll(hostname: string, options: Record<string, unknown>): Promise<LookupAddress[]> {
  const records = await dnsLookup(hostname, { ...options, all: true });
  return records.map(record => ({ address: record.address, family: record.family }));
}

/**
 * Build the connection-time lookup. Exported so focused tests can prove that a
 * private or mixed answer is rejected at the same layer the HTTP client uses,
 * not only by the pre-flight URL check.
 */
export function createGuardedLookup(
  lookupAll: LookupAll = defaultLookupAll,
  timeoutMs: number = 3_000,
): (hostname: string, options: unknown, callback: LookupCallback) => void {
  return (hostname: string, options: unknown, callback: LookupCallback): void => {
    const requested = typeof options === 'number'
      ? { family: options }
      : { ...((options || {}) as Record<string, unknown>) };
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish: LookupCallback = (error, address, family) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (error) callback(error);
      else callback(null, address, family);
    };
    timer = setTimeout(() => {
      const error = new Error(`DNS lookup for ${hostname} exceeded ${timeoutMs}ms`) as NodeJS.ErrnoException;
      error.code = 'ETIMEDOUT';
      finish(error);
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    void (async () => {
      try {
        const list = (await lookupAll(hostname, requested))
          .map(entry => ({ address: String(entry.address), family: Number(entry.family) }))
          .filter(entry => entry.address.length > 0);
        if (!list.length) {
          finish(blockedLookupError(hostname));
          return;
        }
        if (list.some(entry => !isPublicIpAddress(entry.address))) {
          finish(blockedLookupError(hostname));
          return;
        }
        if ((requested as Record<string, unknown>).all === true) {
          finish(null, list);
          return;
        }
        finish(null, list[0].address, list[0].family);
      } catch (error) {
        finish(error as NodeJS.ErrnoException);
      }
    })();
  };
}

const guardedLookup = createGuardedLookup();

let pinnedAgent: PinnedDispatcher | undefined;

export function getPinnedExternalAgent(): PinnedDispatcher {
  if (!pinnedAgent) {
    // Production Node installs undici as a direct dependency now; if it is
    // ever absent the guarded fetch fails closed rather than falling back to
    // unpinned DNS. The same module supplies the fetch implementation so the
    // dispatcher protocol always matches (important across Node versions).
    const { Agent } = loadUndici();
    pinnedAgent = new Agent({
      connect: {
        lookup: guardedLookup,
      },
    });
  }
  return pinnedAgent;
}

/**
 * Wrap the real fetch with the pinned dispatcher. Injected test doubles are
 * returned unchanged so existing focused tests do not perform real DNS.
 */
export function withPinnedExternalFetch(fetchImpl: typeof fetch): typeof fetch {
  if (fetchImpl !== fetch) return fetchImpl;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { fetch: undiciFetch } = loadUndici();
    return undiciFetch(input, {
      ...(init || {}),
      dispatcher: getPinnedExternalAgent(),
    });
  }) as typeof fetch;
}
