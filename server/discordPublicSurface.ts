/**
 * H1 — Discord public server-directory and widget surfaces.
 *
 * Discord invite extraction from text is terminal: a `discord.gg` code is a
 * candidate without a network hop. Two public Discord URL shapes carry no
 * invite code in the URL itself:
 *
 *   https://discord.com/servers/<slug>-<guildId>
 *   https://discord.com/widget?id=<guildId>
 *
 * The crawler previously dropped both hosts before admission, so a creator
 * that linked only one of them produced a clean negative. This module parses
 * the guild identity, performs a bounded public fetch, and returns any native
 * invite candidates with source attribution.
 *
 * Server pages are server-rendered and expose the server's vanity invite
 * (verified against the live directory: a server page contains its
 * `discord.gg/<code>` link). Widget pages are a JavaScript shell; the public
 * widget JSON is the authoritative surface and may expose `instant_invite`.
 *
 * Fetching reuses the crawler's guarded manual-redirect path
 * (`fetchProfilerUrl`): every redirect destination is checked before contact,
 * production DNS is pinned, and the body is read under the same deadline and
 * response cap as ordinary crawler requests.
 *
 * Everything here is public-only: no login, token, or guild membership. The
 * callers keep the existing candidate admission, ownership, and validation
 * pipeline; this module never validates an invite.
 */
import { extractDiscordCandidates, type DiscordCandidate } from './discordCandidates';
import { MAX_CRAWL_RESPONSE_CHARS } from './crawlResponseBounds';
import type { DnsResolver } from './publicDestination';
import {
  fetchProfilerUrl,
  type ProfilerRedirectFailure,
  type ProfilerTransportFailure,
} from './siteProfiler';
import type { AcquisitionSurface } from './inspector';

export type DiscordPublicSurfaceKind = 'SERVER_PAGE' | 'WIDGET';

export interface DiscordPublicSurfaceRef {
  kind: DiscordPublicSurfaceKind;
  guildId: string;
  /** Stable fetch/dedupe URL. Discord-owned host aliases collapse to
   * `discord.com` so `discordapp.com` variants share one inspection. */
  canonicalUrl: string;
}

export type DiscordPublicSurfaceOutcome = 'FOUND' | 'INSPECTED_NO_MATCH' | 'ACQUISITION_FAILED';

export interface DiscordPublicSurfaceAcquisition {
  surface: DiscordPublicSurfaceRef;
  outcome: DiscordPublicSurfaceOutcome;
  retryable: boolean;
  failureClass?: string;
  detail: string;
  candidates: DiscordCandidate[];
  /** Bounded public requests actually started. */
  requestsStarted: number;
  /** HTML pages fully parsed (server pages only). */
  pagesInspected: number;
}

const DISCORD_PUBLIC_HOSTS = new Set([
  'discord.com',
  'www.discord.com',
  'discordapp.com',
  'www.discordapp.com',
]);
const GUILD_ID = /^\d{15,25}$/;
const SERVER_PATH = /^\/servers\/([^/]+)$/i;
const SERVER_GUILD_ID = /(?:^|-)(\d{15,25})$/;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_REDIRECT_HOPS = 5;
const PUBLIC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

/**
 * Parse a Discord server-directory or widget URL. Returns null for every
 * other Discord path (invites, channels, the directory root, category pages,
 * extra path segments, and malformed guild ids) so callers keep the existing
 * terminal-invite behavior for those shapes.
 *
 * The guild id is anchored to the end of one server-path segment. This
 * prevents a numeric slug segment from being selected instead of the real
 * trailing id, and rejects over-long numeric runs instead of truncating them.
 */
export function discordPublicSurfaceFor(raw: string): DiscordPublicSurfaceRef | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!DISCORD_PUBLIC_HOSTS.has(host)) return null;

  const path = parsed.pathname.replace(/\/+$/, '');
  const serverPath = SERVER_PATH.exec(path);
  if (serverPath) {
    const tail = serverPath[1];
    const match = SERVER_GUILD_ID.exec(tail);
    if (!match) return null;
    return {
      kind: 'SERVER_PAGE',
      guildId: match[1],
      canonicalUrl: `https://discord.com/servers/${tail}`,
    };
  }

  if (/^\/widget$/i.test(path)) {
    const id = parsed.searchParams.get('id')
      || parsed.searchParams.get('server_id')
      || parsed.searchParams.get('serverId')
      || '';
    if (!GUILD_ID.test(id)) return null;
    return {
      kind: 'WIDGET',
      guildId: id,
      canonicalUrl: `https://discord.com/widget?id=${id}`,
    };
  }

  return null;
}

export function widgetJsonUrl(guildId: string): string {
  return `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/widget.json`;
}

interface BoundedFetch {
  status: number;
  text: string;
  truncated: boolean;
  /** Actual requests made, including every followed redirect hop. */
  requestsStarted: number;
  failureClass?: string;
  detail?: string;
  retryable?: boolean;
}

function redirectFailure(failure: ProfilerRedirectFailure | undefined): {
  failureClass: string;
  retryable: boolean;
  detail: string;
} {
  switch (failure) {
    case 'DNS_RESOLUTION_FAILED':
      return { failureClass: 'NETWORK_FAILURE', retryable: true, detail: 'redirect destination DNS lookup failed' };
    case 'DNS_TIMEOUT':
      return { failureClass: 'TIMEOUT', retryable: true, detail: 'redirect destination DNS lookup timed out' };
    case 'REDIRECT_LOOP':
      return { failureClass: 'REDIRECT_LOOP', retryable: false, detail: 'redirect loop detected' };
    case 'REDIRECT_LIMIT':
      return { failureClass: 'REDIRECT_LIMIT', retryable: false, detail: `redirect hop limit reached (${MAX_REDIRECT_HOPS})` };
    case 'NON_PUBLIC_DESTINATION':
      return { failureClass: 'SSRF_BLOCKED', retryable: false, detail: 'redirect destination is not public' };
    case 'MALFORMED_LOCATION':
    default:
      return { failureClass: 'INVALID_REDIRECT', retryable: false, detail: 'malformed redirect destination' };
  }
}

async function fetchBounded(
  fetchImpl: typeof fetch,
  url: string,
  accept: string,
  timeoutMs: number,
  maxBodyChars: number,
  resolveHost: DnsResolver | undefined,
): Promise<BoundedFetch> {
  let transportFailure: ProfilerTransportFailure | undefined;
  const fetched = await fetchProfilerUrl(
    url,
    fetchImpl,
    maxBodyChars,
    timeoutMs,
    resolveHost,
    { ...PUBLIC_HEADERS, Accept: accept },
    {
      maxHops: MAX_REDIRECT_HOPS,
      onTransportError: failure => { transportFailure = failure; },
    },
  );
  if (!fetched) {
    const blocked = transportFailure?.code === 'ESSRFBLOCKED' || transportFailure?.causeCode === 'ESSRFBLOCKED';
    const timedOut = transportFailure?.name === 'AbortError';
    return {
      status: 0,
      text: '',
      truncated: false,
      requestsStarted: 1,
      failureClass: blocked ? 'SSRF_BLOCKED' : timedOut ? 'TIMEOUT' : 'NETWORK_FAILURE',
      retryable: !blocked,
      detail: blocked
        ? 'public fetch blocked a non-public destination'
        : timedOut
          ? 'public fetch timed out'
          : `public fetch failed: ${transportFailure?.message || 'transport failure'}`,
    };
  }
  if (fetched.redirectRejected || fetched.redirectFailure) {
    const failure = redirectFailure(fetched.redirectFailure);
    return {
      status: fetched.status,
      text: '',
      truncated: false,
      requestsStarted: Math.max(1, fetched.redirectsFollowed.length),
      ...failure,
      detail: `${failure.detail}${fetched.rejectedRedirect ? `: ${fetched.rejectedRedirect}` : ''}`,
    };
  }
  return {
    status: fetched.status,
    text: fetched.text,
    truncated: fetched.truncated,
    requestsStarted: Math.max(1, fetched.redirectsFollowed.length),
  };
}

function statusFailure(status: number): { failureClass: string; retryable: boolean; detail: string } {
  if (status === 408 || status === 425) {
    return { failureClass: 'TRANSIENT_HTTP', retryable: true, detail: `HTTP ${status} transient request failure` };
  }
  if (status === 429) return { failureClass: 'RATE_LIMIT', retryable: true, detail: `HTTP ${status} rate limited` };
  if (status >= 500) return { failureClass: 'TRANSIENT_HTTP', retryable: true, detail: `HTTP ${status} transient upstream failure` };
  if (status === 401 || status === 403) {
    return { failureClass: 'HTTP_ERROR', retryable: true, detail: `HTTP ${status} blocked public inspection` };
  }
  return { failureClass: 'HTTP_ERROR', retryable: false, detail: `HTTP ${status}` };
}

/**
 * Only a confirmed disabled/unknown widget is a clean negative. A generic
 * 401/403 (or an HTML block page) is an access failure and stays retryable;
 * otherwise a temporary block can masquerade as an absent invite.
 */
function confirmedWidgetUnavailable(status: number, bodyText: string): boolean {
  let body: any = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return false;
  }
  const code = Number(body?.code);
  const message = String(body?.message || '');
  if (status === 403) {
    return code === 50004 || /widget.*disabled|disabled.*widget|not enabled/i.test(message);
  }
  if (status === 404) {
    return code === 10004 || /unknown (?:guild|server)/i.test(message);
  }
  return false;
}

interface WidgetResult {
  state: 'OK' | 'UNAVAILABLE' | 'FAILED';
  candidates: DiscordCandidate[];
  detail: string;
  failureClass?: string;
  retryable?: boolean;
  requestsStarted: number;
}

async function readWidget(
  fetchImpl: typeof fetch,
  guildId: string,
  sourceSurface: AcquisitionSurface,
  surfaceUrl: string,
  timeoutMs: number,
  maxBodyChars: number,
  resolveHost: DnsResolver | undefined,
): Promise<WidgetResult> {
  const fetched = await fetchBounded(
    fetchImpl,
    widgetJsonUrl(guildId),
    'application/json',
    timeoutMs,
    maxBodyChars,
    resolveHost,
  );
  if (fetched.failureClass) {
    return {
      state: 'FAILED',
      candidates: [],
      failureClass: fetched.failureClass,
      retryable: fetched.retryable !== false,
      detail: fetched.detail || 'widget fetch failed',
      requestsStarted: fetched.requestsStarted,
    };
  }
  if (fetched.status < 200 || fetched.status >= 300) {
    if (confirmedWidgetUnavailable(fetched.status, fetched.text)) {
      return { state: 'UNAVAILABLE', candidates: [], detail: `widget disabled/unavailable (HTTP ${fetched.status})`, requestsStarted: fetched.requestsStarted };
    }
    const failure = statusFailure(fetched.status);
    return {
      state: 'FAILED',
      candidates: [],
      failureClass: failure.failureClass,
      retryable: failure.retryable,
      detail: failure.detail,
      requestsStarted: fetched.requestsStarted,
    };
  }
  if (fetched.truncated) {
    return {
      state: 'FAILED',
      candidates: [],
      failureClass: 'RESPONSE_TRUNCATED',
      retryable: true,
      detail: 'widget JSON exceeded the bounded response cap',
      requestsStarted: fetched.requestsStarted,
    };
  }
  let body: any;
  try {
    body = JSON.parse(fetched.text);
  } catch {
    return {
      state: 'FAILED',
      candidates: [],
      failureClass: 'MALFORMED_RESPONSE',
      retryable: true,
      detail: 'widget JSON could not be parsed',
      requestsStarted: fetched.requestsStarted,
    };
  }
  const invite = typeof body?.instant_invite === 'string' ? body.instant_invite : '';
  const candidates = invite
    ? extractDiscordCandidates(invite, sourceSurface, surfaceUrl).filter(candidate => candidate.nativeInviteCode)
    : [];
  const name = typeof body?.name === 'string' && body.name ? ` (${body.name})` : '';
  return {
    state: 'OK',
    candidates,
    detail: candidates.length
      ? `widget exposed ${candidates.length} native invite candidate(s)${name}`
      : `widget inspected with no instant invite${name}`,
    requestsStarted: fetched.requestsStarted,
  };
}

/**
 * Bounded public acquisition for one parsed Discord surface.
 *
 * Server pages: fetch the page and scan the rendered HTML for native invite
 * links. A server page that fails or proves no invite still falls back to the
 * independent public widget JSON (the page may be a client shell, temporarily
 * unavailable, or the server may expose only the widget). Widget URLs: fetch
 * the public widget JSON directly.
 */
export async function acquireDiscordPublicSurface(input: {
  surface: DiscordPublicSurfaceRef;
  sourceSurface: AcquisitionSurface;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Test/diagnostic body cap; production uses the shared crawler cap. */
  maxBodyChars?: number;
  resolveHost?: DnsResolver;
}): Promise<DiscordPublicSurfaceAcquisition> {
  const fetchImpl = input.fetchImpl || fetch;
  const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxBodyChars = Math.max(1, input.maxBodyChars ?? MAX_CRAWL_RESPONSE_CHARS);
  const surface = input.surface;
  let requestsStarted = 0;
  let pagesInspected = 0;

  if (surface.kind === 'WIDGET') {
    const widget = await readWidget(
      fetchImpl,
      surface.guildId,
      input.sourceSurface,
      surface.canonicalUrl,
      timeoutMs,
      maxBodyChars,
      input.resolveHost,
    );
    requestsStarted += widget.requestsStarted;
    if (widget.candidates.length) {
      return {
        surface,
        outcome: 'FOUND',
        retryable: false,
        detail: widget.detail,
        candidates: widget.candidates,
        requestsStarted,
        pagesInspected,
      };
    }
    if (widget.state === 'FAILED') {
      return {
        surface,
        outcome: 'ACQUISITION_FAILED',
        retryable: widget.retryable !== false,
        failureClass: widget.failureClass,
        detail: widget.detail,
        candidates: [],
        requestsStarted,
        pagesInspected,
      };
    }
    return {
      surface,
      outcome: 'INSPECTED_NO_MATCH',
      retryable: false,
      detail: widget.detail,
      candidates: [],
      requestsStarted,
      pagesInspected,
    };
  }

  const page = await fetchBounded(
    fetchImpl,
    surface.canonicalUrl,
    'text/html,application/xhtml+xml',
    timeoutMs,
    maxBodyChars,
    input.resolveHost,
  );
  requestsStarted += page.requestsStarted;
  let pageFailure: { failureClass: string; retryable: boolean; detail: string } | null = null;
  if (page.failureClass) {
    pageFailure = {
      failureClass: page.failureClass,
      retryable: page.retryable !== false,
      detail: page.detail || 'server page fetch failed',
    };
  } else if (page.status < 200 || page.status >= 300) {
    pageFailure = statusFailure(page.status);
  } else {
    // A truncated prefix is parsed for candidate recall but is not a fully
    // inspected page; do not overstate coverage telemetry.
    if (!page.truncated) pagesInspected = 1;
    const candidates = extractDiscordCandidates(page.text, input.sourceSurface, surface.canonicalUrl)
      .filter(candidate => candidate.nativeInviteCode);
    if (candidates.length) {
      return {
        surface,
        outcome: 'FOUND',
        retryable: false,
        detail: `server page exposed ${candidates.length} native invite candidate(s)`,
        candidates,
        requestsStarted,
        pagesInspected,
      };
    }
    // A truncated prefix that contains no invite is not proof of absence.
    if (page.truncated) {
      pageFailure = {
        failureClass: 'RESPONSE_TRUNCATED',
        retryable: true,
        detail: 'server page exceeded the bounded response cap without an invite in the prefix',
      };
    }
  }

  // The widget is an independent public surface for the same guild id: try it
  // even when the server page failed, so a 404/blocked page cannot hide an
  // enabled widget invite.
  const widget = await readWidget(
    fetchImpl,
    surface.guildId,
    input.sourceSurface,
    surface.canonicalUrl,
    timeoutMs,
    maxBodyChars,
    input.resolveHost,
  );
  requestsStarted += widget.requestsStarted;
  if (widget.candidates.length) {
    return {
      surface,
      outcome: 'FOUND',
      retryable: false,
      detail: `${pageFailure ? 'server page unavailable; ' : 'server page had no static invite; '}${widget.detail}`,
      candidates: widget.candidates,
      requestsStarted,
      pagesInspected,
    };
  }
  if (widget.state === 'FAILED') {
    const retryable = pageFailure?.retryable === true || widget.retryable !== false;
    // A retryable widget failure must not inherit a permanent page class
    // (e.g. REDIRECT_LIMIT), or the retry classifier would reject it.
    const failureClass = retryable
      ? (pageFailure?.retryable === true ? pageFailure.failureClass : widget.failureClass)
      : (pageFailure?.failureClass || widget.failureClass);
    return {
      surface,
      outcome: 'ACQUISITION_FAILED',
      retryable,
      failureClass,
      detail: pageFailure
        ? `${pageFailure.detail}; ${widget.detail}`
        : widget.detail,
      candidates: [],
      requestsStarted,
      pagesInspected,
    };
  }
  if (pageFailure) {
    return {
      surface,
      outcome: 'ACQUISITION_FAILED',
      retryable: pageFailure.retryable,
      failureClass: pageFailure.failureClass,
      detail: `${pageFailure.detail}; ${widget.detail}`,
      candidates: [],
      requestsStarted,
      pagesInspected,
    };
  }
  return {
    surface,
    outcome: 'INSPECTED_NO_MATCH',
    retryable: false,
    detail: `server page and public widget inspected with no invite (${widget.detail})`,
    candidates: [],
    requestsStarted,
    pagesInspected,
  };
}
